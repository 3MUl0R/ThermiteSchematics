import { inside, separated, type Rect } from "../device-legend/geometry.js";
import {
  anchorDistance,
  boxDistance,
  localNavigationSlot,
  type SymbolGeometry,
} from "./navigation-symbols.js";
import type { NavigationShape } from "./navigation-types.js";
import {
  navigationPlacementFamily,
  type NavigationPlacementFamily,
} from "./navigation-placement.js";
export const NAVIGATION_CLEARANCE_MM = 1.5;
export const NAVIGATION_TEXT_CLEARANCE_MM = 4;
function slotCandidates(
  size: Rect,
  area: Rect,
  owner: Rect,
  obstacles: readonly Rect[],
  locality?: SymbolGeometry,
  texts: readonly Rect[] = [],
) {
  const { w, h } = size;
  const xs = [
    ...new Set([
      area.x,
      area.x + area.w - w,
      owner.x,
      owner.x + owner.w - w,
      ...texts.flatMap((b) => [
        b.x + b.w + NAVIGATION_TEXT_CLEARANCE_MM + 0.01,
        b.x - w - NAVIGATION_TEXT_CLEARANCE_MM - 0.01,
      ]),
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
  texts: readonly Rect[] = [],
  preferBesideBelow = false,
  families?: readonly NavigationPlacementFamily[],
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
      texts,
    );
    if (preferBesideBelow && shape.mode === "local")
      candidates.sort(
        (a, b) =>
          Number(!besideBelow(a, owner)) - Number(!besideBelow(b, owner)),
      );
    const box = candidates.find(
      (b) =>
        (!families ||
          families.includes(
            navigationPlacementFamily(b, area, owner, locality),
          )) &&
        inside(b, area) &&
        obstacles.every((o) => separated(b, o, NAVIGATION_CLEARANCE_MM)) &&
        texts.every((t) => textSeparated(b, t)) &&
        (shape.mode !== "local" ||
          !locality ||
          localNavigationSlot(b, locality)),
    );
    if (box) return { box, shape };
  }
  return undefined;
}

/** Protect the fixed text envelope horizontally where line bands overlap. */
function textSeparated(label: Rect, other: Rect) {
  return (
    label.y + label.h <= other.y ||
    other.y + other.h <= label.y ||
    label.x + label.w + NAVIGATION_TEXT_CLEARANCE_MM <= other.x ||
    other.x + other.w + NAVIGATION_TEXT_CLEARANCE_MM <= label.x
  );
}

function besideBelow(box: Rect, owner: Rect) {
  return (
    box.y >= owner.y + owner.h ||
    box.x >= owner.x + owner.w ||
    box.x + box.w <= owner.x
  );
}
