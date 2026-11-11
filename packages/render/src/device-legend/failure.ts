import type { DeviceTagPlan } from "../device-tags.js";
import { required } from "../presentation/util.js";
import { expand, intersection, type Rect } from "./geometry.js";
import { legendLayouts, type LegendLayout } from "./placement.js";

const area = (b: Rect) => b.w * b.h;
/** Four deterministic empty-region trials. Each subtraction keeps a real
 * rectangle; these are measured capacities, never the obstructed drawing area. */
export function legendFreeRegions(
  bounds: Rect,
  obstacles: readonly Rect[],
): Rect[] {
  return ["top", "bottom", "left", "right"]
    .map((direction) => {
      let free = { ...bounds };
      const axis = direction === "top" || direction === "bottom" ? "y" : "x",
        sign = direction === "bottom" || direction === "right" ? -1 : 1;
      for (const obstacle of [...obstacles].sort(
        (a, b) => sign * (a[axis] - b[axis]),
      )) {
        const cut = intersection(free, expand(obstacle, 3.13));
        if (!cut) continue;
        const options = [
          { ...free, w: cut.x - free.x },
          { ...free, x: cut.x + cut.w, w: free.x + free.w - cut.x - cut.w },
          { ...free, h: cut.y - free.y },
          { ...free, y: cut.y + cut.h, h: free.y + free.h - cut.y - cut.h },
        ].filter((b) => b.w > 0 && b.h > 0);
        free = options.sort((a, b) => area(b) - area(a))[0] ?? {
          ...free,
          w: 0,
          h: 0,
        };
      }
      return free;
    })
    .sort((a, b) => area(b) - area(a));
}
const ratio = (required: number, available: number) =>
  available > 0 ? required / available : Infinity;
export function legendFitDiagnostic(
  tags: readonly DeviceTagPlan[],
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
