import { PacketDraftError } from "./errors.js";
import {
  ContinuationLabelError,
  continuationLabelSvg,
} from "./continuation-label.js";
import { fitContinuations } from "./continuation-fit.js";
import { postTrimCaptionConstraint, inkOverlaps } from "./rooted-caption.js";
import { rootedPageCostFailure } from "./rooted-bound.js";
import { resolveRootedContinuations } from "./continuation-resolve.js";
import type { RootedCandidate } from "./rooted-build.js";
import type { PaperPage } from "./types.js";

/** Check final ink and reciprocal anchors on the independent alternative.
 * The unchanged conservative bank covers serial/destination digit transitions;
 * packet assembly still resolves the actual global numbering after all views. */
export function compositionFits(
  c: RootedCandidate,
  native: RootedCandidate,
  page: PaperPage,
) {
  if (
    fitContinuations(c.drafts, page, c.bank) ||
    postTrimCaptionConstraint(c.drafts, page) ||
    c.drafts.some((d) =>
      d.rootedCaptionInk?.some((ink, i, all) =>
        all.slice(i + 1).some((other) => inkOverlaps(ink, other)),
      ),
    )
  )
    return false;
  const probe = structuredClone(c.drafts),
    first = probe[0];
  if (!first) return false;
  first.rootedFit = {
    basePages: native.drafts.length,
    actualPages: probe.length,
    context: "post-search composition",
  };
  if (rootedPageCostFailure(probe)) return false;
  try {
    resolveRootedContinuations(probe, page);
    for (const draft of probe)
      for (const link of draft.links) continuationLabelSvg(link);
  } catch (error) {
    if (
      error instanceof PacketDraftError ||
      error instanceof ContinuationLabelError
    )
      return false;
    throw error;
  }
  return true;
}
