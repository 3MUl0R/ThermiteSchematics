import type { CircuitInlineContext } from "../layout/circuit-inline-context.js";
import type { CircuitLayoutRun } from "../layout/circuit-inline.js";
import type { RenderedPacket } from "./types.js";
import type { RenderOutcome } from "../types.js";
import type { RootedCandidate } from "./rooted-build.js";
import {
  copyCandidate,
  powerPlacementAvailable,
} from "../layout/power-placement.js";
import { powerRouteGraph } from "../layout/power-placement-guard.js";
import { circuitHasJogs } from "../layout/circuit-route-quality.js";
import { circuitPacketGuard } from "../layout/circuit-packet-guard.js";
import { required } from "../presentation/util.js";
import { sharePowerQualityBudget } from "../layout/power-quality-budget.js";

export type FoldRender = () => Promise<RenderOutcome<RenderedPacket>>;

export function proposalRun(
  run: CircuitLayoutRun,
  raw: RootedCandidate,
): CircuitLayoutRun {
  const state = required(run.power, "Missing final power reference");
  const proposed: CircuitLayoutRun = {
    ...run,
    quality: true,
    decisions: new Map(run.decisions),
    power: {
      ...state,
      original: copyCandidate(raw),
      selected: copyCandidate(raw),
      decided: true,
    },
  };
  sharePowerQualityBudget(proposed, run);
  return proposed;
}

/** Reuse the existing quality pass, including its final packet guard. A failed
 * quality attempt retains this proposal's original composition, just as base. */
export async function qualityFold(
  context: CircuitInlineContext,
  run: CircuitLayoutRun,
  render: FoldRender,
) {
  context.cursor = 0;
  const raw = await render();
  assertFoldRender(raw);
  if (!raw.ok) return raw;
  const state = required(run.power, "Missing fold quality state");
  if (
    !circuitHasJogs(powerRouteGraph(state.original)) ||
    !powerPlacementAvailable(run)
  )
    return raw;
  state.decided = false;
  state.selected = undefined;
  context.cursor = 0;
  const quality = await render();
  assertFoldRender(quality);
  if (
    quality.ok &&
    state.selected &&
    circuitPacketGuard(quality.value, raw.value)
  )
    return quality;
  state.selected = copyCandidate(state.original);
  state.decided = true;
  return raw;
}

function assertFoldRender(result: RenderOutcome<RenderedPacket>) {
  if (!result.ok && result.error.code !== "R006")
    throw new Error(
      `Unexpected fold candidate failure: ${result.error.message}`,
    );
}
