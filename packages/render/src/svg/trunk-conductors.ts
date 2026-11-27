import { svgSemanticId } from "./escape.js";
import type { PresentationEdge, PresentationGraph } from "../types.js";

/** Canonical native conductor identity matching compiler/checker conventions. */
export function conductorIdentityForEdge(
  edge: Readonly<PresentationEdge>,
): string | undefined {
  if (edge.kind !== "conductor") return undefined;
  const fallback = edge.elementIds[0];
  if (edge.conductor?.kind === "wire") return edge.conductor.uid;
  if (edge.conductor?.kind === "jumper") return edge.conductor.uid;
  if (edge.conductor?.kind === "cable-conductor")
    return JSON.stringify([
      edge.conductor.cableUid,
      edge.conductor.conductorId,
    ]);
  if (fallback?.kind === "wire" || fallback?.kind === "jumper")
    return fallback.uid;
  if (fallback?.kind === "cable_conductor")
    return JSON.stringify([fallback.cableUid, fallback.conductorId]);
  return undefined;
}

function junctionPortIndex(
  graph: Readonly<PresentationGraph>,
): ReadonlyMap<string, string> {
  const portToJunction = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind !== "junction") continue;
    for (const port of node.ports) portToJunction.set(port.id, node.id);
  }
  return portToJunction;
}

function junctionAdjacency(
  graph: Readonly<PresentationGraph>,
  portToJunction: ReadonlyMap<string, string>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = adj.get(a) ?? new Set<string>();
    set.add(b);
    adj.set(a, set);
  };
  for (const edge of graph.edges) {
    if (edge.kind !== "boundary-segment") continue;
    const src = portToJunction.get(edge.sourcePortId);
    const tgt = portToJunction.get(edge.targetPortId);
    if (src && tgt && src !== tgt) {
      link(src, tgt);
      link(tgt, src);
    }
  }
  return adj;
}

function junctionComponent(
  seeds: readonly string[],
  adj: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const visited = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (cur === undefined) continue;
    for (const next of adj.get(cur) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

/** Map each junction-attached boundary segment to its deterministic native conductor list. */
export function trunkConductorMap(
  graph: Readonly<PresentationGraph>,
): ReadonlyMap<string, string> {
  const portToJunction = junctionPortIndex(graph);
  const adj = junctionAdjacency(graph, portToJunction);
  const result = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind !== "boundary-segment") continue;
    const seeds = [
      portToJunction.get(edge.sourcePortId),
      portToJunction.get(edge.targetPortId),
    ].filter((id): id is string => id !== undefined);
    if (seeds.length === 0) continue;
    const component = junctionComponent(seeds, adj);
    const ids = new Set<string>();
    for (const candidate of graph.edges) {
      if (candidate.kind !== "conductor" || candidate.netId !== edge.netId)
        continue;
      const srcJ = portToJunction.get(candidate.sourcePortId);
      const tgtJ = portToJunction.get(candidate.targetPortId);
      if (
        (srcJ !== undefined && component.has(srcJ)) ||
        (tgtJ !== undefined && component.has(tgtJ))
      ) {
        const id = conductorIdentityForEdge(candidate);
        if (id !== undefined) ids.add(id);
      }
    }
    // Preserve presentation-graph edge order so trunk conductor lists are UID-independent.
    if (ids.size > 0) result.set(edge.id, JSON.stringify([...ids]));
  }
  return result;
}

export function boundaryAttrs(
  edge: Readonly<PresentationEdge>,
  trunks: ReadonlyMap<string, string>,
  endpoints: Record<string, string | number | undefined>,
): Record<string, string | number | undefined> {
  const value = trunks.get(edge.id);
  return {
    id: svgSemanticId("boundary", [edge.id]),
    class: "boundary-path",
    "data-net-id": edge.netId,
    "data-presentation-only": "true",
    ...(value === undefined ? {} : { "data-trunk-conductors": value }),
    ...endpoints,
  };
}
