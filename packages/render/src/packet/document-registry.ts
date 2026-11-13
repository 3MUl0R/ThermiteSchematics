import type { DocumentationTable } from "@thermite/query";
import type { Rect } from "../device-legend/geometry.js";
import { required } from "../presentation/util.js";
import type {
  ElectricalIr,
  CompiledProjectPresentation,
} from "@thermite/compiler";
import type { Draft, RenderedSheet, PaperPage } from "./types.js";
import type {
  DocumentDependency,
  DocumentIdentity,
  DocumentRowDraft,
  IssuedDocument,
  IssuedDocumentRow,
} from "./document-types.js";
import {
  documentIdentity,
  documentLabel,
  factKey,
  rowFacts,
} from "./document-facts.js";
import { navigationGeometry } from "./navigation-walk.js";
import { bounds } from "./page.js";
import { navigationHash } from "./navigation-identity.js";
import { navigationZone, roundNavigation } from "./navigation-location.js";
import { documentRowLabel } from "./document-row-label.js";
import { reportIdentifiers } from "./report-identifiers.js";
import { nativeDocumentTable } from "./document-native.js";
import {
  printedDocumentRegion,
  printedDocumentLabel,
} from "./document-visible.js";
function printedRows(
  ir: Readonly<ElectricalIr>,
  draft: Draft,
  sheet: RenderedSheet,
  page: PaperPage,
): IssuedDocumentRow[] {
  const geometry = navigationGeometry(sheet.svg),
    header = draft.documentHeader;
  if (!header) return [];
  const tables = new Map<string, ReturnType<typeof nativeDocumentTable>>();
  return (draft.documentRows ?? []).flatMap((r) => {
    const kind = "kind" in draft.view ? draft.view.kind : "unknown";
    if (
      !printedDocumentLabel(header, documentLabel(kind), geometry, sheet.number)
    )
      return [];
    const cacheKey =
      kind === "terminals"
        ? required(
            JSON.stringify(r.nativeKey).split(",")[0],
            "Missing document source",
          )
        : kind;
    if (!tables.has(cacheKey))
      tables.set(cacheKey, nativeDocumentTable(ir, kind, r.nativeKey));
    const table = tables.get(cacheKey),
      native = table?.rows.find((row) => row.key === r.nativeKey);
    if (
      !table ||
      !native ||
      JSON.stringify(r.cells) !== JSON.stringify(native.cells) ||
      JSON.stringify(header.cells) !== JSON.stringify(table.columns)
    )
      return [];
    if (!printedDocumentRegion(header, table.columns, geometry, sheet.number))
      return [];
    const identifiers = reportIdentifiers(ir, { ...table, rows: [native] }).get(
      r.nativeKey,
    );
    const rectMm = printedDocumentRegion(
      r,
      table.columns,
      geometry,
      sheet.number,
      identifiers,
    );
    if (!rectMm) return [];
    return [locatedRow(ir, table, r, draft, sheet.number, page, rectMm)];
  });
}
function locatedRow(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  r: DocumentRowDraft,
  draft: Draft,
  sheet: number,
  page: PaperPage,
  rectMm: Rect,
): IssuedDocumentRow {
  const anchorMm = {
    x: roundNavigation(rectMm.x + rectMm.w / 2),
    y: roundNavigation(rectMm.y + rectMm.h / 2),
  };
  return {
    ...rowFacts(ir, table, r.nativeKey),
    id: `${required(draft.issuedDocument, "Missing document source").id}/row/${navigationHash(r.nativeKey)}`,
    nativeKey: r.nativeKey,
    displayName: documentRowLabel(
      ir,
      rowFacts(ir, table, r.nativeKey).facts,
      r.displayName,
    ),
    primitiveId: `sheet-${sheet}-${r.primitiveId}`,
    rectMm,
    sheet: sheet,
    zone: navigationZone(anchorMm.x, anchorMm.y, bounds(draft.title, page)),
    anchorMm,
    anchorRule: "row-region-center/1" as const,
  };
}
/** Only visible, source-bound printed rows and headers enter this registry. */
export function issuedDocuments(
  ir: Readonly<ElectricalIr>,
  drafts: readonly Draft[],
  sheets: readonly RenderedSheet[],
  page: PaperPage,
  presentation?: CompiledProjectPresentation,
): IssuedDocument[] {
  const identity = documentIdentity(ir, presentation),
    documents = new Map<string, IssuedDocument>();
  for (const [i, draft] of drafts.entries()) {
    const d = draft.issuedDocument,
      sheet = sheets[i];
    if (!d || !sheet || !sameIdentity(d, identity)) continue;
    const rows = printedRows(ir, draft, sheet, page),
      prior = documents.get(d.id);
    if (
      new Set([...(prior?.rows ?? []), ...rows].map((r) => r.id)).size !==
      (prior?.rows.length ?? 0) + rows.length
    )
      throw Error("Duplicate issued document row identity");
    documents.set(d.id, {
      ...d,
      kind: "kind" in draft.view ? draft.view.kind : "unknown",
      label: documentLabel("kind" in draft.view ? draft.view.kind : "unknown"),
      ...(draft.autoDocumentOrigin
        ? { autoOrigin: draft.autoDocumentOrigin }
        : { authoredOrder: draft.views?.[0]?.viewIndex ?? i }),
      rows: [...(prior?.rows ?? []), ...rows],
    });
  }
  return [...documents.values()];
}
export function sameIdentity(
  a: Omit<DocumentIdentity, "id">,
  b: Omit<DocumentIdentity, "id">,
) {
  return (
    a.snapshotDigest === b.snapshotDigest &&
    a.presentationDigest === b.presentationDigest &&
    a.revision === b.revision
  );
}
export function resolveDocumentNeed(
  need: DocumentDependency,
  documents: readonly IssuedDocument[],
): DocumentDependency["resolution"] {
  const required = new Set(need.requiredFacts.map(factKey));
  const candidates = documents
    .filter((d) => sameIdentity(need, d))
    .map((document) => {
      const rows = document.rows.filter((r) =>
        need.requiredColumns.every((c) => r.columns.includes(c)),
      );
      const facts = new Set(rows.flatMap((r) => r.facts.map(factKey)));
      return { document, rows, facts };
    })
    .sort((a, b) => {
      const exact = (candidate: {
        rows: readonly IssuedDocumentRow[];
        facts: Set<string>;
      }) =>
        candidate.rows.every((r) =>
          r.facts.some((f) => required.has(factKey(f))),
        ) && [...required].every((f) => candidate.facts.has(f));
      return (
        Number(exact(b)) - Number(exact(a)) ||
        a.rows.length - b.rows.length ||
        (a.document.authoredOrder ?? Infinity) -
          (b.document.authoredOrder ?? Infinity)
      );
    });
  const one = candidates.find((c) =>
    [...required].every((f) => c.facts.has(f)),
  );
  const remaining = new Set(required),
    result: {
      documentId: string;
      rows: string[];
    }[] = [];
  for (const c of one ? [one] : candidates) {
    const rows = c.rows.filter((r) =>
      r.facts.some((f) => remaining.has(factKey(f))),
    );
    if (!rows.length) continue;
    result.push({ documentId: c.document.id, rows: rows.map((r) => r.id) });
    for (const r of rows) for (const f of r.facts) remaining.delete(factKey(f));
  }
  return result;
}
export function missingDocumentFacts(
  need: DocumentDependency,
  documents: readonly IssuedDocument[],
) {
  const selected = resolveDocumentNeed(need, documents);
  const delivered = new Set(
    selected.flatMap((s) =>
      required(
        documents.find((d) => d.id === s.documentId),
        "Missing document source",
      )
        .rows.filter((r) => s.rows.includes(r.id))
        .flatMap((r) => r.facts.map(factKey)),
    ),
  );
  return need.requiredFacts.filter((f) => !delivered.has(factKey(f)));
}
