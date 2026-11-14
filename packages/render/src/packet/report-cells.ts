import type { ElectricalIr } from "@thermite/compiler";
import type { DocumentationTable } from "@thermite/query";
import { describeCodePoint, measureText } from "../text-metrics.js";
import { escapeXmlAttribute as attr } from "../svg/escape.js";
import { n, text } from "./svg.js";
import {
  reportColumns,
  reportHeaderParts,
  type ReportName,
} from "./report-column-widths.js";
import type { PaperPage } from "./types.js";

import {
  reportIdentifiers,
  type ReportIdentifiers,
} from "./report-identifiers.js";
import { wrapReportCell } from "./report-wrapping.js";
import {
  wireReportColumns,
  type WireColumnAllocation,
} from "./wire-report-columns.js";

const REPORT_CELL_SIZES = [2.6, 2.5] as const;

interface ProbeCache {
  wraps: Map<string, string[]>;
  metrics: Map<string, ReturnType<typeof measureText>>;
}

/** Reuse native names, identifiers and exact wraps across a bounded width grid.
 * The ordinary cell splitter and geometry remain the measurement authority. */
export function wireColumnProbe(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  width: number,
  page: PaperPage,
  size: number,
) {
  const names = reportNames(ir),
    identifiers = reportIdentifiers(ir, table),
    allocation = wireReportColumns(
      table,
      width,
      size,
      names,
      identifiers,
      "columns",
    ),
    cache: ProbeCache = { wraps: new Map(), metrics: new Map() };
  return {
    widths: allocation.widths,
    minimums: allocation.minimums,
    measure(widths: number[]) {
      if (
        widths.length !== 7 ||
        widths.some((w) => !Number.isFinite(w) || w <= 4) ||
        Math.abs(widths.reduce((sum, w) => sum + w, 0) - width) > 1e-6
      )
        throw Error(
          "Wire column candidate does not fill seven physical columns",
        );
      return measuredCells(
        ir,
        table,
        width,
        page,
        size,
        names,
        identifiers,
        {
          ...allocation,
          widths,
          padding: 2,
          inlineLocations: false,
        },
        cache,
      );
    },
  };
}

/** Measured identifier minima, then the allowed smaller em, then a refusal. */
export function reportCells(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  width: number,
  page?: PaperPage,
  wireMode?: "columns" | "legacy",
) {
  const identifiers = reportIdentifiers(ir, table);
  const names = reportNames(ir);
  let cellSize: number = REPORT_CELL_SIZES[0];
  let allocation = wireReportColumns(
    table,
    width,
    cellSize,
    names,
    identifiers,
    wireMode,
  );
  if (allocation.error && !allocation.nativeFits) {
    cellSize = REPORT_CELL_SIZES[1];
    allocation = wireReportColumns(
      table,
      width,
      cellSize,
      names,
      identifiers,
      wireMode,
    );
  }
  const standard = measuredCells(
    ir,
    table,
    width,
    page,
    cellSize,
    names,
    identifiers,
    allocation,
  );
  return preferredHeader(
    ir,
    table,
    width,
    page,
    cellSize,
    names,
    identifiers,
    allocation,
    standard,
  );
}

function reportNames(ir: Readonly<ElectricalIr>): ReportName[] {
  const designations = [
    ...ir.devices,
    ...ir.wires,
    ...ir.jumpers,
    ...ir.cables,
  ].map((e) => e.designation);
  return [
    ...[...designations, ...ir.relations.map((r) => r.designation)]
      .filter((v): v is string => !!v)
      .map((value) => ({
        value: value.normalize("NFC"),
        kind: "designation" as const,
      })),
    ...[
      ...ir.devices.map((d) => d.location),
      ...ir.cables.flatMap((c) => [c.fromLocation, c.toLocation]),
    ].flatMap((value) =>
      value
        ? [{ value: value.normalize("NFC"), kind: "location" as const }]
        : [],
    ),
  ];
}

/** Cosmetic preference cannot change body capacity or increase header height. */
function preferredHeader(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  width: number,
  page: PaperPage | undefined,
  size: number,
  names: ReportName[],
  identifiers: ReportIdentifiers,
  allocation: WireColumnAllocation,
  standard: ReturnType<typeof measuredCells>,
) {
  if (
    allocation.error ||
    table.kind !== "bom" ||
    table.columns[4] !== "Order number"
  )
    return standard;
  const preferred = reportColumns(table, width, size, names, identifiers, [4]);
  if (preferred.wholeWidth > width) return standard;
  try {
    const candidate = measuredCells(
      ir,
      table,
      width,
      page,
      size,
      names,
      identifiers,
      preferred,
    );
    if (
      candidate.geometry(candidate.split(table.columns, "header"), true)
        .height >
      standard.geometry(standard.split(table.columns, "header"), true).height
    )
      return standard;
    for (const row of table.rows) {
      const before = standard.split(row.cells, "probe", row.key);
      if (
        candidate
          .split(row.cells, "probe", row.key)
          .some((lines, i) => lines.length > before[i]!.length)
      )
        return standard;
    }
    return candidate;
  } catch {
    // A cosmetic probe may encounter an indivisible prose cluster that fits
    // only the mandatory allocation. Its failure must not refuse that view.
    return standard;
  }
}

