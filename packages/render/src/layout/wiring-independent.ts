import { wiringLandingInkFits } from "./wiring-landing-ink.js";
import type { ElkNode, ELK } from "elkjs/lib/elk-api.js";
import { independentWiringInput } from "./wiring-landings.js";
import { independentWiringRoutes } from "./wiring-independent-guard.js";
import {
  wiringGeometryInUnits,
  wiringSolverInput,
  WIRING_UNITS_PER_MM,
  WIRING_WIDE_UNITS_PER_MM,
} from "./wiring-unit-space.js";
import {
  assertTopologyIdentities,
  assertTopologyRouteEndpoints,
} from "./topology-conservation.js";
import { circuitConductorNonRegression } from "./circuit-route-quality.js";
import { circuitCrossingGuard } from "./circuit-native-guard.js";
import { ElkWorkBudgetError } from "./elk-work.js";

// Baseline, 0.5 mm independent layout, and guarded 0.625 mm symmetric fallback.
export const MAX_INDEPENDENT_WIRING_LAYOUTS = 3;
type WiringPlan = NonNullable<ReturnType<typeof independentWiringInput>>;
type WiringAttempt =
  | { status: "accepted"; graph: ElkNode }
  | { status: "ink-failed" }
  | { status: "rejected" };

function conserved(graph: ElkNode, expected: ElkNode) {
  try {
    assertTopologyIdentities(graph, expected);
    assertTopologyRouteEndpoints(graph);
    return true;
  } catch {
    return false;
  }
}

async function evaluateWiringPlan(
  plan: WiringPlan,
  baseline: ElkNode,
  engine: ELK,
  unitsPerMm: number,
  admit?: (candidate: ElkNode, original: ElkNode) => boolean,
  strokes?: ReadonlyMap<string, number>,
): Promise<WiringAttempt> {
  const solver = wiringSolverInput(plan.input, unitsPerMm),
    expected = structuredClone(solver);
  let native: ElkNode;
  try {
    native = await engine.layout(solver);
  } catch (error) {
    if (error instanceof ElkWorkBudgetError) return { status: "rejected" };
    throw error;
  }
  if (!conserved(native, expected)) return { status: "rejected" };
  const candidate = wiringGeometryInUnits(native, 1 / unitsPerMm);
  if (
    !conserved(candidate, plan.input) ||
    !independentWiringRoutes(candidate, plan.aliases)
  )
    return { status: "rejected" };
  if (!wiringLandingInkFits(candidate, plan.aliases, strokes))
    return { status: "ink-failed" };
  if (
    !circuitConductorNonRegression(candidate, baseline) ||
    !circuitCrossingGuard(candidate, baseline) ||
    (admit && !admit(candidate, baseline))
  )
    return { status: "rejected" };
  return { status: "accepted", graph: candidate };
}

export async function chooseIndependentWiring(
  input: ElkNode,
  baseline: ElkNode,
  engine: ELK,
  admit?: (candidate: ElkNode, original: ElkNode) => boolean,
  strokes?: ReadonlyMap<string, number>,
) {
  const plan = independentWiringInput(input, baseline);
  if (!plan) return baseline;
  const first = await evaluateWiringPlan(
    plan,
    baseline,
    engine,
    WIRING_UNITS_PER_MM,
    admit,
    strokes,
  );
  if (first.status === "accepted") return first.graph;
  if (first.status !== "ink-failed") return baseline;
  const wide = independentWiringInput(input, baseline, true);
  if (!wide) return baseline;
  const fallback = await evaluateWiringPlan(
    wide,
    baseline,
    engine,
    WIRING_WIDE_UNITS_PER_MM,
    admit,
    strokes,
  );
  return fallback.status === "accepted" ? fallback.graph : baseline;
}
