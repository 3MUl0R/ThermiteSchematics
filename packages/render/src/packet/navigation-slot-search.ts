import {
  clearNavigationXs,
  NAVIGATION_CLEARANCE_MM,
  NAVIGATION_TEXT_CLEARANCE_MM,
} from "./navigation-clearance.js";
export {
  NAVIGATION_CLEARANCE_MM,
  NAVIGATION_TEXT_CLEARANCE_MM,
} from "./navigation-clearance.js";
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
  navigationPlacementInk,
  type NavigationPlacementFamily,
} from "./navigation-placement.js";
function slotAxes(
  size: Rect,
  area: Rect,
  owner: Rect,
  obstacles: readonly Rect[],
  texts: readonly Rect[],
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
  return { xs: xs.sort((a, b) => a - b), ys };
}
function slotCandidates(
  size: Rect,
  area: Rect,
  owner: Rect,
  obstacles: readonly Rect[],
  locality?: SymbolGeometry,
  texts: readonly Rect[] = [],
  ink?: Rect,
  preferBesideBelow = false,
) {
  const { w, h } = size;
  const { xs, ys } = slotAxes(size, area, owner, obstacles, texts);
  return ys
    .flatMap((y) =>
      clearNavigationXs(xs, y, w, h, obstacles, texts).map((x) => ({
        x,
        y,
        w,
        h,
      })),
    )
    .map((box) => {
      const printed = navigationPlacementInk(box, ink);
      return {
        box,
        distance: locality
          ? anchorDistance(locality.anchorMm, printed)
          : boxDistance(owner, box),
        priority: preferBesideBelow ? Number(!besideBelow(printed, owner)) : 0,
      };
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.distance - b.distance ||
        a.box.y - b.box.y ||
        a.box.x - b.box.x,
    )
    .map(({ box }) => box);
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
  localityInkMm?: ReadonlyMap<string, Rect>,
  fitPrintedInk = false,
) {
  const ordered = ["local", "self-located"].flatMap((mode) =>
    shapes.filter((s) => s.mode === mode),
  );
  for (const shape of ordered) {
    const ink = localityInkMm?.get(shape.id);
    // Keep a 0.01 mm metric/rounding margin around the final fixed-font ink.
    // Empty emission padding is not printed content or a clearance obstacle.
    const fit = fitPrintedInk ? ink : undefined;
    const size = fit
      ? { x: 0, y: 0, w: fit.w + 0.02, h: fit.h + 0.02 }
      : shape.inkMm;
    const envelope = (b: Rect): Rect =>
      fit
        ? { ...shape.inkMm, x: b.x - fit.x + 0.01, y: b.y - fit.y + 0.01 }
        : b;
    const candidates = slotCandidates(
      size,
      area,
      owner,
      obstacles,
      locality,
      texts,
      fit ? undefined : ink,
      preferBesideBelow && shape.mode === "local",
    );
    const box = candidates.find(
      (b) =>
        (!families ||
          families.includes(
            navigationPlacementFamily(
              navigationPlacementInk(envelope(b), ink),
              area,
              owner,
              locality,
            ),
          )) &&
        inside(b, area) &&
        obstacles.every((o) => separated(b, o, NAVIGATION_CLEARANCE_MM)) &&
        texts.every((t) => textSeparated(b, t)) &&
        ((shape.mode !== "local" && !locality?.sourceAnchorsMm) ||
          !locality ||
          localNavigationSlot(
            navigationPlacementInk(envelope(b), ink),
            locality,
          )),
    );
    if (box) return { box: envelope(box), protectedBox: box, shape };
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
