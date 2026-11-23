import type {
  LayoutEdge,
  LayoutLabel,
  LayoutNode,
  LayoutPoint,
  PresentationGraph,
} from "../types.js";
import type { Bounds } from "./validate-output.js";

export interface Segment {
  readonly edge: LayoutEdge;
  readonly start: LayoutPoint;
  readonly end: LayoutPoint;
  readonly horizontal: boolean;
}

export function segmentIntersectsInterior(segment: Segment, bounds: Bounds) {
  if (segment.horizontal) {
    const left = Math.min(segment.start.x, segment.end.x);
    const right = Math.max(segment.start.x, segment.end.x);
    return (
      segment.start.y > bounds.top &&
      segment.start.y < bounds.bottom &&
      Math.min(right, bounds.right) > Math.max(left, bounds.left)
    );
  }
  const top = Math.min(segment.start.y, segment.end.y);
  const bottom = Math.max(segment.start.y, segment.end.y);
  return (
    segment.start.x > bounds.left &&
    segment.start.x < bounds.right &&
    Math.min(bottom, bounds.bottom) > Math.max(top, bounds.top)
  );
}

/** A painted edge net label may sit at its route source device, never inside a non-owner device frame. */
export function assertLabelClearOfDevicesAndEdges(
  graph: Readonly<PresentationGraph>,
  label: LayoutLabel,
  labelBounds: Bounds,
  layoutNodes: ReadonlyMap<string, LayoutNode>,
  segments: readonly Segment[],
  reject: (
    message: string,
    netId?: string,
    failureKind?: "net-label-intersection",
  ) => never,
): void {
  if (label.role === "net" && label.ownerKind === "edge") {
    const edge = graph.edges.find((e) => e.id === label.ownerId);
    if (edge !== undefined) {
      const sourceNode = graph.nodes.find((node) =>
        node.ports.some((port) => port.id === edge.sourcePortId),
      );
      const ownerDeviceId =
        sourceNode?.kind === "symbol" ? sourceNode.deviceGroupId : undefined;
      for (const node of layoutNodes.values()) {
        if (node.kind !== "device" || node.id === ownerDeviceId) continue;
        if (
          Math.min(labelBounds.right, node.x + node.width) >
            Math.max(labelBounds.left, node.x) &&
          Math.min(labelBounds.bottom, node.y + node.height) >
            Math.max(labelBounds.top, node.y)
        ) {
          reject(
            `label ${label.id} overlaps non-owner device ${node.id}`,
            edge.netId,
            "net-label-intersection",
          );
        }
      }
    }
  }
  for (const segment of segments) {
    if (!segmentIntersectsInterior(segment, labelBounds)) continue;
    reject(
      `label ${label.id} overlaps edge ${segment.edge.id}`,
      segment.edge.netId,
      label.role === "net" ? "net-label-intersection" : undefined,
    );
  }
}
