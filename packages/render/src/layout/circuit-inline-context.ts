import { AsyncLocalStorage } from "node:async_hooks";
import { InlineLabelFitError } from "./inline-label-error.js";
import type { CircuitLayoutRun } from "./circuit-inline.js";

export interface CircuitInlineContext {
  cursor: number;
  runs: CircuitLayoutRun[];
  currentRun?: CircuitLayoutRun;
  selected: Set<number>;
  layouts: Map<string, unknown>;
  qualityPhase: boolean;
  permittedInputs: Set<string>;
  viewDecisions: { view: number; reason: string }[];
}
export const circuitInlineContext =
  new AsyncLocalStorage<CircuitInlineContext>();

export const circuitInlineTrace = new AsyncLocalStorage<
  CircuitInlineContext[]
>();

/** Recomposition reuses exact immutable native outputs for identical ELK inputs.
 * Only an authorised circuit alternative has a new input in the quality pass. */
export async function cachedCircuitLayout<T>(
  input: unknown,
  layout: () => Promise<T>,
): Promise<T> {
  const context = circuitInlineContext.getStore();
  if (!context) return layout();
  const key = JSON.stringify(input),
    found = context.layouts.get(key);
  if (found) return structuredClone(found) as T;
  if (context.qualityPhase && !context.permittedInputs.has(key))
    throw new InlineLabelFitError(
      "Circuit alternative requires recovery outside the original printable composition.",
    );
  const output = await layout();
  context.layouts.set(key, structuredClone(output));
  return output;
}
