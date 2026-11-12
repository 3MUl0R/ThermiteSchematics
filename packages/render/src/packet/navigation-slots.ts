import { generatedSvgInk } from "../device-legend/svg-ink.js";
import {
  inside,
  separated,
  project,
  type Rect,
} from "../device-legend/geometry.js";
import { navigationGeometry } from "./navigation-walk.js";
import type { AnnotationReservation } from "./navigation-types.js";
export const NAVIGATION_CLEARANCE_MM = 1.5;
export interface SheetSlotRequest {
  reservation: AnnotationReservation;
  owner: Rect;
}
/** Vacant sheet-mm space after real continuation/legend ink. Never grows an ELK leaf. */
export function allocateNavigationSlots(
  requests: readonly SheetSlotRequest[],
  area: Rect,
  svg: string,
  sheet: number,
): AnnotationReservation[] {
  const measured = generatedSvgInk(svg);
  const obstacles = [
    ...measured.ink,
    ...measured.regions,
    ...navigationGeometry(svg).flatMap((g) => {
      const a = g.node.attrs;
      return g.visible &&
        g.node.name === "rect" &&
        /device-frame|off-view-card|device-legend-frame/.test(a.class ?? "")
        ? [
            project(
              {
                x: Number(a.x ?? 0),
                y: Number(a.y ?? 0),
                w: Number(a.width),
                h: Number(a.height),
              },
              g.matrix,
            ),
          ]
        : [];
    }),
  ];
  return requests.map(({ reservation, owner }) => {
    const { w, h } = reservation.inkMm;
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
      Math.hypot(
        Math.max(owner.x - b.x - b.w, b.x - owner.x - owner.w, 0),
        Math.max(owner.y - b.y - b.h, b.y - owner.y - owner.h, 0),
      );
    const candidates = ys
      .flatMap((y) => xs.map((x) => ({ x, y, w, h })))
      .sort((a, b) => distance(a) - distance(b) || a.y - b.y || a.x - b.x);
    const box = candidates.find(
      (b) =>
        inside(b, area) &&
        obstacles.every((o) => separated(b, o, NAVIGATION_CLEARANCE_MM)),
    );
    if (!box)
      throw Error(
        `Navigation ${reservation.profileId} cannot fit sheet ${sheet}: required ${w.toFixed(2)} × ${h.toFixed(2)} mm with ${NAVIGATION_CLEARANCE_MM} mm clearance; owner ${reservation.ownerAppearance}`,
      );
    obstacles.push(box);
    return { ...reservation, allocatedMm: { sheet, rect: box } };
  });
}
