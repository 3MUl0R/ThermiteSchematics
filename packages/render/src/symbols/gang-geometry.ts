import { compareText } from "../ordering.js";
import type { ElectricalIr } from "@thermite/compiler";
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
      const poles =
        graph.view.family === "power"
          ? members.filter((n) => isPowerSwitchingPole(n, ir))
          : [];
      return members.length >= 2
        ? [
            {
              group,
              members: poles.length >= 2 ? poles : members,
              mandatory: poles.length >= 2,
            },
          ]
        : [];
    });
}

/** Closed power marks identify pole roles; contact marks additionally need the
 * power-contact classification so auxiliary/control contacts stay optional. */
export function isPowerSwitchingPole(
  node: SymbolPresentationNode,
  ir: Readonly<ElectricalIr>,
): boolean {
  if (node.representation !== "function") return false;
  if (
    ["ais:breaker-pole", "ais:disconnector", "ais:overload-pole"].includes(
      node.symbolId,
    )
  )
    return true;
  if (
    !["ais:contact-no", "ais:contact-nc"].includes(node.symbolId) ||
    node.classification !== "power-contact"
  )
    return false;
  const roles = node.ports.map(
    (p) =>
      ir.terminals.find(
        (t) =>
          t.id.deviceUid === p.terminal.deviceUid &&
          t.id.terminalKey === p.terminal.terminalKey,
      )?.role,
  );
  return roles.includes("power_input") && roles.includes("power_output");
}

/** Before ELK, the finite prospective owner box is contained in its device
 * group. Only that owner's cards are checked here; actual inter-member spans
 * are checked after ELK. No sheet-wide or guessed coordinate extent is used. */
export function gangReservationBand(
  node: Pick<
    SymbolPresentationNode,
    | "symbolId"
    | "orientation"
    | "symbolSize"
    | "primitiveOrigin"
    | "mechanicalGangId"
  >,
  bounds: { x: number; y: number; width: number; height: number },
) {
  const anchor = node.mechanicalGangId ? gangAnchor(node) : undefined;
  if (!anchor) return undefined;
  return node.orientation === "top-to-bottom"
    ? {
        x: bounds.x - GANG_CLEARANCE,
        y: node.primitiveOrigin.y + anchor.y - GANG_CLEARANCE,
        width: bounds.width + 2 * GANG_CLEARANCE,
        height: 2 * GANG_CLEARANCE,
      }
    : {
        x: node.primitiveOrigin.x + anchor.x - GANG_CLEARANCE,
        y: bounds.y - GANG_CLEARANCE,
        width: 2 * GANG_CLEARANCE,
        height: bounds.height + 2 * GANG_CLEARANCE,
      };
}
