import { bounds } from "./page.js";
import type { PaperPage } from "./types.js";
import type { PreparedSchematicDrawing } from "../renderer.js";
import type { DrawingBounds } from "./types.js";
import { protectedDrawingIntervals } from "./rooted-geometry.js";
import { mergedIntervals } from "./safe-cuts.js";
import { OUTER_SVG_PADDING } from "../symbols/catalog.js";

/** Measured reservation shortfall, not a claim about the omitted wire's route. */
export function rootedConstraint(
  p: PreparedSchematicDrawing,
  b: DrawingBounds,
  scale: number,
) {
  const { protectedX, protectedY } = protectedDrawingIntervals(
    p.layout,
    OUTER_SVG_PADDING,
  );
  const constraints = [
    { name: "width", items: protectedX, capacity: b.w },
    { name: "height", items: protectedY, capacity: b.h },
  ].flatMap(({ name, items, capacity }) => {
    const span = Math.max(
      0,
      ...mergedIntervals(items).map((i) => (i.end - i.start) * scale),
    );
    return span > capacity + 0.001
      ? [
          `protected ${name} ${span.toFixed(2)} mm exceeds ${capacity.toFixed(2)} mm by ${(span - capacity).toFixed(2)} mm`,
        ]
      : [];
  });
  return (
    "No safe sheet grid fits: " +
    (constraints.length
      ? constraints.join("; ")
      : "no complete grid satisfies protected bounds, 3/18 mm continuation spacing and the 40-cut/80-sheet limits") +
    ". Use a larger sheet or landscape."
  );
}

/** A card itself cannot become smaller by choosing a different nearby position. */
export function invariantCardConstraint(
  p: PreparedSchematicDrawing,
  page: PaperPage,
) {
  const b = bounds(p.titleContext, page, p.view),
    height = b.h - 4;
  if (height < 50)
    return "Title information leaves insufficient drawing height. Use a larger sheet or shorter title lines.";
  const width = page.widthMm - 2 * page.marginMm - 10;
  for (const n of p.graph.nodes)
    if (n.kind !== "junction")
      for (const l of n.labels)
        if (l.offView) {
          const dw = l.width * 0.25 - width,
            dh = l.height * 0.25 - height;
          if (dw > 0.001 || dh > 0.001)
            return `Card at ${l.offView.terminalName} exceeds printable ${dw > dh ? "width" : "height"} by ${Math.max(dw, dh).toFixed(2)} mm at 3 mm em. Use a larger sheet or landscape.`;
        }
}
