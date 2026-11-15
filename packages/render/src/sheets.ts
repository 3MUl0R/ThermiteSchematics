import { finalizeTitleData } from "./internal/title-data/finalize.js";
import {
  packetFrameMetadata,
  authoredTitlePresentation,
} from "./internal/title-data/frame-context.js";
import { withFontMetricCache } from "./symbols/font-metric-cache.js";
import {
  fitLegendDrafts,
  type LegendViewDrafts,
} from "./packet/device-legend.js";
import { circuitPreviewSheets as legendSheets } from "./layout/circuit-preview-cache.js";
import { rootedPageCostFailure } from "./packet/rooted-bound.js";
import { renderErrorContext } from "./render-error-context.js";
import { referenceTables } from "./packet/references.js";
import { viewDrafts } from "./packet/dispatch.js";
import { circuitSelectionContext } from "./packet/circuit.js";
import { appendViewDrafts } from "./packet/assembly.js";
import { navigationViewKey } from "./packet/navigation-identity.js";
import { centroidReferences } from "./packet/navigation-occurrences.js";
import { seedCircuitNavigation } from "./packet/navigation-circuit.js";
import { appendDocumentCompanions } from "./packet/document-companions.js";

import {
  circuitFunctionAppearances,
  type CircuitViewRequest,
} from "./circuit.js";

import {
  buildPacketCoverage,
  packetDeviceCoverageDiagnostics,
} from "./coverage.js";

import type {
  CompiledProjectPresentation,
  ElectricalIr,
} from "@thermite/compiler";
import {
  type DocumentationSelection,
  resolveDeviceFilter,
} from "@thermite/query";

import type { RenderOutcome, SchematicViewRequest } from "./types.js";

import type {
  SchematicPacketRequest,
  RenderedPacket,
  ReferenceSelection,
  Draft,
  PageSettings,
} from "./packet/types.js";
export type {
  PageSettings,
  PacketRenderOptions,
  PaperPage,
  SchematicPacketRequest,
  SheetReference,
  NormalizedDocumentationView,
  RenderedSheet,
  CommunicationContinuation,
  CircuitContinuation,
  RenderedPacket,
  ReferenceSelection,
} from "./packet/types.js";
import {
  failure,
  record,
  packetViewContext,
  withPacketViews,
  PacketDraftError,
  composedPacketFailure,
} from "./packet/errors.js";
import { normalizePaperPage, sheetLabel } from "./packet/page.js";
export { normalizePaperPage, sheetLabel } from "./packet/page.js";
import { printPacketHtml } from "./packet/html.js";
export { printPacketHtml } from "./packet/html.js";

import { tableDrafts } from "./packet/reports.js";

