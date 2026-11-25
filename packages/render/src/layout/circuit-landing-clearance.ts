import type { ElkExtendedEdge, ElkNode, ElkPort } from "elkjs/lib/elk-api.js";
import {
  circuitLandingPort,
  splitPhysicalCircuitPorts,
} from "../circuit/landing-ports.js";
import {
  rectOverlaps,
  segmentLaunchesNormallyAwayFromFace,
  strokeRect,
  type Rect,
} from "../circuit/recess-extension.js";
import type { Pin, Point } from "../circuit/types.js";

const SYMBOL_BORDER_HALF = 0.15;
const APPROACH_CONDUCTOR_CLEARANCE = 0.05;

type PortOwner = { node: ElkNode; port: ElkPort };

function edgePoints(edge: ElkExtendedEdge): Point[] {
  const sec = edge.sections?.[0];
  if (!sec) return [];
  return [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint];
}

function trimNormalLaunch(box: Rect, side: Pin["side"], trim: number): Rect {
  if (side === "EAST") return { ...box, x0: box.x0 + trim };
  if (side === "WEST") return { ...box, x1: box.x1 - trim };
  if (side === "SOUTH") return { ...box, y0: box.y0 + trim };
  return { ...box, y1: box.y1 - trim };
}

function portSideOf(owner: PortOwner | undefined): Pin["side"] | undefined {
  const side = owner?.port.layoutOptions?.["elk.port.side"];
  return side === "EAST" ||
    side === "WEST" ||
    side === "NORTH" ||
    side === "SOUTH"
    ? side
    : undefined;
}

function edgeClearsNodesStroked(
  edge: ElkExtendedEdge,
  pts: readonly Point[],
  half: number,
  owners: ReadonlyMap<string, PortOwner>,
  children: readonly ElkNode[],
): boolean {
  const srcOwner = owners.get(edge.sources[0] ?? "");
  const tgtOwner = owners.get(edge.targets[0] ?? "");
  const srcSide = portSideOf(srcOwner);
  const tgtSide = portSideOf(tgtOwner);
  const trim = SYMBOL_BORDER_HALF + 0.01;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) <= 1e-7) continue;
    const raw = strokeRect(a, b, half);
    for (const n of children) {
      if (
        n.x === undefined ||
        n.y === undefined ||
        n.width === undefined ||
        n.height === undefined
      )
        continue;
      let box = raw;
      if (
        i === 1 &&
        srcOwner?.node === n &&
        srcSide &&
        segmentLaunchesNormallyAwayFromFace(pts, false, srcSide)
      )
        box = trimNormalLaunch(box, srcSide, trim);
      if (
        i === pts.length - 1 &&
        tgtOwner?.node === n &&
        tgtSide &&
        segmentLaunchesNormallyAwayFromFace(pts, true, tgtSide)
      )
        box = trimNormalLaunch(box, tgtSide, trim);
      if (box.x0 >= box.x1 - 1e-7 || box.y0 >= box.y1 - 1e-7) continue;
      const nBox: Rect = {
        x0: n.x - SYMBOL_BORDER_HALF,
        y0: n.y - SYMBOL_BORDER_HALF,
        x1: n.x + n.width + SYMBOL_BORDER_HALF,
        y1: n.y + n.height + SYMBOL_BORDER_HALF,
      };
      if (rectOverlaps(box, nBox)) return false;
    }
  }
  return true;
}

function launchClearsPeerConductors(
  edgeId: string,
  a: Point,
  b: Point,
  half: number,
  edges: readonly ElkExtendedEdge[],
  strokes: ReadonlyMap<string, number>,
): boolean {
  const launchHoriz = Math.abs(a.y - b.y) <= 1e-7;
  const launchBox = strokeRect(a, b, half);
  for (const other of edges) {
    if (other.id === edgeId) continue;
    const oHalf = (strokes.get(other.id) ?? 0.32) / 2;
    const oPts = edgePoints(other);
    for (let i = 1; i < oPts.length; i++) {
      const oa = oPts[i - 1];
      const ob = oPts[i];
      if (!oa || !ob || Math.hypot(oa.x - ob.x, oa.y - ob.y) <= 1e-7) continue;
      const oHoriz = Math.abs(oa.y - ob.y) <= 1e-7;
      if (oHoriz !== launchHoriz) continue;
      if (
        rectOverlaps(
          launchBox,
          strokeRect(oa, ob, oHalf),
          APPROACH_CONDUCTOR_CLEARANCE,
        )
      )
        return false;
    }
  }
  return true;
}

/** Require a normal outward launch and full-stroke symbol + peer-conductor
 * clearance for every newly split incidence, with or without a recess. */
export function splitApproachClearanceGuard(
  candidate: ElkNode,
  originalInput: ElkNode,
  strokes: ReadonlyMap<string, number>,
): boolean {
  const origSplit = splitPhysicalCircuitPorts(originalInput);
  const newlySplit = new Set(
    [...splitPhysicalCircuitPorts(candidate)].filter((p) => !origSplit.has(p)),
  );
  if (!newlySplit.size) return true;
  const owners = new Map<string, PortOwner>();
  for (const node of candidate.children ?? []) {
    for (const port of node.ports ?? []) owners.set(port.id, { node, port });
  }
  const edges = candidate.edges ?? [];
  const children = candidate.children ?? [];
  for (const edge of edges) {
    const pts = edgePoints(edge);
    if (pts.length < 2) return false;
    const half = (strokes.get(edge.id) ?? 0.32) / 2;
    let edgeHasNewSplit = false;
    for (const [isTarget, raw] of [
      [false, edge.sources[0]],
      [true, edge.targets[0]],
    ] as const) {
      if (!raw || !newlySplit.has(circuitLandingPort(raw).physical)) continue;
      edgeHasNewSplit = true;
      const side = portSideOf(owners.get(raw));
      if (!side || !segmentLaunchesNormallyAwayFromFace(pts, isTarget, side))
        return false;
      const a = isTarget ? pts.at(-1) : pts[0];
      const b = isTarget ? pts.at(-2) : pts[1];
      if (
        !a ||
        !b ||
        !launchClearsPeerConductors(edge.id, a, b, half, edges, strokes)
      )
        return false;
    }
    if (
      edgeHasNewSplit &&
      !edgeClearsNodesStroked(edge, pts, half, owners, children)
    )
      return false;
  }
  return true;
}
