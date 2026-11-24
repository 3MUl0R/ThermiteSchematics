import { AsyncLocalStorage } from "node:async_hooks";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { IrFunction } from "@thermite/compiler";
import { circuitInlineContext } from "../layout/circuit-inline-context.js";
import {
  layoutCircuitGroup,
  type CircuitLayoutRun,
} from "../layout/circuit-inline.js";
import { circuitPortGroups } from "../layout/circuit-port-order.js";
import { rememberCircuitDrawing } from "../layout/circuit-printed-layouts.js";
import { InlineLabelFitError } from "../layout/inline-label-error.js";
import { MAX_PLACEMENT_LAYOUTS } from "../packet/rooted-search.js";
import type { CircuitRenderError } from "../render-error-context.js";
import type { RenderFailure } from "../types.js";
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

export interface CircuitViewRecovery {
  firstError?: CircuitRenderError;
  attempts: number;
}

export type RecoveredPartition =
  | { readonly kind: "whole" }
  | {
      readonly kind: "parts";
      readonly unitIndices: readonly (readonly number[])[];
    };

const viewRecoveryScope = new AsyncLocalStorage<CircuitViewRecovery>();
const captionRecoverySink = new AsyncLocalStorage<
  (failure: RenderFailure) => void
>();
const recoveredCauses = new WeakMap<object, unknown>();
const recoveredRenderErrors = new WeakMap<object, CircuitRenderError>();
const runRecoveredCauses = new WeakMap<
  CircuitLayoutRun,
  Map<string, unknown>
>();
const runRecoveredPartitions = new WeakMap<
  CircuitLayoutRun,
  Map<string, RecoveredPartition>
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

export function withCircuitViewRecovery<T>(
  recovery: CircuitViewRecovery,
  fn: () => Promise<T>,
): Promise<T> {
  return viewRecoveryScope.run(recovery, fn);
}

export async function captureCaptionRecovery<T>(
  fn: () => Promise<T>,
): Promise<{ readonly result: T; readonly captionFailure?: RenderFailure }> {
  let captionFailure: RenderFailure | undefined;
  const result = await captionRecoverySink.run((failure) => {
    captionFailure ??= failure;
  }, fn);
  return captionFailure ? { result, captionFailure } : { result };
}

export function reportRecoveredCaptionFailure(failure: RenderFailure): void {
  captionRecoverySink.getStore()?.(failure);
}

export function recoveredCaptionCause(drawing: object): unknown {
  return recoveredCauses.get(drawing);
}

export function rememberRecoveredRenderError(
  drawing: object,
  error: CircuitRenderError,
): void {
  recoveredRenderErrors.set(drawing, error);
  const view = viewRecoveryScope.getStore();
  if (view && !view.firstError) view.firstError = error;
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

export function recordRecoveredPartition(
  groupId: string,
  partition: RecoveredPartition,
  run = circuitInlineContext.getStore()?.currentRun,
): void {
  if (!run || run.quality || circuitInlineContext.getStore()?.qualityPhase)
    return;
  const map = runRecoveredPartitions.get(run) ?? new Map();
  map.set(groupId, partition);
  runRecoveredPartitions.set(run, map);
}

export function qualityRecoveredPartition(
  groupId: string,
  run = circuitInlineContext.getStore()?.currentRun,
): RecoveredPartition | undefined {
  if (!run || (!run.quality && !circuitInlineContext.getStore()?.qualityPhase))
    return undefined;
  return runRecoveredPartitions.get(run)?.get(groupId);
}

export function throwRecoveredPartitionChange(): never {
  throw new InlineLabelFitError(
    "Circuit alternative does not preserve the recovered baseline partition.",
  );
}

export function replayRecoveredUnits<U>(
  units: readonly U[],
  replay: Extract<RecoveredPartition, { kind: "parts" }>,
): U[][] {
  return replay.unitIndices.map((indices) => {
    const items = indices.map((i) => units[i]);
    if (!items.length || items.some((u) => u === undefined))
      throwRecoveredPartitionChange();
    return items.filter((u): u is U => u !== undefined);
  });
}

export function conserveCircuitParts(
  groupId: string,
  original: {
    readonly conductorIds: readonly string[];
    readonly functionIds: readonly string[];
    readonly terminalIds: readonly string[];
  },
  drawings: readonly {
    readonly coverage: {
      readonly conductorIds: readonly string[];
      readonly functionIds: readonly string[];
      readonly terminalIds: readonly string[];
    };
  }[],
): void {
  const equal = (a: readonly string[], b: readonly string[]) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (
    !equal(
      drawings.flatMap((d) => d.coverage.conductorIds),
      original.conductorIds,
    ) ||
    !equal(
      [...new Set(drawings.flatMap((d) => d.coverage.functionIds))],
      original.functionIds,
    ) ||
    !equal(
      [...new Set(drawings.flatMap((d) => d.coverage.terminalIds))],
      original.terminalIds,
    )
  )
    throw new Error(
      `Circuit ${groupId}: pagination did not conserve the original source selection.`,
    );
}

function circuitRecoveryKey(
  params: CircuitAttemptParams,
  primaryKey: string,
): string {
  const fids = params.fs
    .map((f) => params.hooks.fkey(f))
    .sort(params.hooks.compare);
  const cids = params.cs.map((c) => c.id).sort(params.hooks.compare);
  return JSON.stringify([params.group.id, fids, cids, primaryKey]);
}

function canDispatchCaptionRetry(run?: CircuitLayoutRun): boolean {
  if (run) return run.attempts < MAX_PLACEMENT_LAYOUTS;
  const view = viewRecoveryScope.getStore();
  return !view || view.attempts < MAX_PLACEMENT_LAYOUTS;
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
  if (!params.run) {
    const view = viewRecoveryScope.getStore();
    if (view) view.attempts++;
  }
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
 * Recovery mode and first cause stay keyed per logical group or part, and the
 * added retry obeys the 48-placement ceiling without capping native rendering. */
export async function layoutCircuitGroupWithRetry(
  params: CircuitAttemptParams,
) {
  const primary = buildCircuitAttemptInput(params, true);
  const primaryKey = JSON.stringify(primary.input);
  const recoveryKey = circuitRecoveryKey(params, primaryKey);
  const inQualityPhase = Boolean(
    params.run?.quality || circuitInlineContext.getStore()?.qualityPhase,
  );
  if (params.run?.captionFallbacks.has(recoveryKey)) {
    const drawing = await renderCircuitAttempt(params, false);
    const savedCause = runRecoveredCauses.get(params.run)?.get(recoveryKey);
    if (savedCause && !inQualityPhase) recoveredCauses.set(drawing, savedCause);
    return drawing;
  }
  try {
    return await renderCircuitAttempt(params, true, primary);
  } catch (error) {
    if (
      !params.vertical ||
      inQualityPhase ||
      !(error instanceof CircuitCaptionCollisionError) ||
      !canDispatchCaptionRetry(params.run)
    )
      throw error;
    try {
      const drawing = await renderCircuitAttempt(params, false);
      recoveredCauses.set(drawing, error);
      if (params.run) {
        params.run.captionFallbacks.add(recoveryKey);
        const map = runRecoveredCauses.get(params.run) ?? new Map();
        map.set(recoveryKey, error);
        runRecoveredCauses.set(params.run, map);
      }
      return drawing;
    } catch {
      throw error;
    }
  }
}
