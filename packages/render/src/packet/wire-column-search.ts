import type { DocumentationTable } from "@thermite/query";
import type { ElectricalIr } from "@thermite/compiler";
import type { PaperPage } from "./types.js";
import { required } from "../presentation/util.js";
import { reportCells, wireColumnProbe } from "./report-cells.js";

export const WIRE_GRID_DIVISIONS = 12;
const NATIVE_COLUMNS = 5;
export const WIRE_SEARCH_CANDIDATES = candidateBound(WIRE_GRID_DIVISIONS);
function candidateBound(divisions: number) {
  let count = 1;
  for (let i = 1; i < NATIVE_COLUMNS; i++)
    count = (count * (divisions + i)) / i;
  return count + 1; // One weighted vector, then all C(divisions + 4, 4) shares.
}

export interface WireAllocationAttempt {
  widths: number[];
  pages: number | null;
  wrapLines: number | null;
  failure?: string;
}
export interface WireAllocationReceipt {
  format: "wire-column-search/1";
  title: string;
  rows: number;
  field: { width: number; height: number; top: number };
  cellSize: number;
  nativePages: number | null;
  bounds: { divisions: number; nativeColumns: number; maxCandidates: number };
  minimums: number[];
  locators: number[];
  candidates: WireAllocationAttempt[];
  selected: number | null;
  tier: "b" | "c";
}

function* shares(
  total: number,
  columns: number,
  prefix: number[] = [],
): Generator<number[]> {
  if (columns === 1) yield [...prefix, total];
  else
    for (let n = 0; n <= total; n++)
      yield* shares(total - n, columns - 1, [...prefix, n]);
}

function vectors(minimums: number[], locators: number[], width: number) {
  const slack =
    width - [...minimums, ...locators].reduce((sum, w) => sum + w, 0);
  if (slack < 0) return [];
  return [...shares(WIRE_GRID_DIVISIONS, NATIVE_COLUMNS)].map((share) => {
    const native = minimums.map(
      (w, i) =>
        w +
        (slack * required(share[i], "Missing width share")) /
          WIRE_GRID_DIVISIONS,
    );
    // Put floating-point residue in a field with positive slack, preserving minima.
    const receiver = share.findIndex((n) => n > 0);
    native[receiver] =
      required(native[receiver], "Missing width receiver") +
      width -
      [...native, ...locators].reduce((sum, w) => sum + w, 0);
    return [...native, ...locators];
  });
}

const vectorOrder = (a: number[], b: number[]) => {
  for (const [i, value] of a.entries()) {
    const other = required(b[i], "Missing comparison width");
    if (value !== other) return value - other;
  }
  return 0;
};
const scoreOrder = (a: WireAllocationAttempt, b: WireAllocationAttempt) =>
  (a.pages ?? Infinity) - (b.pages ?? Infinity) ||
  (a.wrapLines ?? Infinity) - (b.wrapLines ?? Infinity) ||
  vectorOrder(a.widths, b.widths);

function scoreCandidate(
  table: DocumentationTable,
  widths: number[],
  measure: ReturnType<typeof wireColumnProbe>["measure"],
  pageCount: (measured: ReturnType<typeof reportCells>) => number,
) {
  const attempt: WireAllocationAttempt = {
    widths,
    pages: null,
    wrapLines: null,
  };
  try {
    const measured = measure(widths),
      pages = pageCount(measured);
    if (!Number.isFinite(pages)) {
      attempt.failure = "A header or body row exceeds fresh-sheet capacity";
      return { attempt };
    }
    attempt.pages = pages;
    attempt.wrapLines =
      measured.split(table.columns, "header").flat().length * pages +
      table.rows.reduce(
        (n, row) =>
          n + measured.split(row.cells, "probe", row.key).flat().length,
        0,
      );
    return { attempt, measured };
  } catch (error) {
    attempt.failure =
      error instanceof Error ? error.message : "Candidate measurement failed";
    return { attempt };
  }
}

/** Enumerate the complete bounded grid, not just the first capacity-preserving
 * probe. Pages, printed wrap lines, then numeric vector order break ties. */
export function searchWireColumns(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  width: number,
  height: number,
  page: PaperPage,
  size: number,
  nativePages: number,
  pageCount: (measured: ReturnType<typeof reportCells>) => number,
  top: number,
) {
  const probe = wireColumnProbe(ir, table, width, page, size),
    locators = probe.widths.slice(5),
    minimums = probe.minimums.slice(0, NATIVE_COLUMNS);
  const receipt: WireAllocationReceipt = {
    format: "wire-column-search/1",
    title: table.title,
    rows: table.rows.length,
    field: { width, height, top },
    cellSize: size,
    nativePages: Number.isFinite(nativePages) ? nativePages : null,
    bounds: {
      divisions: WIRE_GRID_DIVISIONS,
      nativeColumns: NATIVE_COLUMNS,
      maxCandidates: WIRE_SEARCH_CANDIDATES,
    },
    minimums,
    locators,
    candidates: [],
    selected: null,
    tier: "c",
  };
  let best: ReturnType<typeof reportCells> | undefined;
  for (const widths of [probe.widths, ...vectors(minimums, locators, width)]) {
    if (receipt.candidates.length >= WIRE_SEARCH_CANDIDATES)
      throw Error("Wire allocation grid exceeded its bound");
    const { attempt, measured } = scoreCandidate(
      table,
      widths,
      probe.measure,
      pageCount,
    );
    const index = receipt.candidates.push(attempt) - 1;
    if (!measured || attempt.pages === null || attempt.pages > nativePages)
      continue;
    const previous =
      receipt.selected === null
        ? undefined
        : receipt.candidates[receipt.selected];
    if (!previous || scoreOrder(attempt, previous) < 0) {
      receipt.selected = index;
      best = measured;
    }
  }
  if (best) receipt.tier = "b";
  return { measured: best, receipt };
}
