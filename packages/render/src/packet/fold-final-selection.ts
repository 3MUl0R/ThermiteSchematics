import type { RenderedPacket } from "./types.js";
import type { RenderOutcome } from "../types.js";
import { circuitInlineContext } from "../layout/circuit-inline-context.js";
import { copyCandidate } from "../layout/power-placement.js";
import { hasCompactFrame } from "./frame-profile.js";
import {
  foldSources,
  foldDecisionTrace,
  type FoldDecision,
} from "./fold-final-context.js";
import { foldProposals } from "./rooted-fold-search.js";
import type { FoldRender } from "./fold-final-quality.js";
import { tryFold, type FoldView } from "./fold-final-trial.js";

/** Base has already completed ordinary quality selection. Keep its immutable
 * per-view reference; rejection restores only this view, preserving other wins. */
export async function selectFinalFolds(
  base: RenderOutcome<RenderedPacket>,
  render: FoldRender,
) {
  const context = circuitInlineContext.getStore();
  if (
    !base.ok ||
    !context ||
    base.value.sheets.length !== 2 ||
    hasCompactFrame(base.value.page)
  )
    return base;
  let selected = base;
  for (const [index, originalRun] of context.runs.slice().entries()) {
    const alternative = await selectViewFold({
      context,
      index,
      originalRun,
      packet: base.value,
      render,
    });
    if (alternative) selected = alternative;
  }
  return selected;
}

async function selectViewFold(job: FoldView) {
  const { context, index, originalRun, packet } = job;
  const state = originalRun.power,
    ir = state && foldSources.get(state.search);
  if (!state || !ir) return undefined;
  const wasSelected = context.selected.has(index);
  const reference = copyCandidate(
    wasSelected && state.selected ? state.selected : state.original,
  );
  const decision: FoldDecision = {
    view: index,
    referenceRequests: state.work.calls,
    branchRequests: 0,
    qualityRequests: 0,
    accepted: false,
    rejected: [],
  };
  foldDecisionTrace.getStore()?.push(decision);
  const proposals = foldProposals(ir, state.search, packet.page, reference);
  let before = state.work.calls;
  try {
    for await (const raw of proposals) {
      decision.branchRequests += state.work.calls - before;
      const result = await tryFold(job, raw, reference, ir, decision);
      before = state.work.calls;
      if (result) {
        decision.accepted = true;
        return result;
      }
      context.runs[index] = originalRun;
      if (!wasSelected) context.selected.delete(index);
    }
  } finally {
    decision.branchRequests += state.work.calls - before;
    if (!decision.accepted) {
      context.runs[index] = originalRun;
      if (!wasSelected) context.selected.delete(index);
    }
  }
  return undefined;
}
