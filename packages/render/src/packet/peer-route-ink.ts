import type { ConductiveElementId } from "@thermite/compiler";
import {
  expand,
  inside,
  intersection,
  project,
  type Rect,
} from "../device-legend/geometry.js";
import { pathInk } from "../device-legend/shape-ink.js";
import { documentCoverRectangle } from "./document-covering.js";
import { paintedStroke } from "./document-assembly-geometry.js";
import { conductorEndpoints, pathElement } from "./navigation-incidence.js";
import { boxDistance } from "./navigation-symbols.js";
import type { NavigationGeometry } from "./navigation-walk.js";

interface RouteInk {
  runs: Rect[];
  tips: Rect[];
}

function subtractMask(run: Rect, mask: Rect): Rect[] {
  const cut = intersection(run, mask);
  if (!cut) return [run];
  const pieces =
    run.w >= run.h
      ? [
          { ...run, w: cut.x - run.x },
          { ...run, x: cut.x + cut.w, w: run.x + run.w - cut.x - cut.w },
        ]
      : [
          { ...run, h: cut.y - run.y },
          { ...run, y: cut.y + cut.h, h: run.y + run.h - cut.y - cut.h },
        ];
  return pieces.filter((p) => p.w > 0 && p.h > 0);
}

function paintedRuns(g: NavigationGeometry, masks: readonly Rect[]) {
  return pathInk(g.node.attrs.d ?? "").flatMap((run) => {
    const box = intersection(expand(project(run, g.matrix), 0.01), g.clip);
    return box
      ? masks.reduce(
          (pieces, mask) => pieces.flatMap((p) => subtractMask(p, mask)),
          [box],
        )
      : [];
  });
}

function routeKey(id: ConductiveElementId) {
  return id.kind === "cable_conductor"
    ? JSON.stringify({ cableUid: id.cableUid, conductorId: id.conductorId })
    : id.uid;
}

function paintedRouteKey(geometry: NavigationGeometry) {
  const native = pathElement(geometry);
  if (native) return routeKey(native);
  // Circuit, wiring, and signal-loop drawing paths inherit the native conductor
  // from a route group. White halos are filtered before looking up this binding.
  return (
    geometry.style?.["data-circuit-conductor"] ??
    geometry.style?.["data-wiring-conductor"] ??
    geometry.style?.["data-loop-conductor"]
  );
}

export interface PeerRouteIndex {
  route(element: ConductiveElementId): RouteInk;
  foreignRuns(element: ConductiveElementId): Rect[];
}

export function peerRouteIndex(
  geometry: readonly NavigationGeometry[],
): PeerRouteIndex {
  const masks = geometry.flatMap((g, index) => {
    const cover = documentCoverRectangle(g, index);
    return cover ? [cover] : [];
  });
  const index = new Map<string, { g: NavigationGeometry; i: number }[]>();
  geometry.forEach((g, i) => {
    if (g.node.name !== "path" || !paintedStroke(g)) return;
    const key = paintedRouteKey(g);
    if (!key) return;
    const paths = index.get(key) ?? [];
    paths.push({ g, i });
    index.set(key, paths);
  });
  const runCache = new Map<string, Rect[]>();
  const tipCache = new Map<string, Rect[]>();
  const runsForKey = (key: string): Rect[] => {
    const found = runCache.get(key);
    if (found) return found;
    const runs: Rect[] = [];
    for (const { g, i } of index.get(key) ?? []) {
      const covers = masks.filter((m) => m.index > i).map((m) => m.box);
      runs.push(...paintedRuns(g, covers));
    }
    runCache.set(key, runs);
    return runs;
  };
  const tipsForKey = (key: string): Rect[] => {
    const found = tipCache.get(key);
    if (found) return found;
    const tips: Rect[] = [];
    for (const { g } of index.get(key) ?? [])
      tips.push(
        ...conductorEndpoints(g.node.attrs.d ?? "")
          .map((p) => project({ ...p, w: 0, h: 0 }, g.matrix))
          .filter((p) => inside(p, g.clip)),
      );
    tipCache.set(key, tips);
    return tips;
  };
  return {
    route: (element: ConductiveElementId): RouteInk => {
      const key = routeKey(element);
      return { runs: runsForKey(key), tips: tipsForKey(key) };
    },
    foreignRuns: (element: ConductiveElementId): Rect[] => {
      const ownKey = routeKey(element);
      const out: Rect[] = [];
      for (const key of index.keys())
        if (key !== ownKey) out.push(...runsForKey(key));
      return out;
    },
  };
}

export function landsOnMarks(route: RouteInk, marks: readonly Rect[] = []) {
  return marks.some(
    (marker) =>
      route.tips.some((tip) => inside(tip, expand(marker, 0.05))) &&
      route.runs.some((run) => boxDistance(run, marker) <= 0.25),
  );
}
