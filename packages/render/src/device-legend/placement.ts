import { printableTextMetrics } from "../symbols/printable-font.js";
import type { DeviceTagPlan } from "../device-tags.js";
import type { Rect } from "./geometry.js";
import { inside, separated } from "./geometry.js";
export const LEGEND_TITLE = "Devices on this sheet";
const heading = printableTextMetrics(LEGEND_TITLE, 2.7, true, true);
const titleWidth =
  Math.max(heading.advance, heading.right) - Math.min(0, heading.left) + 6;
export interface LegendLayout {
  box: Rect;
  entries: { tag: DeviceTagPlan; x: number; y: number }[];
}
export function legendColumns(
  tags: readonly DeviceTagPlan[],
  columns: number,
  split = Math.ceil(tags.length / columns),
): LegendLayout {
  const entries: LegendLayout["entries"] = [],
    groups = columns === 1 ? [tags] : [tags.slice(0, split), tags.slice(split)];
  // The shared 50 mm plan owns wrapping. Remove only unused outer whitespace;
  // every emitted glyph retains its measured position, em and 3 mm side padding.
  let height = 0,
    x = 0;
  for (const group of groups) {
    let y = 6;
    const width = Math.max(
      titleWidth,
      ...group.map((tag) => tag.ink.x + tag.ink.w + 3),
    );
    for (const tag of group) {
      entries.push({ tag, x, y });
      y += tag.heightMm + 1;
    }
    height = Math.max(height, y - 1);
    x += width + 2;
  }
  return { box: { x: 0, y: 0, w: x - 2, h: height }, entries };
}
export function legendLayouts(tags: readonly DeviceTagPlan[]) {
  return [
    legendColumns(tags, 1),
    ...Array.from({ length: Math.max(0, tags.length - 1) }, (_, i) =>
      legendColumns(tags, 2, i + 1),
    ).sort((a, b) => a.box.h - b.box.h),
  ];
}
export function placeLegend(
  tags: readonly DeviceTagPlan[],
  area: Rect,
  ink: readonly Rect[],
  regions: readonly Rect[],
): LegendLayout | undefined {
  const layouts = legendLayouts(tags);
  const valid = (box: Rect) =>
    inside(box, area) &&
    ink.every((b) => separated(box, b, 3.13)) &&
    regions.every((r) => separated(box, r, 3.13));
  for (const anchor of ["top", "bottom"])
    for (const layout of layouts) {
      const { w, h } = layout.box,
        box = {
          x: area.x + area.w - w,
          y: anchor === "top" ? area.y : area.y + area.h - h,
          w,
          h,
        };
      if (valid(box)) return { ...layout, box };
    }
  for (const layout of layouts) {
    const { w, h } = layout.box;
    if (w > area.w || h > area.h) continue;
    const xs = [
        area.x,
        area.x + area.w - w,
        ...ink.flatMap((b) => [b.x + b.w + 3.13, b.x - w - 3.13]),
      ],
      ys = [
        area.y,
        area.y + area.h - h,
        ...ink.flatMap((b) => [b.y + b.h + 3.13, b.y - h - 3.13]),
      ];
    for (const y of [...new Set(ys)].sort((a, b) => a - b))
      for (const x of [...new Set(xs)].sort((a, b) => b - a)) {
        const box = { x, y, w, h };
        if (valid(box)) return { ...layout, box };
      }
  }
}
