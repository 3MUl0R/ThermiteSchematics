import type { DeviceTagPlan } from "../device-tags.js";
import { measure } from "../symbols/circuit-text.js";
import type { Diagnostic } from "@thermite/schema";
import type { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk-api.js";
import type { IrFunction, TerminalId } from "@thermite/compiler";
import type { DeviceNode, PhysicalConductor, Pin } from "./types.js";
import { independentCircuitLandings } from "./landing-ports.js";
export type LayoutGroup = {
  id: string;
  label?: string;
  lineReference?: string;
};
export interface LayoutHooks {
  key: (t: TerminalId) => string;
  fkey: (f: IrFunction) => string;
  compare: (a: string, b: string) => number;
  n: (v: number) => string;
  text: (
    x: number,
    y: number,
    s: string,
    size?: number,
    anchor?: string,
    bold?: boolean,
  ) => string;
  conductorLabelLines: (c: PhysicalConductor) => string[];
  circuitDeviceTags: (nodes: DeviceNode[]) => DeviceTagPlan[];
  emitNode: (
    node: DeviceNode,
    x: number,
    y: number,
    vertical: boolean,
    conductors: PhysicalConductor[],
    diagnostics: Diagnostic[],
    omitDesignation?: boolean,
    attachmentWeights?: ReadonlyMap<string, number>,
  ) => string;
}
export type CircuitPins = ReturnType<typeof circuitGraphPins>;
export function circuitGraphPins(nodes: DeviceNode[], key: LayoutHooks["key"]) {
  const pins = new Map<string, { node: DeviceNode; pins: Pin[] }>();
  for (const node of nodes)
    for (const pin of node.pins) {
      const entry = pins.get(key(pin.terminal)) ?? { node, pins: [] };
      entry.pins.push(pin);
      pins.set(key(pin.terminal), entry);
    }
  return pins;
}

export function circuitGraphChildren(nodes: DeviceNode[]) {
  const children: ElkNode[] = nodes.map((d) => ({
    id: d.id,
    width: d.width,
    height: d.height,
    layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    ports: d.pins.map((p) => ({
      id: p.id,
      width: 0,
      height: 0,
      x: p.x,
      y: p.y,
      layoutOptions: { "elk.port.side": p.side },
    })),
  }));
  return children;
}

export function circuitGraphEdge(
  c: PhysicalConductor,
  i: number,
  group: LayoutGroup,
  pins: CircuitPins,
  selfLoops: Set<number>,
  hooks: LayoutHooks,
): ElkExtendedEdge {
  const { key, conductorLabelLines } = hooks;
  const lines = conductorLabelLines(c);
  let a = pins.get(key(c.ends[0]!))!,
    b = pins.get(key(c.ends[1]!))!;
  if (!a || !b)
    throw new Error(
      `Circuit ${group.id}: missing physical endpoint presentation.`,
    );
  if (a.node.rank > b.node.rank) [a, b] = [b, a];
  if (a.node === b.node) selfLoops.add(i);
  const ap =
    a.pins.find((p) => ["EAST", "SOUTH"].includes(p.side)) ?? a.pins[0]!;
  const bp =
    b.pins.find((p) => ["WEST", "NORTH"].includes(p.side)) ?? b.pins[0]!;
  return {
    id: `e${i}`,
    sources: [ap.id],
    targets: [bp.id],
    labels: [
      {
        text: lines.join("\n"),
        width: Math.max(...lines.map((line) => measure(line))) + 1.5,
        height: 3.8 + (lines.length - 1) * 3.1,
        layoutOptions: { "elk.edgeLabels.inline": "true" },
      },
    ],
  };
}

function nestedSameSideSelfLoopGaps(
  children: readonly ElkNode[],
  edges: readonly ElkExtendedEdge[],
  selfLoops: ReadonlySet<number>,
) {
  const gaps = new Map<string, number>();
  if (selfLoops.size < 2) return gaps;
  const ports = new Map<string, { nodeId: string; side: string; x: number }>();
  for (const child of children)
    for (const port of child.ports ?? [])
      ports.set(port.id, {
        nodeId: child.id,
        side: port.layoutOptions?.["elk.port.side"] ?? "",
        x: port.x ?? 0,
      });
  const loops = edges
    .filter((_, i) => selfLoops.has(i))
    .flatMap((edge) => {
      const a = ports.get(edge.sources[0] ?? ""),
        b = ports.get(edge.targets[0] ?? "");
      if (
        !a ||
        !b ||
        a.nodeId !== b.nodeId ||
        a.side !== b.side ||
        (a.side !== "NORTH" && a.side !== "SOUTH")
      )
        return [];
      const lo = Math.min(a.x, b.x),
        hi = Math.max(a.x, b.x);
      return [{ edge, nodeId: a.nodeId, side: a.side, lo, hi, span: hi - lo }];
    });
  for (const loop of loops) {
    if (
      !loops.some(
        (o) =>
          o !== loop &&
          o.nodeId === loop.nodeId &&
          o.side === loop.side &&
          o.lo < loop.hi &&
          loop.lo < o.hi,
      )
    )
      continue;
    for (const label of loop.edge.labels ?? []) {
      const w = label.width ?? 0,
        h = label.height ?? 0;
      if (loop.span < w + 2 * Math.max(2, h))
        gaps.set(loop.nodeId, Math.max(gaps.get(loop.nodeId) ?? 3, h + 2.2));
    }
  }
  return gaps;
}

export function circuitGraphInput(
  children: ElkNode[],
  edges: ElkExtendedEdge[],
  selfLoops: Set<number>,
  vertical: boolean,
  conductors: readonly PhysicalConductor[],
) {
  const nestedSelfLoopGaps = vertical
    ? nestedSameSideSelfLoopGaps(children, edges, selfLoops)
    : new Map<string, number>();
  const spacedChildren = nestedSelfLoopGaps.size
    ? children.map((child) => {
        const gap = nestedSelfLoopGaps.get(child.id);
        return gap !== undefined
          ? {
              ...child,
              layoutOptions: {
                ...child.layoutOptions,
                "elk.spacing.individual": `spacing.edgeEdge:${gap}`,
              },
            }
          : child;
      })
    : children;
  const input: ElkNode = {
    id: "circuit",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": vertical ? "DOWN" : "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "5",
      "elk.layered.spacing.nodeNodeBetweenLayers": "7",
      "elk.spacing.edgeNode": "3",
      "elk.spacing.edgeEdge": "3",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "3",
      "elk.layered.spacing.edgeNodeBetweenLayers": "3",
      "elk.spacing.edgeLabel": "1",
      // A nested fixed-port loop can obstruct an outer-side label. Reserve
      // enough room for its measured label inside the loop, with 1 mm on
      // each side; ELK still owns the complete route and node placement.
      ...(selfLoops.size
        ? {
            "elk.spacing.nodeSelfLoop": String(
              Math.max(
                10,
                ...edges
                  .filter((_, i) => selfLoops.has(i))
                  .flatMap((edge) =>
                    edge.labels!.map(
                      (label) => Math.max(label.width!, label.height!) + 2,
                    ),
                  ),
              ),
            ),
          }
        : {}),
      "elk.padding": "[top=2,left=2,bottom=2,right=2]",
      "elk.randomSeed": "1",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
      "elk.layered.mergeEdges": "false",
    },
    children: spacedChildren,
    edges,
  };
  return independentCircuitLandings(
    input,
    new Set(conductors.flatMap((c, i) => (c.jumper ? [] : [`e${i}`]))),
  );
}
