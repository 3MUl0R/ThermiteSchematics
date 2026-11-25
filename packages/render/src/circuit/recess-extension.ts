import type { ElkNode } from "elkjs/lib/elk-api.js";
import { InlineLabelCollisionError } from "../layout/inline-label-error.js";
import { CIRCUIT_TAG_COLUMN_WIDTH } from "../symbols/circuit-relations.js";
import {
  circuitLandingGeometry,
  splitPhysicalCircuitPorts,
} from "./landing-ports.js";
import type { CircuitRouteState } from "./layout-routes.js";
import type { DeviceNode, Pin, Point } from "./types.js";

const MARKER_OUTER_RADIUS = 0.65 + 0.15;
const MARKER_CLEARANCE = 0.1;
const TAG_CLEARANCE = 0.1;
const CONDUCTOR_CLEARANCE = 0.05;

type Rect = { x0: number; y0: number; x1: number; y1: number };

type ExtendedRecess = {
  routeIndex: number;
  geom: ReturnType<typeof circuitLandingGeometry>;
  laid: ElkNode;
  localSeg: [Point, Point];
  sheetSeg: [Point, Point];
  strokeHalf: number;
};

function faceNormal(side: Pin["side"]): { nx: number; ny: number } {
  if (side === "EAST") return { nx: 1, ny: 0 };
  if (side === "WEST") return { nx: -1, ny: 0 };
  if (side === "SOUTH") return { nx: 0, ny: 1 };
  return { nx: 0, ny: -1 };
}

export function segmentLaunchesNormallyAwayFromFace(
  points: readonly Point[],
  isTarget: boolean,
  side: Pin["side"],
): boolean {
  const start = isTarget ? points.at(-1) : points[0];
  const next = isTarget ? points.at(-2) : points[1];
  if (!start || !next) return false;
  const { nx, ny } = faceNormal(side);
  const dx = next.x - start.x;
  const dy = next.y - start.y;
  return dx * nx + dy * ny > 1e-4 && Math.abs(dx * ny - dy * nx) <= 1e-6;
}

function rectOverlaps(a: Rect, b: Rect, pad = 0): boolean {
  return (
    a.x0 < b.x1 + pad - 1e-7 &&
    a.x1 > b.x0 - pad + 1e-7 &&
    a.y0 < b.y1 + pad - 1e-7 &&
    a.y1 > b.y0 - pad + 1e-7
  );
}

function strokeRect(a: Point, b: Point, half: number): Rect {
  const horiz = Math.abs(a.y - b.y) <= 1e-7;
  return {
    x0: Math.min(a.x, b.x) - (horiz ? 0 : half),
    x1: Math.max(a.x, b.x) + (horiz ? 0 : half),
    y0: Math.min(a.y, b.y) - (horiz ? half : 0),
    y1: Math.max(a.y, b.y) + (horiz ? half : 0),
  };
}

function pointToRectDist(p: Point, r: Rect): number {
  const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1);
  const dy = Math.max(r.y0 - p.y, 0, p.y - r.y1);
  return Math.hypot(dx, dy);
}

