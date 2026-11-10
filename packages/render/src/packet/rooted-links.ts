import { required } from "../presentation/util.js";
import type { PresentationEdge, LayoutEdge, RenderOutcome } from "../types.js";
import type { Draft, DrawingBounds } from "./types.js";
import {
  continuationIdentity,
  continuationIdentityConstraint,
} from "./continuation-identity.js";
import { rootedCrossings } from "./rooted-crossings.js";
import { failure } from "./errors.js";

export function drawingContinuations(
  drafts: Draft[],
  graph: {
    readonly edges: readonly Pick<
      PresentationEdge,
      "id" | "label" | "conductor" | "elementIds"
    >[];
  },
  layout: {
    readonly edges: readonly Pick<LayoutEdge, "id" | "points" | "netId">[];
  },
  xs: readonly number[],
  ys: readonly number[],
  b: DrawingBounds,
  scale: number,
): RenderOutcome<void> {
  let serial = 0;
  for (const edge of layout.edges) {
    const semantic = graph.edges.find((e) => e.id === edge.id);
    if (!semantic || semantic.label?.role === "reference") continue;
    const crossings = rootedCrossings(edge, xs, ys, b, scale);
    if (!crossings.length) continue;
    const identity = continuationIdentity(semantic);
    if (!identity)
      return failure(
        "unprintable-layout",
        `A candidate cut crosses this conductor. ${required(
          continuationIdentityConstraint(semantic),
          "Missing identity constraint",
        )} Use larger paper, landscape, or the other flow so no cut crosses this conductor.`,
        { continuationIdentity: edge.id },
      );
    for (const c of crossings) {
      const id = `C${String(++serial).padStart(3, "0")}`;
      const common = { id, ...identity, netId: edge.netId };
      required(drafts[c.from], "Missing source section").links.push({
        ...common,
        end: 0,
        to: c.to + 1,
        ...c.a,
      });
      required(drafts[c.to], "Missing peer section").links.push({
        ...common,
        end: 1,
        to: c.from + 1,
        ...c.z,
      });
    }
  }
  for (const d of drafts)
    for (let i = 0; i < d.links.length; i++)
      for (const other of d.links.slice(i + 1)) {
        const l = required(d.links[i], "Missing endpoint");
        if (
          l.side === other.side &&
          (l.side === "left" || l.side === "right"
            ? Math.abs(l.y - other.y) < 3
            : Math.abs(l.x - other.x) < 18)
        )
          return failure(
            "unprintable-layout",
            "Continuation labels are too close to print clearly. Change flow, use a larger sheet, or narrow the view.",
          );
      }
  return { ok: true, value: undefined };
}
