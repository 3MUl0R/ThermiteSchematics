import { diagnoseRooted } from "./rooted-diagnostics.js";
import { renderErrorContext } from "./render-error-context.js";
import { compareText, functionIdKey } from "./ordering.js";
import type {
  CompiledProjectPresentation,
  ElectricalIr,
} from "@thermite/compiler";
import type { ELK as ElkApi } from "elkjs/lib/elk-api.js";
import type { QueryEngine } from "@thermite/query";

import { deepFreeze } from "./internal.js";
import { layoutPresentationGraph } from "./layout/elk-adapter.js";
import { buildPresentationGraph } from "./presentation.js";
import {
  selectCableConductorSubgraph,
  selectLoadsSubgraph,
  selectSemanticSubgraph,
  selectTraceSubgraph,
} from "./selection.js";
import { orientSourceWindingMappings } from "./symbols/source-winding.js";
import { SYMBOL_CATALOG } from "./symbols/catalog.js";
import {
  CORE_DEVICE_TYPE_SYMBOL_MAPPINGS,
  projectDeviceTypeSymbolMappings,
  type DeviceTypeSymbolMapping,
} from "./symbols/mappings.js";
import type { SymbolDefinition } from "./symbols/types.js";
import { emitSchematicSvg } from "./svg/emitter.js";
import { preflightRenderText } from "./svg/escape.js";
import { prepareSchematicTitleContext } from "./title-block.js";
import type {
  RenderFailure,
  RenderOutcome,
  RenderedSchematic,
  SchematicRenderer,
  SchematicViewRequest,
} from "./types.js";
import { normalizeSchematicView } from "./view-spec.js";
import { traceRootRuleForType } from "./intent-rules.js";

export interface SchematicRendererDependencies {
  readonly mappings?: readonly DeviceTypeSymbolMapping[];
  readonly catalog?: readonly SymbolDefinition[];
  readonly queryEngineFactory?: (ir: Readonly<ElectricalIr>) => QueryEngine;
  readonly layoutEngine?: ElkApi;
  readonly spacingProfile?: "compact" | "dense";
}

function detachedFrozen<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}

function failed(error: RenderFailure): RenderOutcome<never> {
  return detachedFrozen({ ok: false as const, error });
}

function succeeded(value: RenderedSchematic): RenderOutcome<RenderedSchematic> {
  return detachedFrozen({ ok: true as const, value });
}

export interface PreparedSchematicDrawing {
  readonly graph: import("./types.js").PresentationGraph;
  readonly layout: import("./types.js").NormalizedSchematicLayout;
  readonly titleContext: import("./title-block.js").SchematicTitleContext;
  readonly summary: import("./types.js").RenderSummary;
  readonly view: import("./types.js").NormalizedSchematicView;
}

