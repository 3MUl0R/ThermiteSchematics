import type { ElectricalIr } from "@thermite/compiler";
import type { CircuitInlineContext } from "../layout/circuit-inline-context.js";
import type { CircuitLayoutRun } from "../layout/circuit-inline.js";
import type { RootedCandidate } from "./rooted-build.js";
import type { RenderedPacket } from "./types.js";
import type { FoldDecision } from "./fold-final-context.js";
import { foldTrialTrace } from "./fold-final-context.js";
import { circuitPacketGuard } from "../layout/circuit-packet-guard.js";
import { required } from "../presentation/util.js";
import { foldCandidateAllowed } from "./rooted-fold-search.js";
import {
  proposalRun,
  qualityFold,
  type FoldRender,
} from "./fold-final-quality.js";

export interface FoldView {
  context: CircuitInlineContext;
  index: number;
  originalRun: CircuitLayoutRun;
  packet: RenderedPacket;
  render: FoldRender;
}

export async function tryFold(
  job: FoldView,
  raw: RootedCandidate,
  reference: RootedCandidate,
  ir: Readonly<ElectricalIr>,
  decision: FoldDecision,
) {
  const { context, index, originalRun, packet, render } = job;
  const proposed = proposalRun(originalRun, raw);
  context.runs[index] = proposed;
  context.selected.add(index);
  const state = required(proposed.power, "Missing composed fold");
  const before = state.work.calls;
  const result = await qualityFold(context, proposed, render);
  decision.qualityRequests += state.work.calls - before;
  originalRun.attempts = state.work.calls;
  proposed.attempts = state.work.calls;
  const candidate = state.selected ?? raw;
  const routes =
    result.ok && foldCandidateAllowed(ir, candidate, reference, packet.page);
  const conserved = result.ok && circuitPacketGuard(result.value, packet);
  foldTrialTrace.getStore()?.push({
    view: index,
    raw,
    candidate,
    reference,
    basePacket: packet,
    ...(result.ok ? { packet: result.value } : {}),
    routesAllowed: routes,
    packetAllowed: conserved,
  });
  if (result.ok && routes && conserved) return result;
  decision.rejected.push(
    !result.ok
      ? "render refusal"
      : !routes
        ? "final routes/geometry"
        : "final packet guard",
  );
  return undefined;
}
