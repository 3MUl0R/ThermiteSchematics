import type { RenderOutcome } from "../types.js";
import { nextCircuitLayoutRun } from "./circuit-inline.js";
import {
  circuitInlineContext,
  type CircuitInlineContext,
} from "./circuit-inline-context.js";

interface SavedView {
  ir: object;
  presentation: object | undefined;
  input: string;
  start: number;
  selected: boolean[];
  result: unknown;
}
const views = new WeakMap<CircuitInlineContext, SavedView[]>();

/** Reuse only identical pre-assembly inputs and the same run selection. Each
 * caller gets its own drafts: assembly mutates links, namespaces and headings.
 * Replaying nextCircuitLayoutRun preserves RT2a's cursor/current-run contract.
 * Final sheet assembly, NAV measurements and the packet guard still run. */
export async function cachedCircuitView<T>(
  ir: object,
  presentation: object | undefined,
  input: readonly unknown[],
  render: () => Promise<RenderOutcome<T>>,
): Promise<RenderOutcome<T>> {
  const context = circuitInlineContext.getStore();
  if (!context) return render();
  const entries = views.get(context) ?? [];
  views.set(context, entries);
  const key = JSON.stringify(input),
    start = context.cursor;
  const saved =
    context.qualityPhase &&
    entries.find(
      (entry) =>
        entry.ir === ir &&
        entry.presentation === presentation &&
        entry.input === key &&
        entry.start === start &&
        start + entry.selected.length <= context.runs.length &&
        entry.selected.every(
          (selected, i) => selected === context.selected.has(start + i),
        ),
    );
  if (saved) {
    for (const _ of saved.selected) nextCircuitLayoutRun();
    return structuredClone(saved.result) as RenderOutcome<T>;
  }
  const result = await render();
  if (result.ok)
    entries.push({
      ir,
      presentation,
      input: key,
      start,
      selected: Array.from({ length: context.cursor - start }, (_, i) =>
        context.selected.has(start + i),
      ),
      result: structuredClone(result),
    });
  return result;
}