export async function prepareSchematicDrawing(
  ir: Readonly<ElectricalIr>,
  request: Readonly<SchematicViewRequest>,
  presentation?: Readonly<CompiledProjectPresentation>,
  dependencies: Readonly<SchematicRendererDependencies> = {},
  preNormalized?: ReturnType<typeof normalizeSchematicView>,
): Promise<RenderOutcome<PreparedSchematicDrawing>> {
  const mappings = dependencies.mappings ?? projectDeviceTypeSymbolMappings(ir);
  const catalog = dependencies.catalog ?? SYMBOL_CATALOG;
  const normalized =
    preNormalized ??
    normalizeSchematicView(ir, request, {
      mappings,
      ...(dependencies.queryEngineFactory === undefined
        ? {}
        : { queryEngineFactory: dependencies.queryEngineFactory }),
    });
  if (!normalized.ok) return failed(renderErrorContext(ir, normalized.error));

  const titleContext = prepareSchematicTitleContext(
    ir.project.name,
    normalized.value.view,
    presentation,
  );
  if (!titleContext.ok) return failed(titleContext.error);

  // Diagnose only actual failures: profile metadata cannot turn a successful
  // traversal or layout into an error (including unsupported side branches).
  const diagnose = (error: RenderFailure): RenderFailure =>
    diagnoseRooted(ir, normalized.value.view, mappings, error);

  const selected =
    normalized.value.view.format === "schematic-view/0.1"
      ? selectSemanticSubgraph({
          ir,
          view: normalized.value.view,
          engine: normalized.value.engine,
          mappings,
        })
      : normalized.value.view.intent === "trace"
        ? selectTraceSubgraph({
            ir,
            view: normalized.value.view,
            engine: normalized.value.engine,
            mappings,
            target: normalized.value.view.target,
            includePower: normalized.value.view.includePower,
          })
        : normalized.value.view.intent === "loads"
          ? selectLoadsSubgraph({
              ir,
              view: normalized.value.view,
              engine: normalized.value.engine,
              mappings,
              catalog,
            })
          : selectCableConductorSubgraph({
              ir,
              view: normalized.value.view,
              engine: normalized.value.engine,
              mappings,
              root:
                "rootSelector" in normalized.value
                  ? normalized.value.rootSelector
                  : (() => {
                      throw new Error(
                        "Prepared cable view omitted its root selector.",
                      );
                    })(),
            });
  if (!selected.ok) return failed(diagnose(selected.error));

  const presented = buildPresentationGraph({
    ir,
    selected: selected.value,
    mappings: orientSourceWindingMappings(ir, selected.value, mappings),
    catalog,
  });
  if (!presented.ok) return failed(diagnose(presented.error));

  const preflight = preflightRenderText(presented.value.graph);
  if (!preflight.ok) return failed(preflight.error);

  const laidOut = await layoutPresentationGraph(presented.value.graph, {
    catalog,
    selected: selected.value,
    ...(dependencies.spacingProfile
      ? { spacingProfile: dependencies.spacingProfile }
      : {}),
    ...(dependencies.layoutEngine === undefined
      ? {}
      : { engine: dependencies.layoutEngine }),
  });
  if (!laidOut.ok) {
    let error = laidOut.error;
    if (
      error.code === "R004" &&
      normalized.value.view.format === "schematic-view/0.2" &&
      normalized.value.view.intent === "loads"
    ) {
      const selectedIds = new Set(
        selected.value.functionIds.map(functionIdKey),
      );
      const loadFunctions = ir.functions.filter(
        (f) => f.kind === "load" && selectedIds.has(functionIdKey(f.id)),
      );
      const loads = ir.devices
        .filter((device) =>
          loadFunctions.some((f) => f.id.deviceUid === device.uid),
        )
        .map((device) => ({
          deviceUid: device.uid,
          designation: device.designation,
          functionIds: loadFunctions
            .filter((f) => f.id.deviceUid === device.uid)
            .map((f) => f.id),
        }))
        .sort((a, b) => compareText(a.designation, b.designation));
      if (loads.length >= 2) {
        const traceRoots = loads.filter((load) => {
          const device = ir.devices.find((d) => d.uid === load.deviceUid)!;
          return (
            traceRootRuleForType(
              device.typeId,
              ir.deviceTypes.find((t) => t.id === device.typeId),
              mappings.find((m) => m.typeId === device.typeId),
            ) !== undefined
          );
        });
        error = {
          ...error,
          message: `${error.message} Selected loads: ${loads.map((load) => load.designation).join(", ")}. Draw these loads in a circuit view built from details.loads with thermite packet --input.${traceRoots.map((load) => ` A trace can also start at ${load.designation}; choose its connected input target with --to and add --include-power.`).join("")}`,
          details: { ...error.details, loads },
        };
      }
    }
    return failed(renderErrorContext(ir, error));
  }

  return {
    ok: true,
    value: {
      graph: presented.value.graph,
      layout: laidOut.value,
      titleContext: titleContext.value,
      summary: presented.value.summary,
      view: normalized.value.view,
    },
  };
}

