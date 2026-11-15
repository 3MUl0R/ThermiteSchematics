import type {
  CompiledProjectPresentation,
  ElectricalIr,
} from "@thermite/compiler";
import type { SchematicViewRequest } from "../types.js";
import type { PaperPage } from "./types.js";
import type { RootedCandidate } from "./rooted-build.js";
import {
  searchRootedCandidates as searchBase,
  type RootedSearch,
} from "./rooted-search.js";
import { materializeRootedCandidate, rootedSpace } from "./rooted-build.js";
import { continuationBanks, bankBounds } from "./continuation-bank.js";
import { foldCropExtent, croppedFoldCandidates } from "./fold-crop.js";
import { foldBranchLabels, foldBranchInput } from "./fold-branch-input.js";
import { relayoutDrawing } from "../off-view/prepared.js";
import { createElkEngine } from "../layout/elk-runtime.js";
import {
  elkWorkScope,
  ElkWorkBudgetError,
  type ElkWorkLedger,
} from "../layout/elk-work.js";
import {
  powerNativeGuard,
  powerRouteGraph,
} from "../layout/power-placement-guard.js";
import { circuitCrossingGuard } from "../layout/circuit-native-guard.js";
import { routeGrowth } from "./rooted-clipped-routes.js";
import { compositionFits } from "./composition-fit.js";
import { rootedGangSegments } from "../symbols/rooted-gangs.js";
import { hasCompactFrame } from "./frame-profile.js";
import { economyExhausted } from "./rooted-economy.js";
import { applyLayoutSpacing } from "../layout/spacing.js";
import {
  withCircuitLayoutCache,
  circuitInlineContext,
  circuitLayoutCacheKey,
} from "../layout/circuit-inline-context.js";
import { foldSources } from "./fold-final-context.js";

export const FOLD_BRANCH_SPACINGS = [24, 28] as const;
export const MAX_FOLD_BRANCH_LAYOUTS = FOLD_BRANCH_SPACINGS.length;
export const MAX_FOLD_EXTRA_REQUESTS = 2 * MAX_FOLD_BRANCH_LAYOUTS;
const strips = (c: RootedCandidate) =>
  c.drafts.reduce((n, d) => n + (d.rootedSections?.length ?? 0), 0);
const ends = (c: RootedCandidate) =>
  c.drafts.reduce((n, d) => n + d.links.length, 0);

export async function searchRootedCandidates(
  ir: Readonly<ElectricalIr>,
  request: SchematicViewRequest,
  presentation: CompiledProjectPresentation | undefined,
  page: PaperPage,
  compact: boolean,
  referenceOffset = 0,
) {
  return withCircuitLayoutCache(async () => {
    const run = await searchBase(
      ir,
      request,
      presentation,
      page,
      compact,
      referenceOffset,
    );
    if (
      compact &&
      request.format === "schematic-view-request/0.1" &&
      request.family === "power" &&
      request.flow === "left-to-right" &&
      !hasCompactFrame(page)
    )
      foldSources.set(run, ir);
    return run;
  });
}

export async function* foldProposals(
  ir: Readonly<ElectricalIr>,
  run: RootedSearch,
  page: PaperPage,
  original: RootedCandidate,
) {
  const dense = run.prepared.find((p) => p.profile === "dense")?.p;
  if (
    !original ||
    !dense ||
    original.drafts.length !== 1 ||
    strips(original) <= 2 ||
    ends(original) <= 8
  )
    return;
  const { b, scale } = rootedSpace(dense, page, true),
    extent = foldCropExtent(dense);
  const capacity = Math.max(
    ...continuationBanks(dense, b, scale).map(
      (bank) => bankBounds(b, bank).w / scale,
    ),
  );
  const labels = foldBranchLabels(dense, {
    start: extent.end - capacity,
    end: extent.start + capacity,
  });
  if (!labels || extent.end - extent.start > 2 * capacity) return;
  for (const spacing of FOLD_BRANCH_SPACINGS) {
    if (
      !run.elkWork ||
      run.elkWork.calls >= run.elkWork.limit ||
      economyExhausted(run)
    )
      break;
    const engine = branchEngine(original, labels, spacing, run.elkWork);
    run.attempts++;
    let result;
    try {
      result = await relayoutDrawing(original.prepared, engine);
    } catch (error) {
      if (!(error instanceof ElkWorkBudgetError)) throw error;
      continue;
    }
    if (!result.ok) continue;
    for (const candidate of croppedFoldCandidates(
      result.value,
      page,
      run.referenceOffset ?? 0,
    )) {
      const printed = materializeRootedCandidate(ir, candidate, page);
      if (!printed.ok) continue;
      const selected = {
        ...candidate,
        drafts: printed.value,
        printableDrafts: printed.value,
      };
      if (foldGeometryAllowed(ir, selected, original, page)) {
        yield selected;
        break;
      }
    }
  }
}

function branchEngine(
  original: RootedCandidate,
  labels: ReadonlySet<string>,
  spacing: number,
  work: ElkWorkLedger,
) {
  let calls = 0;
  const engine = createElkEngine(),
    layout = engine.layout.bind(engine);
  engine.layout = (input, options) => {
    if (++calls > 1)
      throw new ElkWorkBudgetError("One branch input per alternative");
    const copy = structuredClone(input);
    applyLayoutSpacing(copy, original.prepared.graph, {
      spacingProfile: "dense",
    });
    const candidate = foldBranchInput(copy, labels, spacing);
    circuitInlineContext
      .getStore()
      ?.permittedInputs.add(circuitLayoutCacheKey(candidate, options));
    return elkWorkScope.run(work, () => layout(candidate, options));
  };
  return engine;
}

/** Compare the composed, quality-processed proposal with the fixed final base,
 * never the earlier rooted winner. routeGrowth uses the unchanged 3 mm policy
 * and JOG_NUMERICAL_TOLERANCE_MM for native and printed paths. */
export function foldCandidateAllowed(
  ir: Readonly<ElectricalIr>,
  candidate: RootedCandidate,
  original: RootedCandidate,
  page: PaperPage,
) {
  return (
    foldGeometryAllowed(ir, candidate, original, page) &&
    [false, true].every(
      (clipped) =>
        routeGrowth(candidate, original, clipped).every((n) => n === 0) &&
        circuitCrossingGuard(
          powerRouteGraph(candidate, clipped),
          powerRouteGraph(original, clipped),
        ),
    )
  );
}

function foldGeometryAllowed(
  ir: Readonly<ElectricalIr>,
  candidate: RootedCandidate,
  original: RootedCandidate,
  page: PaperPage,
) {
  return (
    candidate.drafts.length <= original.drafts.length &&
    candidate.scale === original.scale &&
    strips(candidate) === 2 &&
    ends(candidate) <= 8 &&
    powerNativeGuard(candidate.prepared, original.prepared) &&
    rootedGangSegments(ir, candidate.prepared.graph, candidate.prepared.layout)
      .ok &&
    compositionFits(candidate, original, page)
  );
}
