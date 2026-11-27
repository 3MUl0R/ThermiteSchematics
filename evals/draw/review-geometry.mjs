// Small geometry helpers shared by independent drawing-review predicates.
export const pointDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = ([a, b]) => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});
export const extent = (points) => {
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};
export const finding = (kind, item = {}, evidence = {}) => ({
  kind,
  element: item.element ?? "sheet",
  designation: item.designation ?? item.text ?? item.deviceUid ?? "sheet",
  ...(item.bbox ? { bbox: item.bbox } : { sheetLevel: true }),
  ...evidence,
});
export const painted = (t) => t.reviewPainted !== false && t.painted !== false;
export const segment = (s) =>
  s.points?.length >= 2 ? [s.points[0], s.points.at(-1)] : null;
const cross = (a, b, c) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
export function crosses(a, b) {
  return (
    cross(...a, b[0]) * cross(...a, b[1]) <= 1e-8 &&
    cross(...b, a[0]) * cross(...b, a[1]) <= 1e-8 &&
    Math.max(Math.min(a[0].x, a[1].x), Math.min(b[0].x, b[1].x)) <=
      Math.min(Math.max(a[0].x, a[1].x), Math.max(b[0].x, b[1].x)) + 0.01 &&
    Math.max(Math.min(a[0].y, a[1].y), Math.min(b[0].y, b[1].y)) <=
      Math.min(Math.max(a[0].y, a[1].y), Math.max(b[0].y, b[1].y)) + 0.01
  );
}
export function mergedIntervals(intervals) {
  const result = [];
  for (const [a, b] of intervals.slice().sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && a <= last[1] + 0.05) last[1] = Math.max(last[1], b);
    else result.push([a, b]);
  }
  return result;
}
export function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}
export function segmentPointDistance(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    l = dx * dx + dy * dy,
    t = l
      ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l))
      : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function segmentHitsBox(a, b, box) {
  let lo = 0,
    hi = 1;
  const dx = b.x - a.x,
    dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - box.x],
    [dx, box.x + box.w - a.x],
    [-dy, a.y - box.y],
    [dy, box.y + box.h - a.y],
  ]) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) lo = Math.max(lo, r);
      else hi = Math.min(hi, r);
    }
  }
  return lo <= hi;
}
export function boxToPolylineDistance(box, points, stroke = 0) {
  if (!points || points.length < 2) return Infinity;
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x, y: box.y + box.h },
    { x: box.x + box.w, y: box.y + box.h },
  ];
  const toBox = (p) =>
    Math.hypot(
      Math.max(box.x - p.x, 0, p.x - box.x - box.w),
      Math.max(box.y - p.y, 0, p.y - box.y - box.h),
    );
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (segmentHitsBox(a, b, box) || toBox(a) === 0 || toBox(b) === 0) return 0;
    best = Math.min(
      best,
      toBox(a),
      toBox(b),
      ...corners.map((c) => segmentPointDistance(c, a, b)),
    );
  }
  return Math.max(0, best - stroke / 2);
}
