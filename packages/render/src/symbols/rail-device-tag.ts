import type { RailPresentationNode, SymbolPresentationNode } from "../types.js";
import type { SvgWriter } from "../svg/writer.js";
import type { RenderSourceRegistry } from "../svg/source-registry.js";
import { printableTextMetrics } from "../text-metrics.js";

export const RAIL_TAG_FONT = 10;

type RailTagNode = Pick<
  RailPresentationNode,
  "symbolId" | "orientation" | "designation" | "boundary"
>;

export interface RailDeviceTagPlacement {
  readonly x: number;
  readonly y: number;
  readonly textAnchor: "start" | "end";
  readonly box: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export function railDeviceTagWidth(designation: string): number {
  const m = printableTextMetrics(designation, RAIL_TAG_FONT, true);
  return Math.ceil((Math.max(m.advance, m.right - m.left) + 4) * 1000) / 1000;
}

/** Local native device tag beside a source-backed potential reference bar. */
export function railDeviceTagAnchor(
  node: RailTagNode,
): RailDeviceTagPlacement | undefined {
  if (node.boundary.kind !== "potential" || !node.designation.trim())
    return undefined;
  const m = printableTextMetrics(node.designation, RAIL_TAG_FONT, true);
  const w = Math.max(m.right - m.left, m.advance);
  const h = Math.max(m.top - m.bottom, 1);
  if (node.orientation === "top-to-bottom") {
    const x = 4;
    const y = node.symbolId === "ais:rail-source" ? -2 : 23;
    return {
      x,
      y,
      textAnchor: "start",
      box: { x: x + m.left, y: y - m.top, width: w, height: h },
    };
  }
  const y = 39;
  if (node.symbolId === "ais:rail-return") {
    const x = 12;
    return {
      x,
      y,
      textAnchor: "end",
      box: { x: x - m.advance + m.left, y: y - m.top, width: w, height: h },
    };
  }
  const x = 4;
  return {
    x,
    y,
    textAnchor: "start",
    box: { x: x + m.left, y: y - m.top, width: w, height: h },
  };
}

export function railDeviceTagNodeBox(
  node: RailTagNode & Pick<RailPresentationNode, "primitiveOrigin">,
) {
  const placement = railDeviceTagAnchor(node);
  if (!placement) return undefined;
  return {
    x: node.primitiveOrigin.x + placement.box.x,
    y: node.primitiveOrigin.y + placement.box.y,
    width: placement.box.width,
    height: placement.box.height,
  };
}

export function emitRailDeviceTag(
  writer: SvgWriter,
  node: RailPresentationNode,
  registry: RenderSourceRegistry,
): void {
  const tag = railDeviceTagAnchor(node);
  if (!tag) return;
  writer.element(
    2,
    "text",
    {
      class: "rail-device-tag",
      "data-rail-device-tag": "true",
      "data-rail-device-uid": node.deviceUid,
      x: tag.x,
      y: tag.y,
      "font-family": "Thermite Sans, Thermite Math, sans-serif",
      "font-size": RAIL_TAG_FONT,
      "font-weight": 700,
      "text-anchor": tag.textAnchor,
      fill: "#344054",
      stroke: "none",
    },
    registry.valueFor(
      "device.designation",
      node.designation,
      `rail ${node.id} device tag`,
    ),
  );
}

export function emitSymbolAnnotations(
  writer: SvgWriter,
  node: SymbolPresentationNode | RailPresentationNode,
  legends: readonly string[],
  anchor: Readonly<{ x: number; y: number }>,
  registry: RenderSourceRegistry,
): void {
  for (const [i, word] of legends.entries())
    writer.element(
      2,
      "text",
      {
        x: anchor.x,
        y: anchor.y + (legends.length > 1 ? (i === 0 ? -2 : 10) : 3),
        "font-family": "Thermite Sans, Thermite Math, sans-serif",
        "font-size": word === "M" ? 12 : 10,
        "text-anchor": "middle",
        fill: "#17212b",
        stroke: "none",
      },
      word,
    );
  if (node.kind === "rail") emitRailDeviceTag(writer, node, registry);
}
