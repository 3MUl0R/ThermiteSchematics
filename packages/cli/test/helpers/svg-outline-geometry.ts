import type { Page } from "playwright-core";
import { printableTextMetrics } from "../../../render/src/text-metrics.js";

export type Point = { x: number; y: number };
export type Box = { left: number; right: number; top: number; bottom: number };
type Matrix = [number, number, number, number, number, number];
export const point = (p: Point, m: Matrix): Point => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
});
export function bounds(points: Point[]): Box {
  if (!points.length) throw Error("Empty SVG geometry");
  return points.reduce(
    (b, p) => ({
      left: Math.min(b.left, p.x),
      right: Math.max(b.right, p.x),
      top: Math.min(b.top, p.y),
      bottom: Math.max(b.bottom, p.y),
    }),
    { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
  );
}
function transformBox(b: Box, m: Matrix): Box {
  return bounds(
    [
      { x: b.left, y: b.top },
      { x: b.right, y: b.top },
      { x: b.left, y: b.bottom },
      { x: b.right, y: b.bottom },
    ].map((p) => point(p, m)),
  );
}
export function distance(a: Box, b: Box): number {
  return Math.hypot(
    Math.max(a.left - b.right, b.left - a.right, 0),
    Math.max(a.top - b.bottom, b.top - a.bottom, 0),
  );
}
export function routeDistance(box: Box, points: Point[]): number {
  return Math.min(
    ...points.slice(1).map((p, i) => {
      const a = points[i]!;
      if (Math.abs(a.x - p.x) > 1e-6 && Math.abs(a.y - p.y) > 1e-6)
        throw Error("Expected an orthogonal wiring route");
      return distance(box, bounds([a, p]));
    }),
  );
}
function segmentDistance(box: Box, a: Point, b: Point): number {
  let enter = 0,
    leave = 1;
  for (const [origin, delta, low, high] of [
    [a.x, b.x - a.x, box.left, box.right],
    [a.y, b.y - a.y, box.top, box.bottom],
  ]) {
    if (delta === 0) {
      if (origin! < low! || origin! > high!) leave = -Infinity;
    } else {
      const first = (low! - origin!) / delta!,
        last = (high! - origin!) / delta!;
      enter = Math.max(enter, Math.min(first, last));
      leave = Math.min(leave, Math.max(first, last));
    }
  }
  if (enter <= leave) return 0;
  const pointBox = (p: Point): Box => ({
    left: p.x,
    right: p.x,
    top: p.y,
    bottom: p.y,
  });
  const corners = [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.left, y: box.bottom },
    { x: box.right, y: box.bottom },
  ];
  return Math.min(
    distance(box, pointBox(a)),
    distance(box, pointBox(b)),
    ...corners.map((p) => {
      const dx = b.x - a.x,
        dy = b.y - a.y,
        square = dx * dx + dy * dy,
        t = square
          ? Math.max(
              0,
              Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / square),
            )
          : 0;
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    }),
  );
}
export function primitiveDistance(box: Box, points: Point[]): number {
  return points
    .slice(1)
    .reduce(
      (best, p, i) => Math.min(best, segmentDistance(box, points[i]!, p)),
      Infinity,
    );
}
export const inside = (a: Box, b: Box) =>
  a.left >= b.left &&
  a.right <= b.right &&
  a.top >= b.top &&
  a.bottom <= b.bottom;

type ElementIdentity = {
  wire: string | null | undefined;
  device: string | null | undefined;
  mark: number;
};
type RawBoxTuple = [number, number, number, number, Matrix];
type RawRectTuple = [number, number, number, number, number, number, number];
type RawText = ElementIdentity & {
  text: string;
  x: number;
  y: number;
  size: number;
  bold: boolean;
  family: string;
  anchor: string;
  baseline: string;
  length: number | undefined;
  lengthAdjust: string | null;
  matrix: Matrix;
  clips: RawBoxTuple[];
  plate: RawBoxTuple | undefined;
  caption: boolean;
  owner: number;
};
type RawShape = ElementIdentity & {
  stroke: number;
  m: Matrix;
  localPoints?: [number, number][];
  rect?: RawRectTuple;
  path?: string;
};

