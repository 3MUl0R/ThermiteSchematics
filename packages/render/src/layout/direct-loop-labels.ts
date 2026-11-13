import type { ElkExtendedEdge, ElkLabel, ElkNode } from "elkjs/lib/elk-api.js";
import { required } from "../presentation/util.js";
import { InlineLabelFitError } from "./inline-label-error.js";

/** Remove inline labels from ELK's transverse lane demand, not from the drawing. */
export function detachLoopLabels(
  edges: ElkExtendedEdge[],
  ids: readonly string[],
) {
  const labels = new Map<string, ElkLabel[]>();
  for (const edge of edges) {
    if (!ids.includes(edge.id)) continue;
    labels.set(edge.id, edge.labels ?? []);
    edge.labels = [];
  }
  return labels;
}

/** Only labels move after layout. Routes and fixed terminal ports stay native. */
export function placeLoopLabels(
  graph: ElkNode,
  labels: Map<string, ElkLabel[]>,
) {
  for (const edge of graph.edges ?? []) {
    const inline = labels.get(edge.id);
    if (!inline) continue;
    const segments = (edge.sections ?? []).flatMap((section) => {
      const points = [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ];
      return points.slice(1).flatMap((b, i) => {
        const a = required(points[i], "Missing loop segment start");
        return Math.abs(a.x - b.x) < 1e-6
          ? [
              {
                x: (a.x + b.x) / 2,
                y: (a.y + b.y) / 2,
                length: Math.abs(a.y - b.y),
              },
            ]
          : [];
      });
    });
    const segment = segments.sort((a, b) => b.length - a.length)[0];
    if (!segment)
      throw new InlineLabelFitError(
        "No vertical segment fits the output loop wire label.",
      );
    edge.labels = inline.map((label) => {
      const width = required(label.width, "Missing loop label width");
      const height = required(label.height, "Missing loop label height");
      if (height > segment.length)
        throw new InlineLabelFitError(
          "No vertical segment fits the output loop wire label.",
        );
      return { ...label, x: segment.x - width / 2, y: segment.y - height / 2 };
    });
  }
}
