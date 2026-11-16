import type { CircuitLabelState } from "./layout-routes.js";
type Segment = CircuitLabelState["segments"][number];
const EPSILON = 1e-7;
function covered(segment: Segment, foreign: readonly Segment[]) {
  const { a, b } = segment,
    vertical = Math.abs(a.x - b.x) < EPSILON,
    axis = vertical ? "y" : "x",
    fixed = vertical ? "x" : "y",
    low = Math.min(a[axis], b[axis]),
    high = Math.max(a[axis], b[axis]);
  if (
    ![a.x, a.y, b.x, b.y].every(Number.isFinite) ||
    Math.abs(a[fixed] - b[fixed]) >= EPSILON ||
    high - low <= EPSILON
  )
    return false;
  const intervals = foreign
    .filter(
      (s) =>
        [s.a.x, s.a.y, s.b.x, s.b.y].every(Number.isFinite) &&
        Math.abs(s.a[fixed] - a[fixed]) < EPSILON &&
        Math.abs(s.b[fixed] - a[fixed]) < EPSILON,
    )
    .map((s) => ({
      low: Math.max(low, Math.min(s.a[axis], s.b[axis])),
      high: Math.min(high, Math.max(s.a[axis], s.b[axis])),
    }))
    .filter((s) => s.high > s.low)
    .sort((s, t) => s.low - t.low);
  let end = low;
  for (const span of intervals) {
    if (span.low > end + EPSILON) return false;
    end = Math.max(end, span.high);
    if (end >= high - EPSILON) return true;
  }
  return false;
}
/** #359: native separation of coincident circuit routes is deferred. Preserve
 * base captions only when every owner segment is covered by foreign collinear
 * segments. Net membership grants no exemption; partial coverage fails closed. */
export function fullyCoincidentCaption(
  index: number,
  segments: readonly Segment[],
) {
  const own = segments.filter((s) => s.index === index),
    foreign = segments.filter((s) => s.index !== index);
  return own.length > 0 && own.every((s) => covered(s, foreign));
}
