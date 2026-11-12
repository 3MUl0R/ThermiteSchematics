import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { PresentationGraph } from "../types.js";
import {
  verticalPowerLanes,
  VERTICAL_POWER_EDGE_NODE_SPACING,
} from "./adapter-ordering.js";
import { ELK_OPTIONS } from "./options.js";

/** Spacing alternatives leave all fixed ports, ordering and route checks intact. */
export function applyLayoutSpacing(
  input: ElkNode,
  graph: PresentationGraph,
  options: { spacingProfile?: "compact" | "dense"; powerTurnSpacing?: number },
) {
  const vertical = verticalPowerLanes(graph);
  const visit = (node: ElkNode): void => {
    if (!node.children?.length) return;
    if (options.spacingProfile) {
      const dense = options.spacingProfile === "dense";
      node.layoutOptions = {
        ...node.layoutOptions,
        [ELK_OPTIONS.nodeNodeSpacing]: dense ? "12" : "18",
        [ELK_OPTIONS.nodeNodeBetweenLayersSpacing]: dense ? "20" : "40",
        [ELK_OPTIONS.edgeNodeSpacing]: vertical
          ? VERTICAL_POWER_EDGE_NODE_SPACING
          : dense
            ? "10"
            : "12",
        [ELK_OPTIONS.componentComponentSpacing]: dense ? "16" : "24",
      };
    }
    if (vertical && options.powerTurnSpacing) {
      node.layoutOptions = {
        ...node.layoutOptions,
        [ELK_OPTIONS.edgeNodeSpacing]: String(
          Math.max(
            Number(node.layoutOptions?.[ELK_OPTIONS.edgeNodeSpacing] ?? 0),
            options.powerTurnSpacing,
          ),
        ),
      };
    }
    node.children.forEach(visit);
  };
  visit(input);
}
