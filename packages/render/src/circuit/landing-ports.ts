import type { ElkNode, ElkPort, ElkExtendedEdge } from "elkjs/lib/elk-api.js";
import type { DeviceNode } from "./types.js";
import { required } from "../presentation/util.js";

// Two approaches fit inside the existing .65 mm terminal mark. Their centres
// retain .7 mm clear ink even for the existing .55 mm jumper stroke.
export const CIRCUIT_LANDING_OFFSET = (0.7 + 0.55) / 2;
const SUFFIX = "-circuit-landing-";
type Use = { edge: ElkExtendedEdge; end: "sources" | "targets"; other: string };
function owners(input: ElkNode) {
  return new Map(
    (input.children ?? []).flatMap((node) =>
      (node.ports ?? []).map((port) => [port.id, { node, port }] as const),
    ),
  );
}
function uses(input: ElkNode) {
  const result = new Map<string, Use[]>();
  for (const edge of input.edges ?? [])
    for (const end of ["sources", "targets"] as const) {
      const id = required(edge[end][0], "Missing circuit endpoint port");
      const other = required(
        edge[end === "sources" ? "targets" : "sources"][0],
        "Missing opposite circuit port",
      );
      result.set(id, [...(result.get(id) ?? []), { edge, end, other }]);
    }
  return result;
}
type LandingPlan = {
  id: string;
  ends: Use[];
  loop: Use;
  axis: "x" | "y";
  direction: number;
};
function landingPlans(input: ElkNode, wires: ReadonlySet<string>) {
  const native = owners(input);
  return [...uses(input)].flatMap<LandingPlan>(([id, ends]) => {
    const owner = required(native.get(id), "Missing native circuit port");
    const local = ends.filter((u) => native.get(u.other)?.node === owner.node);
    if (
      ends.length !== 2 ||
      local.length !== 1 ||
      ends[0]?.edge === ends[1]?.edge
    )
      return [];
    const loop = required(local[0], "Missing circuit self-loop incidence");
    // This mechanism only separates authored wire approaches at the mark.
    if (!wires.has(loop.edge.id)) return [];
    const other = required(
      native.get(loop.other),
      "Missing self-loop endpoint",
    );
    const axis = ["WEST", "EAST"].includes(
      owner.port.layoutOptions?.["elk.port.side"] ?? "",
    )
      ? "y"
      : "x";
    const direction =
      Math.sign(
        required(other.port[axis], "Unplaced loop port") -
          required(owner.port[axis], "Unplaced circuit port"),
      ) || 1;
    return [{ id, ends, loop, axis, direction }];
  });
}

/** Split only a terminal shared by an external conductor and a local loop.
 * ELK receives both fixed approach sites before routing; no path is spliced. */
export function planIndependentCircuitLandings(
  input: ElkNode,
  wires: ReadonlySet<string>,
): { graph: ElkNode; splitPorts: ReadonlySet<string> } {
  const plans = landingPlans(input, wires);
  if (!plans.length) return { graph: input, splitPorts: new Set() };
  const copy = structuredClone(input),
    native = owners(copy);
  const edges = new Map((copy.edges ?? []).map((e) => [e.id, e]));
  for (const plan of plans) {
    const { node, port } = required(
      native.get(plan.id),
      "Missing landing owner",
    );
    for (const use of plan.ends) {
      const sign = use === plan.loop ? plan.direction : -plan.direction;
      const id = plan.id + SUFFIX + (sign > 0 ? "positive" : "negative");
      const landing: ElkPort = {
        ...port,
        id,
        layoutOptions: { ...port.layoutOptions },
      };
      landing[plan.axis] =
        required(port[plan.axis], "Unplaced native circuit port") +
        sign * CIRCUIT_LANDING_OFFSET;
      node.ports = [...(node.ports ?? []), landing];
      const edge = required(
        edges.get(use.edge.id),
        "Missing landing conductor",
      );
      edge[use.end] = edge[use.end].map((p) => (p === plan.id ? id : p));
    }
  }
  return { graph: copy, splitPorts: new Set(plans.map((p) => p.id)) };
}

export function independentCircuitLandings(
  input: ElkNode,
  wires: ReadonlySet<string>,
): ElkNode {
  return planIndependentCircuitLandings(input, wires).graph;
}

export function circuitLandingPort(id: string) {
  const at = id.indexOf(SUFFIX);
  if (at < 0) return { physical: id, offset: 0 };
  const direction = id.slice(at + SUFFIX.length);
  if (direction !== "positive" && direction !== "negative")
    throw Error("Invalid circuit incidence port");
  return {
    physical: id.slice(0, at),
    offset: (direction === "positive" ? 1 : -1) * CIRCUIT_LANDING_OFFSET,
  };
}

export function splitPhysicalCircuitPorts(graph: ElkNode): ReadonlySet<string> {
  const split = new Set<string>();
  for (const edge of graph.edges ?? []) {
    for (const id of [...edge.sources, ...edge.targets]) {
      const site = circuitLandingPort(id);
      if (site.offset !== 0) split.add(site.physical);
    }
  }
  return split;
}

export function circuitLandingGeometry(
  id: string,
  nodes: readonly DeviceNode[],
) {
  const site = circuitLandingPort(id);
  const node = required(
    nodes.find((n) => n.pins.some((p) => p.id === site.physical)),
    "Missing physical circuit port owner",
  );
  const pinIndex = node.pins.findIndex((p) => p.id === site.physical);
  const pin = required(node.pins[pinIndex], "Missing physical circuit pin");
  const horizontal = pin.side === "WEST" || pin.side === "EAST";
  const bodyPin = node.tagLane?.body.pins[pinIndex] ?? pin;
  const physicalMarkerCentre = node.tagLane
    ? {
        x: bodyPin.x + node.tagLane.geometry.bodyX,
        y: bodyPin.y + node.tagLane.geometry.bodyY,
      }
    : { x: pin.x, y: pin.y };
  const offsetPaintedLanding = {
    x: physicalMarkerCentre.x + (horizontal ? 0 : site.offset),
    y: physicalMarkerCentre.y + (horizontal ? site.offset : 0),
  };
  const outerRoutePort = {
    x: pin.x + (horizontal ? 0 : site.offset),
    y: pin.y + (horizontal ? site.offset : 0),
  };
  const hasRecessExtension =
    Math.abs(outerRoutePort.x - offsetPaintedLanding.x) > 1e-7 ||
    Math.abs(outerRoutePort.y - offsetPaintedLanding.y) > 1e-7;
  return {
    node,
    pin,
    bodyPin,
    physicalPortId: site.physical,
    offset: site.offset,
    physicalMarkerCentre,
    offsetPaintedLanding,
    outerRoutePort,
    hasRecessExtension,
  };
}

export function circuitRoutePin(id: string, nodes: readonly DeviceNode[]) {
  const geom = circuitLandingGeometry(id, nodes);
  return {
    node: geom.node,
    pin: geom.pin,
    x: geom.outerRoutePort.x,
    y: geom.outerRoutePort.y,
  };
}
