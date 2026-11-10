import type { Page } from "playwright-core";
import {
  svgOutlineGeometry,
  primitiveDistance,
  distance,
  bounds,
  type Box,
  type Point,
} from "../../../cli/test/helpers/svg-outline-geometry.js";

function clipped(a: Point, b: Point, clip: Box): Point[] {
  let lo = 0,
    hi = 1;
  for (const [origin, delta, min, max] of [
    [a.x, b.x - a.x, clip.left, clip.right],
    [a.y, b.y - a.y, clip.top, clip.bottom],
  ]) {
    const o = Number(origin),
      d = Number(delta),
      low = Number(min),
      high = Number(max);
    if (d === 0) {
      if (o < low || o > high) return [];
    } else {
      const t = (low - o) / d,
        u = (high - o) / d;
      lo = Math.max(lo, Math.min(t, u));
      hi = Math.min(hi, Math.max(t, u));
    }
  }
  return lo > hi
    ? []
    : [
        { x: a.x + (b.x - a.x) * lo, y: a.y + (b.y - a.y) * lo },
        { x: a.x + (b.x - a.x) * hi, y: a.y + (b.y - a.y) * hi },
      ];
}

function strokeMetadata() {
  const root = document.querySelector("svg") as SVGSVGElement,
    inverse = root.getScreenCTM()?.inverse();
  return [
    ...document.querySelectorAll<SVGGeometryElement>(
      "line,path,polyline,rect,circle",
    ),
  ]
    .filter(
      (e) =>
        !e.closest("defs") &&
        getComputedStyle(e).display !== "none" &&
        getComputedStyle(e).visibility !== "hidden",
    )
    .map((e) => {
      const css = getComputedStyle(e),
        clip = {
          left: 0,
          top: 0,
          right: root.viewBox.baseVal.width,
          bottom: root.viewBox.baseVal.height,
        };
      for (let p = e.parentElement; p && p !== root; p = p.parentElement)
        if (
          p.tagName.toLowerCase() === "svg" &&
          getComputedStyle(p).overflow !== "visible"
        ) {
          const s = p as unknown as SVGSVGElement,
            v = s.viewBox.baseVal,
            m = inverse?.multiply(s.getScreenCTM() as DOMMatrix);
          const a = new DOMPoint(v.x, v.y).matrixTransform(m),
            b = new DOMPoint(v.x + v.width, v.y + v.height).matrixTransform(m);
          clip.left = Math.max(clip.left, a.x);
          clip.right = Math.min(clip.right, b.x);
          clip.top = Math.max(clip.top, a.y);
          clip.bottom = Math.min(clip.bottom, b.y);
        }
      return {
        clip,
        card: !!e.closest("[data-off-view-terminal]"),
        ink: !["none", "white", "rgb(255, 255, 255)"].includes(css.stroke),
        attachment: e
          .closest("[data-terminal-attachment]")
          ?.getAttribute("data-terminal-attachment"),
        symbol: e.closest("[data-symbol-id]")?.getAttribute("data-symbol-id"),
        functionKey: e
          .closest("[data-function-key]")
          ?.getAttribute("data-function-key"),
        stub: !!e.closest("[data-function-interface],[data-source-stub]"),
        conductor:
          !!e.closest("[data-circuit-conductor]") ||
          e.classList.contains("net-path") ||
          e.classList.contains("boundary-path"),
      };
    });
}
function textOwners() {
  return [...document.querySelectorAll("text")]
    .filter(
      (e) =>
        !e.closest("defs") &&
        getComputedStyle(e).display !== "none" &&
        getComputedStyle(e).visibility !== "hidden" &&
        e.textContent?.trim(),
    )
    .map((e) => {
      const hex = e.getAttribute("clip-path")?.match(/clip-([a-f0-9]+)/u)?.[1];
      if (!hex) return null;
      const tuple = JSON.parse(
        hex
          .match(/.{4}/gu)
          ?.map((s) => String.fromCharCode(parseInt(s, 16)))
          .join("") ?? "[]",
      );
      const owner = tuple[1] === "symbol" ? JSON.parse(tuple[2]) : null;
      return owner ? { device: owner[1], functionKey: owner[2] } : null;
    });
}

/** Pinned glyph outlines and every painted stroke, including terminal
 * attachments. Reads no placement slots or production obstacle lists. */
export async function captionOracle(page: Page, svg: string) {
  const g = await svgOutlineGeometry(page, svg),
    metadata = await page.evaluate(strokeMetadata),
    owners = await page.evaluate(textOwners);
  const shapes = g.shapes.flatMap((s, i) => {
    const meta = metadata[i];
    if (!meta?.ink) return [];
    return s.points.slice(1).flatMap((p, j) => {
      const a = s.points[j];
      if (!a) return [];
      const points = clipped(a, p, meta.clip);
      return points.length ? [{ ...s, ...meta, points }] : [];
    });
  });
  const texts = g.texts.filter((t) => t.painted);
  return texts.map((t) => {
    const owner = owners[g.texts.indexOf(t)];
    const device = t.device ?? owner?.device;
    const own = shapes.filter(
        (s) => s.device === device && (s.attachment || s.stub),
      ),
      wiring = shapes.filter((s) => s.attachment || s.stub || s.conductor),
      mark = shapes.filter(
        (s) =>
          s.device === device &&
          s.symbol &&
          (!owner?.functionKey || s.functionKey === owner.functionKey),
      );
    const nearest = (ss: typeof shapes) =>
      Math.min(
        ...ss.map((s) =>
          Math.max(0, primitiveDistance(t.box, s.points) - s.stroke / 2),
        ),
      );
    return {
      ...t,
      device,
      attachmentGap: nearest(own),
      ownerStrokeGap: nearest(shapes.filter((s) => s.device === device)),
      wiringGap: nearest(wiring),
      markGap: nearest(mark),
      cardGap: nearest(shapes.filter((s) => s.card)),
      textGap: Math.min(
        ...texts.filter((o) => o !== t).map((o) => distance(t.box, o.box)),
      ),
      markDistance: mark.length
        ? distance(t.box, bounds(mark.flatMap((s) => s.points)))
        : null,
    };
  });
}
