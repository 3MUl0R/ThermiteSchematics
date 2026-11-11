import type { LegendTag } from "./reference.js";
import { required } from "../presentation/util.js";
import { expand, intersection, inside, type Rect } from "./geometry.js";
import { legendLayouts, type LegendLayout } from "./placement.js";

const area = (b: Rect) => b.w * b.h;
/** Maximal empty rectangles after 3 mm ink/frame clearance. Keep all four
 * residual rectangles, including overlapping ones; discard only contained
 * capacities. Greedily retaining one residual can miss the largest free pocket. */
export function legendFreeRegions(
  bounds: Rect,
  obstacles: readonly Rect[],
): Rect[] {
  let free = [bounds];
  for (const obstacle of obstacles) {
    const blocked = expand(obstacle, 3.13);
    if (!intersection(bounds, blocked)) continue;
    const next = free.flatMap((region) => {
      const cut = intersection(region, blocked);
      if (!cut || cut.w <= 0 || cut.h <= 0) return [region];
      return [
        { ...region, w: cut.x - region.x },
        { ...region, x: cut.x + cut.w, w: region.x + region.w - cut.x - cut.w },
        { ...region, h: cut.y - region.y },
        { ...region, y: cut.y + cut.h, h: region.y + region.h - cut.y - cut.h },
      ].filter((b) => b.w > 0 && b.h > 0);
    });
    free = next.filter(
      (b, i) =>
        !next.some(
          (other, j) =>
            j !== i && inside(b, other) && (area(b) < area(other) || j < i),
        ),
    );
    if (!free.length) return [{ ...bounds, w: 0, h: 0 }];
  }
  return free.sort((a, b) => area(b) - area(a) || a.y - b.y || b.x - a.x);
}

const ratio = (required: number, available: number) =>
  available > 0 ? required / available : Infinity;
export function legendFitDiagnostic(
  tags: readonly LegendTag[],
  available: Rect,
) {
  const layout = required(
    legendLayouts(tags).sort(
      (a, b) =>
        Math.max(ratio(a.box.w, available.w), ratio(a.box.h, available.h)) -
          Math.max(ratio(b.box.w, available.w), ratio(b.box.h, available.h)) ||
        area(a.box) - area(b.box),
    )[0],
    "Missing legend size",
  );
  const horizontal =
    ratio(layout.box.w, available.w) >= ratio(layout.box.h, available.h);
  return {
    layout,
    available,
    ...constrainingRow(layout, available, horizontal),
  };
}
function constrainingRow(
  layout: LegendLayout,
  available: Rect,
  horizontal: boolean,
) {
  for (const entry of layout.entries)
    for (const row of entry.tag.rows)
      if (
        horizontal
          ? entry.x + row.ink.x + row.ink.w + 3 > available.w
          : entry.y + row.ink.y + row.ink.h + 1 > available.h
      )
        return { tag: entry.tag, field: row.field as string };
  // The frame/title or inter-entry padding can be the limiting reservation.
  return {
    tag: required(layout.entries[0], "Missing legend entry").tag,
    field: horizontal ? "legend heading" : "entry",
  };
}