function assertTagAndSiblingClearance(
  ext: ExtendedRecess,
  box: Rect,
  groupId: string,
) {
  const { geom } = ext;
  const tagLane = geom.node.tagLane;
  if (!tagLane) return;
  const { body, plan, geometry: g } = tagLane;
  const tagRect: Rect = {
    x0: g.tagX,
    y0: g.tagY,
    x1: g.tagX + plan.widthMm,
    y1: g.tagY + plan.heightMm,
  };
  if (rectOverlaps(box, tagRect, TAG_CLEARANCE))
    throw new InlineLabelCollisionError(
      `Circuit ${groupId}: split recess extension encroaches on device tag box.`,
    );
  const captionW = Math.max(plan.widthMm, CIRCUIT_TAG_COLUMN_WIDTH);
  for (let i = 0; i < geom.node.tagColumnCaptions.length; i++) {
    const baseline = g.tagY + plan.heightMm + (i + 1) * 3.1;
    const capRect: Rect = {
      x0: g.tagX + 2,
      y0: baseline - 2.5,
      x1: g.tagX + captionW,
      y1: baseline + 0.5,
    };
    if (rectOverlaps(box, capRect, TAG_CLEARANCE))
      throw new InlineLabelCollisionError(
        `Circuit ${groupId}: split recess extension encroaches on tag caption.`,
      );
  }
  const minSiblingDist = MARKER_OUTER_RADIUS + MARKER_CLEARANCE;
  for (const sib of body.pins) {
    if (sib.id === geom.bodyPin.id) continue;
    const center = { x: sib.x + g.bodyX, y: sib.y + g.bodyY };
    if (pointToRectDist(center, box) < minSiblingDist)
      throw new InlineLabelCollisionError(
        `Circuit ${groupId}: split recess extension encroaches on sibling physical marker.`,
      );
  }
}

function assertNodeRecessClearance(ext: ExtendedRecess, groupId: string) {
  const { geom, localSeg, strokeHalf } = ext;
  const tagLane = geom.node.tagLane;
  if (!tagLane) return;
  const { body, geometry: g } = tagLane;
  const [p0, p1] = localSeg;
  const horiz = geom.pin.side === "EAST" || geom.pin.side === "WEST";
  const faceCoord = horiz ? p0.y : p0.x;
  const faceMin = horiz ? g.bodyY : g.bodyX;
  const faceMax = horiz ? g.bodyY + body.height : g.bodyX + body.width;
  if (
    faceCoord - strokeHalf < faceMin - 1e-7 ||
    faceCoord + strokeHalf > faceMax + 1e-7
  )
    throw new InlineLabelCollisionError(
      `Circuit ${groupId}: split recess extension exceeds physical body face.`,
    );
  const box = strokeRect(p0, p1, strokeHalf);
  const trim = 0.01;
  const interiorBox: Rect = horiz
    ? {
        ...box,
        x0: geom.pin.side === "EAST" ? box.x0 + trim : box.x0,
        x1: geom.pin.side === "WEST" ? box.x1 - trim : box.x1,
      }
    : {
        ...box,
        y0: geom.pin.side === "SOUTH" ? box.y0 + trim : box.y0,
        y1: geom.pin.side === "NORTH" ? box.y1 - trim : box.y1,
      };
  const bodyRect: Rect = {
    x0: g.bodyX,
    y0: g.bodyY,
    x1: g.bodyX + body.width,
    y1: g.bodyY + body.height,
  };
  if (rectOverlaps(interiorBox, bodyRect))
    throw new InlineLabelCollisionError(
      `Circuit ${groupId}: split recess extension crosses physical symbol body.`,
    );
  assertTagAndSiblingClearance(ext, box, groupId);
}

type RouteSegmentOwner = {
  index: number;
  points: readonly Point[];
  strokeHalf: number;
};

function assertPeerConductorsClear(
  ext: ExtendedRecess,
  peers: readonly RouteSegmentOwner[],
  groupId: string,
) {
  const box = strokeRect(ext.sheetSeg[0], ext.sheetSeg[1], ext.strokeHalf);
  for (const other of peers) {
    if (other.index === ext.routeIndex) continue;
    for (let i = 1; i < other.points.length; i++) {
      const a = other.points[i - 1];
      const b = other.points[i];
      if (!a || !b) continue;
      const oBox = strokeRect(a, b, other.strokeHalf);
      if (rectOverlaps(box, oBox, CONDUCTOR_CLEARANCE))
        throw new InlineLabelCollisionError(
          `Circuit ${groupId}: split recess extension collides with another conductor.`,
        );
    }
  }
}

