import { graphCardContext } from "../off-view/context.js";
import { materializeRootedCandidate } from "./rooted-build.js";
import { rootedDiagnosticError } from "./rooted-constraint.js";
import type {
  CompiledProjectPresentation,
  ElectricalIr,
} from "@thermite/compiler";
import type { RenderOutcome, SchematicViewRequest } from "../types.js";
import type { Draft, PaperPage } from "./types.js";
import {
  searchRootedCandidates,
  rootedWinner,
  nativeWinner,
} from "./rooted-search.js";
export { cuts } from "./rooted-cuts.js";

/** All alternatives run ELK and the same geometry, text and pagination guards. */
export async function drawingDrafts(
  ir: Readonly<ElectricalIr>,
  request: SchematicViewRequest,
  presentation: CompiledProjectPresentation | undefined,
  page: PaperPage,
  mode: "standard" | "compact" = "standard",
  referenceOffset = 0,
): Promise<RenderOutcome<Draft[]>> {
  const run = await searchRootedCandidates(
    ir,
    request,
    presentation,
    page,
    mode === "compact",
    referenceOffset,
  );
  const winner = rootedWinner(run, page),
    native = nativeWinner(run);
  if (!winner || !native) {
    const profile = winner ? winner.profile : run.prepared[0]?.profile;
    const error = (!native && run.nativeErrors.get(profile)) || run.errors[0];
    if (error)
      return {
        ok: false,
        error: rootedDiagnosticError(error, run.diagnostics),
      };
    throw Error("Rooted search returned neither drawing nor error");
  }
  const materialized = materializeRootedCandidate(ir, winner, page);
  if (!materialized.ok) return materialized;
  winner.drafts = materialized.value;
  const context = graphCardContext(winner.prepared.graph);
  winner.drafts[0]!.rootedFit = {
    basePages: native.drafts.length,
    actualPages: winner.drafts.length,
    context,
  };
  return { ok: true, value: winner.drafts };
}
