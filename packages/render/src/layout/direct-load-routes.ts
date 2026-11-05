import { compareTerminalId } from "../ordering.js";
import type { SymbolSide } from "../symbols/types.js";
import type { JunctionPresentationNode, PresentationGraph } from "../types.js";

/** ELK may loop a branch across its sibling when both loads share a compound.
 * Enumerate the four straight/turned assignments at each two-arm source fork.
 * Only routing sides change: identities, anchors and incidence stay exact. */
export function* directLoadRouteAlternatives(
  graph: PresentationGraph,
): Generator<PresentationGraph> {
  if (!graph.directLoadPair) return;
  const sourceUid =
    "deviceUid" in graph.view.root ? graph.view.root.deviceUid : undefined;
  const designations = new Map(
    graph.deviceGroups.map((g) => [g.deviceUid, g.designation]),
  );
  const forks = graph.nodes
    .filter(
      (node): node is JunctionPresentationNode =>
        node.kind === "junction" &&
        node.terminal.deviceUid === sourceUid &&
        node.ports.length === 3,
    )
    .sort((a, b) =>
      compareTerminalId(a.terminal, b.terminal, (uid) =>
        designations.get(uid)!,
      ),
    );
  // A DC source has two mapped arms. Keep the search bounded at 4² routes.
  if (forks.length === 0 || forks.length > 2) return;
  const forward: SymbolSide =
    graph.view.flow === "left-to-right" ? "east" : "south";
  const opposite = {
    north: "south",
    south: "north",
    east: "west",
    west: "east",
  } as const;
  const ports = forks.map((node) =>
    node.ports
      .filter((port) =>
        graph.edges.some(
          (edge) => edge.kind === "conductor" && edge.sourcePortId === port.id,
        ),
      )
      .sort((a, b) => a.order - b.order),
  );
  if (
    ports.some(
      (pair) =>
        pair.length !== 2 ||
        pair[0]!.side !== forward ||
        pair[1]!.side === forward ||
        pair[1]!.side === opposite[forward],
    )
  )
    return;
  for (let candidate = 1; candidate < 4 ** forks.length; candidate++) {
    const sides = new Map<string, SymbolSide>();
    ports.forEach((pair, index) => {
      const variant = Math.floor(candidate / 4 ** index) % 4;
      const turn = variant < 2 ? pair[1]!.side : opposite[pair[1]!.side];
      sides.set(pair[0]!.id, variant % 2 === 0 ? forward : turn);
      sides.set(pair[1]!.id, variant % 2 === 0 ? turn : forward);
    });
    yield {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.kind !== "junction"
          ? node
          : {
              ...node,
              ports: node.ports.map((port) => ({
                ...port,
                side: sides.get(port.id) ?? port.side,
              })),
            },
      ),
    };
  }
}