async function renderPacket(
  ir: Readonly<ElectricalIr>,
  request: SchematicPacketRequest,
  presentation: Readonly<CompiledProjectPresentation> | undefined,
  explicitPacket: boolean,
  configurePage?: (page: import("./packet/types.js").PaperPage) => void,
): Promise<RenderOutcome<RenderedPacket>> {
  const contextError: typeof withPacketViews = (error, views) =>
    explicitPacket ? withPacketViews(error, views) : error;
  if (
    !record(request) ||
    request.format !== "schematic-packet-request/0.1" ||
    Object.keys(request).some(
      (key) =>
        !["format", "page", "views", "layout", "index", "references"].includes(
          key,
        ),
    ) ||
    (request.index !== undefined && typeof request.index !== "boolean") ||
    (request.layout !== undefined &&
      !["standard", "compact"].includes(request.layout)) ||
    !Array.isArray(request.views) ||
    request.views.length < 1 ||
    request.views.length > 40
  )
    return failure(
      "invalid-packet",
      "A packet requires format schematic-packet-request/0.1 and 1–40 views, with an optional shared page.",
    );
  if (
    request.references !== undefined &&
    (request.index !== true ||
      (request.references !== false &&
        (!record(request.references) ||
          !Object.keys(request.references).length ||
          Object.keys(request.references).some(
            (k) => !["filter", "appearances"].includes(k),
          ) ||
          (Object.hasOwn(request.references, "appearances") &&
            !["all", "drawings"].includes(request.references.appearances!)) ||
          (Object.hasOwn(request.references, "filter") &&
            request.references.filter === undefined))))
  )
    return failure(
      "invalid-packet",
      "Reference options require index: true and either false or filter/appearances settings.",
    );
  let referenceDevices: ReturnType<typeof resolveDeviceFilter> | undefined;
  try {
    if (request.references && request.references.filter !== undefined)
      referenceDevices = resolveDeviceFilter(ir, request.references.filter);
  } catch (e) {
    return failure(
      "invalid-packet",
      e instanceof Error ? e.message : "Invalid reference filter.",
    );
  }
  const paper = packetPaperPage(request, presentation, configurePage);
  if (!paper.ok) return paper;
  let drafts: Draft[] = [];
  const legendViews: LegendViewDrafts[] = [];
  const composedFailure = (message: string) =>
    composedPacketFailure(message, drafts, contextError);
  const documentationSelections: (DocumentationSelection & { view: number })[] =
    [];
  let referenceSelection: ReferenceSelection | undefined;
  let referenceNumber = 0;
  const circuitAppearances = new Map<string, string[]>();
  const navigationDuplicates = new Map<string, number>();
  for (const [viewIndex, view] of request.views.entries()) {
    if (!record(view) || view.format !== "circuit-view-request/0.1") continue;
    try {
      for (const [key, labels] of circuitFunctionAppearances(ir, [
        view as unknown as CircuitViewRequest,
      ]))
        circuitAppearances.set(key, [
          ...new Set([...(circuitAppearances.get(key) ?? []), ...labels]),
        ]);
    } catch (error) {
      const failed = invalidCircuitFailure(ir, view, error);
      if (!failed.ok)
        return {
          ok: false,
          error: contextError(failed.error, [
            packetViewContext(view, viewIndex, ir),
          ]),
        };
    }
  }
  for (const [viewIndex, view] of request.views.entries()) {
    const context = packetViewContext(view, viewIndex, ir);
    if (record(view) && Object.hasOwn(view, "page")) {
      const failed = failure(
        "invalid-packet",
        "Individual views cannot override the packet's shared page settings.",
      );
      if (!failed.ok)
        return { ok: false, error: contextError(failed.error, [context]) };
    }
    const result = await viewDrafts(
      ir,
      view,
      authoredTitlePresentation(
        presentation,
        paper.value,
        viewIndex,
        drafts.length + 1,
      ),
      paper.value,
      request.layout,
      circuitAppearances,
      referenceNumber,
    );
    if (!result.ok)
      return {
        ok: false,
        error: contextError(renderErrorContext(ir, result.error), [context]),
      };
    const reportSelection = result.value[0]?.documentationSelection;
    if (record(view) && view.format === "circuit-view-request/0.1")
      seedCircuitNavigation(ir, result.value);
    const normalizedSelection = result.value[0]?.view.format.startsWith(
      "schematic-view/",
    )
      ? result.value[0].view
      : view;
    const identityKey = navigationViewKey(ir, normalizedSelection, 0);
    const ordinal = navigationDuplicates.get(identityKey) ?? 0;
    navigationDuplicates.set(identityKey, ordinal + 1);
    const navigationView = {
      key: navigationViewKey(ir, normalizedSelection, ordinal),
      authoredOrder: viewIndex,
    };
    if (reportSelection)
      documentationSelections.push({ ...reportSelection, view: viewIndex + 1 });
    legendViews.push({
      drafts: structuredClone(result.value),
      viewIndex,
      context,
      navigationView,
    });
    referenceNumber = appendViewDrafts(
      drafts,
      result.value,
      viewIndex,
      request.layout,
      referenceNumber,
      context,
      navigationView,
    );
    if (drafts.length > 100)
      return composedFailure(
        "Packet exceeds the 100-sheet alpha limit; split it into smaller packets.",
      );
  }
  const legendFit = fitPacketLegends(
    ir,
    drafts,
    legendViews,
    paper.value,
    request.layout,
    contextError,
  );
  if (!legendFit.ok)
    return {
      ok: false,
      error: contextError(
        legendFit.error,
        drafts.flatMap((d) => d.views ?? []),
      ),
    };
  drafts = legendFit.value;
  const pageCost = checkedPageCost(drafts, contextError);
  if (!pageCost.ok) return pageCost;
  const companions = packetCompanions(
    ir,
    drafts,
    paper.value,
    presentation,
    explicitPacket,
    contextError,
  );
  if (!companions.ok) return companions;
  drafts = companions.value;
  if (request.index) {
    const located = legendSheets(ir, drafts, paper.value);
    if (!located.ok) return located;
    centroidReferences(drafts, located.navigation?.occurrences ?? []);
    const indexes = referenceTables(ir, drafts, request, referenceDevices);
    referenceSelection = indexes.referenceSelection;
    for (const table of indexes.tables) {
      const extra = tableDrafts(ir, table, presentation, paper.value);
      if (!extra.ok)
        return {
          ok: false,
          error: contextError(
            extra.error,
            drafts.flatMap((d) => d.views ?? []),
          ),
        };
      drafts.push(...extra.value);
    }
  }
  if (drafts.length > 100)
    return composedFailure(
      "Packet exceeds the 100-sheet limit including indexes.",
    );
  return assemblePacket(
    ir,
    drafts,
    paper.value,
    explicitPacket,
    documentationSelections,
    referenceSelection,
    presentation,
  );
}
function checkedPageCost(
  drafts: Draft[],
  contextError: typeof withPacketViews,
): RenderOutcome<Draft[]> {
  const error = rootedPageCostFailure(drafts);
  return error
    ? {
        ok: false,
        error: contextError(
          error,
          drafts.flatMap((d) => d.views ?? []),
        ),
      }
    : { ok: true, value: drafts };
}
function packetCompanions(
  ir: Readonly<ElectricalIr>,
  drafts: Draft[],
  page: import("./packet/types.js").PaperPage,
  presentation: CompiledProjectPresentation | undefined,
  explicit: boolean,
  contextError: typeof withPacketViews,
): RenderOutcome<Draft[]> {
  const result = explicit
    ? appendDocumentCompanions(ir, drafts, page, presentation)
    : { ok: true as const, value: drafts };
  return result.ok
    ? result
    : {
        ok: false,
        error: contextError(
          result.error,
          drafts.flatMap((d) => d.views ?? []),
        ),
      };
}
function fitPacketLegends(
  ir: Readonly<ElectricalIr>,
  drafts: Draft[],
  views: readonly LegendViewDrafts[],
  page: import("./packet/types.js").PaperPage,
  layout: "standard" | "compact" | undefined,
  contextError: typeof withPacketViews,
): RenderOutcome<Draft[]> {
  try {
    return fitLegendDrafts(ir, drafts, views, page, layout, legendSheets);
  } catch (error) {
    return assemblyError(error, drafts, contextError);
  }
}
function assemblePacket(
  ir: Readonly<ElectricalIr>,
  drafts: Draft[],
  page: import("./packet/types.js").PaperPage,
  explicitPacket: boolean,
  documentationSelections: readonly (DocumentationSelection & {
    view: number;
  })[],
  referenceSelection: ReferenceSelection | undefined,
  presentation: CompiledProjectPresentation | undefined,
): RenderOutcome<RenderedPacket> {
  const contextError: typeof withPacketViews = (error, views) =>
    explicitPacket ? withPacketViews(error, views) : error;
  try {
    const titles = finalizeTitleData(ir, drafts, page, presentation);
    if (!titles.ok) return titles;
    const rendered = legendSheets(ir, drafts, page, true, {
      presentation,
      standalone: !explicitPacket,
    });
    if (!rendered.ok)
      return {
        ok: false,
        error: contextError(
          rendered.error,
          drafts.flatMap((d) => d.views ?? []),
        ),
      };
    const sheets = rendered.value;
    const diagnostics = explicitPacket
      ? packetDeviceCoverageDiagnostics(
          ir,
          sheets.map((sheet, i) => ({
            number: sheet.number,
            schematic: !drafts[i]!.documentationTable,
            references: sheet.references,
          })),
        )
      : [];
    diagnostics.push(...drafts.flatMap((d) => d.diagnostics ?? []));
    return {
      ok: true,
      value: {
        format: "schematic-packet/0.1",
        ...packetFrameMetadata(page),
        page: page,
        sheets,
        html: printPacketHtml(sheets, page, ir.project.name),
        coverage: {
          ...buildPacketCoverage(
            ir,
            drafts.map((draft, i) => ({
              sheet: i + 1,
              view: sheetLabel(draft.view),
              drawings: draft.coverage ?? [],
              topologyDrawings: draft.topologyCoverage ?? [],
            })),
          ),
          ...(diagnostics.length ? { diagnostics } : {}),
        },
        ...(documentationSelections.length ? { documentationSelections } : {}),
        ...(rendered.navigation ? { navigation: rendered.navigation } : {}),
        ...(referenceSelection ? { referenceSelection } : {}),
      },
    };
  } catch (error) {
    return assemblyError(error, drafts, contextError);
  }
}
function assemblyError(
  error: unknown,
  drafts: readonly Draft[],
  contextError: typeof withPacketViews,
): RenderOutcome<never> {
  const failed = failure(
    "unprintable-layout",
    error instanceof Error
      ? error.message
      : "Unable to produce the sheet title block.",
  );
  return !failed.ok
    ? {
        ok: false,
        error: contextError(
          failed.error,
          error instanceof PacketDraftError
            ? error.views
            : drafts.flatMap((d) => d.views ?? []),
        ),
      }
    : failed;
}