function resolveRecessExtension(
  portId: string,
  pts: readonly Point[],
  isTarget: boolean,
  nodes: readonly DeviceNode[],
  laidNodes: ReadonlyMap<string, ElkNode>,
  splitPhysical: ReadonlySet<string>,
  routeIndex: number,
  strokeHalf: number,
  groupId: string,
): { ext: ExtendedRecess; extendedPt: Point } | "skip" | "missing-laid" {
  const geom = circuitLandingGeometry(portId, nodes);
  if (!splitPhysical.has(geom.physicalPortId) || !geom.hasRecessExtension)
    return "skip";
  if (!segmentLaunchesNormallyAwayFromFace(pts, isTarget, geom.pin.side))
    throw new InlineLabelCollisionError(
      `Circuit ${groupId}: split landing on ${geom.physicalPortId} does not launch normally away from face.`,
    );
  const laid = laidNodes.get(geom.node.id);
  if (!laid || laid.x === undefined || laid.y === undefined)
    return "missing-laid";
  const extendedPt = {
    x: laid.x + geom.offsetPaintedLanding.x,
    y: laid.y + geom.offsetPaintedLanding.y,
  };
  const outerPt = {
    x: laid.x + geom.outerRoutePort.x,
    y: laid.y + geom.outerRoutePort.y,
  };
  return {
    extendedPt,
    ext: {
      routeIndex,
      geom,
      laid,
      localSeg: [geom.offsetPaintedLanding, geom.outerRoutePort],
      sheetSeg: [extendedPt, outerPt],
      strokeHalf,
    },
  };
}

export function extendSplitCircuitRecessLandings(state: CircuitRouteState) {
  const splitPhysical = splitPhysicalCircuitPorts(state.graph);
  if (!splitPhysical.size) return;
  const totalIncidences = new Map<string, number>();
  const extendedIncidences = new Map<string, number>();
  const extensions: ExtendedRecess[] = [];
  for (const route of state.routes) {
    const edge = route.edge;
    if (!edge) continue;
    const strokeHalf = (state.cs[route.index]?.jumper ? 0.55 : 0.32) / 2;
    for (const [endIdx, portId] of [
      [0, edge.sources[0]],
      [1, edge.targets[0]],
    ] as const) {
      if (!portId) continue;
      const res = resolveRecessExtension(
        portId,
        route.points,
        endIdx === 1,
        state.nodes,
        state.laidNodes,
        splitPhysical,
        route.index,
        strokeHalf,
        state.group.id,
      );
      if (res === "skip") continue;
      const pid = circuitLandingGeometry(portId, state.nodes).physicalPortId;
      totalIncidences.set(pid, (totalIncidences.get(pid) ?? 0) + 1);
      if (res === "missing-laid") continue;
      if (endIdx === 1) route.points[route.points.length - 1] = res.extendedPt;
      else route.points[0] = res.extendedPt;
      extendedIncidences.set(pid, (extendedIncidences.get(pid) ?? 0) + 1);
      extensions.push(res.ext);
    }
  }
  const peers = state.routes.map((r) => ({
    index: r.index,
    points: r.points,
    strokeHalf: (state.cs[r.index]?.jumper ? 0.55 : 0.32) / 2,
  }));
  for (const ext of extensions) {
    assertNodeRecessClearance(ext, state.group.id);
    assertPeerConductorsClear(ext, peers, state.group.id);
  }
  for (const [portId, total] of totalIncidences) {
    if (total > 0 && extendedIncidences.get(portId) === total)
      state.suppressedStemPorts.add(portId);
  }
}

/** Pure graph-level equivalent of extendSplitCircuitRecessLandings for
 * pre-emission admission guards. Returns undefined if any recess extension
 * fails normal launch, full-stroke clearance, or complete incidence coverage. */
