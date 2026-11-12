import { withFontMetricCache } from "../symbols/font-metric-cache.js";
import { validateEconomyCandidate } from "./rooted-economy.js";
import { placements } from "./rooted-placements.js";
import { repairSearchJogs } from "./rooted-jog-repair.js";
import { searchSettled } from "./rooted-settled.js";
import { MAX_MIXED_LAYOUTS } from "./rooted-mixed.js";
import { invariantCardConstraint } from "./rooted-constraint.js";
import { offViewPacketFailure } from "../off-view/presentation.js";
import type {
  CompiledProjectPresentation,
  ElectricalIr,
} from "@thermite/compiler";
import {
  prepareSchematicDrawing,
  type PreparedSchematicDrawing,
} from "../renderer.js";
import { nativeDrawing } from "../off-view/prepared.js";
import type { SchematicViewRequest, RenderFailure } from "../types.js";
import type { PaperPage } from "./types.js";
import { buildRootedCandidates, type RootedCandidate } from "./rooted-build.js";
import {
  recordRootedDiagnostic,
  type RootedDiagnostic,
} from "./rooted-constraint.js";
import { compareCandidates } from "./rooted-score.js";

const INITIAL_PLACEMENT_LAYOUTS = 24;
export const MAX_PLACEMENT_LAYOUTS =
  INITIAL_PLACEMENT_LAYOUTS + MAX_MIXED_LAYOUTS;
type Profile = "compact" | "dense" | undefined;
export interface RootedSearch {
  diagnostics?: RootedDiagnostic[];
  referenceOffset?: number;
  candidates: RootedCandidate[];
  native: RootedCandidate[];
  errors: RenderFailure[];
  nativeErrors: Map<Profile, RenderFailure>;
  prepared: { p: PreparedSchematicDrawing; profile: Profile }[];
  attempts: number;
  tried: Set<string>;
  settled?: boolean;
  earlyExit?: boolean;
  standardEconomy?: boolean;
  jogRetryReserved?: boolean;
  economyStartedAt?: number;
  validatedCandidate?: RootedCandidate;
  localityReference?: RootedCandidate;
}
async function initial(
  ir: Readonly<ElectricalIr>,
  request: SchematicViewRequest,
  presentation: CompiledProjectPresentation | undefined,
  page: PaperPage,
  profile: Profile,
  run: RootedSearch,
) {
  const result = await prepareSchematicDrawing(
    ir,
    request,
    presentation,
    profile
      ? { spacingProfile: profile, packetContinuations: true }
      : { packetContinuations: true },
  );
  if (!result.ok) {
    run.errors.push(result.error);
    return;
  }
  const p = result.value;
  run.tried.add(`${profile ?? "standard"}:[]`);
  const invariant = invariantCardConstraint(p, page);
  if (invariant) {
    const failed = offViewPacketFailure(
      p.graph,
      "unprintable-layout",
      invariant,
    );
    run.errors.push(failed.error);
    return;
  }
  run.prepared.push({ p, profile });
  const build = profileBuilder(ir, page, profile, run.referenceOffset ?? 0);
  const actual = build(p);
  recordRootedDiagnostic(run.diagnostics, actual);
  if (actual.ok) run.candidates.push(...actual.value);
  else run.errors.push(actual.error);
  const native = await nativeDrawing(p);
  if (!native.ok) {
    const error = offViewPacketFailure(
      p.graph,
      "unprintable-layout",
      `No printable no-card baseline: ${native.error.message}`,
    ).error;
    run.nativeErrors.set(profile, error);
    run.errors.push(error);
    return;
  }
  const baseline = build(native.value, true);
  if (baseline.ok) {
    run.native.push(...baseline.value);
    if (
      actual.ok &&
      Math.min(...actual.value.map((c) => c.drafts.length)) >
        Math.min(...baseline.value.map((c) => c.drafts.length))
    ) {
      const repacked = build(p, false, true);
      if (repacked.ok) run.candidates.push(...repacked.value);
    }
  } else {
    run.nativeErrors.set(profile, baseline.error);
    run.errors.push(baseline.error);
  }
}
export function nativeWinner(run: RootedSearch) {
  let best: RootedCandidate | undefined;
  for (const candidate of run.native) {
    if (
      !best ||
      candidate.drafts.length < best.drafts.length ||
      (candidate.drafts.length === best.drafts.length &&
        candidate.drafts.reduce((n, d) => n + d.links.length, 0) <
          best.drafts.reduce((n, d) => n + d.links.length, 0))
    )
      best = candidate;
    if (best.drafts.length === 1) break;
  }
  return best;
}
export function rootedWinner(run: RootedSearch, page: PaperPage) {
  const baseline = nativeWinner(run)?.jogs ?? new Map<string, number>();
  return [...run.candidates].sort((a, b) =>
    compareCandidates(
      a,
      b,
      baseline,
      page,
      nativeWinner(run)?.detours,
      nativeWinner(run),
      run.localityReference,
    ),
  )[0];
}

export async function searchRootedCandidates(
  ir: Readonly<ElectricalIr>,
  request: SchematicViewRequest,
  presentation: CompiledProjectPresentation | undefined,
  page: PaperPage,
  compact: boolean,
  referenceOffset = 0,
) {
  return withFontMetricCache(async () => {
    const run: RootedSearch = {
      standardEconomy: !compact,
      diagnostics: [],
      referenceOffset,
      candidates: [],
      native: [],
      errors: [],
      nativeErrors: new Map(),
      prepared: [],
      attempts: 0,
      tried: new Set(),
    };
    for (const profile of compact
      ? ([undefined, "compact", "dense"] as const)
      : [undefined]) {
      await initial(ir, request, presentation, page, profile, run);
    }
    validateEconomyCandidate(ir, run, page);
    if (searchSettled(run, page)) {
      run.earlyExit = true;
    } else {
      // Hold one existing attempt for a physical jog left by ordinary recovery.
      // Testing only the initial layout can pre-empt a jog-free recovered base.
      const winner = rootedWinner(run, page);
      run.jogRetryReserved =
        winner?.prepared.view.family === "power" &&
        winner.prepared.view.flow === "top-to-bottom" &&
        [...(winner?.jogs.values() ?? [])].some((n) => n > 0);
      await placements(ir, request, presentation, page, run);
      if (run.validatedCandidate) run.candidates = [run.validatedCandidate];
    }
    delete run.jogRetryReserved;
    await repairSearchJogs(ir, run, page);
    validateEconomyCandidate(ir, run, page);
    return run;
  });
}

function profileBuilder(
  ir: Readonly<ElectricalIr>,
  page: PaperPage,
  profile: Profile,
  offset: number,
) {
  return (p: PreparedSchematicDrawing, native = false, explore = false) =>
    buildRootedCandidates(ir, p, page, profile, native, explore, offset);
}
