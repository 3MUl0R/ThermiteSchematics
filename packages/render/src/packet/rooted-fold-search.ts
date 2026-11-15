import type {
  CompiledProjectPresentation,
  ElectricalIr,
} from "@thermite/compiler";
import type { SchematicViewRequest } from "../types.js";
import type { PaperPage } from "./types.js";
import type { RootedCandidate } from "./rooted-build.js";
import {
  searchRootedCandidates as searchBase,
  rootedWinner,
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
import { powerNativeGuard } from "../layout/power-placement-guard.js";
import { routeGrowth } from "./rooted-clipped-routes.js";
import { compositionFits } from "./composition-fit.js";
import { rootedGangSegments } from "../symbols/rooted-gangs.js";
import { hasCompactFrame } from "./frame-profile.js";
import { economyExhausted } from "./rooted-economy.js";
import { applyLayoutSpacing } from "../layout/spacing.js";
import { withCircuitLayoutCache } from "../layout/circuit-inline-context.js";

export const FOLD_BRANCH_SPACINGS = [24, 28] as const;
export const MAX_FOLD_BRANCH_LAYOUTS = FOLD_BRANCH_SPACINGS.length;
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
      await improveFold(ir, run, page);
    return run;
  });
}

async function improveFold(
  ir: Readonly<ElectricalIr>,
  run: RootedSearch,
  page: PaperPage,
) {
  const original = rootedWinner(run, page),
    dense = run.prepared.find((p) => p.profile === "dense")?.p;
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
      if (foldCandidateAllowed(ir, selected, original, page)) {
        run.candidates = [selected];
        return;
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
    return elkWorkScope.run(work, () =>
      layout(foldBranchInput(copy, labels, spacing), options),
    );
  };
  return engine;
}

/** The fold objective can add ordinary bends; it cannot buy a printed/native
 * jog, detour, crossing, lost endpoint, phase permutation or broken gang. */
export function foldCandidateAllowed(
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
    compositionFits(candidate, original, page) &&
    [false, true].every((clipped) =>
      routeGrowth(candidate, original, clipped).every((n) => n === 0),
    )
  );
}