export function extendSplitCircuitGraph(
  graph: ElkNode,
  nodes: readonly DeviceNode[],
  strokes: ReadonlyMap<string, number>,
): ElkNode | undefined {
  const splitPhysical = splitPhysicalCircuitPorts(graph);
  if (!splitPhysical.size) return graph;
  const copy = structuredClone(graph);
  const laidNodes = new Map((copy.children ?? []).map((n) => [n.id, n]));
  const totalIncidences = new Map<string, number>();
  const extendedIncidences = new Map<string, number>();
  const extensions: ExtendedRecess[] = [];
  const peers: RouteSegmentOwner[] = [];
  try {
    for (const [index, edge] of (copy.edges ?? []).entries()) {
      const sec = edge.sections?.[0];
      if (!sec) return undefined;
      const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint];
      const strokeHalf = (strokes.get(edge.id) ?? 0.32) / 2;
      for (const [endIdx, portId] of [
        [0, edge.sources[0]],
        [1, edge.targets[0]],
      ] as const) {
        if (!portId) continue;
        const res = resolveRecessExtension(
          portId,
          pts,
          endIdx === 1,
          nodes,
          laidNodes,
          splitPhysical,
          index,
          strokeHalf,
          graph.id,
        );
        if (res === "skip") continue;
        if (res === "missing-laid") return undefined;
        const pid = res.ext.geom.physicalPortId;
        totalIncidences.set(pid, (totalIncidences.get(pid) ?? 0) + 1);
        if (endIdx === 1) {
          sec.endPoint = res.extendedPt;
          pts[pts.length - 1] = res.extendedPt;
        } else {
          sec.startPoint = res.extendedPt;
          pts[0] = res.extendedPt;
        }
        extendedIncidences.set(pid, (extendedIncidences.get(pid) ?? 0) + 1);
        extensions.push(res.ext);
      }
      peers.push({ index, points: pts, strokeHalf });
    }
    for (const [portId, total] of totalIncidences) {
      if (extendedIncidences.get(portId) !== total) return undefined;
    }
    for (const ext of extensions) {
      assertNodeRecessClearance(ext, graph.id);
      assertPeerConductorsClear(ext, peers, graph.id);
    }
  } catch {
    return undefined;
  }
  return copy;
}

/** Extend baseline outer-port endpoints to physicalMarkerCentre on the same
 * recessed ports so printed-path route quality compares apples to apples. */
export function extendBaselineRecessGraph(
  original: ElkNode,
  nodes: readonly DeviceNode[],
  splitPhysical: ReadonlySet<string>,
): ElkNode {
  if (!splitPhysical.size) return original;
  const copy = structuredClone(original);
  const laidNodes = new Map((copy.children ?? []).map((n) => [n.id, n]));
  for (const edge of copy.edges ?? []) {
    const sec = edge.sections?.[0];
    if (!sec) continue;
    const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint];
    for (const [endIdx, portId] of [
      [0, edge.sources[0]],
      [1, edge.targets[0]],
    ] as const) {
      if (!portId) continue;
      const geom = circuitLandingGeometry(portId, nodes);
      if (!splitPhysical.has(geom.physicalPortId) || !geom.hasRecessExtension)
        continue;
      const laid = laidNodes.get(geom.node.id);
      if (!laid || laid.x === undefined || laid.y === undefined) continue;
      const physPt = {
        x: laid.x + geom.physicalMarkerCentre.x,
        y: laid.y + geom.physicalMarkerCentre.y,
      };
      const isTarget = endIdx === 1;
      if (segmentLaunchesNormallyAwayFromFace(pts, isTarget, geom.pin.side)) {
        if (isTarget) sec.endPoint = physPt;
        else sec.startPoint = physPt;
      } else {
        const bends = sec.bendPoints ?? [];
        if (isTarget) {
          sec.bendPoints = [...bends, sec.endPoint];
          sec.endPoint = physPt;
        } else {
          sec.bendPoints = [sec.startPoint, ...bends];
          sec.startPoint = physPt;
        }
      }
    }
  }
  return copy;
}
