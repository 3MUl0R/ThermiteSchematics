import { deepFreeze } from "../../internal.js";
import type { JsonValue } from "@thermite/schema";
import type {
  ElectricalIr,
  CompiledProjectPresentation,
} from "@thermite/compiler";
import type { SchematicPacketRequest } from "../../packet/types.js";
import type { PacketRequest, Presentation } from "./model.js";
import {
  validatePacketMetadata,
  validateInternalPresentation,
} from "./parse.js";
import {
  configureTitleFrame,
  registerTitlePresentation,
} from "./frame-context.js";
import { renderPacketWithAdvice } from "../../sheets.js";
import { selectCircuitPacket } from "../../layout/circuit-packet-selection.js";
import { withFontMetricCache } from "../../symbols/font-metric-cache.js";
import { titleFailure } from "./errors.js";

function snapshotTitleInputs(
  presentation: Presentation,
  metadata: PacketRequest,
) {
  // Only the authored-view cardinality is needed by the resolver. Real view
  // objects remain untouched in the request sent to the existing dispatcher.
  return deepFreeze({
    presentation: structuredClone(presentation),
    request: {
      format: "schematic-packet-request/0.2" as const,
      views: structuredClone(metadata.views),
      ...(metadata.titleData
        ? { titleData: structuredClone(metadata.titleData) }
        : {}),
    },
  });
}

/** Metadata parsing is deliberately blind to view contents. The unmodified
 * authored views go through the same strict dispatcher and source selection as
 * request/0.1, including page overrides and family-specific rejection order. */
export function prepareTitlePacket(
  request: PacketRequest | SchematicPacketRequest,
  presentation: Presentation,
) {
  const parsed = validateInternalPresentation(
    presentation as unknown as JsonValue,
  );
  if (!parsed.value) return titleFailure(parsed.diagnostics);
  const metadata = validatePacketMetadata({
    ...request,
    format: "schematic-packet-request/0.2",
    views: Array.isArray(request.views)
      ? request.views.map(() => ({}))
      : request.views,
  } as unknown as JsonValue);
  if (!metadata.value) return titleFailure(metadata.diagnostics);
  const legacy = {
    ...request,
    format: "schematic-packet-request/0.1" as const,
  };
  if (request.format === "schematic-packet-request/0.2")
    delete (legacy as { titleData?: unknown }).titleData;
  const context = snapshotTitleInputs(parsed.value, metadata.value);
  const source = context.presentation;
  const compiled: CompiledProjectPresentation = {
    format: "project-presentation/0.2",
    revision: source.revision ?? "UNSPECIFIED",
    backgroundColor: source.backgroundColor ?? "#ffffff",
    titleBlockLines: source.titleBlock?.lines ?? [],
    ...(source.page ? { page: source.page } : {}),
  };
  registerTitlePresentation(compiled, context);
  return { ok: true as const, value: { request: legacy, compiled, context } };
}
/** Hidden pre-publication entry. It exercises the actual packet pipeline. */
export function renderTitleFrameBenchmark(
  ir: Readonly<ElectricalIr>,
  request: PacketRequest | SchematicPacketRequest,
  presentation: Presentation,
) {
  return withFontMetricCache(async () => {
    const prepared = prepareTitlePacket(request, presentation);
    if (!prepared.ok) return prepared;
    const value = prepared.value;
    return selectCircuitPacket(value.request, () =>
      renderPacketWithAdvice(ir, value.request, value.compiled, true, (page) =>
        configureTitleFrame(page, value.context),
      ),
    );
  });
}
