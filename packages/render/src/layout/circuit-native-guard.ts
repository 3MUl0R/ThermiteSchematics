import { required } from "../presentation/util.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";

type Point = { x: number; y: number };
const near = (a: number | undefined, b: number | undefined) =>
  Number.isFinite(a) &&
  Number.isFinite(b) &&
  Math.abs(
    required(a, "Missing native circuit geometry") -
      required(b, "Missing native circuit geometry"),
  ) < 1e-7;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const ids = (a: readonly { id: string }[]) => a.map((n) => n.id).sort();

/** Check the original fixed local geometry, ordered ports and endpoint ownership.
 * Compound/phase order is never an optimisation variable in the circuit slice. */
export function circuitNativeGuard(graph: ElkNode, input: ElkNode) {
  if (
    !same(ids(graph.children ?? []), ids(input.children ?? [])) ||
    !same(ids(graph.edges ?? []), ids(input.edges ?? []))
  )
    return false;
  const ports = new Map<string, Point>();
  for (const node of graph.children ?? []) {
    const source = required(
      (input.children ?? []).find((n) => n.id === node.id),
      "Missing native circuit geometry",
    );
    if (
      !near(node.width, source.width) ||
      !near(node.height, source.height) ||
      !same(ids(node.ports ?? []), ids(source.ports ?? []))
    )
      return false;
    for (const p of node.ports ?? []) {
      const fixed = required(
        (source.ports ?? []).find((f) => f.id === p.id),
        "Missing native circuit geometry",
      );
      if (
        !near(p.x, fixed.x) ||
        !near(p.y, fixed.y) ||
        !same(p.layoutOptions, fixed.layoutOptions)
      )
        return false;
      ports.set(p.id, {
        x:
          required(node.x, "Missing native circuit geometry") +
          required(p.x, "Missing native circuit geometry"),
        y:
          required(node.y, "Missing native circuit geometry") +
          required(p.y, "Missing native circuit geometry"),
      });
    }
  }
  return (graph.edges ?? []).every((e) => validEdge(e, input, ports));
}

function validEdge(
  e: NonNullable<ElkNode["edges"]>[number],
  input: ElkNode,
  ports: ReadonlyMap<string, Point>,
) {
  const source = required(
    (input.edges ?? []).find((s) => s.id === e.id),
    "Missing native circuit geometry",
  );
  if (
    !same(e.sources, source.sources) ||
    !same(e.targets, source.targets) ||
    e.sections?.length !== 1
  )
    return false;
  const section = required(e.sections[0], "Missing native circuit geometry");
  const a = ports.get(
      required(e.sources[0], "Missing native circuit geometry"),
    ),
    b = ports.get(required(e.targets[0], "Missing native circuit geometry"));
  if (
    !a ||
    !b ||
    !near(a.x, section.startPoint.x) ||
    !near(a.y, section.startPoint.y) ||
    !near(b.x, section.endPoint.x) ||
    !near(b.y, section.endPoint.y)
  )
    return false;
  const points = [
    section.startPoint,
    ...(section.bendPoints ?? []),
    section.endPoint,
  ];
  return points
    .slice(1)
    .every(
      (p, i) =>
        near(p.x, required(points[i], "Missing native circuit geometry").x) ||
        near(p.y, required(points[i], "Missing native circuit geometry").y),
    );
}

function intersections(graph: ElkNode) {
  const edges = graph.edges ?? [],
    result = new Map<string, number>();
  const segments = edges.flatMap((e) =>
    (e.sections ?? []).flatMap((s) => {
      const p = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      return p.slice(1).map((b, i) => ({
        id: e.id,
        a: required(p[i], "Missing native circuit geometry"),
        b,
      }));
    }),
  );
  for (const [i, s] of segments.entries())
    for (const t of segments.slice(i + 1)) {
      if (s.id === t.id) continue;
      const lowX = Math.max(Math.min(s.a.x, s.b.x), Math.min(t.a.x, t.b.x));
      const highX = Math.min(Math.max(s.a.x, s.b.x), Math.max(t.a.x, t.b.x));
      const lowY = Math.max(Math.min(s.a.y, s.b.y), Math.min(t.a.y, t.b.y));
      const highY = Math.min(Math.max(s.a.y, s.b.y), Math.max(t.a.y, t.b.y));
      if (lowX > highX + 1e-7 || lowY > highY + 1e-7) continue;
      const kind =
        highX - lowX > 1e-7 || highY - lowY > 1e-7 ? "overlap" : "touch";
      const key = JSON.stringify([[s.id, t.id].sort(), kind]);
      result.set(key, (result.get(key) ?? 0) + 1);
    }
  return result;
}
/** A new crossing, false junction or merged landing cannot buy a label repair. */
export function circuitCrossingGuard(candidate: ElkNode, original: ElkNode) {
  const before = intersections(original);
  return [...intersections(candidate)].every(
    ([id, n]) => n <= (before.get(id) ?? 0),
  );
}

export function circuitLabelGuard(graph: ElkNode, input: ElkNode) {
  const inventory = (g: ElkNode) =>
    (g.edges ?? [])
      .map((e) => [e.id, (e.labels ?? []).map(({ x, y, ...label }) => label)])
      .sort((a, b) =>
        String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0,
      );
  return JSON.stringify(inventory(graph)) === JSON.stringify(inventory(input));
}
export function circuitNodeClearanceGuard(graph: ElkNode) {
  return (graph.edges ?? []).every((e) =>
    (e.sections ?? []).every((s) => {
      const points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      return points.slice(1).every((b, i) => {
        const a = required(points[i], "Missing native circuit geometry");
        if (Math.hypot(a.x - b.x, a.y - b.y) <= 1e-7) return true;
        return (graph.children ?? []).every((n) => {
          const x0 = required(n.x, "Missing node x"),
            y0 = required(n.y, "Missing node y");
          const x1 = x0 + required(n.width, "Missing node width"),
            y1 = y0 + required(n.height, "Missing node height");
          return (
            !(
              near(a.x, b.x) &&
              a.x >= x0 - 1e-4 &&
              a.x <= x1 + 1e-4 &&
              Math.max(a.y, b.y) > y0 + 1e-4 &&
              Math.min(a.y, b.y) < y1 - 1e-4
            ) &&
            !(
              near(a.y, b.y) &&
              a.y >= y0 - 1e-4 &&
              a.y <= y1 + 1e-4 &&
              Math.max(a.x, b.x) > x0 + 1e-4 &&
              Math.min(a.x, b.x) < x1 - 1e-4
            )
          );
        });
      });
    }),
  );
}
