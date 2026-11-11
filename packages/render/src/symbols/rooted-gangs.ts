import type { ElectricalIr } from "@thermite/compiler";
import type {
  PresentationGraph,
  NormalizedSchematicLayout,
  LayoutPoint,
  SymbolPresentationNode,
  RenderOutcome,
} from "../types.js";
import {
  GANG_CLEARANCE,
  gangAnchor,
  visibleRootedGangs,
} from "./gang-geometry.js";

export interface RootedGangSegment {
  groupId: string;
  from: LayoutPoint;
  to: LayoutPoint;
  functions: SymbolPresentationNode["functionIds"];
}

/** An authored visible association is mandatory ink. Any missing, misaligned or
 * obstructed stroke refuses the whole drawing; it never becomes a partial gang. */
export function rootedGangSegments(
  ir: Readonly<ElectricalIr>,
  graph: Readonly<PresentationGraph>,
  layout: Readonly<NormalizedSchematicLayout>,
): RenderOutcome<readonly RootedGangSegment[]> {
  const vertical = graph.view.flow === "left-to-right";
  const labels = new Map(
    [
      ...graph.locationGroups.map((g) => g.label),
      ...graph.deviceGroups.map((g) => g.label),
      ...graph.nodes.flatMap((n) => (n.kind === "junction" ? [] : n.labels)),
      ...graph.edges.flatMap((e) => [
        ...(e.label ? [e.label] : []),
        ...(e.netLabel ? [e.netLabel] : []),
      ]),
    ].map((l) => [l.id, l.printableText ?? l.text]),
  );
  const result: RootedGangSegment[] = [];
  for (const { group, members } of visibleRootedGangs(ir, graph)) {
    const member = members[0];
    if (!member) continue;
    const refuse = (blockedBy: string): RenderOutcome<never> => ({
      ok: false,
      error: {
        code: "R006",
        reason: "unprintable-layout",
        root: graph.view.root.designation,
        message: `Mechanical gang ${group.id} (${member.designation}) cannot paint all ${members.length - 1} links: ${blockedBy}. Use a larger page or change flow.`,
        details: {
          reason: "mechanical-gang",
          groupId: group.id,
          designation: member.designation,
          expectedStrokes: members.length - 1,
          blockedBy,
        },
      },
    });
    const centers = members.map((node) => {
      const o = layout.nodes.find((n) => n.id === node.id)?.primitiveOrigin,
        a = gangAnchor(node);
      return o && a ? { node, x: o.x + a.x, y: o.y + a.y } : undefined;
    });
    if (centers.some((c) => !c)) return refuse("missing supported gang anchor");
    const aligned = centers
      .filter((c) => c !== undefined)
      .sort((a, b) => (vertical ? a.y - b.y : a.x - b.x));
    if (
      aligned.some(
        (c) =>
          Math.abs(
            (vertical ? c.x : c.y) - (vertical ? aligned[0]!.x : aligned[0]!.y),
          ) > 0.001,
      )
    )
      return refuse("misaligned poles");
    for (let i = 1; i < aligned.length; i++) {
      const from = aligned[i - 1]!,
        to = aligned[i]!;
      const between = (x: number, y: number, w: number, h: number) =>
        vertical
          ? from.x > x - GANG_CLEARANCE &&
            from.x < x + w + GANG_CLEARANCE &&
            y + h > from.y - GANG_CLEARANCE &&
            y < to.y + GANG_CLEARANCE
          : from.y > y - GANG_CLEARANCE &&
            from.y < y + h + GANG_CLEARANCE &&
            x + w > from.x - GANG_CLEARANCE &&
            x < to.x + GANG_CLEARANCE;
      const node = layout.nodes.find(
        (n) =>
          n.id !== from.node.id &&
          n.id !== to.node.id &&
          ["symbol", "rail", "junction"].includes(n.kind) &&
          between(n.x, n.y, n.width, n.height),
      );
      if (node) return refuse(`node ${node.id}`);
      const label = layout.labels.find(
        (l) => labels.get(l.id) && between(l.x, l.y, l.width, l.height),
      );
      if (label) return refuse(`annotation ${label.id}`);
      const edge = layout.edges.find((e) =>
        e.points.some(
          (p, j) =>
            j > 0 &&
            between(
              Math.min(p.x, e.points[j - 1]!.x),
              Math.min(p.y, e.points[j - 1]!.y),
              Math.abs(p.x - e.points[j - 1]!.x),
              Math.abs(p.y - e.points[j - 1]!.y),
            ),
        ),
      );
      if (edge) return refuse(`conductor ${edge.id}`);
      result.push({
        groupId: group.id,
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y },
        functions: [...from.node.functionIds, ...to.node.functionIds],
      });
    }
  }
  return { ok: true, value: result };
}
