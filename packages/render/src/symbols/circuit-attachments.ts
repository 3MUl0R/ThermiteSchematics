import type { TerminalId } from "@thermite/compiler";
import { required } from "../presentation/util.js";
import { escapeXmlAttribute as attr } from "../svg/escape.js";
import { captionInk } from "./caption-ink.js";
import { TERMINAL_TEXT_SIZE } from "./circuit-text.js";
import { circuitAttachment, type AttachmentLabelClearance } from "./circuit.js";
import { terminalAttachmentStroke } from "./attachment-stroke.js";

type AttachmentPin = {
  id?: string;
  terminal: TerminalId;
  x: number;
  y: number;
  side: string;
  label?: string;
  outside?: number;
  omitLabel?: boolean;
};

type AttachmentNode<P extends AttachmentPin = AttachmentPin> = {
  width: number;
  height: number;
  pins: readonly P[];
};

export function nodeAttachmentLabelClearance(
  node: AttachmentNode,
): AttachmentLabelClearance {
  let northBottom: number | undefined;
  let southTop: number | undefined;
  let lateralCrossTop: number | undefined;
  for (const p of node.pins) {
    if (p.omitLabel) continue;
    const text =
      (p.label ?? p.terminal.terminalKey) +
      (p.outside ? ` [+${p.outside}]` : "");
    if (p.side === "NORTH") {
      const ink = captionInk(text, p.x + 1, 6, TERMINAL_TEXT_SIZE, "start");
      northBottom =
        northBottom === undefined
          ? ink.bottom
          : Math.max(northBottom, ink.bottom);
    } else if (p.side === "SOUTH") {
      const ink = captionInk(
        text,
        p.x + 1,
        node.height - 1.5,
        TERMINAL_TEXT_SIZE,
        "start",
      );
      southTop = southTop === undefined ? ink.top : Math.min(southTop, ink.top);
    } else if (p.side === "WEST" || p.side === "EAST") {
      const ink = captionInk(
        text,
        p.side === "WEST" ? 1.5 : node.width - 1.5,
        p.y - 1.5,
        TERMINAL_TEXT_SIZE,
        p.side === "EAST" ? "end" : "start",
      );
      lateralCrossTop =
        lateralCrossTop === undefined
          ? ink.top
          : Math.min(lateralCrossTop, ink.top);
    }
  }
  return {
    ...(northBottom === undefined ? {} : { northBottom }),
    ...(southTop === undefined ? {} : { southTop }),
    ...(lateralCrossTop === undefined ? {} : { lateralCrossTop }),
  };
}

/** Preserve catalog attachment geometry while selecting ink by the routed port. */
export function circuitTerminalAttachments(
  node: AttachmentNode<AttachmentPin & { id: string }>,
  terminals: readonly TerminalId[],
  earth: boolean,
  vertical: boolean,
  cx: number,
  cy: number,
  weights?: ReadonlyMap<string, number>,
): string {
  const labelClearance = nodeAttachmentLabelClearance(node);
  return [
    required(terminals[0], "Missing first attachment terminal"),
    ...(earth
      ? []
      : [required(terminals.at(-1), "Missing last attachment terminal")]),
  ]
    .map((terminal, i) => {
      const side = vertical
        ? i === 0
          ? "NORTH"
          : "SOUTH"
        : i === 0
          ? "WEST"
          : "EAST";
      const same = (t: TerminalId) =>
        t.deviceUid === terminal.deviceUid &&
        t.terminalKey === terminal.terminalKey;
      const pin = required(
        node.pins.find((p) => same(p.terminal) && p.side === side) ??
          node.pins.find((p) => same(p.terminal)),
        "Missing circuit attachment pin",
      );
      const target = vertical
        ? { x: cx, y: cy + (i === 0 ? -4 : 4) }
        : { x: cx + (i === 0 ? -4 : 4), y: cy };
      return `<g data-terminal-attachment="${attr(JSON.stringify([terminal.deviceUid, terminal.terminalKey]))}" data-attachment-from="${attr(JSON.stringify({ x: pin.x, y: pin.y }))}" data-attachment-to="${attr(JSON.stringify(target))}">${circuitAttachment(pin, target, side, node.width, node.height, terminalAttachmentStroke(pin.id, weights), labelClearance)}</g>`;
    })
    .join("");
}
