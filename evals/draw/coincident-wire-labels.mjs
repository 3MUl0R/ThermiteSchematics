import { routePoints, wirePlacement } from "./checks.mjs";
import { finding, groupBy, painted } from "./review-geometry.mjs";

const EPSILON = 1e-7;

function covered([a, b], foreign) {
  const length = Math.hypot(b.x - a.x, b.y - a.y),
    dx = (b.x - a.x) / length,
    dy = (b.y - a.y) / length,
    distance = (p) => Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx),
    project = (p) => (p.x - a.x) * dx + (p.y - a.y) * dy,
    intervals = foreign
      .filter(([p, q]) => distance(p) <= EPSILON && distance(q) <= EPSILON)
      .map(([p, q]) => [project(p), project(q)].sort((x, y) => x - y))
      .sort(([x], [y]) => x - y);
  let end = 0;
  for (const [lo, hi] of intervals) {
    if (lo > end + EPSILON) return false;
    end = Math.max(end, hi);
    if (end >= length - EPSILON) return true;
  }
  return false;
}

function segments(shape) {
  const points = routePoints(shape) ?? [];
  return points
    .slice(1)
    .map((p, i) => [points[i], p])
    .filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) > EPSILON);
}

const scope = (item) =>
  item.circuitGroup
    ? JSON.stringify([item.appearanceScope, item.circuitGroup])
    : undefined;

/** Use the issued centreline, including inline interruptions by the label's
 * own plate. The SVG conductor identity binds the measurement; net IDs and
 * caption distance cannot exempt a fully covered path. */
export function coincidentWireLabels(g) {
  const groups = groupBy(
    g.shapes.filter((s) => s.conductor && s.wire && painted(s) && s.stroke > 0),
    scope,
  );
  const labels = groupBy(
    g.texts.filter((t) => scope(t) && t.wire && painted(t)),
    (t) => JSON.stringify([scope(t), t.wire]),
  );
  return [...labels.values()].flatMap(([label]) => {
    const paths = groups.get(scope(label)) ?? [],
      own = paths.filter((r) => r.wire === label.wire).flatMap(segments),
      foreign = paths.filter((r) => r.wire !== label.wire).flatMap(segments);
    return own.length && own.every((s) => covered(s, foreign))
      ? [
          finding("fully-coincident-wire-label", label, {
            wire: label.wire,
            text: label.text,
          }),
        ]
      : [];
  });
}

export function wireCaptionFindings(g, sourceFindings) {
  return [...wirePlacement(g), ...coincidentWireLabels(g), ...sourceFindings];
}