function collectSvgTexts(wiringOnly: boolean) {
  const root = document.querySelector("svg")!,
    inverse = root.getScreenCTM()!.inverse(),
    marks = [...document.querySelectorAll("[data-circuit-mark]")];
  const n = (a: SVGAnimatedLength) => a.baseVal.value;
  const mat = (e: SVGGraphicsElement): Matrix => {
    const m = inverse.multiply(e.getScreenCTM()!);
    return [m.a, m.b, m.c, m.d, m.e, m.f];
  };
  const attr = (e: Element, k: string) => e.closest(`[${k}]`)?.getAttribute(k);
  const idOf = (e: Element): ElementIdentity => ({
    wire: attr(e, "data-wiring-conductor"),
    device: attr(e, "data-device-uid"),
    mark: marks.indexOf(e.closest("[data-circuit-mark]")!),
  });
  const texts: RawText[] = [];
  const sel = wiringOnly ? "[data-wiring-conductor] text" : "text";
  for (const e of document.querySelectorAll<SVGTextElement>(sel)) {
    if (e.closest("defs") || !e.textContent?.trim()) continue;
    const css = getComputedStyle(e);
    if (css.display === "none" || css.visibility === "hidden") continue;
    if (
      e.matches("[dx],[dy]") ||
      e.querySelector("tspan,textPath") ||
      !["normal", "0px"].includes(css.letterSpacing)
    )
      throw Error("Unsupported SVG text positioning in outline test");
    let prev = e.previousElementSibling;
    while (prev?.tagName.toLowerCase() === "text")
      prev = prev.previousElementSibling;
    const clips: RawBoxTuple[] = [];
    for (let p = e.parentElement; p; p = p.parentElement) {
      if (!(p instanceof SVGSVGElement)) continue;
      if (p !== root && getComputedStyle(p).overflow === "visible") continue;
      const v = p.viewBox.baseVal;
      clips.push([v.x, v.y, v.width, v.height, mat(p)]);
    }
    const caption = e.closest("[data-contact-caption]"),
      own = caption?.parentElement?.querySelector("[data-circuit-mark]"),
      tl = e.getAttribute("textLength"),
      hasPlate =
        prev instanceof SVGRectElement &&
        getComputedStyle(prev).fill === "rgb(255, 255, 255)";
    const plate: RawBoxTuple | undefined = hasPlate
      ? [n(prev.x), n(prev.y), n(prev.width), n(prev.height), mat(prev)]
      : undefined;
    texts.push({
      ...idOf(e),
      text: e.textContent,
      x: e.x.baseVal[0]?.value ?? 0,
      y: e.y.baseVal[0]?.value ?? 0,
      size: parseFloat(css.fontSize),
      bold: Number(css.fontWeight) >= 600,
      family: css.fontFamily,
      anchor: css.textAnchor,
      baseline: css.dominantBaseline,
      length: tl !== null ? Number(tl) : undefined,
      lengthAdjust: e.getAttribute("lengthAdjust"),
      matrix: mat(e),
      clips,
      plate,
      caption: !!caption,
      owner: marks.indexOf(own!),
    });
  }
  return { texts, marks: marks.map(idOf) };
}

function collectSvgShapes(wiringOnly: boolean): string {
  const root = document.querySelector("svg")!,
    inverse = root.getScreenCTM()!.inverse(),
    marks = [...document.querySelectorAll("[data-circuit-mark]")];
  const n = (a: SVGAnimatedLength) => a.baseVal.value;
  const straightRe =
    /^\s*M(?:[\s,]*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?){2}(?:[\s,]*(?:L(?:(?:[\s,]*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?){2})+|[HV](?:[\s,]*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)+))+[\s,]*(?:[Zz]\s*)?$/u;
  const shapes: RawShape[] = [];
  const sel = wiringOnly
    ? "[data-wiring-conductor] path"
    : "line,path,polyline,rect,circle";
  for (const e of document.querySelectorAll<SVGGeometryElement>(sel)) {
    if (e.closest("defs")) continue;
    const css = getComputedStyle(e);
    if (css.display === "none" || css.visibility === "hidden") continue;
    const dm = inverse.multiply(e.getScreenCTM()!),
      m: Matrix = [dm.a, dm.b, dm.c, dm.d, dm.e, dm.f],
      scale = Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));
    const attr = (k: string) => e.closest(`[${k}]`)?.getAttribute(k);
    const shape: RawShape = {
      wire: attr("data-wiring-conductor"),
      device: attr("data-device-uid"),
      mark: marks.indexOf(e.closest("[data-circuit-mark]")!),
      stroke: css.stroke === "none" ? 0 : parseFloat(css.strokeWidth) * scale,
      m,
    };
    if (e instanceof SVGPathElement) {
      const d = e.getAttribute("d")!.trim();
      if (wiringOnly || straightRe.test(d)) shape.path = d;
    } else if (e instanceof SVGLineElement) {
      shape.localPoints = [
        [n(e.x1), n(e.y1)],
        [n(e.x2), n(e.y2)],
      ];
    } else if (e instanceof SVGPolylineElement && e.points.numberOfItems > 1) {
      shape.localPoints = Array.from(e.points, (p) => [p.x, p.y]);
    } else if (e instanceof SVGRectElement) {
      shape.rect = [
        n(e.x),
        n(e.y),
        n(e.width),
        n(e.height),
        n(e.rx),
        n(e.ry),
        scale,
      ];
    }
    if (!shape.path && !shape.localPoints && !shape.rect) {
      const len = e.getTotalLength(),
        cnt = Math.max(1, Math.ceil((len * scale) / 0.01));
      shape.localPoints = Array.from({ length: cnt + 1 }, (_, i) => {
        const p = e.getPointAtLength((len * i) / cnt);
        return [p.x, p.y];
      });
    }
    shapes.push(shape);
  }
  return JSON.stringify(shapes);
}

