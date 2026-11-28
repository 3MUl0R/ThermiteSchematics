import type { IrFunction, TerminalId } from "@thermite/compiler";
import { required } from "../presentation/util.js";
import { escapeXmlAttribute as attr } from "../svg/escape.js";
import { captionInk } from "./caption-ink.js";
import { TERMINAL_TEXT_SIZE } from "./circuit-text.js";
import {
  circuitAttachment,
  circuitAttachmentHalo,
  circuitAttachmentLead,
  circuitAttachmentPathData,
  circuitAttachmentPoints,
  type AttachmentLabelClearance,
  type CircuitMark,
} from "./circuit.js";
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

type PlanRow = { f: IrFunction; mark: CircuitMark };

export type PlannedAttachment = {
  readonly pinId: string;
  readonly terminal: TerminalId;
  readonly pin: { x: number; y: number };
  readonly target: { x: number; y: number };
  readonly path: string;
  readonly stroke: number;
};

export type NodeAttachmentPlan = {
  readonly baseClearance: AttachmentLabelClearance;
  readonly layered: boolean;
  readonly clearanceFor: (
    terminal: TerminalId,
    targetSide: string,
  ) => AttachmentLabelClearance;
};

const termKey = (t: TerminalId) => JSON.stringify([t.deviceUid, t.terminalKey]);
const sameTerminal = (a: TerminalId, b: TerminalId) =>
  a.deviceUid === b.deviceUid && a.terminalKey === b.terminalKey;

function findAttachmentPin<P extends AttachmentPin>(
  pins: readonly P[],
  terminal: TerminalId,
  side: string,
): P | undefined {
  return (
    pins.find((p) => sameTerminal(p.terminal, terminal) && p.side === side) ??
    pins.find((p) => sameTerminal(p.terminal, terminal))
  );
}

export function nodeAttachmentLabelClearance(
  node: AttachmentNode,
): AttachmentLabelClearance {
  let northBottom: number | undefined;
  let southTop: number | undefined;
  let lateralCrossTop: number | undefined;
  let westRight: number | undefined;
  let eastLeft: number | undefined;
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
      if (p.side === "WEST")
        westRight =
          westRight === undefined ? ink.right : Math.max(westRight, ink.right);
      else
        eastLeft =
          eastLeft === undefined ? ink.left : Math.min(eastLeft, ink.left);
    }
  }
  return {
    ...(northBottom === undefined ? {} : { northBottom }),
    ...(southTop === undefined ? {} : { southTop }),
    ...(lateralCrossTop === undefined ? {} : { lateralCrossTop }),
    ...(westRight === undefined ? {} : { westRight }),
    ...(eastLeft === undefined ? {} : { eastLeft }),
  };
}

function orderByPinIndex(
  node: AttachmentNode,
  keys: ReadonlySet<string>,
): Map<string, number> {
  const ordered: string[] = [];
  for (const pin of node.pins) {
    const k = termKey(pin.terminal);
    if (keys.has(k) && !ordered.includes(k)) ordered.push(k);
  }
  for (const k of keys) if (!ordered.includes(k)) ordered.push(k);
  return new Map(ordered.map((k, idx) => [k, idx]));
}

function scanAttachmentOffsets(
  node: AttachmentNode,
  rows: readonly PlanRow[],
  centers: readonly { x: number; y: number }[],
  vertical: boolean,
  oneSided: (f: IrFunction, mark: CircuitMark) => boolean,
) {
  const countByPin = new Map<string, number>();
  const northOff = new Set<string>(),
    southOff = new Set<string>(),
    westOff = new Set<string>(),
    eastOff = new Set<string>(),
    crossOff = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (oneSided(row.f, row.mark) && row.f.kind !== "bus") continue;
    const c = centers[i],
      first = row.f.terminals[0],
      last = row.f.terminals.at(-1);
    if (!c || !first || !last) continue;
    const ends = row.mark === "earth" ? [first] : [first, last];
    for (const [j, t] of ends.entries()) {
      const side = vertical
        ? j === 0
          ? "NORTH"
          : "SOUTH"
        : j === 0
          ? "WEST"
          : "EAST";
      const pin = findAttachmentPin(node.pins, t, side);
      if (!pin) continue;
      const k = termKey(t);
      const pinKey = pin.id ?? `${k}@${pin.side}@${pin.x},${pin.y}`;
      countByPin.set(pinKey, (countByPin.get(pinKey) ?? 0) + 1);
      const target = vertical
        ? { x: c.x, y: c.y + (j === 0 ? -4 : 4) }
        : { x: c.x + (j === 0 ? -4 : 4), y: c.y };
      if (pin.side !== side) {
        crossOff.add(k);
        if (vertical) {
          northOff.add(k);
          southOff.add(k);
        }
      } else if (vertical && Math.abs(pin.x - target.x) >= 1e-7) {
        (side === "NORTH" ? northOff : southOff).add(k);
      } else if (!vertical && Math.abs(pin.y - target.y) >= 1e-7) {
        (side === "WEST" ? westOff : eastOff).add(k);
      }
    }
  }
  return { countByPin, northOff, southOff, westOff, eastOff, crossOff };
}

