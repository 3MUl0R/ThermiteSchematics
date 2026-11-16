import { captionAssociation } from "./beside-caption.js";
import { captionPlacementDiagnostic } from "./caption-diagnostic.js";
import { CircuitRenderError } from "../render-error-context.js";
import { routeSegments } from "./ink-geometry.js";
import type { ElkNode, ElkLabel } from "elkjs/lib/elk-api.js";
import { required } from "../presentation/util.js";
import {
  horizontalLabelSupport,
  ownedLabelLeader,
  type LabelInkBox,
} from "./wire-label-support.js";

type Point = { x: number; y: number };
function box(label: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): LabelInkBox {
  const x = required(label.x, "Unplaced wiring label"),
    y = required(label.y, "Unplaced wiring label");
  return {
    left: x,
    right: x + required(label.width, "Missing wiring label width"),
    top: y,
    bottom: y + required(label.height, "Missing wiring label height"),
  };
}
function overlaps(a: LabelInkBox, b: LabelInkBox) {
  return (
    a.left < b.right - 0.01 &&
    a.right > b.left + 0.01 &&
    a.top < b.bottom - 0.01 &&
    a.bottom > b.top + 0.01
  );
}
function paths(graph: ElkNode) {
  return (graph.edges ?? []).map((e) => ({
    id: e.id,
    labels: e.labels ?? [],
    routes: (e.sections ?? []).map((s) => [
      s.startPoint,
      ...(s.bendPoints ?? []),
      s.endPoint,
    ]),
  }));
}
function free(
  label: ElkLabel,
  own: string,
  graph: ElkNode,
  edges: ReturnType<typeof paths>,
) {
  const area = box(label);
  if (
    area.left < 0 ||
    area.top < 0 ||
    area.right > required(graph.width, "Missing wiring width") ||
    area.bottom > required(graph.height, "Missing wiring height")
  )
    return false;
  if ((graph.children ?? []).some((n) => overlaps(area, box(n)))) return false;
  return !edges.some(
    (e) =>
      e.labels.some((l) => l !== label && overlaps(area, box(l))) ||
      (e.id !== own &&
        e.routes.some((r) =>
          routeSegments(r).some(({ a, b }) => {
            return overlaps(area, {
              left: Math.min(a.x, b.x),
              right: Math.max(a.x, b.x),
              top: Math.min(a.y, b.y),
              bottom: Math.max(a.y, b.y),
            });
          }),
        )),
  );
}
function positions(label: ElkLabel, routes: readonly (readonly Point[])[]) {
  const width = required(label.width, "Missing label width"),
    height = required(label.height, "Missing label height");
  const segments = routes
    .flatMap((r) => routeSegments(r))
    .filter(
      (s) => Math.abs(s.a.y - s.b.y) < 1e-7 && Math.abs(s.a.x - s.b.x) >= width,
    )
    .sort((s, t) => Math.abs(t.a.x - t.b.x) - Math.abs(s.a.x - s.b.x));
  return segments.flatMap(({ a, b }) => {
    const left = Math.min(a.x, b.x),
      right = Math.max(a.x, b.x);
    const x = Math.max(
      left,
      Math.min(right - width, required(label.x, "Unplaced label")),
    );
    // Inline blocks keep both caption rows close to their conductor. Try the
    // ends first so adjacent runs can carry separate, staggered plates.
    return [
      ...new Set([left, right - width, x, (left + right - width) / 2]),
    ].map((x) => ({ x, y: a.y - height / 2 }));
  });
}

/** Use the longest free owned straight run without changing native paths,
 * bounds, font, label dimensions or physical identities. Keep legal old plates. */
export function ownedWiringLabels(
  graph: ElkNode,
  keep?: (edgeId: string, label: Readonly<ElkLabel>) => boolean,
) {
  const copy = structuredClone(graph),
    edges = paths(copy);
  for (const edge of edges)
    for (const label of edge.labels) {
      const foreign = edges
        .filter((e) => e.id !== edge.id)
        .flatMap((e) => e.routes);
      if (
        keep?.(edge.id, label) ||
        horizontalLabelSupport(box(label), edge.routes, 2, foreign)
      )
        continue;
      const original = { x: label.x, y: label.y };
      for (const p of positions(label, edge.routes)) {
        Object.assign(label, p);
        if (
          free(label, edge.id, copy, edges) &&
          horizontalLabelSupport(box(label), edge.routes, 2, foreign)
        )
          break;
        Object.assign(label, original);
      }
    }
  return copy;
}

export function wiringLabelLeaders(graph: ElkNode) {
  const edges = paths(graph);
  return edges.flatMap((edge) =>
    edge.labels.flatMap((label) => {
      const own = edge.routes,
        foreign = edges
          .filter((e) => e.id !== edge.id)
          .flatMap((e) => e.routes),
        ink = box(label);
      if (horizontalLabelSupport(ink, own, 2, foreign)) return [];
      const association = captionAssociation(ink, own, foreign, 0.35, 2);
      if (
        association.owner > 0 &&
        association.foreign > 0 &&
        !association.needsLeader
      )
        return [];
      const points = ownedLabelLeader(
        ink,
        ink,
        own,
        {
          foreign,
          obstacles: [
            ...(graph.children ?? []).map(box),
            ...edges.flatMap((e) =>
              e.labels.filter((l) => l !== label).map(box),
            ),
          ],
          strokeClearance: 0.25,
          bounds: {
            left: 0,
            top: 0,
            right: required(graph.width, "Missing wiring width"),
            bottom: required(graph.height, "Missing wiring height"),
          },
        },
        2,
        0.25,
      );
      if (!points)
        throw new CircuitRenderError(
          captionPlacementDiagnostic(
            label.text ?? "",
            edge.id,
            edge.id,
            "control",
          ),
        );
      return [{ edgeId: edge.id, points }];
    }),
  );
}
