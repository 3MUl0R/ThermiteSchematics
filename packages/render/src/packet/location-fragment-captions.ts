import { escapeXmlAttribute as attr } from "../svg/escape.js";
import { required } from "../presentation/util.js";
import type { PreparedSchematicDrawing } from "../renderer.js";
import type { LocationGroup } from "../types.js";
import type { DrawingBounds, LocationFragmentFallback } from "./types.js";
import { inkOverlaps, textInk } from "./rooted-caption.js";
import { intersectInk, type InkBox } from "./rooted-ink.js";
import { text } from "./svg.js";

function fragmentOccupied(
  p: PreparedSchematicDrawing,
  box: { x: number; y: number; width: number; height: number },
  viewport: InkBox,
) {
  return p.graph.nodes.some((node) => {
    if (!("deviceUid" in node)) return false;
    const nb = p.layout.nodes.find((n) => n.id === node.id);
    if (!nb) return false;
    const inGroup =
      nb.x >= box.x - 1 &&
      nb.x + nb.width <= box.x + box.width + 1 &&
      nb.y >= box.y - 1 &&
      nb.y + nb.height <= box.y + box.height + 1;
    const inView =
      nb.x < viewport.x + viewport.w &&
      nb.x + nb.width > viewport.x &&
      nb.y < viewport.y + viewport.h &&
      nb.y + nb.height > viewport.y;
    return inGroup && inView;
  });
}

function viewportDetailObstacles(
  p: PreparedSchematicDrawing,
  viewport: InkBox,
  b: DrawingBounds,
  scale: number,
): InkBox[] {
  const raw: InkBox[] = [];
  for (const n of p.layout.nodes) {
    if (n.kind === "location") continue;
    raw.push({ x: n.x, y: n.y, w: n.width, h: n.height });
  }
  for (const l of p.layout.labels) {
    if (l.ownerKind === "location") continue;
    raw.push({ x: l.x, y: l.y, w: l.width, h: l.height });
  }
  for (const e of p.layout.edges) {
    for (let i = 1; i < e.points.length; i++) {
      const a = required(e.points[i - 1], "Missing route point"),
        z = required(e.points[i], "Missing route point");
      const minX = Math.min(a.x, z.x),
        minY = Math.min(a.y, z.y);
      raw.push({
        x: minX - 1,
        y: minY - 1,
        w: Math.abs(z.x - a.x) + 2,
        h: Math.abs(z.y - a.y) + 2,
      });
    }
  }
  return raw.flatMap((box) => {
    const clipped = intersectInk(box, viewport);
    return clipped
      ? [
          {
            x: b.x + (clipped.x - viewport.x) * scale,
            y: b.y + (clipped.y - viewport.y) * scale,
            w: clipped.w * scale,
            h: clipped.h * scale,
          },
        ]
      : [];
  });
}

function clearOf(box: InkBox, obstacles: readonly InkBox[], pad: number) {
  const padded = {
    x: box.x - pad,
    y: box.y - pad,
    w: box.w + 2 * pad,
    h: box.h + 2 * pad,
  };
  return !obstacles.some((o) => inkOverlaps(padded, o));
}

function placeFragmentLines(
  lines: readonly string[],
  frag: InkBox,
  obstacles: readonly InkBox[],
) {
  const samples = lines.map((line) => textInk(line, 0, 0, 2.5, true));
  const w = Math.max(...samples.map((s) => s.w));
  const pitch = 3.2;
  const ascent = -required(samples[0], "Missing caption sample").y;
  const h =
    (lines.length - 1) * pitch +
    required(samples.at(-1), "Missing caption sample").h;
  const inset = 1.5;
  const minX = frag.x + inset,
    maxX = frag.x + frag.w - inset - w;
  const minY = frag.y + inset,
    maxY = frag.y + frag.h - inset - h;
  if (maxX < minX || maxY < minY) return undefined;
  const local = obstacles.filter((o) => inkOverlaps(frag, o));
  for (const pad of [1.2, 0.7, 0.35]) {
    const xs = [
      ...new Set([
        minX,
        maxX,
        ...local.flatMap((o) => [o.x + o.w + pad + 0.05, o.x - w - pad - 0.05]),
      ]),
    ]
      .filter((x) => x >= minX - 1e-6 && x <= maxX + 1e-6)
      .sort((a, b) => a - b);
    const ys = [
      ...new Set([
        minY,
        maxY,
        ...local.flatMap((o) => [o.y + o.h + pad + 0.05, o.y - h - pad - 0.05]),
      ]),
    ]
      .filter((y) => y >= minY - 1e-6 && y <= maxY + 1e-6)
      .sort((a, b) => a - b);
    for (const y of ys)
      for (const x of xs) {
        const baseline = y + ascent;
        const boxes = lines.map((line, i) =>
          textInk(line, x, baseline + i * pitch, 2.5, true),
        );
        if (boxes.every((b) => clearOf(b, local, pad)))
          return { x, baseline, pitch, boxes };
      }
  }
  return undefined;
}

