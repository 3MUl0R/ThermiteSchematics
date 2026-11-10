import type { PreparedSchematicDrawing } from "../renderer.js";
import { drawingContinuations } from "./continuations.js";
import { protectedDrawingIntervals } from "./rooted-geometry.js";
import { cuts } from "./rooted-cuts.js";
import { safeAxisPlans, MAX_GRID_SHEETS, MAX_GRID_PLANS } from "./safe-cuts.js";
import { OUTER_SVG_PADDING } from "../symbols/catalog.js";
import type { Draft, DrawingBounds } from "./types.js";

export interface RootedGrid {
  greedy?: boolean;
  xs: number[];
  ys: number[];
}
export function gridLinks(
  p: PreparedSchematicDrawing,
  grid: RootedGrid,
  b: DrawingBounds,
  scale: number,
  drafts?: Draft[],
) {
  const count = (grid.xs.length - 1) * (grid.ys.length - 1);
  if (count > MAX_GRID_SHEETS) return false;
  return drawingContinuations(
    drafts ??
      Array.from({ length: count }, () => ({ links: [] }) as unknown as Draft),
    p.graph,
    p.layout,
    grid.xs,
    grid.ys,
    b,
    scale,
  ).ok;
}

/** Keep the successful greedy plan. On failure score complete safe grids. */
export function rootedGrids(
  p: PreparedSchematicDrawing,
  b: DrawingBounds,
  scale: number,
  fallback = true,
  explore = false,
): RootedGrid[] {
  const w = p.layout.width + 2 * OUTER_SVG_PADDING,
    h = p.layout.height + 2 * OUTER_SVG_PADDING;
  const { protectedX, protectedY } = protectedDrawingIntervals(
    p.layout,
    OUTER_SVG_PADDING,
  );
  const xs = cuts(w, b.w / scale, [...protectedX]),
    ys = cuts(h, b.h / scale, [...protectedY]);
  const fast =
    xs && ys && gridLinks(p, { xs, ys }, b, scale)
      ? [{ xs, ys, greedy: true }]
      : [];
  if (fast.length && !explore) return fast;
  if (!fallback) return [];
  const xp = safeAxisPlans(w, b.w / scale, protectedX, (x) =>
    gridLinks(p, { xs: [0, x, w], ys: [0, h] }, b, scale),
  );
  const grids: RootedGrid[] = [...fast];
  for (const x of xp) {
    const yp = safeAxisPlans(h, b.h / scale, protectedY, (y) =>
      gridLinks(p, { xs: x, ys: [0, y, h] }, b, scale),
    );
    for (const y of yp) {
      const grid = { xs: x, ys: y };
      if (
        gridLinks(p, grid, b, scale) &&
        !grids.some(
          (g) =>
            JSON.stringify([g.xs, g.ys]) === JSON.stringify([grid.xs, grid.ys]),
        )
      )
        grids.push(grid);
      if (grids.length >= MAX_GRID_PLANS) return grids;
    }
  }
  return grids;
}
