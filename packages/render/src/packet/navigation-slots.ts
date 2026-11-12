import { generatedSvgInk } from "../device-legend/svg-ink.js";
import { project, type Rect } from "../device-legend/geometry.js";
import { navigationGeometry } from "./navigation-walk.js";
import type { SymbolGeometry } from "./navigation-symbols.js";
import type {
  AnnotationReservation,
  NavigationShape,
} from "./navigation-types.js";
import {
  searchNavigationSlot,
  NAVIGATION_CLEARANCE_MM,
} from "./navigation-slot-search.js";
export { NAVIGATION_CLEARANCE_MM } from "./navigation-slot-search.js";
export interface SheetSlotRequest {
  reservation: AnnotationReservation;
  owner: Rect;
  locality?: SymbolGeometry;
}
function navigationObstacles(svg: string): Rect[] {
  const measured = generatedSvgInk(svg);
  return [
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
}
/** Vacant sheet-mm space after real continuation/legend ink. Never grows an ELK leaf. */
export function allocateNavigationSlots(
  requests: readonly SheetSlotRequest[],
  area: Rect,
  svg: string,
  sheet: number,
): AnnotationReservation[] {
  const obstacles = navigationObstacles(svg);
  return requests.map(({ reservation, owner, locality }) => {
    const legacy: NavigationShape[] = (["local", "self-located"] as const).map(
      (mode) => ({
        id: mode,
        mode,
        inkMm: reservation.inkMm,
        maximumForms: reservation.maximumForms,
        wrapWidthMm: reservation.inkMm.w - 2,
      }),
    );
    const result = searchNavigationSlot(
      reservation.shapes ?? legacy,
      area,
      owner,
      obstacles,
      locality,
    );
    if (!result)
      throw Error(
        `Navigation ${reservation.profileId} cannot fit sheet ${sheet}: required ${reservation.inkMm.w.toFixed(2)} × ${reservation.inkMm.h.toFixed(2)} mm with ${NAVIGATION_CLEARANCE_MM} mm clearance; owner ${reservation.ownerAppearance}`,
      );
    obstacles.push(result.box);
    return {
      ...reservation,
      inkMm: result.shape.inkMm,
      maximumForms: result.shape.maximumForms,
      allocatedMm: {
        sheet,
        rect: result.box,
        ...(reservation.shapes ? { shapeId: result.shape.id } : {}),
        ...(locality ? { placement: result.shape.mode } : {}),
      },
    };
  });
}
