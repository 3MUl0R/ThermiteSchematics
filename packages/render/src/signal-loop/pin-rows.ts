import type { IrDeviceType } from "@thermite/compiler";
import { wrapText } from "../text-metrics.js";

/** Keep native row ownership alongside the unchanged caption line layout. */
export function appendPinRows(
  caption: string[],
  type: IrDeviceType,
  terminals: readonly string[],
  uid: string,
  width: number,
) {
  const rows = new Map<number, string>();
  for (const terminal of terminals) {
    const role = type.terminals.find((t) => t.key === terminal)?.description;
    if (!role) continue;
    rows.set(caption.length, JSON.stringify([uid, terminal]));
    caption.push(...wrapText(`${terminal}: ${role}`, width, 2.7));
  }
  return rows;
}

import { text } from "../packet/svg.js";
import { escapeXmlAttribute as attr } from "../svg/escape.js";
export function pinLegend(
  uid: string,
  terminal: string,
  role: string,
  width: number,
  x: number,
  y: number,
) {
  const lines = wrapText(`${terminal}  ${role}`, width, 2.7);
  if (lines.length > 2)
    throw Error("Pin legend is too long for the assembly symbol.");
  return lines.map((line, i) =>
    text(x, y + i * 3.3, line.normalize("NFC"), 2.7).replace(
      "<text ",
      i === 0
        ? `<text data-pin-terminal="${attr(JSON.stringify([uid, terminal]))}" `
        : "<text ",
    ),
  );
}