function measuredCells(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  width: number,
  page: PaperPage | undefined,
  cellSize: number,
  names: ReportName[],
  identifiers: ReportIdentifiers,
  allocation: WireColumnAllocation,
  cache?: ProbeCache,
) {
  const { widths, padding } = allocation;
  const headerNote = reportHeaderNote(allocation, page);
  const { wrapHeader, wrapCell } = cellWrappers(
    cellSize,
    names,
    identifiers,
    allocation,
    cache,
  );
  const insets = reportInsets(
    table,
    widths,
    padding,
    allocation.hyphenatedColumns,
    cellSize,
    wrapHeader,
    wrapCell,
  );
  const diagnostics = reportDiagnostics(ir, table, cellSize);
  const policy = {
    table,
    width,
    page,
    cellSize,
    allocation,
    widths,
    insets,
    wrapHeader,
    wrapCell,
    ...diagnostics,
  };
  const split = (cells: readonly string[], row: string, key?: string) =>
    splitCells(policy, cells, row, key);
  const geometry = (cells: string[][], heading = false) =>
    reportGeometry(
      allocation.inlineLocations ? endpointLocationLines(cells) : cells,
      heading,
      cellSize,
      padding,
      insets,
      headerNote,
      cache?.metrics,
    );
  return {
    widths,
    cellSize,
    ...diagnostics,
    split,
    geometry,
    inlineLocations: !!allocation.inlineLocations,
  };
}

function cellWrappers(
  cellSize: number,
  names: ReportName[],
  identifiers: ReportIdentifiers,
  allocation: WireColumnAllocation,
  cache?: ProbeCache,
) {
  const cached = (key: string, run: () => string[]) => {
    const hit = cache?.wraps.get(key);
    if (hit) return hit;
    const lines = run();
    cache?.wraps.set(key, lines);
    return lines;
  };
  let wrapHeader: HeaderWrapper = (value, w, column) =>
    wrapReportHeader(value, w, column, cellSize, allocation.hyphenatedColumns);
  let wrapCell: CellWrapper = (value, w, column, key) =>
    wrapReportCell(
      value,
      w,
      cellSize,
      names,
      identifiers.get(key ?? "")?.[column],
    );
  if (cache) {
    const header = wrapHeader,
      body = wrapCell;
    wrapHeader = (...args) =>
      cached(JSON.stringify(["header", ...args]), () => header(...args));
    wrapCell = (...args) =>
      cached(JSON.stringify(["body", ...args]), () => body(...args));
  }
  return { wrapHeader, wrapCell };
}

type HeaderWrapper = (value: string, width: number, column: number) => string[];
type CellWrapper = (
  value: string,
  width: number,
  column: number,
  key?: string,
) => string[];

function reportHeaderNote(allocation: WireColumnAllocation, page?: PaperPage) {
  const margin = page
    ? Math.floor((page.widthMm - 36 - allocation.wholeWidth) * 500) / 1000
    : undefined;
  if (!allocation.hyphenate) return undefined;
  return margin !== undefined && margin >= 5
    ? `Hyphenated headers; whole words at margins ≤ ${margin} mm.`
    : page?.orientation === "landscape"
      ? "Hyphenated headers; use larger paper for whole words."
      : "Hyphenated headers; use larger paper or landscape for whole words.";
}

export function wrapReportHeader(
  value: string,
  w: number,
  column: number,
  cellSize: number,
  hyphenatedColumns: readonly boolean[],
) {
  const fits = (s: string, width: number) =>
    measureText(s.trim(), cellSize).width <= width;
  const lines: string[] = [];
  let line = "";
  for (const word of value.match(/\S+/gu) ?? []) {
    if (fits(line ? line + " " + word : word, w)) {
      line += (line ? " " : "") + word;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
    }
    const parts = hyphenatedColumns[column]
      ? reportHeaderParts(word, w, cellSize)
      : fits(word, w)
        ? [word]
        : undefined;
    if (!parts)
      throw Error("A header word cannot fit with readable hyphen fragments.");
    lines.push(...parts.slice(0, -1));
    line = parts.at(-1)!;
  }
  return [...lines, line];
}

