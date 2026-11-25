import type { ElkExtendedEdge, ElkNode, ElkPort } from "elkjs/lib/elk-api.js";
import {
  CIRCUIT_LANDING_OFFSET,
  circuitLandingGeometry,
  circuitLandingPort,
  splitPhysicalCircuitPorts,
} from "../circuit/landing-ports.js";
import {
  extendBaselineRecessGraph,
  extendSplitCircuitGraph,
} from "../circuit/recess-extension.js";
import type { DeviceNode, Point } from "../circuit/types.js";
import {
  circuitCrossingGuard,
  circuitLabelGuard,
  circuitNativeGuard,
  circuitNodeClearanceGuard,
} from "./circuit-native-guard.js";
import { circuitPortOrderGuard } from "./circuit-port-order.js";
import { circuitConductorNonRegression } from "./circuit-route-quality.js";

const MARKER_RADIUS = 0.65;
const SIBLING_MIN_PITCH = 2 * MARKER_RADIUS + CIRCUIT_LANDING_OFFSET + 0.5;
const DEGREE3_MAX_STROKE = 0.35;

type EndKind = "sources" | "targets";
type PortOwner = { node: ElkNode; port: ElkPort };
type EdgeUse = { edge: ElkExtendedEdge; end: EndKind; other: string };

function portOwners(graph: ElkNode): Map<string, PortOwner> {
  const map = new Map<string, PortOwner>();
  for (const node of graph.children ?? []) {
    for (const port of node.ports ?? []) map.set(port.id, { node, port });
  }
  return map;
}

function portAxis(port: ElkPort): "x" | "y" {
  const side = port.layoutOptions?.["elk.port.side"] ?? "";
  return side === "WEST" || side === "EAST" ? "y" : "x";
}

function edgePoints(edge: ElkExtendedEdge): Point[] {
  const sec = edge.sections?.[0];
  if (!sec) return [];
  return [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint];
}

function launchRay(
  edge: ElkExtendedEdge,
  end: EndKind,
): { origin: Point; dx: number; dy: number } | undefined {
  const pts = edgePoints(edge);
  if (pts.length < 2) return undefined;
  const origin = end === "sources" ? pts[0] : pts.at(-1);
  if (!origin) return undefined;
  const step = end === "sources" ? 1 : -1;
  for (
    let i = end === "sources" ? 1 : pts.length - 2;
    i >= 0 && i < pts.length;
    i += step
  ) {
    const p = pts[i];
    if (!p) continue;
    const len = Math.hypot(p.x - origin.x, p.y - origin.y);
    if (len > 1e-6)
      return { origin, dx: (p.x - origin.x) / len, dy: (p.y - origin.y) / len };
  }
  return undefined;
}

function segmentsShareInk(
  a: readonly Point[],
  b: readonly Point[],
  inkLimit: number,
): boolean {
  for (let i = 1; i < a.length; i++) {
    const p1 = a[i - 1];
    const p2 = a[i];
    if (!p1 || !p2) continue;
    const aVert = Math.abs(p1.x - p2.x) < 1e-6;
    const aHoriz = Math.abs(p1.y - p2.y) < 1e-6;
    for (let j = 1; j < b.length; j++) {
      const q1 = b[j - 1];
      const q2 = b[j];
      if (!q1 || !q2) continue;
      if (
        aVert &&
        Math.abs(q1.x - q2.x) < 1e-6 &&
        Math.abs(p1.x - q1.x) < inkLimit
      ) {
        const ov =
          Math.min(Math.max(p1.y, p2.y), Math.max(q1.y, q2.y)) -
          Math.max(Math.min(p1.y, p2.y), Math.min(q1.y, q2.y));
        if (ov > 0.05) return true;
      }
      if (
        aHoriz &&
        Math.abs(q1.y - q2.y) < 1e-6 &&
        Math.abs(p1.y - q1.y) < inkLimit
      ) {
        const ov =
          Math.min(Math.max(p1.x, p2.x), Math.max(q1.x, q2.x)) -
          Math.max(Math.min(p1.x, p2.x), Math.min(q1.x, q2.x));
        if (ov > 0.05) return true;
      }
    }
  }
  return false;
}

