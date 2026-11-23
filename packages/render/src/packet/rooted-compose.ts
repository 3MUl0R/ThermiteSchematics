import { invariant } from "../presentation/util.js";
import { emitSchematicSvg } from "../svg/emitter.js";
import { sideSections } from "./fold-side.js";
import { rootedLocationContent } from "./location-headings.js";
import { compositionFits } from "./composition-fit.js";
import { routeGrowth } from "./rooted-clipped-routes.js";
import { compareCandidates } from "./rooted-score.js";
import type { ElectricalIr } from "@thermite/compiler";
import type { RootedCandidate } from "./rooted-build.js";
import type { Draft, PaperPage } from "./types.js";

function acceptedAlternative(
  original: RootedCandidate,
  native: RootedCandidate,
  page: PaperPage,
  drafts: Draft[],
): RootedCandidate | undefined {
  const alternative: RootedCandidate = { ...original, drafts };
  delete alternative.printableDrafts;
  if (
    routeGrowth(alternative, original, false).some((n) => n > 0) ||
    routeGrowth(alternative, original).some((n) => n > 0) ||
    compareCandidates(
      alternative,
      original,
      native.jogs,
      page,
      native.detours,
      native,
      original,
    ) >= 0 ||
    !compositionFits(alternative, native, page)
  )
    return undefined;
  return alternative;
}

/** Compare the original materialized winner against side-folded strip
 * compositions (tight trim first, then reserving continuation-bank clearance
 * around top/bottom links only if tight trim fails fit). No ELK work. */
export function composeRootedWinner(
  ir: Readonly<ElectricalIr>,
  original: RootedCandidate,
  native: RootedCandidate,
  page: PaperPage,
): RootedCandidate {
  const tightGeometry = sideSections(original, "", false);
  const paddedGeometry = sideSections(original, "", true);
  if (!tightGeometry && !paddedGeometry) return original;
  const p = original.prepared;
  const emitted = emitSchematicSvg(
    p.graph,
    p.layout,
    p.titleContext,
    undefined,
    true,
    original.scale,
    ir,
  );
  // Defensive invariant: the validated winner has already passed this emitter.
  invariant(
    emitted.ok,
    "Validated rooted winner failed re-emission during composition",
  );
  const inner = emitted.value
    .replace(/^<\?xml[^>]*>\s*/, "")
    .replace(/^<svg[^>]*>\s*/, "")
    .replace(/<\/svg>\s*$/, "");
  for (const [geometry, reserveLinks] of [
    [tightGeometry, false],
    [paddedGeometry, true],
  ] as const) {
    if (!geometry) continue;
    const drafts = sideSections(
      original,
      rootedLocationContent(inner, p, geometry),
      reserveLinks,
    );
    if (!drafts) continue;
    const accepted = acceptedAlternative(original, native, page, drafts);
    if (accepted) return accepted;
  }
  return original;
}
