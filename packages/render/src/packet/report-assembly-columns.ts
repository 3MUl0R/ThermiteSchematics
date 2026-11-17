import type { ElectricalIr } from "@thermite/compiler";
import type { DocumentationTable } from "@thermite/query";
import type { PaperPage } from "./types.js";
import { reportCells } from "./report-cells.js";
import { ReportMeasurementError } from "./report-measurement.js";

/** Ten bounded allocations give prose-heavy columns surplus from short cells.
 * Keep native rows, notes, clearances and em; accept only fewer whole pages. */
export function denserAssemblyCells(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  width: number,
  page: PaperPage,
  baseline: ReturnType<typeof reportCells>,
  pages: (cells: ReturnType<typeof reportCells>) => number,
) {
  let best = baseline,
    bestPages = pages(baseline),
    bestHeight = Infinity;
  const basePages = bestPages;
  for (let column = 0; column < table.columns.length; column++) {
    for (const weight of [4, 8]) {
      try {
        const candidate = reportCells(
          ir,
          {
            ...table,
            widths: table.columns.map((_, i) => (i === column ? weight : 1)),
          },
          width,
          page,
        );
        if (candidate.cellSize !== baseline.cellSize) continue;
        const count = pages(candidate);
        if (count >= basePages || count > bestPages) continue;
        const height = table.rows.reduce(
          (sum, row) =>
            sum +
            candidate.geometry(candidate.split(row.cells, "probe", row.key))
              .height,
          candidate.geometry(candidate.split(table.columns, "header"), true)
            .height,
        );
        if (count === bestPages && height >= bestHeight) continue;
        best = candidate;
        bestPages = count;
        bestHeight = height;
      } catch (error) {
        if (!(error instanceof ReportMeasurementError)) throw error;
      }
    }
  }
  return best;
}
