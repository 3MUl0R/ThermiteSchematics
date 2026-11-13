import { AsyncLocalStorage } from "node:async_hooks";
import { InlineLabelFitError } from "./inline-label-error.js";
import type { CircuitLayoutRun } from "./circuit-inline.js";
import type { ElkLayoutArguments } from "elkjs/lib/elk-api.js";

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

export const circuitLayoutCacheKey = (
  input: unknown,
  options?: ElkLayoutArguments,
) => JSON.stringify([input, options]);

/** Within the packet cache, misses lay out a clone and hits return a clone:
 * neither mutates its input, and callers consume the returned graph. Only an
 * authorised circuit alternative has a new input in the quality pass. */
export async function cachedCircuitLayout<Input, T>(
  input: Input,
  layout: (copy: Input) => Promise<T>,
  options?: ElkLayoutArguments,
): Promise<T> {
  const context = circuitInlineContext.getStore();
  if (!context) return layout(input);
  const key = circuitLayoutCacheKey(input, options),
    found = context.layouts.get(key);
  if (found) return structuredClone(found) as T;
  if (context.qualityPhase && !context.permittedInputs.has(key))
    throw new InlineLabelFitError(
      "Circuit alternative requires recovery outside the original printable composition.",
    );
  const output = await layout(structuredClone(input));
  context.layouts.set(key, structuredClone(output));
  return output;
}
