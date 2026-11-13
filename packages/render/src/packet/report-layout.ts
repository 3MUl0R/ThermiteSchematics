import type { ElectricalIr } from "@thermite/compiler";
import type { DocumentationTable } from "@thermite/query";
import type { PaperPage } from "./types.js";
import { reportCells } from "./report-cells.js";
import { wrap } from "./svg.js";

/** Prefer real columns. Extra wrapping is allowed only at native page capacity. */
export function paginatedReportCells(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  width: number,
  height: number,
  page: PaperPage,
) {
  const first = reportCells(ir, table, width, page);
  if (!first.inlineLocations) return first;
  const native = {
    ...table,
    columns: table.columns.slice(0, 5),
    widths: [0.15, 0.24, 0.24, 0.18, 0.19],
    rows: table.rows.map((r) => ({ ...r, cells: r.cells.slice(0, 5) })),
    notes: table.notes.filter(
      (note) =>
        !note.startsWith(
          "Sheet.zone locates the native endpoint in this packet;",
        ),
    ),
  };
  try {
    const baseline = reportCells(ir, native, width, page, "legacy");
    const columns = reportCells(ir, table, width, page, "columns");
    if (
      columns.cellSize === baseline.cellSize &&
      reportPageCount(table, columns, width, height) <=
        reportPageCount(native, baseline, width, height)
    )
      return columns;
  } catch {
    // A real-column probe cannot refuse a printable stacked allocation.
  }
  return first;
}

/** Same row, header, title and note capacity used by the report paginator. */
export function reportPageCount(
  table: DocumentationTable,
  measured: ReturnType<typeof reportCells>,
  width: number,
  height: number,
) {
  const notes = table.notes.flatMap((note) =>
    wrap(note, Math.floor(width / 1.6)),
  );
  const header = measured.geometry(
    measured.split(table.columns, "header"),
    true,
  ).height;
  const capacity = height - 9 - 5 - notes.length * 3.5 - header;
  if (capacity < 9) return Infinity;
  let pages = 1,
    used = 0;
  for (const row of table.rows) {
    const rowHeight = measured.geometry(
      measured.split(row.cells, "probe", row.key),
    ).height;
    if (rowHeight > capacity) return Infinity;
    if (used + rowHeight > capacity) {
      pages++;
      used = 0;
    }
    used += rowHeight;
  }
  return pages;
}
