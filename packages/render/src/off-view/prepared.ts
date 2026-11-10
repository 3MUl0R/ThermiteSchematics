import type { ElectricalIr } from "@thermite/compiler";
import type { PreparedSchematicDrawing } from "../renderer.js";
import type {
  PresentationGraph,
  SelectedSubgraph,
  RenderOutcome,
} from "../types.js";
import type { DeviceTypeSymbolMapping } from "../symbols/mappings.js";
import {
  layoutPresentationGraph,
  type ElkLayoutRequestOptions,
} from "../layout/elk-adapter.js";
import { validatePresentationGraph } from "../presentation/validate.js";
import { preflightRenderText } from "../svg/escape.js";
import { nativeReservations } from "./native.js";
import { addOffViewCards, offViewLayoutFailure } from "./presentation.js";
import { recoverCardLayout } from "./recover.js";
import { required } from "../presentation/util.js";

export interface DrawingContext {
  ir: Readonly<ElectricalIr>;
  selected: Readonly<SelectedSubgraph>;
  mappings: readonly DeviceTypeSymbolMapping[];
  options: Readonly<ElkLayoutRequestOptions>;
}
const contexts = new WeakMap<PreparedSchematicDrawing, DrawingContext>();
export function rememberDrawing(
  p: PreparedSchematicDrawing,
  context: DrawingContext,
) {
  contexts.set(p, context);
  return p;
}
export async function initialCardLayout(
  graph: PresentationGraph,
  c: DrawingContext,
  repair: boolean,
) {
  const layout = await layoutPresentationGraph(graph, c.options);
  if (!layout.ok && repair && layout.failureKind === "symbol-intersection") {
    const recovered = await recoverCardLayout(
      c.ir,
      graph,
      c.selected,
      c.mappings,
      c.options,
    );
    if (recovered) return recovered;
  }
  return { graph, layout };
}

/** Same selected graph and source context, fresh reservations and ELK. Avoid
 * re-running selection/normalisation for each purely visual alternative. */
export async function repositionDrawing(
  p: PreparedSchematicDrawing,
  choices: Readonly<Record<string, number>>,
): Promise<RenderOutcome<PreparedSchematicDrawing>> {
  const c = required(contexts.get(p), "Missing prepared source context");
  const annotated = addOffViewCards(c.ir, nativeReservations(p.graph), choices);
  if (!annotated.ok) return annotated;
  validatePresentationGraph(c.ir, c.selected, annotated.value, c.mappings);
  const preflight = preflightRenderText(annotated.value);
  if (!preflight.ok) return preflight;
  const layout = await layoutPresentationGraph(annotated.value, c.options);
  if (!layout.ok)
    return {
      ok: false,
      error: offViewLayoutFailure(annotated.value, layout.error),
    };
  return {
    ok: true,
    value: rememberDrawing(
      { ...p, graph: annotated.value, layout: layout.value },
      c,
    ),
  };
}

/** Reuse the exact validated selection/options for the no-card comparison. */
export async function nativeDrawing(
  p: PreparedSchematicDrawing,
): Promise<RenderOutcome<PreparedSchematicDrawing>> {
  const c = required(contexts.get(p), "Missing prepared source context"),
    graph = nativeReservations(p.graph);
  const layout = await layoutPresentationGraph(graph, c.options);
  return layout.ok
    ? { ok: true, value: { ...p, graph, layout: layout.value } }
    : { ok: false, error: layout.error };
}