/** Shared deterministic attachment stagger and layering plan for emission and caption reservation. */
export function buildNodeAttachmentPlan(
  node: AttachmentNode,
  rows: readonly PlanRow[],
  centers: readonly { x: number; y: number }[],
  vertical: boolean,
  oneSided: (f: IrFunction, mark: CircuitMark) => boolean,
): NodeAttachmentPlan {
  const baseClearance = nodeAttachmentLabelClearance(node);
  const { countByPin, northOff, southOff, westOff, eastOff, crossOff } =
    scanAttachmentOffsets(node, rows, centers, vertical, oneSided);
  const northRank = orderByPinIndex(node, northOff);
  const southRank = orderByPinIndex(node, southOff);
  const westRank = orderByPinIndex(node, westOff);
  const eastRank = orderByPinIndex(node, eastOff);
  const crossRank = orderByPinIndex(node, crossOff);
  const layered = [...countByPin.values()].some((count) => count >= 2);
  return {
    baseClearance,
    layered,
    clearanceFor(terminal, targetSide) {
      const k = termKey(terminal);
      const northLevel = northRank.get(k);
      const southLevel = southRank.get(k);
      const crossLevel = crossRank.get(k);
      const lateralSideLevel =
        targetSide === "WEST"
          ? westRank.get(k)
          : targetSide === "EAST"
            ? eastRank.get(k)
            : undefined;
      return {
        ...baseClearance,
        ...(northLevel === undefined
          ? {}
          : { northLevel, northLevels: northRank.size }),
        ...(southLevel === undefined
          ? {}
          : { southLevel, southLevels: southRank.size }),
        ...(crossLevel === undefined ? {} : { crossLevel }),
        ...(lateralSideLevel === undefined ? {} : { lateralSideLevel }),
      };
    },
  };
}

export function collectRowAttachments(
  node: AttachmentNode<AttachmentPin & { id: string }>,
  terminals: readonly TerminalId[],
  earth: boolean,
  vertical: boolean,
  cx: number,
  cy: number,
  plan: NodeAttachmentPlan,
  weights?: ReadonlyMap<string, number>,
): PlannedAttachment[] {
  return [
    required(terminals[0], "Missing first attachment terminal"),
    ...(earth
      ? []
      : [required(terminals.at(-1), "Missing last attachment terminal")]),
  ].map((terminal, i) => {
    const side = vertical
      ? i === 0
        ? "NORTH"
        : "SOUTH"
      : i === 0
        ? "WEST"
        : "EAST";
    const pin = required(
      findAttachmentPin(node.pins, terminal, side),
      "Missing circuit attachment pin",
    );
    const target = vertical
      ? { x: cx, y: cy + (i === 0 ? -4 : 4) }
      : { x: cx + (i === 0 ? -4 : 4), y: cy };
    const clearance = plan.clearanceFor(terminal, side);
    const points = circuitAttachmentPoints(
      pin,
      target,
      side,
      node.width,
      node.height,
      clearance,
    );
    return {
      pinId: pin.id,
      terminal,
      pin: { x: pin.x, y: pin.y },
      target,
      path: circuitAttachmentPathData(points),
      stroke: terminalAttachmentStroke(pin.id, weights),
    };
  });
}

/** Paint all halos of each physical terminal before all dark leads of that terminal,
 * preventing same-terminal halo notches while cleanly bridging distinct terminals. */
export function emitLayeredAttachments(
  node: AttachmentNode<AttachmentPin & { id: string }>,
  entries: readonly PlannedAttachment[],
): string {
  const byPin = new Map<string, PlannedAttachment[]>();
  for (const entry of entries) {
    const list = byPin.get(entry.pinId) ?? [];
    list.push(entry);
    byPin.set(entry.pinId, list);
  }
  const orderedPins = node.pins.map((p) => p.id).filter((id) => byPin.has(id));
  for (const id of byPin.keys())
    if (!orderedPins.includes(id)) orderedPins.push(id);
  const out: string[] = [];
  for (const pinId of orderedPins) {
    const group = byPin.get(pinId) ?? [];
    for (const e of group) out.push(circuitAttachmentHalo(e.path));
    for (const e of group) {
      out.push(
        `<g data-terminal-attachment="${attr(termKey(e.terminal))}" data-attachment-from="${attr(JSON.stringify(e.pin))}" data-attachment-to="${attr(JSON.stringify(e.target))}">${circuitAttachmentLead(e.path, e.stroke)}</g>`,
      );
    }
  }
  return out.join("");
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
  plan?: NodeAttachmentPlan,
): string {
  const fallbackClearance = plan
    ? undefined
    : nodeAttachmentLabelClearance(node);
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
      const pin = required(
        findAttachmentPin(node.pins, terminal, side),
        "Missing circuit attachment pin",
      );
      const target = vertical
        ? { x: cx, y: cy + (i === 0 ? -4 : 4) }
        : { x: cx + (i === 0 ? -4 : 4), y: cy };
      const labelClearance =
        plan?.clearanceFor(terminal, side) ?? fallbackClearance;
      return `<g data-terminal-attachment="${attr(termKey(terminal))}" data-attachment-from="${attr(JSON.stringify({ x: pin.x, y: pin.y }))}" data-attachment-to="${attr(JSON.stringify(target))}">${circuitAttachment(pin, target, side, node.width, node.height, terminalAttachmentStroke(pin.id, weights), labelClearance)}</g>`;
    })
    .join("");
}
