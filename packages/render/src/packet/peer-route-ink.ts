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

const COLLINEAR_TOL_MM = 0.05;
const RUN_THICKNESS_TOL_MM = 0.08;
const RESIDUAL_SLIVER_MM = 0.25;

function subtractSpan(
  spans: readonly (readonly [number, number])[],
  cut0: number,
  cut1: number,
): [number, number][] {
  const next: [number, number][] = [];
  for (const [a, b] of spans) {
    if (cut1 <= a || cut0 >= b) {
      next.push([a, b]);
      continue;
    }
    if (cut0 > a) next.push([a, cut0]);
    if (cut1 < b) next.push([cut1, b]);
  }
  return next;
}

function sameBox(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= COLLINEAR_TOL_MM &&
    Math.abs(a.y - b.y) <= COLLINEAR_TOL_MM &&
    Math.abs(a.x + a.w - (b.x + b.w)) <= COLLINEAR_TOL_MM &&
    Math.abs(a.y + a.h - (b.y + b.h)) <= COLLINEAR_TOL_MM
  );
}

/** Exclude collinear ink shared with the note's own route; retain non-coincident parts. */
function subtractCoincidentRun(
  foreign: Rect,
  ownRuns: readonly Rect[],
): Rect[] {
  if (!ownRuns.length) return [foreign];
  if (foreign.w <= RUN_THICKNESS_TOL_MM && foreign.h <= RUN_THICKNESS_TOL_MM)
    return ownRuns.some((o) => boxDistance(foreign, o) <= COLLINEAR_TOL_MM)
      ? []
      : [foreign];
  const horiz = foreign.h <= RUN_THICKNESS_TOL_MM && foreign.w > foreign.h;
  const vert =
    !horiz && foreign.w <= RUN_THICKNESS_TOL_MM && foreign.h > foreign.w;
  if (!horiz && !vert)
    return ownRuns.some((o) => sameBox(foreign, o)) ? [] : [foreign];
  const center = horiz ? foreign.y + foreign.h / 2 : foreign.x + foreign.w / 2;
  const f0 = horiz ? foreign.x : foreign.y;
  const f1 = f0 + (horiz ? foreign.w : foreign.h);
  let spans: [number, number][] = [[f0, f1]];
  let hadOverlap = false;
  for (const o of ownRuns) {
    const oMatch = horiz
      ? o.h <= RUN_THICKNESS_TOL_MM && o.w >= o.h
      : o.w <= RUN_THICKNESS_TOL_MM && o.h >= o.w;
    if (!oMatch) continue;
    const oCenter = horiz ? o.y + o.h / 2 : o.x + o.w / 2;
    if (Math.abs(oCenter - center) > COLLINEAR_TOL_MM) continue;
    const o0 = horiz ? o.x : o.y;
    const o1 = o0 + (horiz ? o.w : o.h);
    if (Math.min(f1, o1) - Math.max(f0, o0) <= COLLINEAR_TOL_MM) continue;
    hadOverlap = true;
    spans = subtractSpan(spans, o0 - COLLINEAR_TOL_MM, o1 + COLLINEAR_TOL_MM);
    if (!spans.length) return [];
  }
  if (!hadOverlap) return [foreign];
  return spans
    .filter(([a, b]) => b - a > RESIDUAL_SLIVER_MM)
    .map(([a, b]) =>
      horiz
        ? { x: a, y: foreign.y, w: b - a, h: foreign.h }
        : { x: foreign.x, y: a, w: foreign.w, h: b - a },
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
      const ownRuns = runsForKey(ownKey);
      const out: Rect[] = [];
      for (const key of index.keys())
        if (key !== ownKey)
          for (const run of runsForKey(key))
            out.push(...subtractCoincidentRun(run, ownRuns));
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
