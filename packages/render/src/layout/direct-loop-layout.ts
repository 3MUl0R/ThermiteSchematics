import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import { createElkEngine } from "./elk-runtime.js";
import { assertTopologyIdentities } from "./topology-conservation.js";
import { detachLoopLabels, placeLoopLabels } from "./direct-loop-labels.js";

/** The direct loop's declared fixed ports survive placement unchanged. */
export async function layoutDirectLoop(
  children: ElkNode[],
  edges: ElkExtendedEdge[],
  vertical: boolean,
  inlineEdgeIds: readonly string[] = [],
): Promise<ElkNode> {
  const input: ElkNode = {
    id: "loop",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": vertical ? "DOWN" : "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "8",
      "elk.spacing.edgeEdge": "6",
      "elk.spacing.edgeNode": "5",
      "elk.padding": "[top=6,left=6,bottom=6,right=6]",
      "elk.randomSeed": "1",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children,
    edges: structuredClone(edges),
  };
  const expected = structuredClone(input);
  const labels = detachLoopLabels(input.edges ?? [], inlineEdgeIds);
  const graph = await createElkEngine().layout(input);
  assertTopologyIdentities(graph, expected);
  placeLoopLabels(graph, labels);
  return graph;
}
