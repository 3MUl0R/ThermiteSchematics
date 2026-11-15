import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { PreparedSchematicDrawing } from "../renderer.js";
import { OUTER_SVG_PADDING as pad } from "../symbols/catalog.js";
import { ELK_OPTIONS } from "../layout/options.js";

/** Three authored, two-ended paths between the same two devices. Labels and
 * designations never establish incidence, phase order or electrical identity. */
export function foldBranchLabels(
  p: PreparedSchematicDrawing,
  window: { start: number; end: number },
) {
  const owners = new Map(
    p.graph.nodes.flatMap((n) => n.ports.map((port) => [port.id, n] as const)),
  );
  const groups = new Map<string, (typeof p.graph.edges)[number][]>();
  for (const edge of p.graph.edges) {
    const a = owners.get(edge.sourcePortId),
      b = owners.get(edge.targetPortId);
    if (
      edge.kind !== "conductor" ||
      !a ||
      !b ||
      !("deviceUid" in a) ||
      !("deviceUid" in b)
    )
      continue;
    const key = JSON.stringify([a.deviceUid, b.deviceUid]);
    const group = groups.get(key) ?? [];
    group.push(edge);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (
      group.length !== 3 ||
      new Set(group.map((e) => e.sourcePortId)).size !== 3 ||
      new Set(group.map((e) => e.targetPortId)).size !== 3
    )
      continue;
    const labels = group.flatMap((e) => (e.label ? [e.label.id] : []));
    if (
      labels.length === 3 &&
      labels.every((id) => {
        const label = p.layout.labels.find((l) => l.id === id);
        return (
          label &&
          label.x + pad - 12 < window.end &&
          label.x + label.width + pad + 12 > window.start
        );
      })
    )
      return new Set(labels);
  }
  return undefined;
}

/** Only ELK input changes: retain fixed ports, hierarchy, gang membership,
 * incidence, net labels and all original edge identities. */
export function foldBranchInput<T extends ElkNode>(
  input: T,
  labels: ReadonlySet<string>,
  spacing: number,
): T {
  const copy = structuredClone(input);
  const visit = (node: ElkNode): void => {
    if (node.children?.length) {
      node.layoutOptions = {
        ...node.layoutOptions,
        [ELK_OPTIONS.nodeNodeBetweenLayersSpacing]: String(spacing),
      };
      node.children.forEach(visit);
    }
    for (const edge of node.edges ?? [])
      for (const label of edge.labels ?? [])
        if (label.id && labels.has(label.id))
          label.layoutOptions = {
            ...label.layoutOptions,
            [ELK_OPTIONS.edgeLabelsPlacement]: "TAIL",
          };
  };
  visit(copy);
  return copy;
}
