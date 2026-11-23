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

export interface NetLabelCollisionReport {
  firstMessage?: string | undefined;
  firstNetId?: string | undefined;
  readonly labelIds: Set<string>;
}

export function createNetLabelCollisionReport(): NetLabelCollisionReport {
  return { labelIds: new Set<string>() };
}

export function recordNetLabelCollision(
  report: NetLabelCollisionReport,
  labelId: string,
  message: string,
  netId?: string,
): void {
  if (report.firstMessage === undefined) {
    report.firstMessage = message;
    report.firstNetId = netId;
  }
  report.labelIds.add(labelId);
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
export function checkLabelClearOfDevicesAndEdges(
  graph: Readonly<PresentationGraph>,
  label: LayoutLabel,
  labelBounds: Bounds,
  layoutNodes: ReadonlyMap<string, LayoutNode>,
  segments: readonly Segment[],
  netCollisions: NetLabelCollisionReport,
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
          recordNetLabelCollision(
            netCollisions,
            label.id,
            `label ${label.id} overlaps non-owner device ${node.id}`,
            edge.netId,
          );
        }
      }
    }
  }
  for (const segment of segments) {
    if (!segmentIntersectsInterior(segment, labelBounds)) continue;
    if (label.role === "net" && label.ownerKind === "edge") {
      recordNetLabelCollision(
        netCollisions,
        label.id,
        `label ${label.id} overlaps edge ${segment.edge.id}`,
        segment.edge.netId,
      );
      continue;
    }
    reject(
      `label ${label.id} overlaps edge ${segment.edge.id}`,
      segment.edge.netId,
    );
  }
}

/**
 * Only edge net-label vs terminal-marking overlaps are recorded as recoverable
 * `net-label-intersection` collisions (deliberate: wide TTB source net labels
 * can encroach on a sibling port's terminal marking and are resolved by pitch
 * widening; LTR never widens and still refuses with R004). Any other pair is a
 * `contract-violation`, except we do not mask an already-recorded collision on
 * the same edge net label (and never add unrelated labels to `labelIds`).
 */
export function checkLabelPairOverlap(
  graph: Readonly<PresentationGraph>,
  left: LayoutLabel,
  right: LayoutLabel,
  netCollisions: NetLabelCollisionReport,
  reject: (message: string) => never,
): void {
  const leftIsEdgeNet = left.role === "net" && left.ownerKind === "edge";
  const rightIsEdgeNet = right.role === "net" && right.ownerKind === "edge";
  const netLabel = leftIsEdgeNet ? left : rightIsEdgeNet ? right : undefined;
  const other = netLabel === left ? right : left;
  if (netLabel !== undefined && other.role === "terminal") {
    const edge = graph.edges.find((e) => e.id === netLabel.ownerId);
    recordNetLabelCollision(
      netCollisions,
      netLabel.id,
      `labels ${left.id} and ${right.id} overlap`,
      edge?.netId,
    );
    return;
  }
  if (
    netLabel !== undefined &&
    netCollisions.labelIds.has(netLabel.id) &&
    (!(leftIsEdgeNet && rightIsEdgeNet) || netCollisions.labelIds.has(other.id))
  ) {
    return;
  }
  reject(`labels ${left.id} and ${right.id} overlap`);
}

export function checkAllLabelPairOverlaps(
  graph: Readonly<PresentationGraph>,
  labels: readonly LayoutLabel[],
  inkBounds: (label: LayoutLabel) => Bounds,
  overlaps: (left: Bounds, right: Bounds) => boolean,
  netCollisions: NetLabelCollisionReport,
  reject: (
    message: string,
    netId?: string,
    failureKind?: "net-label-intersection",
    collidingNetLabelIds?: readonly string[],
  ) => never,
): void {
  for (let leftIndex = 0; leftIndex < labels.length; leftIndex++) {
    const left = labels[leftIndex];
    if (left === undefined) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < labels.length;
      rightIndex++
    ) {
      const right = labels[rightIndex];
      if (right !== undefined && overlaps(inkBounds(left), inkBounds(right)))
        checkLabelPairOverlap(graph, left, right, netCollisions, reject);
    }
  }
  if (netCollisions.firstMessage !== undefined)
    reject(
      netCollisions.firstMessage,
      netCollisions.firstNetId,
      "net-label-intersection",
      [...netCollisions.labelIds],
    );
}