function usesByPhysicalPort(graph: ElkNode): Map<string, EdgeUse[]> {
  const map = new Map<string, EdgeUse[]>();
  for (const edge of graph.edges ?? []) {
    for (const end of ["sources", "targets"] as const) {
      const raw = edge[end][0];
      const other = edge[end === "sources" ? "targets" : "sources"][0];
      if (!raw || !other) continue;
      const phys = circuitLandingPort(raw).physical;
      const list = map.get(phys) ?? [];
      list.push({ edge, end, other });
      map.set(phys, list);
    }
  }
  return map;
}

function portHasMergedApproaches(
  uses: readonly EdgeUse[],
  strokes?: ReadonlyMap<string, number>,
): boolean {
  for (let i = 0; i < uses.length; i++) {
    const a = uses[i];
    if (!a) continue;
    const ra = launchRay(a.edge, a.end);
    const pa = edgePoints(a.edge);
    for (let j = i + 1; j < uses.length; j++) {
      const b = uses[j];
      if (!b || a.edge.id === b.edge.id) continue;
      const rb = launchRay(b.edge, b.end);
      if (
        ra &&
        rb &&
        Math.hypot(ra.origin.x - rb.origin.x, ra.origin.y - rb.origin.y) <=
          0.01 &&
        ra.dx * rb.dx + ra.dy * rb.dy > 0.9999
      )
        return true;
      const limit =
        ((strokes?.get(a.edge.id) ?? 0.32) +
          (strokes?.get(b.edge.id) ?? 0.32)) /
          2 -
        1e-6;
      if (segmentsShareInk(pa, edgePoints(b.edge), limit)) return true;
    }
  }
  return false;
}

function splittableExternalPorts(
  graph: ElkNode,
  strokes?: ReadonlyMap<string, number>,
): Set<string> {
  const owners = portOwners(graph);
  const byPort = usesByPhysicalPort(graph);
  const merged = new Set<string>();
  for (const [physId, uses] of byPort) {
    if (uses.length < 2 || uses.length > 3) continue;
    if (new Set(uses.map((u) => u.edge.id)).size !== uses.length) continue;
    const hasExistingAlias = uses.some(
      (u) => circuitLandingPort(u.edge[u.end][0] ?? "").offset !== 0,
    );
    if (hasExistingAlias) continue;
    const owner = owners.get(physId);
    if (!owner) continue;
    const hasSelfLoop = uses.some(
      (u) =>
        owners.get(circuitLandingPort(u.other).physical)?.node === owner.node,
    );
    if (hasSelfLoop) continue;
    if (
      uses.length === 3 &&
      uses.some((u) => (strokes?.get(u.edge.id) ?? 0.32) > DEGREE3_MAX_STROKE)
    )
      continue;
    if (portHasMergedApproaches(uses, strokes)) merged.add(physId);
  }
  return merged;
}

/** True iff the laid-out graph has at least one 2- or 3-conductor external
 * terminal with collinear/shared approach ink eligible for landing separation. */
export function circuitHasMergedExternalLandings(
  graph: ElkNode,
  strokes?: ReadonlyMap<string, number>,
): boolean {
  return splittableExternalPorts(graph, strokes).size > 0;
}

function fitsFaceAndSiblings(
  owner: PortOwner,
  axis: "x" | "y",
  maxStrokeHalf: number,
  nodes?: readonly DeviceNode[],
): boolean {
  const coord = owner.port[axis];
  const dim = axis === "y" ? owner.node.height : owner.node.width;
  if (coord === undefined || dim === undefined) return false;
  const reach = CIRCUIT_LANDING_OFFSET + maxStrokeHalf;
  if (coord - reach < -1e-7 || coord + reach > dim + 1e-7) return false;
  const side = owner.port.layoutOptions?.["elk.port.side"];
  for (const sib of owner.node.ports ?? []) {
    if (sib.id === owner.port.id) continue;
    if (sib.layoutOptions?.["elk.port.side"] !== side) continue;
    const sibCoord = sib[axis];
    if (
      sibCoord !== undefined &&
      Math.abs(sibCoord - coord) < SIBLING_MIN_PITCH - 1e-7
    )
      return false;
  }
  if (!nodes) return true;
  const dev = nodes.find((n) => n.pins.some((p) => p.id === owner.port.id));
  const tagLane = dev?.tagLane;
  if (!dev || !tagLane) return true;
  const pinIdx = dev.pins.findIndex((p) => p.id === owner.port.id);
  const bodyPin = tagLane.body.pins[pinIdx];
  if (!bodyPin) return false;
  const bodyCoord = bodyPin[axis];
  const bodyDim = axis === "y" ? tagLane.body.height : tagLane.body.width;
  if (bodyCoord - reach < -1e-7 || bodyCoord + reach > bodyDim + 1e-7)
    return false;
  for (const sib of tagLane.body.pins) {
    if (sib.id === bodyPin.id || sib.side !== bodyPin.side) continue;
    if (Math.abs(sib[axis] - bodyCoord) < SIBLING_MIN_PITCH - 1e-7)
      return false;
  }
  return true;
}

