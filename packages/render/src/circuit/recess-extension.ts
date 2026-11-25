import type { ElkNode } from "elkjs/lib/elk-api.js";
import { InlineLabelCollisionError } from "../layout/inline-label-error.js";
import { CIRCUIT_TAG_COLUMN_WIDTH } from "../symbols/circuit-relations.js";
import {
  circuitLandingGeometry,
  splitPhysicalCircuitPorts,
} from "./landing-ports.js";
import type { CircuitRouteState } from "./layout-routes.js";
import type { Pin, Point } from "./types.js";

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

function assertConductorRecessClearance(
  ext: ExtendedRecess,
  state: CircuitRouteState,
) {
  const box = strokeRect(ext.sheetSeg[0], ext.sheetSeg[1], ext.strokeHalf);
  for (const other of state.routes) {
    if (other.index === ext.routeIndex) continue;
    const otherHalf = (state.cs[other.index]?.jumper ? 0.55 : 0.32) / 2;
    for (let i = 1; i < other.points.length; i++) {
      const a = other.points[i - 1];
      const b = other.points[i];
      if (!a || !b) continue;
      const oBox = strokeRect(a, b, otherHalf);
      if (rectOverlaps(box, oBox, CONDUCTOR_CLEARANCE))
        throw new InlineLabelCollisionError(
          `Circuit ${state.group.id}: split recess extension collides with another conductor.`,
        );
    }
  }
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
      const geom = circuitLandingGeometry(portId, state.nodes);
      if (!splitPhysical.has(geom.physicalPortId) || !geom.hasRecessExtension)
        continue;
      totalIncidences.set(
        geom.physicalPortId,
        (totalIncidences.get(geom.physicalPortId) ?? 0) + 1,
      );
      const isTarget = endIdx === 1;
      if (
        !segmentLaunchesNormallyAwayFromFace(
          route.points,
          isTarget,
          geom.pin.side,
        )
      )
        throw new InlineLabelCollisionError(
          `Circuit ${state.group.id}: split landing on ${geom.physicalPortId} does not launch normally away from face.`,
        );
      const laid = state.laidNodes.get(geom.node.id);
      if (!laid || laid.x === undefined || laid.y === undefined) continue;
      const extendedPt = {
        x: laid.x + geom.offsetPaintedLanding.x,
        y: laid.y + geom.offsetPaintedLanding.y,
      };
      const outerPt = {
        x: laid.x + geom.outerRoutePort.x,
        y: laid.y + geom.outerRoutePort.y,
      };
      if (isTarget) route.points[route.points.length - 1] = extendedPt;
      else route.points[0] = extendedPt;
      extendedIncidences.set(
        geom.physicalPortId,
        (extendedIncidences.get(geom.physicalPortId) ?? 0) + 1,
      );
      extensions.push({
        routeIndex: route.index,
        geom,
        laid,
        localSeg: [geom.offsetPaintedLanding, geom.outerRoutePort],
        sheetSeg: [extendedPt, outerPt],
        strokeHalf,
      });
    }
  }

  for (const ext of extensions) {
    assertNodeRecessClearance(ext, state.group.id);
    assertConductorRecessClearance(ext, state);
  }
  for (const [portId, total] of totalIncidences) {
    if (total > 0 && extendedIncidences.get(portId) === total)
      state.suppressedStemPorts.add(portId);
  }
}