function invalidCircuitFailure(
  ir: Readonly<ElectricalIr>,
  view: unknown,
  error: unknown,
) {
  return failure(
    "invalid-packet",
    error instanceof Error ? error.message : "Invalid circuit view.",
    circuitSelectionContext(ir, view as CircuitViewRequest),
  );
}

function compactAdviceView(
  request: SchematicPacketRequest,
  details: Readonly<Record<string, unknown>> | undefined,
) {
  const index =
    typeof details?.viewIndex === "number"
      ? details.viewIndex
      : request.views.length === 1
        ? 0
        : undefined;
  const view = index === undefined ? undefined : request.views[index];
  return (
    record(view) &&
    (view.format === "schematic-view-request/0.1" ||
      view.format === "schematic-view-request/0.2") &&
    view.flow === "top-to-bottom"
  );
}

export async function renderPacketWithAdvice(
  ir: Readonly<ElectricalIr>,
  request: SchematicPacketRequest,
  presentation: Readonly<CompiledProjectPresentation> | undefined,
  explicitPacket: boolean,
  configurePage?: (page: import("./packet/types.js").PaperPage) => void,
  options?: import("./packet/types.js").PacketRenderOptions,
): Promise<RenderOutcome<RenderedPacket>> {
  if (
    presentation?.format === "project-presentation/0.3" ||
    request?.format === "schematic-packet-request/0.2"
  ) {
    const { renderTitlePacket } =
      await import("./internal/title-data/entry.js");
    return renderTitlePacket(
      ir,
      request,
      presentation,
      explicitPacket,
      configurePage,
      options,
    );
  }
  const result = await renderPacket(
    ir,
    request,
    presentation,
    explicitPacket,
    configurePage,
  );
  if (
    result.ok ||
    result.error.code !== "R006" ||
    result.error.reason !== "unprintable-layout" ||
    result.error.details?.navigationInvariant ||
    request.layout === "compact" ||
    !compactAdviceView(request, result.error.details)
  )
    return result;
  // Advice is evidence about the complete export, including assembly and the
  // packet page-cost bound. It never substitutes a different drawing.
  try {
    const compact = await renderPacket(
      ir,
      { ...request, layout: "compact" },
      presentation,
      explicitPacket,
      configurePage,
    );
    return compact.ok
      ? {
          ok: false,
          error: {
            ...result.error,
            message: `${result.error.message} Try --layout compact; it produces a printable version of this packet on this page.`,
            details: { ...result.error.details, compactLayoutAvailable: true },
          },
        }
      : result;
  } catch {
    return result;
  }
}

