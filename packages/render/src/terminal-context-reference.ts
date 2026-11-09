import type {
  PresentationEdge,
  PresentationGraph,
  PresentationLabel,
  SymbolPresentationNode,
} from "./types.js";
import { compareRenderTextSource, structuralTupleId } from "./ordering.js";
import { printableSlotWidth } from "./symbols/printable-font.js";

/** Same-terminal context associations are references, never physical conductors. */
export function terminalContextAttachment(
  graph: Readonly<PresentationGraph>,
  edge: Readonly<PresentationEdge>,
): { context: SymbolPresentationNode; junctionIsSource: boolean } | undefined {
  if (edge.kind !== "boundary-segment") return undefined;
  const source = graph.nodes.find((n) =>
    n.ports.some((p) => p.id === edge.sourcePortId),
  );
  const target = graph.nodes.find((n) =>
    n.ports.some((p) => p.id === edge.targetPortId),
  );
  const context =
    source?.kind === "symbol" && source.representation === "terminal"
      ? source
      : target?.kind === "symbol" && target.representation === "terminal"
        ? target
        : undefined;
  const junction =
    source?.kind === "junction"
      ? source
      : target?.kind === "junction"
        ? target
        : undefined;
  return context && junction
    ? { context, junctionIsSource: source === junction }
    : undefined;
}

function referenceLabel(
  graph: PresentationGraph,
  edge: PresentationEdge,
  context: SymbolPresentationNode,
  role: "reference",
): PresentationLabel {
  const port = context.ports[0];
  if (!port) throw Error("Terminal context has no real terminal");
  const terminal = port.terminal;
  const text = `${context.designation}.${terminal.terminalKey} (reference, no wire)`;
  const width = printableSlotWidth(
    text,
    Math.max(12, Number((6 + 6.2 * [...text].length).toFixed(3))),
  );
  const group = graph.deviceGroups.find((g) => g.id === context.deviceGroupId);
  const caption = context.labels.find((l) => l.role === "terminal");
  if (!group || !caption) throw Error("Terminal context identity is missing");
  return {
    id: structuralTupleId("label", "edge", edge.id, role),
    ownerKind: "edge",
    ownerId: edge.id,
    role,
    text,
    textSources: [...group.label.textSources, ...caption.textSources].sort(
      compareRenderTextSource,
    ),
    width,
    height: 14,
    textLength: Number((width - 6).toFixed(3)),
  };
}

export function labelTerminalContextReferences(
  graph: PresentationGraph,
): PresentationGraph {
  return {
    ...graph,
    edges: graph.edges.map((edge) => {
      const association = terminalContextAttachment(graph, edge);
      return association
        ? {
            ...edge,
            label: referenceLabel(
              graph,
              edge,
              association.context,
              "reference",
            ),
          }
        : edge;
    }),
  };
}

/** At default print scale each solid hairline leader is at most 2 mm. */
export function contextReferenceLeader(
  points: readonly { x: number; y: number }[],
  fromSource: boolean,
): readonly { x: number; y: number }[] {
  const route = fromSource ? [...points] : [...points].reverse();
  let from = route[0];
  if (!from) return [];
  const result = [from];
  let remaining = 8;
  for (const to of route.slice(1)) {
    if (remaining <= 0) break;
    const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    if (length === 0) continue;
    const take = Math.min(remaining, length);
    result.push({
      x: from.x + ((to.x - from.x) * take) / length,
      y: from.y + ((to.y - from.y) * take) / length,
    });
    remaining -= take;
    from = to;
  }
  return result;
}
