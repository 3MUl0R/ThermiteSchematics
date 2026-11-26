import { deviceTagFields } from "../device-tags.js";
import type { IrDevice, IrDeviceType } from "@thermite/compiler";
import { drawingDeviceTag } from "../device-tag-svg.js";
import { CAPTION_CLEARANCE_MM, CaptionPlacementError } from "./caption-ink.js";
import { printableTextMetrics } from "../text-metrics.js";
import { CIRCUIT_TAG_COLUMN_WIDTH } from "./circuit-relations.js";

interface CaptionOwner {
  width: number;
  height?: number;
  device: { designation: string };
  relationLabels: readonly string[];
  pins: { x: number; y?: number; side: string }[];
}

function setNodeHeight(node: CaptionOwner, height: number, vertical: boolean) {
  node.height = height;
  if (vertical)
    for (const p of node.pins) if (p.side === "SOUTH") p.y = node.height;
}

function growNodeWidth(node: CaptionOwner, vertical: boolean, gap: number) {
  const metrics = [
    printableTextMetrics(node.device.designation, 2.7, true),
    ...node.relationLabels.map((s) => printableTextMetrics(s, 2.5)),
  ];
  node.width += Math.max(...metrics.map((m) => m.right - m.left)) + 2 * gap;
  if (!vertical)
    for (const p of node.pins) if (p.side === "EAST") p.x = node.width;
}

function footerBandGrowth(
  node: CaptionOwner,
  vertical: boolean,
  gap: number,
): number {
  const lineHeight = Math.max(
    2.5,
    ...node.relationLabels.map((s) => {
      const m = printableTextMetrics(s, 2.5);
      return m.top - m.bottom;
    }),
  );
  const stack =
    lineHeight + Math.max(0, node.relationLabels.length - 1) * 3.1 + gap;
  return ((vertical ? 2 : 1) * Math.ceil(stack * 1000)) / 1000;
}

/** Validate with the emitter's actual local ink before ELK. Only an owner
 * without a legal caption position grows its footer band or side lane.
 * Existing printable nodes, wrapping and port identities stay unchanged. */
export function reserveCircuitCaptions<Node extends CaptionOwner>(
  nodes: Node[],
  vertical: boolean,
  probe: (node: Node) => unknown,
): void {
  const gap = CAPTION_CLEARANCE_MM + 0.4 / 2 + 0.002;
  for (const node of nodes) {
    let baseHeight: number | undefined;
    let footerGrowth = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        probe(node);
        break;
      } catch (error) {
        if (!(error instanceof CaptionPlacementError)) throw error;
        if (
          error.role === "footer" &&
          node.height !== undefined &&
          baseHeight === undefined &&
          attempt === 0
        ) {
          baseHeight = node.height;
          footerGrowth = footerBandGrowth(node, vertical, gap);
          setNodeHeight(node, baseHeight + footerGrowth, vertical);
          continue;
        }
        if (baseHeight !== undefined && attempt === 1) {
          setNodeHeight(node, baseHeight, vertical);
          growNodeWidth(node, vertical, gap);
          continue;
        }
        if (baseHeight !== undefined && attempt === 2) {
          setNodeHeight(node, baseHeight + footerGrowth, vertical);
          continue;
        }
        if (attempt >= (baseHeight !== undefined ? 3 : 2)) throw error;
        growNodeWidth(node, vertical, gap);
      }
    }
  }
}

/** The tag lane is disjoint from the existing pin, symbol and caption lanes. */
export function circuitTagReservation(
  width: number,
  height: number,
  tag: { widthMm: number; heightMm: number },
  vertical: boolean,
) {
  return vertical
    ? {
        width: width + 2 + tag.widthMm,
        height: Math.max(height, tag.heightMm),
        tagX: width + 2,
        tagY: 0,
        bodyX: 0,
        bodyY: 0,
      }
    : {
        width: Math.max(width, tag.widthMm),
        height: height + 2 + tag.heightMm,
        tagX: 0,
        tagY: 0,
        bodyX: 0,
        bodyY: tag.heightMm + 2,
      };
}

export function reserveCircuitDeviceTag<
  Node extends {
    device: IrDevice;
    type: IrDeviceType;
    width: number;
    height: number;
    tagColumnCaptions: readonly string[];
    rows: { center: number }[];
    pins: { x: number; y: number; side: string }[];
  },
>(node: Node, vertical: boolean) {
  if (!vertical) {
    // The old primary designation band moves into the tag lane.
    node.height -= 4;
    node.rows = node.rows.map((row) => ({ ...row, center: row.center - 4 }));
    node.pins = node.pins.map((pin) => ({ ...pin, y: pin.y - 4 }));
  }
  const plan = drawingDeviceTag(
    node.device,
    node.type,
    vertical
      ? deviceTagFields(node.device, node.type).length === 1
        ? 7
        : CIRCUIT_TAG_COLUMN_WIDTH
      : deviceTagFields(node.device, node.type).length === 1
        ? Math.min(50, node.width)
        : Math.max(42, Math.min(50, node.width)),
    1,
  );
  const geometry = circuitTagReservation(
    node.width,
    node.height,
    node.tagColumnCaptions.length
      ? {
          widthMm: Math.max(plan.widthMm, CIRCUIT_TAG_COLUMN_WIDTH),
          heightMm: plan.heightMm + node.tagColumnCaptions.length * 3.1 + 1,
        }
      : plan,
    vertical,
  );
  const body = { ...node };
  return Object.assign(node, {
    tagLane: { body, plan, geometry },
    width: geometry.width,
    height: geometry.height,
    pins: body.pins.map((p) => ({
      ...p,
      x: p.side === "EAST" ? geometry.width : p.x + geometry.bodyX,
      y: p.side === "SOUTH" ? geometry.height : p.y + geometry.bodyY,
    })),
  });
}
