// The exported registry is a third set of locators. Neither an entry nor its
// absence establishes a native fact or suppresses a visible issued row.
import { finding, painted } from "./review-geometry.mjs";
import {
  nativeNeeds,
  factKeys,
  semanticColumns,
  compact,
  nativeRequestForSheet,
} from "./m3-native.mjs";
import {
  rowMatchesFact,
  printedHeader,
  requestedSupplies,
} from "./m3-documents.mjs";
import { sufficient } from "./document-dependencies.mjs";
const sameSet = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  JSON.stringify(a.slice().sort()) === JSON.stringify(b.slice().sort());
const labels = {
  wires: "wire inventory",
  terminals: "terminal inventory",
  network: "network inventory",
  assemblies: "assembly inventory",
};
export function registryFindings(
  packet,
  geometries,
  ir,
  catalog,
  rows,
  context,
) {
  const nav = packet.navigation,
    findings = [],
    documents = nav.documents ?? [],
    allNeeds = packet.sheets.flatMap((s, i) =>
      nativeNeeds(
        s,
        geometries[i],
        ir,
        catalog,
        nativeRequestForSheet(packet, geometries, context.request, s),
      ).map((n) => ({
        ...n,
        sheet: s.number,
      })),
    ),
    binding = context.binding;
  const add = (kind, evidence) => findings.push(finding(kind, {}, evidence));
  const ids = documents.map((d) => d.id);
  if (new Set(ids).size !== ids.length)
    add("document-registry-duplicate-id", { ids });
  for (const doc of documents.filter((d) => labels[d.kind])) {
    const actual = rows.filter((r) => r.documentId === doc.id),
      table = context.tables?.find((t) => t.documentId === doc.id);
    if (
      !binding ||
      !["snapshotDigest", "presentationDigest", "revision"].every(
        (k) => doc[k] === binding[k],
      )
    )
      add("document-registry-source-mismatch", { documentId: doc.id });
    if (
      doc.label !== labels[doc.kind] ||
      actual.some((r) => r.kind !== doc.kind || r.auto !== !!doc.autoOrigin)
    )
      add("document-registry-origin-mismatch", { documentId: doc.id });
    if (
      doc.autoOrigin
        ? doc.authoredOrder !== undefined
        : table && doc.authoredOrder !== table.authoredOrder
    )
      add("document-registry-authored-scope-mismatch", { documentId: doc.id });
    if (doc.autoOrigin) {
      const auto =
          nav.autoDocuments?.filter((a) => a.documentId === doc.id) ?? [],
        dependencies =
          nav.dependencies?.filter((d) =>
            doc.autoOrigin.dependencyIds?.includes(d.id),
          ) ?? [],
        native = allNeeds.filter((n) =>
          dependencies.some(
            (d) =>
              d.need === n.need &&
              d.owner?.sheet === n.sheet &&
              d.owner?.noteId === n.noteId,
          ),
        ),
        requested = (context.tables ?? []).filter(
          (t) => t.origin === "requested" && t.kind === doc.kind,
        );
      if (
        auto.length !== 1 ||
        !sameSet(auto[0].dependencyIds, doc.autoOrigin.dependencyIds) ||
        !sameSet(auto[0].sheets, [...new Set(actual.map((r) => r.sheet))]) ||
        dependencies.length !== new Set(doc.autoOrigin.dependencyIds).size ||
        !native.length
      )
        add("document-auto-origin-mismatch", { documentId: doc.id });
      for (const row of actual) {
        const source = catalog.find(
          (r) => r.kind === row.kind && r.key === row.key,
        );
        if (
          !source ||
          !native.some((n) => n.facts.some((f) => rowMatchesFact(source, f))) ||
          requestedSupplies(source, requested, rows)
        )
          add("document-auto-row-without-missing-native-need", {
            documentId: doc.id,
            key: row.key,
          });
      }
    }
    const rowIds = (doc.rows ?? []).map((r) => r.id);
    if (new Set(rowIds).size !== rowIds.length)
      add("document-registry-duplicate-row", { documentId: doc.id });
    for (const entry of doc.rows ?? []) {
      const found = actual.filter(
          (r) =>
            r.key === entry.nativeKey &&
            r.sheet === entry.sheet &&
            r.primitiveIds.includes(entry.primitiveId),
        ),
        source = catalog.find(
          (r) => r.kind === doc.kind && r.key === entry.nativeKey,
        );
      if (
        !source ||
        found.length !== 1 ||
        !sufficient(found[0], source) ||
        !printedHeader(found[0], context.tables) ||
        !sameSet(factKeys(entry.facts ?? []), factKeys(source.facts))
      )
        add("document-registry-row-mismatch", {
          documentId: doc.id,
          rowId: entry.id,
          nativeKey: entry.nativeKey,
        });
      if (source) {
        const columns = source.columns ?? [
          ...new Set(source.facts.flatMap((f) => semanticColumns[f.kind])),
        ];
        if (!sameSet(entry.columns, columns))
          add("document-registry-columns-mismatch", {
            documentId: doc.id,
            rowId: entry.id,
            expected: columns,
            actual: entry.columns,
          });
      }
    }
    for (const row of actual)
      if (
        (doc.rows ?? []).filter(
          (r) =>
            r.nativeKey === row.key &&
            r.sheet === row.sheet &&
            row.primitiveIds.includes(r.primitiveId),
        ).length !== 1
      )
        add("document-visible-row-without-registry-entry", {
          documentId: doc.id,
          key: row.key,
        });
    for (const number of [...new Set(actual.map((r) => r.sheet))]) {
      const g = geometries[packet.sheets.findIndex((s) => s.number === number)];
      if (
        !g.texts.some(
          (t) =>
            !t.row &&
            painted(t) &&
            compact(t.text).includes(compact(labels[doc.kind])),
        )
      )
        add("document-visible-short-label-missing", {
          documentId: doc.id,
          targetSheet: number,
        });
    }
  }
  for (const row of rows.filter((r) => labels[r.kind]))
    if (!documents.some((d) => d.id === row.documentId))
      add("document-visible-row-without-issued-document", {
        sheet: row.sheet,
        key: row.key,
      });
  for (const origin of nav.autoDocuments ?? [])
    if (!documents.some((d) => d.id === origin.documentId && d.autoOrigin))
      add("document-auto-origin-without-document", {
        documentId: origin.documentId,
      });
  return findings;
}
