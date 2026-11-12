import { terminalIdKey } from "../ordering.js";
import type { PresentationGraph } from "../types.js";

/** A landing caption already identifies this conductor. Suppress only redundant
 * ink, retaining the net label's reservation, ownership and electrical name.
 * Work within the landing's node appearance: a caption on a remote/split body
 * cannot substitute for the name here. Duplicate port captions may share one
 * printed caption on that same physical terminal and body.
 */
export function redundantNetLabelIds(
  graph: Readonly<PresentationGraph>,
  hiddenCaptions: ReadonlySet<string>,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const edge of graph.edges) {
    const label = edge.netLabel;
    if (!label) continue;
    const text = label.printableText ?? label.text;
    if (!text) continue;
    for (const portId of [edge.sourcePortId, edge.targetPortId]) {
      const node = graph.nodes.find((n) =>
        n.ports.some((p) => p.id === portId),
      );
      if (!node || node.kind === "junction") continue;
      const landing = node.ports.find((p) => p.id === portId);
      if (!landing) continue;
      const terminal = terminalIdKey(landing.terminal);
      if (
        node.labels.some(
          (caption) =>
            caption.role === "terminal" &&
            !hiddenCaptions.has(caption.id) &&
            (caption.printableText ?? caption.text) === text &&
            node.ports.some(
              (p) =>
                p.id === caption.ownerId &&
                terminalIdKey(p.terminal) === terminal,
            ),
        )
      )
        hidden.add(label.id);
    }
  }
  return hidden;
}
