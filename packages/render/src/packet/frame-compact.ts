import type { Draft, PaperPage } from "./types.js";
import {
  compactFramePlan,
  compactTitleRows,
  type FramePlan,
  type FrameText,
} from "./frame-plan.js";
import { admitFinalBanks } from "./frame-banks.js";
import { continuationLabelSvg } from "./continuation-label.js";
import { rootedLegendView } from "../device-legend.js";
import { rootedSheetNoticeSvg, rootedSheetView } from "../off-view/notice.js";
import { sheetLabel } from "./page.js";
import {
  escapeXmlAttribute as attr,
  escapeXmlText as xml,
} from "../svg/escape.js";
import { n, text, line, namespaceSheetContent } from "./svg.js";
import { printableTextMetrics } from "../symbols/printable-font.js";

function cell(x: number, y: number, w: number, h: number): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="none" stroke="#344054" stroke-width="0.25"/>`;
}

export function compactFrame(
  draft: Draft,
  page: PaperPage,
  number: number,
  total: number,
): string {
  const plan = compactFramePlan(
    draft.title,
    page,
    rootedSheetView(draft.view),
    draft.drawingBounds,
  );
  admitFinalBanks(draft, plan);
  const m = page.marginMm,
    w = page.widthMm - 2 * m,
    bottom = page.heightMm - m;
  const top = plan.title.top,
    label = sheetLabel(draft.view);
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(page.widthMm)}mm" height="${n(page.heightMm)}mm" viewBox="0 0 ${n(page.widthMm)} ${n(page.heightMm)}" role="img" aria-label="${attr(`${label}, sheet ${number} of ${total}`)}" data-sheet="${number}" data-total-sheets="${total}"${rootedLegendView(draft.view) ? ` data-view-format="${attr(draft.view.format)}" data-view-family="${attr("family" in draft.view ? draft.view.family : "")}"` : ""} data-paper="${page.size}">`,
    `<title>${xml(label)} - Sheet ${number} of ${total}</title>`,
    `<rect width="${n(page.widthMm)}" height="${n(page.heightMm)}" fill="white"/>`,
    `<rect x="${n(m)}" y="${n(m)}" width="${n(w)}" height="${n(bottom - m)}" fill="none" stroke="#344054" stroke-width="0.4"/>`,
    text(m + 4, m + 5, "THERMITE  /  ELECTRICAL", 2.6, "start", 700),
    text(
      page.widthMm - m - 4,
      m + 5,
      `SHEET ${number} OF ${total}`,
      2.6,
      "end",
    ),
    line(m, m + 8, page.widthMm - m, m + 8),
    namespaceSheetContent(draft.content, number),
  ];
  const notice = rootedSheetNoticeSvg(draft.view, page);
  if (notice) out.push(notice);
  out.push(...gridMarks(plan, page));
  for (const link of draft.links) {
    const sign = link.side === "left" || link.side === "top" ? -1 : 1;
    out.push(
      `<a href="#sheet-${link.to}" data-continuation-id="${attr(link.id)}" data-continuation-end="${link.end}" data-conductor-id="${attr(link.conductor)}" aria-label="${attr(`Continue ${link.conductor} on sheet ${link.to}.${link.toZone}`)}">`,
      link.side === "left" || link.side === "right"
        ? line(link.x, link.y, link.x + sign * 2, link.y)
        : line(link.x, link.y, link.x, link.y + sign * 2),
      continuationLabelSvg(link),
      "</a>",
    );
  }
  out.push(line(m, top, page.widthMm - m, top));
  out.push(...titleCells(draft, plan, page, number, total));
  out.push(
    text(m + 1, bottom + 4, draft.note, 2.5),
    text(page.widthMm - m, bottom + 4, "Thermite 0.3.0-alpha.2", 2.5, "end"),
    "</svg>",
  );
  return out.join("\n") + "\n";
}

