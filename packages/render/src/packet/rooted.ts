import { hasCompactFrame } from "./frame-profile.js";
import {
  beginFramePlanning,
  frameCandidate,
  rememberFrameCandidate,
  frameBudgetFailure,
  frameBudgetOrder,
  finishFramePlanning,
  recordFrameAttempt,
} from "./frame-budget.js";
import { legacyFramePlacement } from "./frame-legacy-placement.js";
import { composeRootedWinner } from "./rooted-compose.js";
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
import { nextCircuitLayoutRun } from "../layout/circuit-inline.js";
import {
  rememberPowerPlacement,
  selectPowerPlacement,
} from "../layout/power-placement.js";
import type { RootedCandidate } from "./rooted-build.js";
export { cuts } from "./rooted-cuts.js";

/** The legacy path is unchanged; compact planning owns a separate reference page. */
export async function drawingDrafts(
  ir: Readonly<ElectricalIr>,
  request: SchematicViewRequest,
  presentation: CompiledProjectPresentation | undefined,
  page: PaperPage,
  mode: "standard" | "compact" = "standard",
  referenceOffset = 0,
): Promise<RenderOutcome<Draft[]>> {
  if (!hasCompactFrame(page))
    return selectedDrawingDrafts(
      ir,
      request,
      presentation,
      page,
      mode,
      referenceOffset,
    );
  const legacy = await selectedDrawingDrafts(
    ir,
    request,
    presentation,
    { ...page },
    mode,
    referenceOffset,
  );
  if (!legacy.ok) return legacy;
  const reference = frameCandidate(legacy.value);
  const ordinary = await selectedDrawingDrafts(
    ir,
    request,
    presentation,
    page,
    mode,
    referenceOffset,
  );
  beginFramePlanning(page, reference);
  if (retainCompactPlacement(ordinary, page)) return ordinary;
  return replanCompactDrawing(
    ir,
    request,
    presentation,
    page,
    mode,
    referenceOffset,
    reference,
  );
}

function retainCompactPlacement(
  result: RenderOutcome<Draft[]>,
  page: PaperPage,
) {
  if (!result.ok) return false;
  const c = frameCandidate(result.value);
  recordFrameAttempt(
    page,
    c.prepared,
    c.profile,
    c.bank,
    c.grid,
    c.foldGroups,
    c.scale,
    c.drafts.map((d) => {
      if (!d.drawingBounds) throw Error("Missing compact field");
      return d.drawingBounds;
    }),
  );
  if (frameBudgetFailure(c, page)) return false;
  finishFramePlanning(page, c, "existing-compact");
  return true;
}
async function replanCompactDrawing(
  ir: Readonly<ElectricalIr>,
  request: SchematicViewRequest,
  presentation: CompiledProjectPresentation | undefined,
  page: PaperPage,
  mode: "standard" | "compact",
  referenceOffset: number,
  reference: import("./rooted-build.js").RootedCandidate,
): Promise<RenderOutcome<Draft[]>> {
  const planned = await selectedDrawingDrafts(
    ir,
    request,
    presentation,
    page,
    mode,
    referenceOffset,
  );
  if (planned.ok && !frameBudgetFailure(frameCandidate(planned.value), page)) {
    finishFramePlanning(page, frameCandidate(planned.value), "folded-group");
    return planned;
  }
  return legacyFramePlacement(
    reference,
    planned.ok ? frameCandidate(planned.value) : undefined,
    page,
  );
}

/** Search owns ELK; the selected winner may then compose its existing strips. */
async function selectedDrawingDrafts(
  ir: Readonly<ElectricalIr>,
  request: SchematicViewRequest,
  presentation: CompiledProjectPresentation | undefined,
  page: PaperPage,
  mode: "standard" | "compact" = "standard",
  referenceOffset = 0,
): Promise<RenderOutcome<Draft[]>> {
  const qualityRun =
    request.format === "schematic-view-request/0.1" &&
    request.family === "power" &&
    request.flow === "left-to-right"
      ? nextCircuitLayoutRun()
      : undefined;
  if (qualityRun?.power) {
    const selected = await selectPowerPlacement(ir, qualityRun, page);
    return drawingResult(selected, qualityRun.power.native);
  }
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
  const materialized = winner.printableDrafts
    ? { ok: true as const, value: winner.printableDrafts }
    : materializeRootedCandidate(ir, winner, page);
  if (!materialized.ok) return materialized;
  winner.drafts = materialized.value;
  const composed = composeRootedWinner(ir, winner, native, page);
  const selected =
    frameBudgetOrder(composed, winner, page) <= 0 ? composed : winner;
  rememberPowerPlacement(qualityRun, selected, native, run);
  return drawingResult(selected, native);
}

function drawingResult(
  selected: RootedCandidate,
  native: RootedCandidate,
): RenderOutcome<Draft[]> {
  const context = graphCardContext(selected.prepared.graph);
  selected.drafts[0]!.rootedFit = {
    basePages: native.drafts.length,
    actualPages: selected.drafts.length,
    context,
  };
  selected.drafts[0]!.rootedLegendSource = {
    prepared: selected.prepared,
    grid: selected.grid,
    scale: selected.scale,
    ...(selected.profile ? { profile: selected.profile } : {}),
  };
  for (const draft of selected.drafts) draft.rootedBank = selected.bank;
  rememberFrameCandidate(selected);
  return { ok: true, value: selected.drafts };
}
