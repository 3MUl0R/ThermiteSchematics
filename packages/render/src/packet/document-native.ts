import type { ElectricalIr } from "@thermite/compiler";
import { buildDocumentation, type DocumentationTable } from "@thermite/query";
import type { DocumentNeedSeed } from "./document-types.js";
import {
  factKey,
  factReport,
  needColumns,
  rowFacts,
} from "./document-facts.js";

/** The public query remains the source projection, including non-strip devices. */
export function nativeDocumentTable(
  ir: Readonly<ElectricalIr>,
  kind: string,
  rowKey: string,
): DocumentationTable | undefined {
  if (!["wires", "terminals", "network", "assemblies"].includes(kind))
    return undefined;
  let device: string | undefined;
  if (kind === "terminals") {
    try {
      const key: unknown = JSON.parse(rowKey);
      if (
        !Array.isArray(key) ||
        typeof key[0] !== "string" ||
        !ir.devices.some((d) => d.uid === key[0])
      )
        return undefined;
      device = key[0];
    } catch {
      return undefined;
    }
  }
  return buildDocumentation(ir, {
    format: "documentation-view-request/0.1",
    kind: kind as "wires" | "terminals" | "network" | "assemblies",
    ...(device ? { device } : {}),
  });
}
const keys = (value: object) => Object.keys(value).sort().join(",");
function factShape(fact: DocumentNeedSeed["requiredFacts"][number]) {
  const shapes = {
    "conductor-incidence": "element,end,kind,terminal",
    "terminal-inventory": "kind,terminal",
    "port-link-status": "deviceUid,kind,portKey",
    "core-inventory": "cableUid,conductorId,kind",
    "assembly-pin-map": "kind,relationUid",
  };
  if (!fact || keys(fact) !== shapes[fact.kind])
    throw Error("Invalid document fact schema");
  if (fact.kind === "conductor-incidence" || fact.kind === "terminal-inventory")
    if (!fact.terminal || keys(fact.terminal) !== "deviceUid,terminalKey")
      throw Error("Invalid terminal fact schema");
  if (
    fact.kind === "conductor-incidence" &&
    (!fact.element ||
      keys(fact.element) !==
        (fact.element.kind === "cable_conductor"
          ? "cableUid,conductorId,kind"
          : "kind,uid"))
  )
    throw Error("Invalid incidence fact schema");
}
export function validateDocumentNeed(
  ir: Readonly<ElectricalIr>,
  need: DocumentNeedSeed,
  cache = new Map<string, ReadonlySet<string>>(),
) {
  if (
    !need ||
    Object.keys(need).some(
      (k) =>
        ![
          "viewKey",
          "noteId",
          "need",
          "requiredFacts",
          "requiredColumns",
          "subject",
          "count",
        ].includes(k),
    ) ||
    !Object.hasOwn(needColumns, need.need) ||
    !need.noteId?.trim() ||
    !need.subject?.trim() ||
    !Array.isArray(need.requiredFacts) ||
    !Array.isArray(need.requiredColumns)
  )
    throw Error("Invalid document dependency schema");
  if (
    JSON.stringify(need.requiredColumns) !==
    JSON.stringify(needColumns[need.need])
  )
    throw Error("Required semantic columns are incomplete or unsupported");
  if (
    ["conductor-incidence", "terminal-inventory"].includes(need.need) &&
    need.count !== need.requiredFacts.length
  )
    throw Error("Hidden count does not equal native fact count");
  const seen = new Set<string>();
  for (const fact of need.requiredFacts) {
    factShape(fact);
    if (fact.kind !== need.need)
      throw Error("Document need and fact kinds disagree");
    const cacheKey =
      fact.kind === "terminal-inventory"
        ? `${need.need}/${fact.terminal.deviceUid}`
        : need.need;
    if (!cache.has(cacheKey)) {
      const table = nativeDocumentTable(
        ir,
        factReport(need.need),
        fact.kind === "terminal-inventory"
          ? JSON.stringify([fact.terminal.deviceUid, fact.terminal.terminalKey])
          : "",
      );
      cache.set(
        cacheKey,
        new Set(
          table?.rows.flatMap((r) =>
            rowFacts(ir, table, r.key).facts.map(factKey),
          ) ?? [],
        ),
      );
    }
    const key = factKey(fact);
    if (seen.has(key) || !cache.get(cacheKey)?.has(key))
      throw Error("Duplicate or non-native document fact");
    seen.add(key);
  }
}
