import { required } from "../presentation/util.js";
import { unionInk, intersectInk } from "./rooted-ink.js";
import type { RootedCandidate } from "./rooted-build.js";
import type { PaperPage } from "./types.js";
export function candidateUtilisation(
  candidate: RootedCandidate,
  page: PaperPage,
) {
  const values = candidate.drafts
    .flatMap((d) => {
      const bounds = d.drawingBounds ?? {
        x: 20,
        y: 25,
        w: page.widthMm - 56,
        h: page.heightMm - 80,
      };
      const ink = unionInk(
        (d.rootedShapes ?? []).flatMap((s) => {
          const clipped = intersectInk(s, bounds);
          return clipped ? [clipped] : [];
        }),
      );
      const nominal = d.rootedScoreBounds ?? bounds;
      return ink ? [(ink.w * ink.h) / (nominal.w * nominal.h)] : [];
    })
    .sort((a, b) => a - b);
  const n = values.length;
  return n
    ? (required(values[Math.floor((n - 1) / 2)], "Missing rooted geometry") +
        required(values[Math.floor(n / 2)], "Missing rooted geometry")) /
        2
    : 0;
}
export function newJogs(
  c: RootedCandidate,
  baseline: ReadonlyMap<string, number>,
) {
  return [...c.jogs].reduce(
    (sum, [id, n]) => sum + Math.max(0, n - (baseline.get(id) ?? 0)),
    0,
  );
}
export function newDetours(
  c: RootedCandidate,
  baseline: ReadonlyMap<string, number>,
) {
  return [...(c.detours ?? new Map<string, number>())].reduce(
    (sum, [id, n]) => sum + Math.max(0, n - (baseline.get(id) ?? 0)),
    0,
  );
}
/** Stable caller order breaks exact ties. No route points are modified. */
export function compareCandidates(
  a: RootedCandidate,
  b: RootedCandidate,
  baseline: ReadonlyMap<string, number>,
  page: PaperPage,
  baselineDetours: ReadonlyMap<string, number> = new Map(),
) {
  return (
    newJogs(a, baseline) - newJogs(b, baseline) ||
    newDetours(a, baselineDetours) - newDetours(b, baselineDetours) ||
    a.drafts.length - b.drafts.length ||
    candidateUtilisation(b, page) - candidateUtilisation(a, page) ||
    a.proximity - b.proximity
  );
}
