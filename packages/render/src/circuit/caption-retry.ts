import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { IrFunction } from "@thermite/compiler";
import { circuitInlineContext } from "../layout/circuit-inline-context.js";
import {
  layoutCircuitGroup,
  type CircuitLayoutRun,
} from "../layout/circuit-inline.js";
import { circuitPortGroups } from "../layout/circuit-port-order.js";
import { rememberCircuitDrawing } from "../layout/circuit-printed-layouts.js";
import type { CircuitRenderError } from "../render-error-context.js";
import { CircuitCaptionCollisionError } from "./caption-error.js";
import { renderCircuitLayout } from "./layout-drawing.js";
import {
  circuitGraphChildren,
  circuitGraphEdge,
  circuitGraphInput,
  type CircuitPins,
  type LayoutGroup,
  type LayoutHooks,
} from "./layout-input.js";
import { circuitRouteState } from "./layout-routes.js";
import type { DeviceNode, PhysicalConductor } from "./types.js";

const recoveredCauses = new WeakMap<object, unknown>();
const recoveredRenderErrors = new WeakMap<object, CircuitRenderError>();
const runRecoveredCauses = new WeakMap<
  CircuitLayoutRun,
  Map<string, unknown>
>();

export interface CircuitAttemptParams {
  group: LayoutGroup;
  fs: IrFunction[];
  cs: PhysicalConductor[];
  nodes: DeviceNode[];
  pins: CircuitPins;
  vertical: boolean;
  hooks: LayoutHooks;
  run?: CircuitLayoutRun | undefined;
}

export function recoveredCaptionCause(drawing: object): unknown {
  return recoveredCauses.get(drawing);
}

export function rememberRecoveredRenderError(
  drawing: object,
  error: CircuitRenderError,
): void {
  recoveredRenderErrors.set(drawing, error);
}

export function recoveredCaptionError(
  drawing: object,
): CircuitRenderError | undefined {
  return recoveredRenderErrors.get(drawing);
}

export function rethrowRecoveredFirstError(
  original: object,
  error: unknown,
): never {
  const firstError = recoveredRenderErrors.get(original);
  if (firstError && !circuitInlineContext.getStore()?.qualityPhase)
    throw firstError;
  throw error;
}

function buildCircuitAttemptInput(
  params: CircuitAttemptParams,
  inlineLabel: boolean,
) {
  const children = circuitGraphChildren(params.nodes);
  const selfLoops = new Set<number>();
  const edges = params.cs.map((c, i) =>
    circuitGraphEdge(
      c,
      i,
      params.group,
      params.pins,
      selfLoops,
      params.hooks,
      inlineLabel,
    ),
  );
  const input = circuitGraphInput(
    children,
    edges,
    selfLoops,
    params.vertical,
    params.cs,
  );
  return { input, selfLoops };
}

async function renderCircuitAttempt(
  params: CircuitAttemptParams,
  inlineLabel: boolean,
  prebuilt?: { input: ElkNode; selfLoops: Set<number> },
) {
  const { input, selfLoops } =
    prebuilt ?? buildCircuitAttemptInput(params, inlineLabel);
  const graph = await layoutCircuitGroup(
    input,
    params.run,
    new Map(params.cs.map((c, i) => [`e${i}`, c.jumper ? 0.55 : 0.32])),
    circuitPortGroups(params.nodes),
  );
  const state = circuitRouteState(
    graph,
    params.nodes,
    params.cs,
    params.group,
    params.hooks,
  );
  return rememberCircuitDrawing(
    renderCircuitLayout(
      state,
      params.fs,
      params.pins,
      selfLoops,
      params.vertical,
    ),
    input,
    params.run,
  );
}

/** Retry a vertical circuit group once with non-inline ELK edge labels when
 * post-recovery caption association or plate obstruction fails in baseline.
 * Quality recomposition replays the accepted baseline mode without new recovery. */
export async function layoutCircuitGroupWithRetry(
  params: CircuitAttemptParams,
) {
  const primary = buildCircuitAttemptInput(params, true);
  const primaryKey = JSON.stringify(primary.input);
  const inQualityPhase = Boolean(
    params.run?.quality || circuitInlineContext.getStore()?.qualityPhase,
  );
  if (params.run?.captionFallbacks.has(primaryKey)) {
    const drawing = await renderCircuitAttempt(params, false);
    const savedCause = runRecoveredCauses.get(params.run)?.get(primaryKey);
    if (savedCause && !inQualityPhase) recoveredCauses.set(drawing, savedCause);
    return drawing;
  }
  try {
    return await renderCircuitAttempt(params, true, primary);
  } catch (error) {
    if (
      !params.vertical ||
      inQualityPhase ||
      !(error instanceof CircuitCaptionCollisionError)
    )
      throw error;
    try {
      const drawing = await renderCircuitAttempt(params, false);
      recoveredCauses.set(drawing, error);
      if (params.run) {
        params.run.captionFallbacks.add(primaryKey);
        const map = runRecoveredCauses.get(params.run) ?? new Map();
        map.set(primaryKey, error);
        runRecoveredCauses.set(params.run, map);
      }
      return drawing;
    } catch {
      throw error;
    }
  }
}