function reportInsets(
  table: DocumentationTable,
  widths: number[],
  padding: number,
  hyphenatedColumns: readonly boolean[],
  size: number,
  wrapHeader: HeaderWrapper,
  wrapCell: CellWrapper,
) {
  const fits = (s: string, w: number) => measureText(s.trim(), size).width <= w;
  return widths.map((w, i) => {
    if (padding === 2) return 2;
    const compact = w - 2.01,
      normal = w - 4.01;
    if (normal <= 0) return 1;
    if (
      !hyphenatedColumns[i] &&
      (table.columns[i]!.match(/\S+/gu) ?? []).some(
        (word) => !fits(word, normal),
      )
    )
      return 1;
    try {
      if (
        wrapHeader(table.columns[i]!, normal, i).length !==
        wrapHeader(table.columns[i]!, compact, i).length
      )
        return 1;
      if (
        table.rows.some(
          (row) =>
            wrapCell(row.cells[i]!, normal, i, row.key).length >
            wrapCell(row.cells[i]!, compact, i, row.key).length,
        )
      )
        return 1;
      return 2;
    } catch {
      return 1;
    }
  });
}

function reportDiagnostics(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  cellSize: number,
) {
  const designations = new Map(
    [...ir.devices, ...ir.wires, ...ir.jumpers, ...ir.cables].map((entity) => [
      entity.uid,
      entity.designation,
    ]),
  );
  const rowDesignation = (index: number) => {
    const source = table.rows[index]!;
    let name = designations.get(source.key);
    if (!name) {
      // Terminal/core report keys contain an owner UUID and terminal/core key.
      try {
        const key: unknown = JSON.parse(source.key);
        if (
          Array.isArray(key) &&
          typeof key[0] === "string" &&
          designations.get(key[0])
        )
          name = [designations.get(key[0]), ...key.slice(1)].join(" / ");
      } catch {
        /* Other reports use ordinary string keys. */
      }
    }
    name ??=
      designations.get(source.deviceUids[0] ?? "") ??
      source.cells[0]?.split(/\r?\n/u)[0] ??
      source.key;
    return name;
  };
  const rowName = (index: number) =>
    `${index + 1} (${JSON.stringify(rowDesignation(index))})`;
  const unknownReason = (value: string) => {
    const unknown = measureText(value, cellSize).unknownGlyphs;
    return unknown.length
      ? ` Unknown glyphs use bounded fallback metrics: ${unknown.map(describeCodePoint).join(", ")}. Check these characters in the label; their browser fallback metrics are estimates.`
      : "";
  };
  const context = (row: string, column: number) =>
    `Report ${JSON.stringify(table.title)} (${table.kind}), row ${row}, column ${column + 1} ${JSON.stringify(table.columns[column])}`;
  return { rowDesignation, rowName, unknownReason, context };
}

type CellPolicy = ReturnType<typeof reportDiagnostics> & {
  table: DocumentationTable;
  width: number;
  page: PaperPage | undefined;
  cellSize: number;
  allocation: WireColumnAllocation;
  widths: number[];
  insets: number[];
  wrapHeader: HeaderWrapper;
  wrapCell: CellWrapper;
};
function allocationMessage({
  table,
  width,
  page,
  allocation,
  rowName,
}: CellPolicy) {
  const driver = allocation.driver!;
  const kind =
    driver.kind === "identifier" && table.kind === "bom" && driver.column === 1
      ? "designation"
      : driver.kind;
  const shorter =
    driver.kind === "designation" ? ", or a shorter designation" : "";
  // Width alone cannot prove that a smaller margin also fits the rows.
  const advice =
    page?.orientation === "landscape"
      ? "Use larger paper or shorter authored text."
      : `Use larger paper, landscape${shorter}.`;
  const source =
    "rowKey" in driver
      ? `, row ${rowName(table.rows.findIndex((r) => r.key === driver.rowKey))}`
      : "";
  return `Report ${JSON.stringify(table.title)} (${table.kind})${source}, column ${driver.column + 1} ${JSON.stringify(table.columns[driver.column])}: ${kind} ${JSON.stringify(driver.authoredName)} drives a minimum table width of ${allocation.minimumWidth.toFixed(3)} mm; only ${width.toFixed(3)} mm is available at the minimum 2.5 mm em after trying 2.6 mm. ${driver.kind === "identifier" ? (page?.orientation === "landscape" ? "Use larger paper." : "Use larger paper or landscape.") : advice}`;
}
function splitCells(
  policy: CellPolicy,
  cells: readonly string[],
  row: string,
  key?: string,
) {
  const {
    table,
    allocation,
    widths,
    insets,
    wrapHeader,
    wrapCell,
    context,
    unknownReason,
    page,
    cellSize,
  } = policy;
  if (allocation.error) throw Error(allocationMessage(policy));
  if (row !== "header" && key === undefined)
    throw Error(
      `Report ${JSON.stringify(table.title)} (${table.kind}), row ${row}: body layout requires an explicit source row key.`,
    );
  return cells.map((value, i) => {
    try {
      return row === "header"
        ? wrapHeader(value, widths[i]! - 2 * insets[i]! - 0.01, i)
        : wrapCell(value, widths[i]! - 2 * insets[i]! - 0.01, i, key);
    } catch (error) {
      throw Error(
        `${context(row, i)}: ${error instanceof Error ? error.message : "Text cannot fit."}${unknownReason(value)} ${page?.orientation === "landscape" ? "Use larger paper or shorter authored text" : "Use larger paper, landscape, or shorter authored text"}; selected text is ${cellSize} mm em (minimum 2.5 mm).`,
      );
    }
  });
}
function endpointLocationLines(cells: string[][]) {
  return cells
    .slice(0, 5)
    .map((lines, i) =>
      i === 1 || i === 2 ? [...lines, ...cells[i + 4]!] : lines,
    );
}