function orderByBaselineGeometry(
  uses: readonly EdgeUse[],
  baseEdges: ReadonlyMap<string, ElkExtendedEdge>,
  axis: "x" | "y",
): EdgeUse[] {
  return [...uses].sort((a, b) => {
    const ea = baseEdges.get(a.edge.id)?.sections?.[0];
    const eb = baseEdges.get(b.edge.id)?.sections?.[0];
    const da = ea
      ? (a.end === "sources" ? ea.endPoint[axis] : ea.startPoint[axis]) -
        (a.end === "sources" ? ea.startPoint[axis] : ea.endPoint[axis])
      : 0;
    const db = eb
      ? (b.end === "sources" ? eb.endPoint[axis] : eb.startPoint[axis]) -
        (b.end === "sources" ? eb.startPoint[axis] : eb.endPoint[axis])
      : 0;
    if (Math.abs(da - db) > 1e-7) return da - db;
    return a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0;
  });
}

/** Build a split ELK input from the untouched baseline input using measured
 * baseline remote coordinates to order each split terminal's incidences. */
export function externalCircuitLandingInput(
  input: ElkNode,
  baseline: ElkNode,
  nodes: readonly DeviceNode[] | undefined,
  strokes: ReadonlyMap<string, number>,
): ElkNode | undefined {
  const targets = splittableExternalPorts(baseline, strokes);
  if (!targets.size) return undefined;
  const copy = structuredClone(input);
  const owners = portOwners(copy);
  const byPort = usesByPhysicalPort(copy);
  const baseEdges = new Map((baseline.edges ?? []).map((e) => [e.id, e]));
  let createdCount = 0;

  for (const physId of targets) {
    const owner = owners.get(physId);
    const uses = byPort.get(physId);
    if (!owner || !uses || uses.length < 2 || uses.length > 3) continue;
    const axis = portAxis(owner.port);
    const maxStrokeHalf =
      Math.max(...uses.map((u) => strokes.get(u.edge.id) ?? 0.32)) / 2;
    if (!fitsFaceAndSiblings(owner, axis, maxStrokeHalf, nodes)) continue;
    const ordered = orderByBaselineGeometry(uses, baseEdges, axis);
    const signs = ordered.length === 2 ? [-1, 1] : [-1, 0, 1];
    const coord = owner.port[axis];
    if (coord === undefined) continue;
    const created: ElkPort[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const sign = signs[i] ?? 0;
      const use = ordered[i];
      if (!use || sign === 0) continue;
      const aliasId = `${physId}-circuit-landing-${sign > 0 ? "positive" : "negative"}`;
      const landing: ElkPort = {
        ...owner.port,
        id: aliasId,
        layoutOptions: { ...owner.port.layoutOptions },
        [axis]: coord + sign * CIRCUIT_LANDING_OFFSET,
      };
      created.push(landing);
      createdCount++;
      use.edge[use.end] = use.edge[use.end].map((p) =>
        p === physId ? aliasId : p,
      );
    }
    const existing = owner.node.ports ?? [];
    const at = existing.indexOf(owner.port);
    if (at < 0) continue;
    const before = created.filter((p) => (p[axis] ?? coord) < coord);
    const after = created.filter((p) => (p[axis] ?? coord) > coord);
    owner.node.ports = [
      ...existing.slice(0, at),
      ...before,
      owner.port,
      ...after,
      ...existing.slice(at + 1),
    ];
  }
  return createdCount > 0 ? copy : undefined;
}

const near = (a: number | undefined, b: number | undefined) =>
  a !== undefined && b !== undefined && Math.abs(a - b) < 1e-7;

/** Verify that candidate conserves every node, physical port, and canonical
 * physical source/target port identity from originalInput (never only splitInput). */
