import { SIZE_CEILINGS, sizeKey, sorted, valuesOf } from "./health-budget.mjs";
import { appendReason } from "./health-reasons.mjs";

const E2_PREFIX = "evals/agent/";
const BASELINE_REASON =
  "Measured initial evals/agent scope baseline (#484); under-ceiling sizes enter the ratchet without raising ceilings or grandfathering over-cap bodies.";

// Legacy v4 budgets predating #484 did not record evals/agent/ file or function
// sizes. Seed under-ceiling entries from authenticated base source only; never
// raise ceilings or grandfather over-cap bodies.
export function seedE2Scope(budget, metrics) {
  if (budget.scopes && Object.hasOwn(budget.scopes, "evals/agent"))
    return budget;
  const next = structuredClone(budget);
  next.scopes = sorted(
    Object.entries({ ...(next.scopes ?? {}), "evals/agent": true }),
  );
  for (const section of ["files", "functions"]) {
    const threshold = next.thresholds[sizeKey(section)];
    const cap = Math.min(
      next.ceilings[sizeKey(section)],
      SIZE_CEILINGS[sizeKey(section)],
    );
    for (const [key, value] of Object.entries(valuesOf(metrics, section))) {
      if (!key.startsWith(E2_PREFIX)) continue;
      if (value <= threshold || value > cap) continue;
      if (next[section][key] !== undefined) continue;
      next[section][key] = value;
      const identity = `${section}:${key}`;
      appendReason(next, identity, {
        identity,
        from: threshold,
        to: value,
        reason: BASELINE_REASON,
      });
    }
    next[section] = sorted(Object.entries(next[section]));
  }
  next.reasons = sorted(Object.entries(next.reasons));
  return sorted(Object.entries(next));
}
