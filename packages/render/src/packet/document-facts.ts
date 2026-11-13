import { required } from "../presentation/util.js";
import { serializeIr, type ElectricalIr } from "@thermite/compiler";
import {
  buildDocumentation,
  type DocumentationTable,
  type ReportKind,
} from "@thermite/query";
import type { CompiledProjectPresentation } from "@thermite/compiler";
import { navigationHash } from "./navigation-identity.js";
import { sourceIncidences } from "./navigation-incidence.js";
import type {
  DocumentFact,
  DocumentNeed,
  DocumentIdentity,
  SemanticColumn,
} from "./document-types.js";
export function factKey(fact: DocumentFact): string {
  switch (fact.kind) {
    case "conductor-incidence":
      return JSON.stringify([
        fact.kind,
        fact.element.kind,
        fact.element.kind === "cable_conductor"
          ? [fact.element.cableUid, fact.element.conductorId]
          : fact.element.uid,
        fact.end,
        fact.terminal.deviceUid,
        fact.terminal.terminalKey,
      ]);
    case "terminal-inventory":
      return JSON.stringify([
        fact.kind,
        fact.terminal.deviceUid,
        fact.terminal.terminalKey,
      ]);
    case "port-link-status":
      return JSON.stringify([fact.kind, fact.deviceUid, fact.portKey]);
    case "core-inventory":
      return JSON.stringify([fact.kind, fact.cableUid, fact.conductorId]);
    case "assembly-pin-map":
      return JSON.stringify([fact.kind, fact.relationUid]);
    default:
      throw Error("Unsupported document fact");
  }
}
export const needColumns: Readonly<
  Record<DocumentNeed, readonly SemanticColumn[]>
> = {
  "conductor-incidence": ["identity", "endpoints", "status"],
  "terminal-inventory": ["identity", "connections", "status"],
  "port-link-status": ["identity", "endpoints", "protocol", "status"],
  "assembly-pin-map": ["identity", "endpoints", "status", "pin-map"],
  "core-inventory": ["identity", "endpoints", "status"],
};
export const documentLabel = (kind: string) =>
  ({
    wires: "wire inventory",
    terminals: "terminal inventory",
    network: "network inventory",
    assemblies: "assembly inventory",
  })[kind] ?? "inventory";
export function documentIdentity(
  ir: Readonly<ElectricalIr>,
  presentation?: CompiledProjectPresentation,
): Omit<DocumentIdentity, "id"> {
  return {
    snapshotDigest: navigationHash(serializeIr(ir)),
    presentationDigest: navigationHash(presentation ?? null),
    revision: presentation?.revision ?? "UNSPECIFIED",
  };
}
export function factReport(need: DocumentNeed): ReportKind {
  return (
    {
      "conductor-incidence": "wires",
      "terminal-inventory": "terminals",
      "port-link-status": "network",
      "assembly-pin-map": "assemblies",
      "core-inventory": "wires",
    } as const
  )[need];
}
export function factRowKey(fact: DocumentFact): string {
  switch (fact.kind) {
    case "conductor-incidence":
      return fact.element.kind === "cable_conductor"
        ? JSON.stringify([fact.element.cableUid, fact.element.conductorId])
        : fact.element.uid;
    case "terminal-inventory":
      return JSON.stringify([
        fact.terminal.deviceUid,
        fact.terminal.terminalKey,
      ]);
    case "assembly-pin-map":
      return fact.relationUid;
    case "core-inventory":
      return JSON.stringify([fact.cableUid, fact.conductorId]);
    case "port-link-status":
      return JSON.stringify([fact.deviceUid, fact.portKey]);
  }
}
export function rowFacts(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  key: string,
): {
  facts: DocumentFact[];
  columns: SemanticColumn[];
} {
  const incidences = sourceIncidences(ir);
  if (table.kind === "wires") {
    const facts: DocumentFact[] = incidences
      .filter((i) => factRowKey({ kind: "conductor-incidence", ...i }) === key)
      .map((i) => ({ kind: "conductor-incidence", ...i }));
    for (const cable of ir.cables) {
      const type = required(
        ir.cableTypes.find((t) => t.id === cable.typeId),
        "Missing document source",
      );
      for (const core of type.conductors)
        if (JSON.stringify([cable.uid, core.id]) === key)
          facts.push({
            kind: "core-inventory",
            cableUid: cable.uid,
            conductorId: core.id,
          });
    }
    return { facts, columns: ["identity", "endpoints", "status"] };
  }
  if (table.kind === "terminals") {
    const facts: DocumentFact[] = ir.terminals
      .filter((t) => JSON.stringify([t.id.deviceUid, t.id.terminalKey]) === key)
      .map((t) => ({ kind: "terminal-inventory", terminal: t.id }));
    return { facts, columns: ["identity", "connections", "status"] };
  }
  if (table.kind === "network") {
    const facts: DocumentFact[] = [];
    for (const d of ir.devices)
      for (const portKey of Object.keys(
        ir.deviceTypes.find((t) => t.id === d.typeId)?.ports ?? {},
      )) {
        const relation = ir.relations.find(
          (r) =>
            r.connection &&
            ((r.fromDeviceUid === d.uid && r.connection.fromPort === portKey) ||
              (r.toDeviceUid === d.uid && r.connection.toPort === portKey)),
        );
        if ((relation?.uid ?? JSON.stringify([d.uid, portKey])) === key)
          facts.push({ kind: "port-link-status", deviceUid: d.uid, portKey });
      }
    return { facts, columns: ["identity", "endpoints", "protocol", "status"] };
  }
  if (table.kind === "assemblies")
    return {
      facts: ir.relations
        .filter((r) => r.assembly && r.uid === key)
        .map((r) => ({ kind: "assembly-pin-map", relationUid: r.uid })),
      columns: ["identity", "endpoints", "status", "pin-map"],
    };
  return { facts: [], columns: [] };
}
/** Explicit device UIDs include non-strip terminals. Preserve whole native rows. */
export function factTable(
  ir: Readonly<ElectricalIr>,
  kind: ReportKind,
  facts: readonly DocumentFact[],
): DocumentationTable {
  const table = buildDocumentation(ir, {
    format: "documentation-view-request/0.1",
    kind,
    ...(kind === "terminals"
      ? {
          filter: {
            devices: [
              ...new Set(
                facts.flatMap((f) =>
                  f.kind === "terminal-inventory" ? [f.terminal.deviceUid] : [],
                ),
              ),
            ],
          },
        }
      : {}),
  });
  const wanted = new Set(facts.map(factKey));
  const { selection: _selection, ...native } = table;
  return {
    ...native,
    title: documentLabel(kind),
    rows: table.rows.filter((r) =>
      rowFacts(ir, table, r.key).facts.some((f) => wanted.has(factKey(f))),
    ),
    notes: [
      ...table.notes,
      "Companion inventory describes source facts only; it does not assess safety or completeness.",
    ],
  };
}