export function conservesOriginalPhysicalEndpoints(
  candidate: ElkNode,
  originalInput: ElkNode,
): boolean {
  const origNodes = new Map(
    (originalInput.children ?? []).map((n) => [n.id, n]),
  );
  const candNodes = new Map((candidate.children ?? []).map((n) => [n.id, n]));
  if (origNodes.size !== candNodes.size) return false;
  for (const [id, origNode] of origNodes) {
    const candNode = candNodes.get(id);
    if (
      !candNode ||
      !near(candNode.width, origNode.width) ||
      !near(candNode.height, origNode.height)
    )
      return false;
    const origPorts = new Map((origNode.ports ?? []).map((p) => [p.id, p]));
    const candPorts = new Map((candNode.ports ?? []).map((p) => [p.id, p]));
    for (const [pid, op] of origPorts) {
      const cp = candPorts.get(pid);
      if (
        !cp ||
        !near(cp.x, op.x) ||
        !near(cp.y, op.y) ||
        JSON.stringify(cp.layoutOptions) !== JSON.stringify(op.layoutOptions)
      )
        return false;
    }
    for (const [pid, cp] of candPorts) {
      if (origPorts.has(pid)) continue;
      let site: { physical: string; offset: number };
      try {
        site = circuitLandingPort(pid);
      } catch {
        return false;
      }
      const basePort = origPorts.get(site.physical);
      if (!basePort || site.offset === 0) return false;
      const axis = portAxis(basePort);
      const otherAxis = axis === "x" ? "y" : "x";
      if (
        !near(cp[axis], (basePort[axis] ?? 0) + site.offset) ||
        !near(cp[otherAxis], basePort[otherAxis]) ||
        JSON.stringify(cp.layoutOptions) !==
          JSON.stringify(basePort.layoutOptions)
      )
        return false;
    }
  }
  const origEdges = new Map((originalInput.edges ?? []).map((e) => [e.id, e]));
  const candEdges = new Map((candidate.edges ?? []).map((e) => [e.id, e]));
  if (origEdges.size !== candEdges.size) return false;
  for (const [id, oe] of origEdges) {
    const ce = candEdges.get(id);
    if (!ce) return false;
    try {
      const src = ce.sources.map((p) => circuitLandingPort(p).physical);
      const tgt = ce.targets.map((p) => circuitLandingPort(p).physical);
      if (
        JSON.stringify(src) !== JSON.stringify(oe.sources) ||
        JSON.stringify(tgt) !== JSON.stringify(oe.targets)
      )
        return false;
    } catch {
      return false;
    }
  }
  return true;
}

function pointOnSegment(p: Point, a: Point, b: Point): boolean {
  return (
    p.x >= Math.min(a.x, b.x) - 1e-7 &&
    p.x <= Math.max(a.x, b.x) + 1e-7 &&
    p.y >= Math.min(a.y, b.y) - 1e-7 &&
    p.y <= Math.max(a.y, b.y) + 1e-7 &&
    (Math.abs(a.x - b.x) < 1e-7
      ? Math.abs(p.x - a.x) < 1e-7
      : Math.abs(p.y - a.y) < 1e-7)
  );
}

function physicalMarkerCenters(
  graph: ElkNode,
  nodes: readonly DeviceNode[] | undefined,
): Point[] {
  const centers: Point[] = [];
  for (const child of graph.children ?? []) {
    if (child.x === undefined || child.y === undefined) continue;
    for (const p of child.ports ?? []) {
      if (circuitLandingPort(p.id).offset !== 0) continue;
      if (nodes) {
        const geom = circuitLandingGeometry(p.id, nodes);
        centers.push({
          x: child.x + geom.physicalMarkerCentre.x,
          y: child.y + geom.physicalMarkerCentre.y,
        });
      } else if (p.x !== undefined && p.y !== undefined) {
        centers.push({ x: child.x + p.x, y: child.y + p.y });
      }
    }
  }
  return centers;
}

