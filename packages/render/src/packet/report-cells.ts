import type { ElectricalIr } from "@thermite/compiler";
import type { DocumentationTable } from "@thermite/query";
import { describeCodePoint, measureText, wrapText } from "../text-metrics.js";
import {
  escapeXmlText as xml,
  escapeXmlAttribute as attr,
} from "../svg/escape.js";
import { n, text } from "./svg.js";

const REPORT_CELL_SIZE = 2.6;

/** The fixed-size measured cell policy, including contextual row/column diagnostics. */
export function reportCells(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  width: number,
) {
  const widthSum = table.widths.reduce((a, b) => a + b, 0),
    widths = table.widths.map((w) => (w / widthSum) * width);
  const cellSize = REPORT_CELL_SIZE;
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
  const split = (cells: readonly string[], row: string): string[][] =>
    cells.map((value, i) => {
      try {
        return wrapText(value, widths[i]! - 4.01, cellSize);
      } catch (error) {
        throw Error(
          `${context(row, i)}: ${error instanceof Error ? error.message : "Text cannot fit."}${unknownReason(value)} Use larger paper or a wider report column; text is never shrunk below the fixed ${cellSize} mm size (minimum 2.5 mm).`,
        );
      }
    });
  const geometry = (cells: string[][], heading = false) => {
    const metrics = cells.flat().map((value) => measureText(value, cellSize)),
      ascent = Math.max(0, ...metrics.map((m) => m.ascent)),
      descent = Math.max(0, ...metrics.map((m) => m.descent)),
      lineHeight = Math.max(3.6, ascent + descent + 0.6),
      baseline = Math.max(4, ascent + 1),
      count = Math.max(...cells.map((c) => c.length));
    return {
      baseline,
      lineHeight,
      height: Math.max(
        count * 3.6 + (heading ? 5 : 4),
        baseline + (count - 1) * lineHeight + descent + 1,
      ),
    };
  };
  return {
    widths,
    cellSize,
    rowDesignation,
    rowName,
    unknownReason,
    context,
    split,
    geometry,
  };
}

function edgeWhitespace(value: string, x: number): string {
  if (!/^\s|\s$/u.test(value)) return `>${xml(value)}</text>`;
  const leading = /^\s*/u.exec(value)![0],
    rest = value.slice(leading.length),
    trailing = /\s*$/u.exec(rest)![0];
  // Preserve characters in textContent, but hang edge whitespace so it cannot
  // indent the next word or create an invisible overflow at a break.
  return `>${leading ? `<tspan xml:space="default">${xml(leading)}</tspan>` : ""}<tspan x="${n(x)}">${xml(rest.slice(0, rest.length - trailing.length))}</tspan>${trailing ? `<tspan xml:space="default">${xml(trailing)}</tspan>` : ""}</text>`;
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
): string[] {
  const content: string[] = [],
    cellSize = REPORT_CELL_SIZE;
  const { baseline, lineHeight } = geometry(cells, heading);
  let x = left;
  // Paint the entire row before any text, so no later background can erase it.
  cells.forEach((_, i) => {
    content.push(
      `<rect x="${n(x)}" y="${n(y)}" width="${n(widths[i]!)}" height="${n(height)}" fill="${heading ? "#e9eef4" : "white"}" stroke="#9ba6b4" stroke-width="0.2"/>`,
    );
    x += widths[i]!;
  });
  x = left;
  cells.forEach((lines, i) => {
    content.push(
      `<g data-report-column="${i + 1}" data-column-name="${attr(columns[i]!)}" data-cell-x="${n(x)}" data-cell-y="${n(y)}" data-cell-width="${n(widths[i]!)}" data-cell-height="${n(height)}">`,
    );
    lines.forEach((value, j) =>
      content.push(
        text(
          x + 2,
          y + baseline + j * lineHeight,
          value,
          cellSize,
          "start",
          heading ? 700 : 400,
        )
          .replace("<text ", '<text xml:space="preserve" ')
          .replace(`>${xml(value)}</text>`, edgeWhitespace(value, x + 2)),
      ),
    );
    content.push("</g>");
    x += widths[i]!;
  });
  return content;
}
