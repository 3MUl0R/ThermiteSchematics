import { netOwnershipGaps } from "./net-label-oracle.mjs";
const sheetObservation = (rows, dq, sheet) =>
  rows.find((r) =>
    r.id.endsWith(`/${dq}/sheet-${String(sheet.number).padStart(3, "0")}`),
  );
export function measurementCoverage(rows, g, wireAudit, sheet) {
  for (const [dq, gaps] of [
    ["DQ-17", netOwnershipGaps(g)],
    [
      "DQ-19",
      (wireAudit?.notMeasured ?? []).filter((p) => p.sheet === sheet.number),
    ],
  ]) {
    if (!gaps.length) continue;
    const row = sheetObservation(rows, dq, sheet);
    if (!row) continue;
    row.evidence.notMeasured = gaps;
    if (row.status === "pass") {
      row.status = "not-measured";
      row.reason = `${gaps.map((p) => p.reason).join("; ")}. Strict mode rejects not-measured observations.`;
    }
  }
  const absences = (wireAudit?.measurements ?? []).filter(
    (p) => p.sheet === sheet.number && p.status === "not-applicable",
  );
  const report = sheetObservation(rows, "DQ-19", sheet);
  if (report && absences.length)
    report.evidence.nativeEndAbsences = absences.map(
      ({ row, end, status, nativeAbsence }) => ({
        row,
        end,
        status,
        nativeAbsence,
      }),
    );
  return rows;
}