function gridMarks(plan: FramePlan, page: PaperPage): string[] {
  const out: string[] = [],
    m = page.marginMm,
    top = plan.title.top,
    area = plan.drawing;
  for (let col = 0; col < plan.grid.columns; col++)
    for (const y of [m + 12, top - 1])
      out.push(
        text(
          area.x + (area.w * (col + 0.5)) / 6,
          y,
          String(col + 1),
          2.5,
          "middle",
        ),
      );
  for (let row = 0; row < plan.grid.rows; row++)
    for (const [x, anchor] of [
      [m + 0.6, "start"],
      [page.widthMm - m - 0.6, "end"],
    ] as const)
      out.push(
        text(
          x,
          area.y + (area.h * (row + 0.5)) / 4,
          String.fromCharCode(65 + row),
          2.5,
          anchor,
        ),
      );
  for (let col = 0; col <= 6; col++) {
    const x = area.x + (area.w * col) / 6;
    out.push(line(x, m + 8, x, m + 10), line(x, top - 2, x, top));
  }
  for (let row = 0; row <= 4; row++) {
    const y = area.y + (area.h * row) / 4;
    out.push(
      line(m, y, m + 1.5, y),
      line(page.widthMm - m - 1.5, y, page.widthMm - m, y),
    );
  }
  return out;
}
function titleCells(
  draft: Draft,
  plan: FramePlan,
  page: PaperPage,
  number: number,
  total: number,
): string[] {
  const out: string[] = [],
    m = page.marginMm,
    w = page.widthMm - 2 * m,
    bottom = page.heightMm - m,
    top = plan.title.top,
    label = sheetLabel(draft.view);
  const rows = compactTitleRows(
    {
      ...draft.title,
      lines: draft.title.lines.map((e) =>
        e.field === "title.view-line" ? { ...e, value: label } : e,
      ),
    },
    page,
  );
  out.push(...rows.map((row, i) => titleRowSvg(row, i, plan, page, number)));
  const right = page.widthMm - m - 66;
  out.push(...authorCells(page));
  out.push(text(m + 3, bottom - 2, "Revision history: UNSPECIFIED", 2.5));
  [
    ["DWG NO", ""],
    ["Customer", ""],
    ["REV", draft.title.revision],
    ["Sheet", `${number} of ${total}`],
  ].forEach(([label, value], i) => {
    const y = top + (i * plan.title.height) / 4;
    out.push(
      cell(right, y, 66, plan.title.height / 4),
      text(right + 2, y + 4.5, `${label}:`, 2.5, "start", 700),
    );
    if (value) {
      if (printableTextMetrics(value, 2.7).right > 39)
        throw Error(
          `Sheet ${number} field ${label} requires more than 39 mm; use a larger paper/profile or shorter supplied value.`,
        );
      out.push(
        text(right + 25, y + 4.5, value, 2.7).replace(
          "<text ",
          label === "Sheet"
            ? '<text data-frame-sheet-number="true" '
            : "<text ",
        ),
      );
    }
  });
  return out;
}

function authorCells(page: PaperPage): string[] {
  const out: string[] = [],
    m = page.marginMm,
    bottom = page.heightMm - m;
  const left = page.widthMm - 2 * m - 66;
  ["Drawn by", "Date", "Checked by", "Approved by"].forEach((label, i) =>
    out.push(
      cell(m + (i * left) / 4, bottom - 13, left / 4, 7),
      text(m + (i * left) / 4 + 2, bottom - 10, `${label}:`, 2.5, "start", 700),
    ),
  );
  return out;
}

function titleRowSvg(
  row: FrameText,
  index: number,
  plan: FramePlan,
  page: PaperPage,
  number: number,
): string {
  const baseline = plan.title.top + 5 + 4 * index;
  const metrics = printableTextMetrics(row.value, row.size, row.bold);
  const width = page.widthMm - 2 * page.marginMm - 76;
  if (metrics.right > width + 0.001 || metrics.left < -4)
    throw Error(
      `Sheet ${number} field ${row.field} requires ${metrics.right.toFixed(3)} mm; ${width.toFixed(3)} mm are available. Use larger paper or a shorter supplied title.`,
    );
  if (baseline - metrics.bottom > page.heightMm - page.marginMm - 14.125)
    throw Error(
      `Sheet ${number} field ${row.field} needs more glyph clearance; use a larger paper/profile or a shorter supplied title.`,
    );
  return text(
    page.marginMm + 4,
    baseline,
    row.value,
    row.size,
    "start",
    row.bold ? 700 : 400,
  );
}