export function createSchematicRendererWithDependencies(
  dependencies: Readonly<SchematicRendererDependencies> = {},
): SchematicRenderer {
  return Object.freeze({
    async render(
      ir: Readonly<ElectricalIr>,
      request: Readonly<SchematicViewRequest>,
      presentation?: Readonly<CompiledProjectPresentation>,
    ): Promise<RenderOutcome<RenderedSchematic>> {
      const normalized = normalizeSchematicView(ir, request, {
        mappings: dependencies.mappings ?? projectDeviceTypeSymbolMappings(ir),
        ...(dependencies.queryEngineFactory === undefined
          ? {}
          : { queryEngineFactory: dependencies.queryEngineFactory }),
      });
      if (!normalized.ok)
        return failed(renderErrorContext(ir, normalized.error));
      const view = normalized.value.view;
      if (
        view.format === "schematic-view/0.2" &&
        view.intent === "conductors"
      ) {
        const cable = ir.cables.find(
          (entry) => entry.uid === view.root.cableUid,
        )!;
        if (cable.assignments !== undefined) {
          const { renderSchematicSheets } = await import("./sheets.js");
          const packet = await renderSchematicSheets(ir, request, presentation);
          if (!packet.ok) return failed(packet.error);
          if (packet.value.sheets.length !== 1)
            return failed({
              code: "R006",
              root: cable.designation,
              reason: "unprintable-layout",
              message:
                "This cable inventory needs multiple sheets. Use thermite view --conductors with HTML or JSON output to retain every core.",
            });
          const terminals = new Map(
            cable.assignments.flatMap((core) =>
              core.endpoints.flatMap((end) =>
                end === null
                  ? []
                  : [[JSON.stringify(end.terminal), end.terminal] as const],
              ),
            ),
          );
          const terminalIds = [...terminals.values()].sort((a, b) =>
            a.deviceUid < b.deviceUid
              ? -1
              : a.deviceUid > b.deviceUid
                ? 1
                : a.terminalKey < b.terminalKey
                  ? -1
                  : a.terminalKey > b.terminalKey
                    ? 1
                    : 0,
          );
          return succeeded({
            view,
            svg: packet.value.sheets[0]!.svg,
            summary: {
              deviceUids: [
                ...new Set(terminalIds.map((id) => id.deviceUid)),
              ].sort(),
              terminalIds,
              functionIds: [],
              presentationNodeIds: [],
              conductiveElementIds: ir.cableConductors
                .filter((core) => core.cableUid === cable.uid)
                .map((core) => ({ kind: "cable_conductor", ...core.id })),
              netIds: [
                ...new Set(
                  ir.indexes.netIdByTerminal
                    .filter(({ key }) =>
                      terminalIds.some(
                        (id) =>
                          id.deviceUid === key.deviceUid &&
                          id.terminalKey === key.terminalKey,
                      ),
                    )
                    .map(({ value }) => value),
                ),
              ].sort(),
            },
          });
        }
      }
      const prepared = await prepareSchematicDrawing(
        ir,
        request,
        presentation,
        dependencies,
        normalized,
      );
      if (!prepared.ok) return failed(prepared.error);
      const { graph, layout, titleContext, summary } = prepared.value;
      const emitted = emitSchematicSvg(
        graph,
        layout,
        titleContext,
        dependencies.catalog ?? SYMBOL_CATALOG,
        false,
        undefined,
        ir,
      );
      if (!emitted.ok) return failed(emitted.error);
      return succeeded({ view, summary, svg: emitted.value });
    },
  });
}

export function createSchematicRenderer(): SchematicRenderer {
  return createSchematicRendererWithDependencies();
}

export function renderSchematic(
  ir: Readonly<ElectricalIr>,
  request: Readonly<SchematicViewRequest>,
  presentation?: Readonly<CompiledProjectPresentation>,
): Promise<RenderOutcome<RenderedSchematic>> {
  return createSchematicRenderer().render(ir, request, presentation);
}