function captionCandidates(
  labelText: string,
): { lines: string[]; fallback?: LocationFragmentFallback["kind"] }[] {
  const words = labelText.split(/\s+/u).filter(Boolean);
  return [
    { lines: [`${labelText} (CONT.)`] },
    { lines: [labelText], fallback: "plain-name" },
    ...(words.length > 1
      ? [
          {
            lines: [...words, "(CONT.)"],
            fallback: "wrapped-continued" as const,
          },
          { lines: words, fallback: "wrapped-plain-name" as const },
        ]
      : []),
  ];
}

function emitFragmentLines(
  group: LocationGroup,
  placed: {
    lines: string[];
    x: number;
    baseline: number;
    pitch: number;
    fallback?: LocationFragmentFallback["kind"];
  },
) {
  const fallbackAttr = placed.fallback
    ? ` data-location-fragment-fallback="${attr(placed.fallback)}"`
    : "";
  return placed.lines.map((line, i) =>
    text(placed.x, placed.baseline + i * placed.pitch, line, 2.5, "start", 700)
      .replace('fill="#18212b"', 'fill="#475569"')
      .replace(
        "<text ",
        `<text class="location-fragment-caption" data-location-fragment-caption="${attr(group.id)}" data-location-name="${attr(group.label.text)}"${fallbackAttr} `,
      ),
  );
}

/** Emit a compact local caption inside each visible occupied clipped location
 * fragment whose native ELK location heading was clipped outside the viewport.
 * Every fallback wording is recorded and marked; if no slot fits, return a
 * visible failure instead of silently skipping the fragment. */
export function locationFragmentCaptions(
  p: PreparedSchematicDrawing,
  continued: readonly LocationGroup[],
  viewport: InkBox,
  b: DrawingBounds,
  scale: number,
  _existingShapes: readonly InkBox[],
) {
  const svg: string[] = [];
  const inks: InkBox[] = [];
  const fallbacks: LocationFragmentFallback[] = [];
  let failure: string | undefined;
  if (!continued.length) return { svg: "", inks, fallbacks, failure };
  const obstacles = viewportDetailObstacles(p, viewport, b, scale);
  for (const group of continued) {
    const box = required(
      p.layout.nodes.find((n) => n.id === group.id),
      "Missing rooted geometry",
    );
    if (!fragmentOccupied(p, box, viewport)) continue;
    const x1 = Math.max(box.x, viewport.x),
      y1 = Math.max(box.y, viewport.y);
    const x2 = Math.min(box.x + box.width, viewport.x + viewport.w),
      y2 = Math.min(box.y + box.height, viewport.y + viewport.h);
    const frag: InkBox = {
      x: b.x + (x1 - viewport.x) * scale,
      y: b.y + (y1 - viewport.y) * scale,
      w: (x2 - x1) * scale,
      h: (y2 - y1) * scale,
    };
    const placed = captionCandidates(group.label.text)
      .map((candidate) => {
        const slot = placeFragmentLines(candidate.lines, frag, obstacles);
        return slot ? { ...candidate, ...slot } : undefined;
      })
      .find(Boolean);
    if (!placed) {
      failure ??= `Continued location fragment ${group.label.text} has no clear interior slot for its local caption. Use larger paper, another flow, or split the view.`;
      continue;
    }
    if (placed.fallback)
      fallbacks.push({
        locationId: group.id,
        locationName: group.label.text,
        kind: placed.fallback,
        lines: placed.lines,
      });
    obstacles.push(...placed.boxes);
    inks.push(...placed.boxes);
    svg.push(...emitFragmentLines(group, placed));
  }
  return { svg: svg.join(""), inks, fallbacks, failure };
}
