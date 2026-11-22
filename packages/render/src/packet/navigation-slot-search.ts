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
  elementDrawingArea,
  roomiestElementSlot,
} from "./navigation-element-room.js";
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
  textVerticalClearanceMm = 0,
  tieBreakAnchor?: { x: number; y: number },
) {
  const { w, h } = size;
  const xs = [
    ...new Set([
      area.x,
      area.x + area.w - w,
      owner.x,
      owner.x + owner.w - w,
      ...(tieBreakAnchor
        ? [owner.x + 1.51, owner.x + owner.w - w - 1.51, tieBreakAnchor.x - w / 2]
        : []),
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
      ...(tieBreakAnchor
        ? [owner.y + 1.51, owner.y + owner.h - h - 1.51, tieBreakAnchor.y - h / 2]
        : []),
      ...(textVerticalClearanceMm
        ? texts.flatMap((b) => [
            b.y + b.h + textVerticalClearanceMm + 0.01,
            b.y - h - textVerticalClearanceMm - 0.01,
          ])
        : []),
      ...obstacles.flatMap((b) => [b.y + b.h + 1.51, b.y - h - 1.51]),
    ]),
  ].filter((y) => y >= area.y && y + h <= area.y + area.h);
  return { xs: xs.sort((a, b) => a - b), ys };
}
export interface SlotReach {
  anchors: readonly Rect[];
  gap: number;
  textVerticalClearanceMm?: number;
  foreignOwners?: readonly Rect[];
  tieBreakAnchor?: { x: number; y: number };
}

function reachableAxes(
  { xs, ys }: { xs: readonly number[]; ys: readonly number[] },
  { w, h }: Rect,
  { anchors, gap }: SlotReach,
) {
  if (!Number.isFinite(gap) || !anchors.length) return { xs, ys };
  const near = (start: number, length: number, v: number, span: number) =>
    Math.max(0, start - v - span, v - start - length) <= gap;
  return {
    xs: xs.filter((x) => anchors.some((a) => near(x, w, a.x, a.w))),
    ys: ys.filter((y) => anchors.some((a) => near(y, h, a.y, a.h))),
  };
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
  textVerticalClearanceMm = 0,
  withinLocalSources = false,
  reach?: SlotReach,
) {
  const { w, h } = size;
  const axes = slotAxes(
    size,
    area,
    owner,
    obstacles,
    texts,
    textVerticalClearanceMm,
    reach?.tieBreakAnchor,
  );
  const localAxes =
    withinLocalSources && locality
      ? localSourceAxes(axes, w, h, locality)
      : axes;
  // Filter the existing coordinates before their Cartesian product. Exact
  // distance is checked below, so no accepted candidate or tie changes.
  const { xs, ys } = reach ? reachableAxes(localAxes, size, reach) : localAxes;
  return ys
    .flatMap((y) =>
      clearNavigationXs(
        xs,
        y,
        w,
        h,
        obstacles,
        texts,
        textVerticalClearanceMm,
      ).map((x) => ({
        x,
        y,
        w,
        h,
      })),
    )
    .filter(
      (box) =>
        !reach ||
        !Number.isFinite(reach.gap) ||
        reach.anchors.some((a) => boxDistance(box, a) <= reach.gap),
    )
    .map((box) => {
      const printed = navigationPlacementInk(box, ink);
      const distance = locality
        ? anchorDistance(locality.anchorMm, printed)
        : boxDistance(owner, box);
      const ownerGap =
        reach?.anchors.length
          ? Math.min(...reach.anchors.map((a) => boxDistance(box, a)))
          : boxDistance(owner, box);
      const foreignDistance = reach?.foreignOwners?.length
        ? Math.min(...reach.foreignOwners.map((f) => boxDistance(f, box)))
        : Infinity;
      const foreignCloser = Number(foreignDistance + 0.02 < ownerGap);
      const tieDistance = reach?.tieBreakAnchor
        ? anchorDistance(reach.tieBreakAnchor, printed)
        : 0;
      return {
        box,
        distance,
        foreignCloser,
        foreignDistance,
        tieDistance,
        priority: preferBesideBelow ? Number(!besideBelow(printed, owner)) : 0,
      };
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.foreignCloser - b.foreignCloser ||
        a.distance - b.distance ||
        a.tieDistance - b.tieDistance ||
        b.foreignDistance - a.foreignDistance ||
        a.box.y - b.box.y ||
        a.box.x - b.box.x,
    )
    .map(({ box }) => box);
}
/** Necessary bounds only: the final ink still has to pass exact 60 mm locality. */
function localSourceAxes(
  axes: { xs: number[]; ys: number[] },
  w: number,
  h: number,
  locality: SymbolGeometry,
) {
  const anchors = [locality.anchorMm, ...(locality.sourceAnchorsMm ?? [])];
  return {
    xs: axes.xs.filter((x) =>
      anchors.every((a) => x <= a.x + 60 && x + w >= a.x - 60),
    ),
    ys: axes.ys.filter((y) =>
      anchors.every((a) => y <= a.y + 60 && y + h >= a.y - 60),
    ),
  };
}
function laneLocal(
  shape: NavigationShape,
  box: Rect,
  ink: Rect | undefined,
  locality: SymbolGeometry | undefined,
) {
  return (
    !locality ||
    (!locality.sourceAnchorsMm && shape.mode !== "local") ||
    localNavigationSlot(navigationPlacementInk(box, ink), locality)
  );
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
  reach?: (shape: NavigationShape) => SlotReach,
  preferRoomiest = fitPrintedInk,
) {
  const fitArea = fitPrintedInk ? elementDrawingArea(area) : area;
  const textVerticalClearanceMm = fitPrintedInk
    ? NAVIGATION_TEXT_CLEARANCE_MM
    : 0;
  const ordered = ["local", "self-located"].flatMap((mode) =>
    shapes.filter((s) => s.mode === mode),
  );
  for (const shape of ordered) {
    const shapeReach = reach?.(shape);
    const verticalClearance = Math.max(
      textVerticalClearanceMm,
      shapeReach?.textVerticalClearanceMm ?? 0,
    );
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
      fitArea,
      owner,
      obstacles,
      locality,
      texts,
      fit ? undefined : ink,
      preferBesideBelow && shape.mode === "local",
      verticalClearance,
      fitPrintedInk && (shape.mode === "local" || !!locality?.sourceAnchorsMm),
      shapeReach,
    );
    const legal = (b: Rect) =>
      (!families ||
        families.includes(
          navigationPlacementFamily(
            navigationPlacementInk(envelope(b), ink),
            area,
            owner,
            locality,
          ),
        )) &&
      inside(b, fitArea) &&
      laneLocal(shape, envelope(b), ink, locality) &&
      obstacles.every((o) => separated(b, o, NAVIGATION_CLEARANCE_MM)) &&
      texts.every((t) => textSeparated(b, t, verticalClearance));
    const box = preferRoomiest
      ? roomiestElementSlot(candidates.filter(legal), fitArea, obstacles, texts)
      : candidates.find(legal);
    if (box) return { box: envelope(box), protectedBox: box, shape };
  }
  return undefined;
}

/** Horizontal text separation, plus the explicit vertical gap for element ink. */
function textSeparated(label: Rect, other: Rect, verticalClearanceMm: number) {
  return (
    label.y + label.h + verticalClearanceMm <= other.y ||
    other.y + other.h + verticalClearanceMm <= label.y ||
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
