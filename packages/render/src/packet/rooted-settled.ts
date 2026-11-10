import {
  nativeWinner,
  rootedWinner,
  type RootedSearch,
} from "./rooted-search.js";
import { newJogs, newDetours } from "./rooted-score.js";
import type { PaperPage } from "./types.js";

/** A valid first placement needs no cosmetic optimisation. Keep all print
 * guards; the 2× refusal bound applies to the complete packet, not this exit. */
export function searchSettled(run: RootedSearch, page: PaperPage): boolean {
  const candidate = rootedWinner(run, page),
    baseline = nativeWinner(run);
  return (
    !!candidate &&
    !!baseline &&
    candidate.drafts.length <= baseline.drafts.length &&
    newJogs(candidate, baseline.jogs) === 0 &&
    newDetours(candidate, baseline.detours ?? new Map()) === 0 &&
    candidate.drafts.every((d) => (d.rootedContent?.figures ?? 0) > 0)
  );
}
