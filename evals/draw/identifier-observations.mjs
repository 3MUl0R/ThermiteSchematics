import { identifierTable } from "./identifier-tables.mjs";
import { identifierFindings } from "./identifier-checks.mjs";
import { pdfIdentifierRuns } from "./identifier-pdf.mjs";
import { tableForSheet } from "./m3-documents.mjs";
export const identifierFailure = (error) => ({
  status: "infrastructure-error",
  instrumentation: "identifier",
  reason: `Identifier measurement failed: ${error.message ?? String(error)}`,
});
export function svgIdentifiers(sheet, packet, g, ir, tables, policy) {
  let table, reportTable;
  try {
    reportTable = tableForSheet(sheet, g, tables);
    table = identifierTable(sheet, packet, g, ir, tables);
    return {
      table: reportTable,
      findings: table
        ? identifierFindings(g, table, ir, "svg", undefined, policy)
        : [],
      extra: {},
    };
  } catch (error) {
    return {
      table: reportTable,
      findings: [],
      extra: identifierFailure(error),
    };
  }
}
export async function mediaIdentifiers(
  c,
  sheet,
  packet,
  g,
  html,
  ir,
  tables,
  pdfPage,
  policy,
  observation,
) {
  const rows = [];
  for (const medium of ["html", "pdf"]) {
    let findings = [],
      extra = {};
    try {
      const table = identifierTable(sheet, packet, g, ir, tables);
      if (!table) continue;
      findings = identifierFindings(
        medium === "html" ? html : g,
        table,
        ir,
        medium,
        medium === "pdf" ? await pdfIdentifierRuns(pdfPage) : undefined,
        policy,
      );
    } catch (error) {
      extra = identifierFailure(error);
    }
    rows.push(
      observation(c, sheet, "DQ-19", findings, {
        id: `${c.id}/DQ-19/${medium}-${sheet.number}`,
        medium,
        scope:
          "Complete source identifier units on one independently measured physical line.",
        ...extra,
      }),
    );
  }
  return rows;
}
