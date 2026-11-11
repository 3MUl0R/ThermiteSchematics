import type { RenderFailure } from "../types.js";
import type { Draft } from "./types.js";
import type { LegendSearchFailure } from "./legend-pagination.js";
import { rootedPageBudget } from "./rooted-bound.js";
/** Report the unresolved terminal span, rather than an unrelated failed trial
 * selected solely for having a larger free rectangle. Search/cost caps stay intact. */
export function legendBoundFailure(
  failures: LegendSearchFailure,
  drafts: readonly Draft[],
  title: string,
): RenderFailure | undefined {
  const tail = failures.tail?.failure;
  if (
    !tail ||
    tail.code !== "R006" ||
    tail.details?.capacityKind !== "free-region"
  )
    return failures.bound;
  const entries = tail.details.legendEntries as
    { designation: string; kind: string }[] | undefined;
  if (!entries?.length) return failures.bound;
  const { base, limit } = rootedPageBudget(drafts),
    devices = entries.map((e) => `${e.designation} (${e.kind})`).join(", ");
  return {
    ...tail,
    root: "packet",
    message: `Legend pagination exhausted the ${limit}-sheet packet page-cost bound (${base} native sheets). The final sheet of ${title} cannot fit complete entries for ${devices}: requires ${Number(tail.details.requiredWidthMm).toFixed(2)} × ${Number(tail.details.requiredHeightMm).toFixed(2)} mm; largest tried free region is ${Number(tail.details.availableWidthMm).toFixed(2)} × ${Number(tail.details.availableHeightMm).toFixed(2)} mm after 3 mm ink clearance. Further pagination must stay within ${limit} sheets. Use larger paper, another flow, or split the view.`,
    details: {
      ...tail.details,
      constraint: "legend-pagination-bound",
      basePages: base,
      maximumPages: limit,
      sheet: "final",
      viewTitle: title,
    },
  };
}
