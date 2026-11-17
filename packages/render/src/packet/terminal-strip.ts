import type { ElectricalIr } from "@thermite/compiler";
import type { DocumentationTable } from "@thermite/query";
import { escapeXmlAttribute as attr } from "../svg/escape.js";
import { measureText } from "../text-metrics.js";
import { required } from "../presentation/util.js";
import { wrapReportCell } from "./report-wrapping.js";
import {
  stripFacts,
  stripTerminalKey,
  type StripFacts,
} from "./terminal-strip-facts.js";
import { line, n, text } from "./svg.js";
import type { DrawingBounds, Draft } from "./types.js";

type Group = StripFacts["groups"][number];
function labelLines(value: string, width: number) {
  return wrapReportCell(value, width, 2.5, [], []);
}
function measuredGroup(group: Group, facts: StripFacts, width: number) {
  const bridges = facts.bridges.filter(
    (j) => j.endpoints[0].terminal.deviceUid === group.device.uid,
  );
  const terminalW = Math.max(
    16,
    ...group.terminals.map((t) => measureText(t.id.terminalKey, 2.5).width + 4),
  );
  const gutter = bridges.length * 4 + 4;
  const labelW = (width - terminalW - gutter - 18) / 2;
  if (labelW < 16) throw Error("Terminal strip labels need wider paper.");
  const heading = labelLines(
    `${group.device.designation} — ${group.ordered ? "authored order" : "order unspecified; declaration listing"}`,
    width,
  );
  const rows = group.terminals.map((t) => {
    const sides = [true, false].map((same) =>
      t.incidences
        .filter((i) => i.sameLocation === same)
        .map((i) => ({ ...i, lines: labelLines(i.label, labelW) })),
    );
    const count = Math.max(
      ...sides.map((s) => s.reduce((sum, i) => sum + i.lines.length, 0)),
    );
    return { terminal: t, sides, height: Math.max(10, count * 3.5 + 3) };
  });
  const legend = bridges.flatMap((j, i) =>
    labelLines(`B${i + 1}: ${j.designation ?? `Jumper ${j.uid}`}`, width),
  );
  const headerH = heading.length * 3.5 + 7;
  return {
    group,
    bridges,
    terminalW,
    gutter,
    labelW,
    heading,
    rows,
    legend,
    headerH,
    height:
      headerH +
      rows.reduce((s, r) => s + r.height, 0) +
      legend.length * 3.5 +
      4,
    width,
  };
}
type Measured = ReturnType<typeof measuredGroup>;
function placeGroups(facts: StripFacts, b: DrawingBounds, columns: number) {
  const width = (b.w - (columns - 1) * 8) / columns;
  const groups = facts.groups.map((g) => measuredGroup(g, facts, width));
  const placed: { measured: Measured; x: number; y: number }[] = [];
  let column = 0,
    y = b.y;
  for (const measured of groups) {
    if (measured.height > b.h) return;
    if (y + measured.height > b.y + b.h) {
      column++;
      y = b.y;
    }
    if (column >= columns) return;
    placed.push({ measured, x: b.x + column * (width + 8), y });
    y += measured.height + 5;
  }
  return placed;
}
function terminalSvg(
  m: Measured,
  row: Measured["rows"][number],
  x: number,
  y: number,
) {
  const t = row.terminal,
    cx = x + m.labelW + 8,
    cy = y + row.height / 2;
  const out = [
    `<g data-strip-terminal="${attr(t.key)}" data-device-uid="${attr(t.id.deviceUid)}" data-terminal-key="${attr(t.id.terminalKey)}" data-strip-ref="${attr(t.ref)}" data-inventory-row="${attr(t.key)}">`,
    `<rect x="${n(cx)}" y="${n(cy - 4)}" width="${n(m.terminalW)}" height="8" fill="#fff" stroke="#344054" stroke-width="0.35"/>`,
    text(cx + m.terminalW / 2, cy - 0.5, t.id.terminalKey, 2.5, "middle", 700),
    text(cx + m.terminalW / 2, cy + 2.8, t.ref, 2.5, "middle"),
    "</g>",
  ];
  row.sides.forEach((side, i) => {
    let baseline = y + 3.5;
    const start = i === 0 ? cx : cx + m.terminalW;
    const end = i === 0 ? cx - 5 : cx + m.terminalW + m.gutter + 5;
    for (const incidence of side) {
      out.push(
        `<g data-strip-incidence="${attr(incidence.identity)}" data-strip-at="${attr(t.key)}">`,
        line(start, cy, end, cy),
      );
      incidence.lines.forEach((value) => {
        out.push(
          text(
            i === 0 ? x + m.labelW : end + 2,
            baseline,
            value,
            2.5,
            i === 0 ? "end" : "start",
          ),
        );
        baseline += 3.5;
      });
      out.push("</g>");
    }
  });
  return { svg: out.join("\n"), x: cx, y: cy };
}
function groupSvg(m: Measured, x: number, y: number) {
  const out = [`<g data-terminal-strip="${attr(m.group.device.uid)}">`];
  m.heading.forEach((s, i) =>
    out.push(text(x, y + 3 + i * 3.5, s, 2.5, "start", 700)),
  );
  out.push(
    text(x, y + m.headerH - 2, "Same location", 2.5),
    text(
      x + m.labelW + 8 + m.terminalW + m.gutter + 7,
      y + m.headerH - 2,
      "Other / unknown location",
      2.5,
    ),
  );
  y += m.headerH;
  const anchors = new Map<string, { x: number; y: number }>();
  for (const row of m.rows) {
    const terminal = terminalSvg(m, row, x, y);
    out.push(terminal.svg);
    anchors.set(row.terminal.key, terminal);
    y += row.height;
  }
  m.bridges.forEach((j, i) => {
    const a = required(
      anchors.get(stripTerminalKey(j.endpoints[0].terminal)),
      "Missing jumper terminal",
    );
    const b = required(
      anchors.get(stripTerminalKey(j.endpoints[1].terminal)),
      "Missing jumper terminal",
    );
    const edge = a.x + m.terminalW,
      lane = edge + 4 * (i + 1);
    out.push(
      `<g data-strip-jumper="${attr(j.uid)}"><path d="M ${n(edge)} ${n(a.y)} H ${n(lane)} V ${n(b.y)} H ${n(edge)}" fill="none" stroke="#18212b" stroke-width="0.5"/>`,
      text(lane, Math.min(a.y, b.y) + 3, `B${i + 1}`, 2.5, "middle"),
      "</g>",
    );
  });
  m.legend.forEach((s, i) => out.push(text(x, y + 3 + i * 3.5, s, 2.5)));
  return [...out, "</g>"].join("\n");
}
/** One complete schematic projection, bounded to one extra terminal-report sheet. */
export function terminalStrip(
  ir: Readonly<ElectricalIr>,
  table: DocumentationTable,
  b: DrawingBounds,
) {
  if (table.kind !== "terminals" || !table.rows.length) return undefined;
  const facts = stripFacts(ir, table);
  const notes = labelLines(
    "Schematic projection; hardware unspecified; dimensions unspecified. Location groups do not assign installation sides. Tn/Rn links each strip terminal to its inventory row.",
    b.w,
  );
  const area = { ...b, y: b.y + 9, h: b.h - 13 - notes.length * 3.5 };
  let placed: ReturnType<typeof placeGroups>;
  for (const columns of [1, 2, 3]) {
    try {
      placed = placeGroups(facts, area, columns);
    } catch {
      continue;
    }
    if (placed) break;
  }
  if (!placed)
    throw Error(
      `Terminal strip ${JSON.stringify(table.title)} cannot fit one additional sheet at 2.5 mm; use larger paper or a narrower terminal selection.`,
    );
  const content = [
    text(b.x, b.y + 3, `${table.title} — graphical strip`, 4, "start", 700),
    ...placed.map((p) => groupSvg(p.measured, p.x, p.y)),
    ...notes.map((s, i) =>
      text(b.x, b.y + b.h - (notes.length - 1 - i) * 3.5, s, 2.5),
    ),
  ].join("\n");
  return { content, facts };
}
export function stripRowReference(
  ref: string | undefined,
  key: string,
  x: number,
  y: number,
) {
  return ref
    ? text(x, y, ref, 2.5).replace(
        "<text ",
        `<text data-strip-row="${attr(key)}" data-strip-ref="${attr(ref)}" `,
      )
    : "";
}
export function stripDraft(
  base: Pick<Draft, "view" | "title">,
  content: string,
): Draft {
  return {
    ...base,
    content,
    links: [],
    references: [],
    note: "Graphical strip; inventory references Tn/Rn",
    documentationTable: true,
  };
}
