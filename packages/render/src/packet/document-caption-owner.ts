import type { DocumentDependency } from "./document-types.js";
import type { RenderedSheet } from "./types.js";
import {
  navigationGeometry,
  type NavigationGeometry,
} from "./navigation-walk.js";
import { navigationZone } from "./navigation-location.js";
import { inside, project, type Rect } from "../device-legend/geometry.js";
import type { SymbolGeometry } from "./navigation-symbols.js";

export interface DocumentCaptionOwner extends SymbolGeometry {
  deviceUid: string;
  terminalKey?: string;
}
function captionFrames(all: readonly NavigationGeometry[]) {
  // Wiring's native outer rectangle is an immediate child of its UID scope;
  // it has no device-frame class. Do not mistake nested tag plates for frames.
  const native = new Set(
    all.flatMap((g) =>
      g.node.attrs["data-device-uid"]
        ? g.node.children.filter((node) => node.name === "rect").slice(0, 1)
        : [],
    ),
  );
  return all.flatMap((g) => {
    const a = g.node.attrs;
    if (
      g.node.name !== "rect" ||
      (!/device-frame/u.test(a.class ?? "") && !native.has(g.node))
    )
      return [];
    const rect = project(
      {
        x: Number(a.x ?? 0),
        y: Number(a.y ?? 0),
        w: Number(a.width),
        h: Number(a.height),
      },
      g.matrix,
    );
    return inside(rect, g.clip) ? [{ uid: g.deviceUid, rect }] : [];
  });
}

/** Source UID/key, never subject text, selects a visible owning terminal/frame.
 * Ambiguous or absent appearances retain the caption's full native subject. */
export function documentCaptionOwner(
  need: DocumentDependency,
  sheet: RenderedSheet,
  field: Rect,
): DocumentCaptionOwner | undefined {
  const terminals = need.requiredFacts.flatMap((fact) =>
    fact.kind === "conductor-incidence" || fact.kind === "terminal-inventory"
      ? [fact.terminal]
      : [],
  );
  const uid = terminals[0]?.deviceUid;
  if (!uid || terminals.some((t) => t.deviceUid !== uid)) return undefined;
  const all = navigationGeometry(sheet.svg).filter(
    (g) => g.visible && (!g.viewKey || g.viewKey === need.owner.viewKey),
  );
  const frames = captionFrames(all);
  const markers =
    need.need === "conductor-incidence"
      ? all
          .filter(
            (g) =>
              g.deviceUid === uid &&
              g.node.name === "circle" &&
              terminals.every(
                (t) => t.terminalKey === g.node.attrs["data-terminal-key"],
              ),
          )
          .map((g) =>
            project(
              {
                x: Number(g.node.attrs.cx),
                y: Number(g.node.attrs.cy),
                w: 0,
                h: 0,
              },
              g.matrix,
            ),
          )
          .filter((point) => inside(point, field))
      : [];
  const points = [
    ...new Map(markers.map((p) => [JSON.stringify([p.x, p.y]), p])).values(),
  ];
  const own = frames.filter(
    (f) =>
      f.uid === uid &&
      (!points.length || points.every((point) => inside(point, f.rect))),
  );
  if (points.length > 1 || own.length !== 1) return undefined;
  const frame = own[0];
  if (!frame) return undefined;
  const anchorMm = points[0] ?? {
    x: frame.rect.x + frame.rect.w / 2,
    y: frame.rect.y + frame.rect.h / 2,
  };
  if (!inside({ ...anchorMm, w: 0, h: 0 }, field)) return undefined;
  return {
    deviceUid: uid,
    ...(points.length && terminals[0]
      ? { terminalKey: terminals[0].terminalKey }
      : {}),
    anchorMm,
    frameMm: frame.rect,
    framesMm: frames.filter((f) => f !== frame).map((f) => f.rect),
    ownerLocation: {
      sheet: sheet.number,
      zone: navigationZone(anchorMm.x, anchorMm.y, field),
    },
  };
}
