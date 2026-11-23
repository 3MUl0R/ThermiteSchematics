import {
  orientSymbolDefinition,
  verticalSourcePortSpacing,
} from "../symbols/catalog.js";
import type { SymbolDefinition } from "../symbols/types.js";
import type { RailPresentationNode, SymbolPresentationNode } from "../types.js";
import type { MutablePresentationEdge } from "./model.js";

const DEFAULT_PITCH_THRESHOLD_MARGIN = 4;
const WIDENED_PITCH_CLEARANCE = 12;

function requiredHorizontalSpan(
  node: SymbolPresentationNode,
  edges: readonly MutablePresentationEdge[],
): number {
  const southPorts = node.ports
    .filter((port) => port.side === "south")
    .sort((left, right) => left.offset - right.offset);
  if (southPorts.length < 2) return 0;
  let maxWidth = 0;
  for (let i = 0; i < southPorts.length - 1; i++) {
    const port = southPorts[i];
    if (port === undefined) continue;
    for (const edge of edges) {
      if (edge.sourcePortId === port.id && edge.netLabel !== undefined) {
        maxWidth = Math.max(maxWidth, edge.netLabel.width);
      }
    }
    for (const label of node.labels) {
      if (label.ownerKind === "port" && label.ownerId === port.id) {
        maxWidth = Math.max(maxWidth, label.width);
      }
    }
  }
  return maxWidth;
}

/**
 * In top-to-bottom flow, horizontal TAIL net labels sit to the right of
 * vertical conductors leaving a multi-port source symbol. Widen the symbol's
 * horizontal port pitch when a label would otherwise cross the adjacent
 * conductor, keeping net labels anchored at the route source instead of
 * moving them to the route destination. Left-to-right flow is never changed.
 */
export function widenVerticalSourceNodes(
  nodes: (SymbolPresentationNode | RailPresentationNode)[],
  edges: readonly MutablePresentationEdge[],
  symbolById: ReadonlyMap<SymbolDefinition["id"], SymbolDefinition>,
): void {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (
      node === undefined ||
      node.kind !== "symbol" ||
      node.orientation !== "top-to-bottom"
    ) {
      continue;
    }
    const spec = verticalSourcePortSpacing(node.symbolId);
    if (spec === undefined) continue;
    const maxWidth = requiredHorizontalSpan(node, edges);
    if (maxWidth <= spec.defaultPitch - DEFAULT_PITCH_THRESHOLD_MARGIN) {
      continue;
    }
    const symbol = symbolById.get(node.symbolId);
    if (symbol === undefined) continue;
    const pitch = Math.ceil((maxWidth + WIDENED_PITCH_CLEARANCE) / 2) * 2;
    const targetWidth = spec.widthForPitch(pitch);
    orientSymbolDefinition(symbol, "top-to-bottom", targetWidth);
    const deltaWidth = targetWidth - node.symbolSize.width;
    nodes[index] = {
      ...node,
      symbolSize: { width: targetWidth, height: node.symbolSize.height },
      width: Number((node.width + deltaWidth).toFixed(3)),
    };
  }
}
