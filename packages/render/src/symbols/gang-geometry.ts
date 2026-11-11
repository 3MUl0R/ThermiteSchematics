import { functionIdKey, compareText } from "../ordering.js";
import type { FunctionId, ElectricalIr } from "@thermite/compiler";
import type { PresentationGraph, SymbolPresentationNode } from "../types.js";
import { PRINTABLE_SYMBOL_POLICY } from "./printable-policy.js";

// Gang stroke + conductor stroke + minimum printable ink gap, at minimum scale.
export const GANG_CLEARANCE =
  (0.25 / 2 +
    PRINTABLE_SYMBOL_POLICY.conductorStrokeMm / 2 +
    PRINTABLE_SYMBOL_POLICY.minimumGapMm) /
  PRINTABLE_SYMBOL_POLICY.rootedMmPerUnit;

export function gangAnchor(
  node: Pick<SymbolPresentationNode, "symbolId" | "orientation" | "symbolSize">,
) {
  const blade = ["ais:breaker-pole", "ais:disconnector"].includes(
    node.symbolId,
  );
  const contact = [
    "ais:contact-no",
    "ais:contact-nc",
    "ais:overload-pole",
  ].includes(node.symbolId);
  if (!blade && !contact) return undefined;
  const x = blade ? 18.5 : 20,
    y = blade ? 6.5 : 10;
  return node.orientation === "left-to-right"
    ? { x, y }
    : { x: node.symbolSize.width - y, y: x };
}

/** A link joins independently drawn, visible members. A lone selected member
 * cannot establish an association to an omitted member's invented position. */
export function visibleRootedGangs(
  ir: Readonly<ElectricalIr>,
  graph: Readonly<PresentationGraph>,
) {
  return [...ir.gangedGroups]
    .sort((a, b) => compareText(a.id, b.id))
    .flatMap((group) => {
      const members = graph.nodes.filter(
        (node): node is SymbolPresentationNode =>
          node.kind === "symbol" &&
          node.functionIds.some((f) =>
            group.functionIds.some(
              (g) =>
                f.deviceUid === g.deviceUid && f.functionKey === g.functionKey,
            ),
          ),
      );
      return members.length >= 2 ? [{ group, members }] : [];
    });
}

export function reserveGangAnnotations(
  ir: Readonly<ElectricalIr>,
  graph: PresentationGraph,
): PresentationGraph {
  const ids = new Map(
    visibleRootedGangs(ir, graph).flatMap(({ group, members }) =>
      members.map((n) => [n.id, group.id] as const),
    ),
  );
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const id = ids.get(n.id);
      return n.kind === "symbol" && id !== undefined
        ? { ...n, mechanicalGangId: id }
        : n;
    }),
  };
}

export function selectedGangId(
  ir: Readonly<ElectricalIr>,
  selected: readonly FunctionId[],
  represented: readonly FunctionId[],
) {
  const selectedKeys = new Set(selected.map(functionIdKey));
  const representedKeys = new Set(represented.map(functionIdKey));
  return ir.gangedGroups.find(
    (g) =>
      g.functionIds.some((f) => representedKeys.has(functionIdKey(f))) &&
      g.functionIds.filter((f) => selectedKeys.has(functionIdKey(f))).length >=
        2,
  )?.id;
}
