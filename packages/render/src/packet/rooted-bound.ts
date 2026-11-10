import type { Draft } from "./types.js";
import type { RenderFailure } from "../types.js";
/** Compare complete packets, rather than imposing a stricter per-view page cap. */
export function rootedPageCostFailure(
  drafts: readonly Draft[],
): RenderFailure | undefined {
  const fits = drafts.flatMap((d) => (d.rootedFit ? [d.rootedFit] : []));
  if (!fits.length) return undefined;
  const base =
    drafts.length - fits.reduce((n, f) => n + f.actualPages - f.basePages, 0);
  const limit = 2 * base;
  if (drafts.length <= limit) return undefined;
  const context = fits
    .map((f) => f.context)
    .filter(Boolean)
    .join("; ");
  return {
    code: "R006",
    root: "packet",
    reason: "unprintable-layout",
    message: `Off-view layout needs ${drafts.length} sheets versus ${base} native sheets: exceeds the ${limit}-sheet page-cost bound by ${drafts.length - limit} sheets. ${context}. Use a larger sheet or landscape.`,
    details: {
      constraint: "page-cost-bound",
      basePages: base,
      candidatePages: drafts.length,
      maximumPages: limit,
      shortfallSheets: drafts.length - limit,
      offViewConnections: context,
    },
  };
}
