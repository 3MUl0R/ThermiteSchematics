import type { CircuitLayoutRun } from "./circuit-inline.js";
import type { ElkWorkLedger } from "./elk-work.js";
import { MAX_PLACEMENT_LAYOUTS } from "../packet/rooted-limits.js";
import { STANDARD_ECONOMY_ATTEMPTS } from "../packet/rooted-economy.js";
import { InlineLabelFitError } from "./inline-label-error.js";

const owners = new WeakMap<CircuitLayoutRun, CircuitLayoutRun>();
export function sharePowerQualityBudget(
  proposal: CircuitLayoutRun,
  original: CircuitLayoutRun,
) {
  owners.set(proposal, owners.get(original) ?? original);
}
export function powerQualityAttempts(run: CircuitLayoutRun) {
  return (owners.get(run) ?? run).qualityAttempts;
}
/** One admission per engine/configuration, including cache hits. All proposals
 * debit the original view's existing economy; no cloned counter resets it. */
export function chargePowerQualityInput(
  run: CircuitLayoutRun,
  work: ElkWorkLedger,
) {
  const owner = owners.get(run) ?? run;
  if (work.calls >= MAX_PLACEMENT_LAYOUTS)
    throw new InlineLabelFitError(
      "Power alternative exhausted its shared layout budget.",
    );
  if (owner.qualityAttempts >= STANDARD_ECONOMY_ATTEMPTS)
    throw new InlineLabelFitError(
      "Power alternative exhausted its shared quality budget.",
    );
  owner.qualityAttempts++;
  run.qualityAttempts = owner.qualityAttempts;
}
