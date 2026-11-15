import { netOwnershipGaps } from "./net-label-oracle.mjs";
export function measurementCoverage(rows, g, wireAudit, sheet) {
  for (const [dq, gaps] of [
    ["DQ-17", netOwnershipGaps(g)],
    [
      "DQ-19",
      (wireAudit?.notMeasured ?? []).filter((p) => p.sheet === sheet.number),
    ],
  ]) {
    if (!gaps.length) continue;
    const row = rows.find((r) => r.dq === dq);
    if (!row) continue;
    row.evidence.notMeasured = gaps;
    if (row.status === "pass") {
      row.status = "not-measured";
      row.reason = gaps.map((p) => p.reason).join("; ");
    }
  }
  const absences = (wireAudit?.measurements ?? []).filter(
    (p) => p.sheet === sheet.number && p.status === "not-applicable",
  );
  const report = rows.find((r) => r.dq === "DQ-19");
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
