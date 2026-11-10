import { OUTER_SVG_PADDING } from "../symbols/catalog.js";
import type { PreparedSchematicDrawing } from "../renderer.js";
import type { InkBox } from "./rooted-ink.js";
import { printableLabelGeometry } from "../symbols/printable-label.js";
import { required } from "../presentation/util.js";

const MARGIN = 4; // >=1 mm at the unchanged minimum 0.25 mm/unit.
const ROUNDING = 0.002; // Same conservative near-touching rule as #163.
const cache = new WeakMap<PreparedSchematicDrawing, InkBox[]>();
function drawingBoxes(p: PreparedSchematicDrawing) {
  const old = cache.get(p);
  if (old) return old;
  const boxes: InkBox[] = [
    ...p.layout.nodes.filter((n) => n.kind !== "location"),
    ...p.layout.labels.filter((l) => l.role !== "location"),
  ].map((b) => ({
    x: b.x - 0.75,
    y: b.y - 0.75,
    w: b.width + 1.5,
    h: b.height + 1.5,
  }));
  // Terminal-marker circles and local reference leaders are independent ink.
  for (const port of p.layout.ports)
    boxes.push({
      x: port.x + port.width / 2 - 2.75,
      y: port.y + port.height / 2 - 2.75,
      w: 5.5,
      h: 5.5,
    });
  for (const ref of p.layout.contextReferences ?? [])
    for (const leader of ref.leaders)
      for (const point of leader)
        boxes.push({ x: point.x - 0.75, y: point.y - 0.75, w: 1.5, h: 1.5 });
  cache.set(p, boxes);
  return boxes;
}
/** Pinned heading ink plus its reserved region: retain any partly painted
 * heading whole, including chains exposed by a preceding expansion. */
export function expandHeadings(
  initial: InkBox,
  headings: readonly InkBox[],
  fullH: number,
  minimum = 0,
) {
  let top = initial.y,
    bottom = initial.y + initial.h;
  for (let pass = 0; pass <= headings.length; pass++) {
    const oldTop = top,
      oldBottom = bottom;
    for (const h of headings)
      if (
        h.x <= initial.x + initial.w + ROUNDING &&
        h.x + h.w >= initial.x - ROUNDING &&
        h.y <= bottom + ROUNDING &&
        h.y + h.h >= top - ROUNDING
      ) {
        top = Math.max(minimum, Math.min(top, h.y - MARGIN));
        bottom = Math.min(fullH, Math.max(bottom, h.y + h.h + MARGIN));
      }
    if (top === oldTop && bottom === oldBottom) break;
  }
  return { ...initial, y: top, h: bottom - top };
}
export function stripEnvelope(
  p: PreparedSchematicDrawing,
  x0: number,
  x1: number,
  fullH: number,
) {
  const spans = drawingBoxes(p).filter((b) => b.x < x1 && b.x + b.w > x0);
  for (const edge of p.layout.edges)
    for (let i = 1; i < edge.points.length; i++) {
      const a = required(edge.points[i - 1], "Missing route point"),
        z = required(edge.points[i], "Missing route point");
      if (Math.max(a.x, z.x) >= x0 && Math.min(a.x, z.x) <= x1)
        spans.push({
          x: x0,
          y: Math.min(a.y, z.y) - 0.75,
          w: x1 - x0,
          h: Math.abs(a.y - z.y) + 1.5,
        });
    }
  if (!spans.length) return undefined;
  const top = Math.max(
    -OUTER_SVG_PADDING,
    Math.min(...spans.map((s) => s.y)) - MARGIN,
  );
  const bottom = Math.min(
    fullH,
    Math.max(...spans.map((s) => s.y + s.h)) + MARGIN,
  );
  const headings = p.graph.locationGroups.map((g) => {
    const l = required(
      p.layout.labels.find((l) => l.id === g.label.id),
      "Missing location heading",
    );
    const ink = printableLabelGeometry(
      l,
      g.label.printableText ?? g.label.text,
      g.label.textLength,
    ).ink;
    const x = Math.min(l.x, ink.left),
      y = Math.min(l.y, ink.top);
    return {
      x,
      y,
      w: Math.max(l.x + l.width, ink.right) - x,
      h: Math.max(l.y + l.height, ink.bottom) - y,
    };
  });
  return expandHeadings(
    { x: x0, y: top, w: x1 - x0, h: bottom - top },
    headings,
    fullH,
    -OUTER_SVG_PADDING,
  );
}