export function renderSchematicPacket(
  ir: Readonly<ElectricalIr>,
  request: SchematicPacketRequest,
  presentation?: Readonly<CompiledProjectPresentation>,
  options?: import("./packet/types.js").PacketRenderOptions,
): Promise<RenderOutcome<RenderedPacket>> {
  return withFontMetricCache(() =>
    renderPacketWithAdvice(ir, request, presentation, true, undefined, options),
  );
}
export function renderSchematicSheets(
  ir: Readonly<ElectricalIr>,
  view: SchematicPacketRequest["views"][number],
  presentation?: Readonly<CompiledProjectPresentation>,
  page?: PageSettings,
  options: Pick<SchematicPacketRequest, "layout" | "index"> = {},
): Promise<RenderOutcome<RenderedPacket>> {
  return withFontMetricCache(() =>
    renderPacketWithAdvice(
      ir,
      {
        ...options,
        format: "schematic-packet-request/0.1",
        ...(page === undefined ? {} : { page }),
        views: [view],
      },
      presentation,
      false,
    ),
  );
}

function packetPaperPage(
  request: SchematicPacketRequest,
  presentation: Readonly<CompiledProjectPresentation> | undefined,
  configurePage:
    ((page: import("./packet/types.js").PaperPage) => void) | undefined,
) {
  const paper = normalizePaperPage(
    Object.hasOwn(request, "page")
      ? record(request.page)
        ? { ...presentation?.page, ...request.page }
        : request.page
      : (presentation?.page ?? {}),
  );
  if (paper.ok) configurePage?.(paper.value);
  return paper;
}
