import type { ElectricalIr } from "@thermite/compiler";
import type { DocumentationTable } from "@thermite/query";
import type { PaperPage } from "./types.js";
import { reportCells } from "./report-cells.js";
import { wrap } from "./svg.js";
import { reportPaginator } from "./report-paginator.js";
import {
  searchWireColumns,
  type WireAllocationReceipt,
} from "./wire-column-search.js";

/** Prefer real columns. Extra wrapping is allowed only at native page capacity. */
export function paginatedReportCells(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  width: number,
  height: number,
  page: PaperPage,
  top = 0,
): ReturnType<typeof reportCells> & {
  allocationReceipt?: WireAllocationReceipt;
} {
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
  const baseline = reportCells(ir, native, width, page, "legacy");
  const count = reportPageCount(native, baseline, width, height, top);
  const searched = searchWireColumns(
    ir,
    table,
    width,
    height,
    page,
    first.cellSize,
    count,
    (measured) => reportPageCount(table, measured, width, height, top),
    top,
  );
  return {
    ...(searched.measured ?? first),
    allocationReceipt: searched.receipt,
  };
}

/** Same row, header, title and note capacity used by the report paginator. */
export function reportPageCount(
  table: DocumentationTable,
  measured: ReturnType<typeof reportCells>,
  width: number,
  height: number,
  top = 0,
) {
  const notes = table.notes.flatMap((note) =>
    wrap(note, Math.floor(width / 1.6)),
  );
  const header = measured.geometry(
    measured.split(table.columns, "header"),
    true,
  ).height;
  const paginator = reportPaginator(top, height, header, notes.length);
  if (!paginator.headerFits) return Infinity;
  for (const row of table.rows) {
    const rowHeight = measured.geometry(
      measured.split(row.cells, "probe", row.key),
    ).height;
    if (paginator.place(rowHeight).kind === "overflow") return Infinity;
  }
  return paginator.pages;
}
