import type { CircuitLabelState } from "./layout-routes.js";
import { uncoveredCaptionRuns } from "./caption-uncovered.js";
/** #359: native separation of coincident circuit routes is deferred. Preserve
 * base captions only when every owner segment is covered by foreign collinear
 * segments. Net membership grants no exemption; partial coverage fails closed. */
export function fullyCoincidentCaption(
  index: number,
  segments: readonly CircuitLabelState["segments"][number][],
) {
  const coverage = uncoveredCaptionRuns(index, segments);
  return coverage !== undefined && coverage.runs.length === 0;
}