function falseJunctionsByPort(
  graph: ElkNode,
  nodes: readonly DeviceNode[] | undefined,
): { byPort: Map<string, Set<string>>; all: Set<string> } {
  const edges = graph.edges ?? [];
  const edgePorts = new Map(
    edges.map((e) => [
      e.id,
      [
        circuitLandingPort(e.sources[0] ?? "").physical,
        circuitLandingPort(e.targets[0] ?? "").physical,
      ] as const,
    ]),
  );
  const segs = edges.flatMap((e) => {
    const pts = edgePoints(e);
    return pts.slice(1).map((b, i) => ({
      id: e.id,
      a: pts[i] ?? b,
      b,
    }));
  });
  const markers = physicalMarkerCenters(graph, nodes);
  const byPort = new Map<string, Set<string>>();
  const all = new Set<string>();
  const common = (aId: string, bId: string) => {
    const pa = edgePorts.get(aId);
    const pb = edgePorts.get(bId);
    return Boolean(pa && pb && pa.some((p) => pb.includes(p)));
  };
  for (const e of edges) {
    for (const p of edgePoints(e)) {
      if (markers.some((m) => Math.hypot(m.x - p.x, m.y - p.y) <= 0.01))
        continue;
      const touching = segs.filter(
        (s) => common(s.id, e.id) && pointOnSegment(p, s.a, s.b),
      );
      const dirs = new Set<string>();
      for (const s of touching) {
        for (const q of [s.a, s.b]) {
          if (q.x > p.x + 1e-7) dirs.add("E");
          if (q.x < p.x - 1e-7) dirs.add("W");
          if (q.y > p.y + 1e-7) dirs.add("S");
          if (q.y < p.y - 1e-7) dirs.add("N");
        }
      }
      if (dirs.size < 3) continue;
      const ptKey = `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
      all.add(ptKey);
      const ep = edgePorts.get(e.id) ?? [];
      for (const pid of ep) {
        const set = byPort.get(pid) ?? new Set<string>();
        set.add(ptKey);
        byPort.set(pid, set);
      }
    }
  }
  return { byPort, all };
}

function countMergedPairsOnPort(
  uses: readonly EdgeUse[],
  strokes: ReadonlyMap<string, number>,
): number {
  let count = 0;
  for (let i = 0; i < uses.length; i++) {
    const a = uses[i];
    if (!a) continue;
    const ra = launchRay(a.edge, a.end);
    const pa = edgePoints(a.edge);
    for (let j = i + 1; j < uses.length; j++) {
      const b = uses[j];
      if (!b || a.edge.id === b.edge.id) continue;
      const rb = launchRay(b.edge, b.end);
      const collinear =
        Boolean(ra && rb) &&
        Math.hypot(
          (ra?.origin.x ?? 0) - (rb?.origin.x ?? 0),
          (ra?.origin.y ?? 0) - (rb?.origin.y ?? 0),
        ) <= 0.01 &&
        (ra?.dx ?? 0) * (rb?.dx ?? 0) + (ra?.dy ?? 0) * (rb?.dy ?? 0) > 0.9999;
      const inkLimit =
        ((strokes.get(a.edge.id) ?? 0.32) + (strokes.get(b.edge.id) ?? 0.32)) /
          2 -
        1e-6;
      if (collinear || segmentsShareInk(pa, edgePoints(b.edge), inkLimit))
        count++;
    }
  }
  return count;
}

function hasDisconnectedEndpoint(
  graph: ElkNode,
  nodes: readonly DeviceNode[] | undefined,
): boolean {
  const splitPhysical = splitPhysicalCircuitPorts(graph);
  const laidNodes = new Map((graph.children ?? []).map((n) => [n.id, n]));
  const owners = portOwners(graph);
  for (const edge of graph.edges ?? []) {
    const pts = edgePoints(edge);
    if (pts.length < 2) return true;
    for (const [endIdx, raw] of [
      [0, edge.sources[0]],
      [1, edge.targets[0]],
    ] as const) {
      if (!raw) return true;
      const pt = endIdx === 0 ? pts[0] : pts.at(-1);
      if (!pt) return true;
      if (nodes) {
        const geom = circuitLandingGeometry(raw, nodes);
        const laid = laidNodes.get(geom.node.id);
        if (!laid || laid.x === undefined || laid.y === undefined) return true;
        const target =
          splitPhysical.has(geom.physicalPortId) && geom.hasRecessExtension
            ? geom.offsetPaintedLanding
            : geom.outerRoutePort;
        if (
          Math.hypot(pt.x - (laid.x + target.x), pt.y - (laid.y + target.y)) >
          0.01
        )
          return true;
        if (
          geom.offset !== 0 &&
          Math.hypot(
            geom.offsetPaintedLanding.x - geom.physicalMarkerCentre.x,
            geom.offsetPaintedLanding.y - geom.physicalMarkerCentre.y,
          ) >
            MARKER_RADIUS + 1e-4
        )
          return true;
      } else {
        const owner = owners.get(raw);
        if (
          !owner ||
          owner.node.x === undefined ||
          owner.node.y === undefined ||
          owner.port.x === undefined ||
          owner.port.y === undefined
        )
          return true;
        if (
          Math.hypot(
            pt.x - (owner.node.x + owner.port.x),
            pt.y - (owner.node.y + owner.port.y),
          ) > 0.01
        )
          return true;
        if (Math.abs(circuitLandingPort(raw).offset) > MARKER_RADIUS + 1e-4)
          return true;
      }
    }
  }
  return false;
}

/** Verify per physical port that no new merge, false junction, or disconnection
 * was introduced anywhere, even when aggregate merged pairs decrease. */
export function perSiteLandingNonRegression(
  extendedCandidate: ElkNode,
  extendedOriginal: ElkNode,
  originalInput: ElkNode,
  nodes: readonly DeviceNode[] | undefined,
  strokes: ReadonlyMap<string, number>,
  requireImprovement = true,
): boolean {
  if (hasDisconnectedEndpoint(extendedCandidate, nodes)) return false;
  const beforeUses = usesByPhysicalPort(extendedOriginal);
  const afterUses = usesByPhysicalPort(extendedCandidate);
  const beforeJunc = falseJunctionsByPort(extendedOriginal, nodes);
  const afterJunc = falseJunctionsByPort(extendedCandidate, nodes);
  if (afterJunc.all.size > beforeJunc.all.size) return false;
  const physicalPorts = new Set<string>();
  for (const edge of originalInput.edges ?? []) {
    if (edge.sources[0])
      physicalPorts.add(circuitLandingPort(edge.sources[0]).physical);
    if (edge.targets[0])
      physicalPorts.add(circuitLandingPort(edge.targets[0]).physical);
  }
  let beforeTotal = 0;
  let afterTotal = 0;
  for (const physId of physicalPorts) {
    const bMerged = countMergedPairsOnPort(
      beforeUses.get(physId) ?? [],
      strokes,
    );
    const aMerged = countMergedPairsOnPort(
      afterUses.get(physId) ?? [],
      strokes,
    );
    if (aMerged > bMerged) return false;
    const bJ = beforeJunc.byPort.get(physId)?.size ?? 0;
    const aJ = afterJunc.byPort.get(physId)?.size ?? 0;
    if (aJ > bJ) return false;
    beforeTotal += bMerged;
    afterTotal += aMerged;
  }
  return requireImprovement
    ? afterTotal < beforeTotal
    : afterTotal <= beforeTotal;
}

function allLabelsPlaced(graph: ElkNode): boolean {
  return (graph.edges ?? []).every((e) =>
    (e.labels ?? []).every(
      (l) =>
        Number.isFinite(l.x) &&
        Number.isFinite(l.y) &&
        Number.isFinite(l.width) &&
        Number.isFinite(l.height),
    ),
  );
}

/** Complete admission gate for external landing separation against the untouched
 * unsplit baseline, including label conservation, original physical endpoints,
 * final extended printed route quality, and per-site non-regression. */
export function admitExternalLandingCandidate(
  candidate: ElkNode,
  splitInput: ElkNode,
  originalInput: ElkNode,
  original: ElkNode,
  nodes: readonly DeviceNode[] | undefined,
  strokes: ReadonlyMap<string, number>,
  portGroups: readonly (readonly string[])[],
  requireImprovement = true,
): boolean {
  if (
    !circuitNativeGuard(candidate, splitInput) ||
    !conservesOriginalPhysicalEndpoints(candidate, originalInput) ||
    !circuitLabelGuard(candidate, originalInput) ||
    !allLabelsPlaced(candidate) ||
    !circuitNodeClearanceGuard(candidate) ||
    !circuitPortOrderGuard(candidate, original, portGroups)
  )
    return false;
  const extendedCandidate = nodes
    ? extendSplitCircuitGraph(candidate, nodes, strokes)
    : candidate;
  if (!extendedCandidate) return false;
  const splitPhysical = splitPhysicalCircuitPorts(candidate);
  const extendedOriginal = nodes
    ? extendBaselineRecessGraph(original, nodes, splitPhysical)
    : original;
  if (
    !circuitCrossingGuard(candidate, original) ||
    !circuitCrossingGuard(extendedCandidate, extendedOriginal) ||
    !circuitConductorNonRegression(candidate, original) ||
    !circuitConductorNonRegression(extendedCandidate, extendedOriginal)
  )
    return false;
  return perSiteLandingNonRegression(
    extendedCandidate,
    extendedOriginal,
    originalInput,
    nodes,
    strokes,
    requireImprovement,
  );
}