function expandRectPoints(
  [x, y, w, h, rawRx, rawRy, scale]: RawRectTuple,
  m: Matrix,
): Point[] {
  const rx = Math.min(w / 2, Math.max(0, rawRx || rawRy)),
    ry = Math.min(h / 2, Math.max(0, rawRy || rawRx));
  if (!rx || !ry) {
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
      { x, y },
    ].map((p) => point(p, m));
  }
  const steps = Math.max(
    1,
    Math.ceil(((Math.PI / 2) * Math.max(rx, ry) * scale) / 0.01),
  );
  const corners: [number, number, number][] = [
    [x + w - rx, y + ry, -Math.PI / 2],
    [x + w - rx, y + h - ry, 0],
    [x + rx, y + h - ry, Math.PI / 2],
    [x + rx, y + ry, Math.PI],
  ];
  const out = corners.flatMap(([cx, cy, start]) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const a = start + (Math.PI / 2) * (i / steps);
      return point({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }, m);
    }),
  );
  out.push(out[0]!);
  return out;
}

function expandStraightPath(
  d: string,
  m: Matrix,
  wiringOnly: boolean,
): Point[] {
  if (wiringOnly) {
    const tokens = d.split(/\s+/u);
    const linear =
      tokens.length > 0 &&
      tokens.length % 3 === 0 &&
      tokens.every((v, i) =>
        i % 3 === 0 ? v === (i ? "L" : "M") : Number.isFinite(Number(v)),
      );
    if (!linear) throw Error("Unsupported wiring path in outline test");
  }
  const parts = d.match(
    /[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/gu,
  )!;
  let x = Number(parts[1]),
    y = Number(parts[2]),
    i = 3,
    cmd = "L";
  const out = [point({ x, y }, m)];
  while (i < parts.length) {
    const token = parts[i]!;
    if (/^[A-Za-z]$/u.test(token)) {
      if (token === "Z" || token === "z") {
        out.push(out[0]!);
        break;
      }
      cmd = token;
      i++;
      continue;
    }
    if (cmd === "L") {
      x = Number(parts[i]!);
      y = Number(parts[i + 1]!);
      i += 2;
    } else if (cmd === "H") x = Number(parts[i++]!);
    else y = Number(parts[i++]!);
    out.push(point({ x, y }, m));
  }
  return out;
}

function measureOutlineTexts(rawTexts: RawText[], legacyFont: boolean) {
  return rawTexts.map((t) => {
    if (
      !legacyFont &&
      !t.family.startsWith('"Thermite Sans"') &&
      !t.family.startsWith("Thermite Sans")
    )
      throw Error(`Expected pinned printable font: ${t.family}`);
    const m = printableTextMetrics(t.text, t.size, t.bold),
      advance = t.length ?? m.advance,
      sx = advance / m.advance,
      anchor =
        t.anchor === "middle" ? advance / 2 : t.anchor === "end" ? advance : 0;
    if (t.length !== undefined && t.lengthAdjust !== "spacingAndGlyphs")
      throw Error("Unsupported textLength adjustment");
    if (!["auto", "alphabetic", "middle"].includes(t.baseline))
      throw Error(`Unsupported SVG baseline: ${t.baseline}`);
    const y = t.y + (t.baseline === "middle" ? m.middleBaseline : 0),
      box = transformBox(
        {
          left: t.x - anchor + m.left * sx,
          right: t.x - anchor + m.right * sx,
          top: y - m.top,
          bottom: y - m.bottom,
        },
        t.matrix,
      );
    const clips = t.clips.map(([cx, cy, cw, ch, cm]) => [
      point({ x: cx, y: cy }, cm),
      point({ x: cx + cw, y: cy + ch }, cm),
    ]);
    const painted = clips.every((points) => {
      const b = bounds(points);
      return (
        Math.min(box.right, b.right) > Math.max(box.left, b.left) &&
        Math.min(box.bottom, b.bottom) > Math.max(box.top, b.top)
      );
    });
    const plate = t.plate
      ? bounds(
          [
            { x: t.plate[0], y: t.plate[1] },
            { x: t.plate[0] + t.plate[2], y: t.plate[1] },
            { x: t.plate[0] + t.plate[2], y: t.plate[1] + t.plate[3] },
            { x: t.plate[0], y: t.plate[1] + t.plate[3] },
          ].map((p) => point(p, t.plate![4])),
        )
      : undefined;
    return { ...t, clips, box, painted, plate };
  });
}

/** Chromium supplies only affine transforms and primitive paths. Never ask it
 * for glyph bounds, advances, character positions or canvas text measurements.
 * Preserve explicit M/L wiring vertices. Coordinates are in the sheet viewBox (mm). */
export async function svgOutlineGeometry(
  page: Page,
  svg: string | undefined,
  wiringOnly = false,
  legacyFont = false,
) {
  if (svg !== undefined) await page.setContent(svg);
  const { texts: rawTexts, marks } = await page.evaluate(
    collectSvgTexts,
    wiringOnly,
  );
  // Return compact JSON over CDP so large sheets stay below Chrome 158's
  // Runtime.callFunctionOn returnByValue object-size limit (#582).
  const rawShapes: RawShape[] = JSON.parse(
    await page.evaluate(collectSvgShapes, wiringOnly),
  );
  const shapes = rawShapes.map(({ m, rect, path, localPoints, ...base }) => ({
    ...base,
    points: rect
      ? expandRectPoints(rect, m)
      : path
        ? expandStraightPath(path, m, wiringOnly)
        : localPoints!.map(([x, y]) => point({ x, y }, m)),
  }));
  return {
    texts: measureOutlineTexts(rawTexts, legacyFont),
    shapes,
    marks,
  };
}

async function wiringLeaderEndpoints(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector("svg");
    const inverse = root?.getScreenCTM()?.inverse();
    if (!inverse) throw Error("Missing outline test viewport");
    return [
      ...document.querySelectorAll<SVGPathElement>(
        "path.wire-label-leader[data-label-leader-owner]",
      ),
    ].flatMap((path) => {
      const style = getComputedStyle(path);
      const matrix = path.getScreenCTM();
      if (
        !matrix ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.stroke === "none" ||
        Number(style.opacity) <= 0 ||
        Number(style.strokeOpacity) <= 0
      )
        return [];
      const transform = inverse.multiply(matrix);
      const position = (n: number) => {
        const p = path.getPointAtLength(n).matrixTransform(transform);
        return { x: p.x, y: p.y };
      };
      return [
        {
          wire: path.getAttribute("data-label-leader-owner"),
          start: position(0),
          tip: position(path.getTotalLength()),
        },
      ];
    });
  });
}

export async function wiringOutlineDistances(
  page: Page,
  svg: string,
  legacyFont = false,
) {
  const g = await svgOutlineGeometry(page, svg, true, legacyFont);
  const leaders = await wiringLeaderEndpoints(page);
  return g.texts
    .filter((t) => t.painted)
    .map((t) => {
      const own = g.shapes.filter((s) => s.wire === t.wire);
      if (!own.length) throw Error(`No owning route for ${t.text}`);
      const inline =
        t.plate &&
        inside(t.box, t.plate) &&
        own.some((s) => routeDistance(t.plate!, s.points) === 0);
      const plate = t.plate;
      const leader =
        !!plate &&
        inside(t.box, plate) &&
        leaders.some((l) => {
          const gap = distance(bounds([l.start]), plate),
            tip = bounds([l.tip]),
            onStroke = own.some((s) => routeDistance(tip, s.points) <= 0.01);
          return l.wire === t.wire && gap <= 0.76 && onStroke;
        });
      return {
        text: t.text,
        leader,
        distance: inline
          ? 0
          : Math.min(
              ...own.map((s) =>
                Math.max(0, routeDistance(t.box, s.points) - s.stroke / 2),
              ),
            ),
      };
    });
}
