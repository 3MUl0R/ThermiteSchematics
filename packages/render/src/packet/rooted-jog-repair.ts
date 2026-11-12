import type { ElectricalIr } from "@thermite/compiler";
import type { RootedCandidate } from "./rooted-build.js";
import {
  MAX_PLACEMENT_LAYOUTS,
  nativeWinner,
  rootedWinner,
  type RootedSearch,
} from "./rooted-search.js";
import type { PaperPage } from "./types.js";
import { VERTICAL_POWER_EDGE_NODE_SPACING } from "../layout/adapter-ordering.js";
import { fragmentDefects } from "./route-fragments.js";
import { actualChoices } from "../off-view/choices.js";
import { repositionDrawing } from "../off-view/prepared.js";
import {
  buildRootedCandidates,
  materializeRootedCandidate,
} from "./rooted-build.js";
import { routeGrowth } from "./rooted-clipped-routes.js";
import { candidateUtilisation } from "./rooted-score.js";
import { localityRegression } from "./rooted-locality.js";
import { composeRootedWinner } from "./rooted-compose.js";
import { compositionFits } from "./composition-fit.js";
import { economyExhausted } from "./rooted-economy.js";

const jogCount = (c: RootedCandidate) =>
  [...c.jogs.values()].reduce((a, b) => a + b, 0);

/** One page-aware ELK retry, charged to the existing placement budget.
 * Keep the original unless the complete printed candidate repairs a jog with
 * no new/worse per-conductor defect, extra page or lost card locality. */
export async function repairRootedJogs(
  ir: Readonly<ElectricalIr>,
  original: RootedCandidate,
  native: RootedCandidate,
  page: PaperPage,
  run: RootedSearch,
  offset = 0,
) {
  if (
    run.attempts >= MAX_PLACEMENT_LAYOUTS ||
    economyExhausted(run) ||
    !jogCount(original) ||
    original.prepared.view.family !== "power" ||
    original.prepared.view.flow !== "top-to-bottom"
  )
    return original;
  run.attempts++;
  const minimum = 3 / original.scale;
  const deficit = sourceJogDeficit(original);
  const prepared = await repositionDrawing(
    original.prepared,
    actualChoices(original.prepared),
    deficit ? 0 : minimum,
    deficit ? Number(VERTICAL_POWER_EDGE_NODE_SPACING) + deficit + 0.001 : 0,
  );
  if (!prepared.ok) return original;
  const built = buildRootedCandidates(
    ir,
    prepared.value,
    page,
    original.profile,
    false,
    false,
    offset,
  );
  if (!built.ok) return original;
  const candidates = built.value
    .filter(
      (c) =>
        c.drafts.length <= original.drafts.length &&
        jogCount(c) < jogCount(original) &&
        !localityRegression(c, original) &&
        routeGrowth(c, original, false).every((n) => n === 0) &&
        routeGrowth(c, original).every((n) => n === 0),
    )
    .sort(
      (a, b) =>
        jogCount(a) - jogCount(b) ||
        a.drafts.length - b.drafts.length ||
        candidateUtilisation(b, page) - candidateUtilisation(a, page),
    );
  const candidate = candidates[0];
  if (!candidate) return original;
  const materialized = materializeRootedCandidate(ir, candidate, page);
  if (!materialized.ok) return original;
  candidate.drafts = materialized.value;
  if (
    !compositionFits(candidate, native, page) ||
    !preservesPrintedPages(ir, original, candidate, native, page)
  )
    return original;
  candidate.printableDrafts = materialized.value;
  return candidate;
}

export async function repairSearchJogs(
  ir: Readonly<ElectricalIr>,
  run: RootedSearch,
  page: PaperPage,
) {
  const original = rootedWinner(run, page),
    native = nativeWinner(run);
  if (!original || !native) return;
  const repaired = await repairRootedJogs(
    ir,
    original,
    native,
    page,
    run,
    run.referenceOffset ?? 0,
  );
  if (repaired !== original) run.candidates = [repaired];
}

/** Compare the final strip compositions too: equal virtual grids can fold to
 * different physical page counts after a reservation changes the strip widths. */
function preservesPrintedPages(
  ir: Readonly<ElectricalIr>,
  original: RootedCandidate,
  candidate: RootedCandidate,
  native: RootedCandidate,
  page: PaperPage,
) {
  const printed = original.printableDrafts
    ? { ok: true as const, value: original.printableDrafts }
    : materializeRootedCandidate(ir, original, page);
  if (!printed.ok) return false;
  const before = composeRootedWinner(
    ir,
    { ...original, drafts: printed.value },
    native,
    page,
  );
  const after = composeRootedWinner(ir, candidate, native, page);
  return after.drafts.length <= before.drafts.length;
}

/** Reserve only the measured source-side shortfall. One 0.001-unit coordinate
 * quantum prevents rounding from undoing the added physical turn clearance. */
function sourceJogDeficit(c: RootedCandidate) {
  const ports = new Set(
    c.prepared.graph.nodes.flatMap((node) =>
      node.kind === "symbol" && node.classification === "source"
        ? node.ports.map((p) => p.id)
        : [],
    ),
  );
  const edges = new Set(
    c.prepared.graph.edges
      .filter(
        (e) =>
          (c.jogs.get(e.id) ?? 0) > 0 &&
          (ports.has(e.sourcePortId) || ports.has(e.targetPortId)),
      )
      .map((e) => e.id),
  );
  return (
    Math.max(
      0,
      ...c.prepared.layout.edges
        .filter((e) => edges.has(e.id))
        .flatMap((e) => fragmentDefects(e.points, c.scale).jogs),
    ) / c.scale
  );
}
