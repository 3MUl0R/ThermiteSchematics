import { inside, separated, type Rect } from "../device-legend/geometry.js";
import {
  anchorDistance,
  boxDistance,
  localNavigationSlot,
  type SymbolGeometry,
} from "./navigation-symbols.js";
import type { NavigationShape } from "./navigation-types.js";
export const NAVIGATION_CLEARANCE_MM = 1.5;
function slotCandidates(
  size: Rect,
  area: Rect,
  owner: Rect,
  obstacles: readonly Rect[],
  locality?: SymbolGeometry,
) {
  const { w, h } = size;
  const xs = [
    ...new Set([
      area.x,
      area.x + area.w - w,
      owner.x,
      owner.x + owner.w - w,
      ...obstacles.flatMap((b) => [b.x + b.w + 1.51, b.x - w - 1.51]),
    ]),
  ].filter((x) => x >= area.x && x + w <= area.x + area.w);
  const ys = [
    ...new Set([
      area.y,
      area.y + area.h - h,
      owner.y - h - 1.51,
      owner.y + owner.h + 1.51,
      ...obstacles.flatMap((b) => [b.y + b.h + 1.51, b.y - h - 1.51]),
    ]),
  ].filter((y) => y >= area.y && y + h <= area.y + area.h);
  const distance = (b: Rect) =>
    locality ? anchorDistance(locality.anchorMm, b) : boxDistance(owner, b);
  return ys
    .flatMap((y) => xs.map((x) => ({ x, y, w, h })))
    .sort((a, b) => distance(a) - distance(b) || a.y - b.y || a.x - b.x);
}
/** All local shapes precede all self-located shapes; preserve authored shape order within each mode. */
export function searchNavigationSlot(
  shapes: readonly NavigationShape[],
  area: Rect,
  owner: Rect,
  obstacles: readonly Rect[],
  locality?: SymbolGeometry,
) {
  const ordered = ["local", "self-located"].flatMap((mode) =>
    shapes.filter((s) => s.mode === mode),
  );
  for (const shape of ordered) {
    const candidates = slotCandidates(
      shape.inkMm,
      area,
      owner,
      obstacles,
      locality,
    );
    const box = candidates.find(
      (b) =>
        inside(b, area) &&
        obstacles.every((o) => separated(b, o, NAVIGATION_CLEARANCE_MM)) &&
        (shape.mode !== "local" ||
          !locality ||
          localNavigationSlot(b, locality)),
    );
    if (box) return { box, shape };
  }
  return undefined;
}