function reportGeometry(
  cells: string[][],
  heading: boolean,
  cellSize: number,
  padding: number,
  insets: number[],
  headerNote?: string,
  cache?: ProbeCache["metrics"],
) {
  const metrics = cells.flat().map((value) => {
      const hit = cache?.get(value);
      if (hit) return hit;
      const measured = measureText(value, cellSize);
      cache?.set(value, measured);
      return measured;
    }),
    ascent = Math.max(0, ...metrics.map((m) => m.ascent)),
    descent = Math.max(0, ...metrics.map((m) => m.descent)),
    lineHeight = Math.max(3.6, ascent + descent + 0.6),
    baseline = Math.max(4, ascent + 1),
    count = Math.max(...cells.map((c) => c.length));
  return {
    cellSize,
    padding,
    insets,
    descent,
    headerNote: heading ? headerNote : undefined,
    noteHeight: heading && headerNote ? 4 : 0,
    baseline,
    lineHeight,
    height:
      (heading && headerNote ? 4 : 0) +
      Math.max(
        count * 3.6 + (heading ? 5 : 4),
        baseline + (count - 1) * lineHeight + descent + 1,
      ),
  };
}

export function emitReportRow(
  cells: string[][],
  height: number,
  widths: readonly number[],
  columns: readonly string[],
  left: number,
  y: number,
  geometry: ReturnType<typeof reportCells>["geometry"],
  heading = false,
  inlineLocations = false,
): string[] {
  const content: string[] = [];
  const { cellSize, baseline, lineHeight, insets, noteHeight, headerNote } =
    geometry(cells, heading);
  const regions = reportCellRegions(
    cells,
    widths,
    left,
    y,
    height,
    geometry(cells, heading),
    inlineLocations,
  );
  // Paint every semantic field before text so no background erases another field.
  for (const r of regions)
    content.push(
      `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="${heading ? "#e9eef4" : "white"}" stroke="#9ba6b4" stroke-width="0.2"/>`,
    );
  cells.forEach((lines, i) => {
    const region = regions[i]!;
    content.push(
      `<g data-report-column="${i + 1}" data-column-name="${attr(columns[i]!)}" data-cell-x="${n(region.x)}" data-cell-y="${n(region.y)}" data-cell-width="${n(region.w)}" data-cell-height="${n(region.h)}">`,
    );
    lines.forEach((value, j) =>
      content.push(
        text(
          region.x + insets[i]!,
          region.y + baseline + j * lineHeight,
          value.trim(),
          cellSize,
          "start",
          heading ? 700 : 400,
        ).replace("<text ", '<text xml:space="preserve" '),
      ),
    );
    content.push("</g>");
  });
  if (headerNote)
    content.push(
      `<g data-report-header-note="true">${text(left, y + height - 0.8, headerNote, 2.5)}</g>`,
    );
  return content;
}

/** The endpoint and its locator partition one column into two painted fields. */
function reportCellRegions(
  cells: string[][],
  widths: readonly number[],
  left: number,
  y: number,
  height: number,
  metrics: ReturnType<ReturnType<typeof reportCells>["geometry"]>,
  stacked: boolean,
) {
  const { noteHeight, baseline, lineHeight, descent } = metrics;
  const footerHeight = (column: number) =>
    baseline + (cells[column]!.length - 1) * lineHeight + descent + 0.5;
  return cells.map((_, i) => {
    const footer = stacked && i >= 5;
    const x =
      left + widths.slice(0, footer ? i - 4 : i).reduce((sum, w) => sum + w, 0);
    const bottom = y + height - noteHeight;
    const top = footer ? bottom - footerHeight(i) : y;
    const h =
      stacked && (i === 1 || i === 2)
        ? bottom - top - footerHeight(i + 4)
        : bottom - top;
    return { x, y: top, w: widths[i]!, h };
  });
}
