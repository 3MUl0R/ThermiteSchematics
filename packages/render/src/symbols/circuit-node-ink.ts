import {
  conversionQualifierSpan,
  interfaceLeadTip,
  interfaceOutlineRect,
  usesCircuitInterface,
} from "./circuit-interface.js";
import { ownerExtraSegments, type InkOwner } from "./circuit-owner-ink.js";
import type { IrFunction, TerminalId } from "@thermite/compiler";
import {
  buildNodeAttachmentPlan,
  type NodeAttachmentPlan,
} from "./circuit-attachments.js";
import {
  circuitAttachmentPoints,
  circuitMarkSegments,
  type CircuitMark,
} from "./circuit.js";
import type { CaptionPoint, CaptionSegment } from "./circuit-caption.js";

type Row = { f: IrFunction; mark: CircuitMark };
type Node = InkOwner;
const same = (a: TerminalId, b: TerminalId) =>
  a.deviceUid === b.deviceUid && a.terminalKey === b.terminalKey;

function interfaceSegments(
  node: Node,
  centers: readonly CaptionPoint[],
  vertical: boolean,
): CaptionSegment[] {
  return node.rows.flatMap((row, i) => {
    if (!usesCircuitInterface(row.f.kind, row.mark)) return [];
    const c = centers[i];
    if (!c) throw Error("Missing caption owner center");
    const pins = row.f.terminals.map((t) => {
      const p = node.pins.find((p) => same(p.terminal, t));
      if (!p) throw Error("Missing interface caption pin");
      return p;
    });
    const source = row.f.kind === "source";
    const segments: CaptionSegment[] = pins.map(
      (p) =>
        [
          { x: p.x, y: p.y },
          interfaceLeadTip(row.mark, p, pins, c.x, c.y, vertical, source),
        ] as const,
    );
    const rect = interfaceOutlineRect(
      row.mark,
      c.x,
      c.y,
      pins,
      vertical,
      source,
    );
    if (rect) {
      const { x, y, width, height } = rect;
      segments.push(
        [
          { x, y },
          { x: x + width, y },
        ],
        [
          { x: x + width, y },
          { x: x + width, y: y + height },
        ],
        [
          { x: x + width, y: y + height },
          { x, y: y + height },
        ],
        [
          { x, y: y + height },
          { x, y },
        ],
      );
    }
    return segments;
  });
}

function attachmentSegments(
  node: Node,
  row: Row,
  c: CaptionPoint,
  vertical: boolean,
  plan: NodeAttachmentPlan,
  actual = false,
): CaptionSegment[] {
  const first = row.f.terminals[0],
    last = row.f.terminals.at(-1);
  if (!first || !last) return [];
  const ends = actual
    ? row.mark === "earth"
      ? [first]
      : [first, last]
    : row.f.terminals.filter(
        (_, i) => i === 0 || i === row.f.terminals.length - 1,
      );
  return ends.flatMap((terminal, j) => {
    const side = vertical
      ? j === 0
        ? "NORTH"
        : "SOUTH"
      : j === 0
        ? "WEST"
        : "EAST";
    const pin =
      node.pins.find((p) => same(p.terminal, terminal) && p.side === side) ??
      node.pins.find((p) => same(p.terminal, terminal));
    if (!pin) return [];
    const target = vertical
      ? { x: c.x, y: c.y + (j === 0 ? -4 : 4) }
      : { x: c.x + (j === 0 ? -4 : 4), y: c.y };
    const points = circuitAttachmentPoints(
      pin,
      target,
      side,
      node.width,
      node.height,
      plan.clearanceFor(terminal, side),
    );
    return points.slice(1).map((b, i) => {
      const a = points[i];
      if (!a) throw Error("Missing attachment vertex");
      return [
        { x: a[0], y: a[1] },
        { x: b[0], y: b[1] },
      ] as const;
    });
  });
}

function rowMarkSegments(
  node: Node,
  row: Row,
  center: CaptionPoint,
  vertical: boolean,
) {
  if (row.mark !== "ac-input" && row.mark !== "dc-output")
    return circuitMarkSegments(row.mark, center.x, center.y, vertical);
  const positions = row.f.terminals.map((t) => {
    const pin = node.pins.find((p) => same(p.terminal, t));
    if (!pin) throw Error("Missing conversion caption pin");
    return vertical ? pin.x : pin.y;
  });
  const span = conversionQualifierSpan(
    row.mark,
    vertical ? center.x : center.y,
    positions,
  );
  return circuitMarkSegments(row.mark, center.x, center.y, vertical, span);
}

/** Preserve the existing optional contact-caption obstacles. Required captions
 * additionally check actual interface leads, excluding unpainted attachments. */
export function nodeCaptionSegments(
  node: Node,
  centers: readonly CaptionPoint[],
  vertical: boolean,
  oneSided: (f: IrFunction, mark: CircuitMark) => boolean,
) {
  const marks = centers.map((c, i) => {
    const row = node.rows[i];
    if (!row) throw Error("Missing caption owner row");
    return rowMarkSegments(node, row, c, vertical);
  });
  const captionSegments = marks.flat();
  const ownerSegments = [
    ...marks.flatMap((segments, i) =>
      node.rows[i]?.mark === "winding" ? [] : segments,
    ),
    ...ownerExtraSegments(node, centers, vertical),
    ...interfaceSegments(node, centers, vertical),
  ];
  const attachmentPlan = buildNodeAttachmentPlan(
    node,
    node.rows,
    centers,
    vertical,
    oneSided,
  );
  for (const [i, row] of node.rows.entries()) {
    const c = centers[i];
    if (!c) throw Error("Missing caption owner center");
    const segments = attachmentSegments(node, row, c, vertical, attachmentPlan);
    captionSegments.push(...segments);
    if (!oneSided(row.f, row.mark) || row.f.kind === "bus")
      ownerSegments.push(
        ...attachmentSegments(node, row, c, vertical, attachmentPlan, true),
      );
  }
  return { captionSegments, ownerSegments };
}
