export function mergeCollinearSegments(pieces) {
  if (pieces.length <= 1) return pieces;
  const out = [[pieces[0][0], pieces[0][1]]];
  for (let i = 1; i < pieces.length; i++) {
    const [p, q] = pieces[i];
    const last = out[out.length - 1];
    const [a, b] = last;
    if (Math.hypot(p.x - b.x, p.y - b.y) <= 1e-4) {
      const dx1 = b.x - a.x,
        dy1 = b.y - a.y;
      const dx2 = q.x - b.x,
        dy2 = q.y - b.y;
      const len1 = Math.hypot(dx1, dy1),
        len2 = Math.hypot(dx2, dy2);
      const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
      const dot = dx1 * dx2 + dy1 * dy2;
      if (len1 > 0 && len2 > 0 && dot > 0 && cross <= 1e-3 * len1 * len2) {
        last[1] = q;
        continue;
      }
    }
    out.push([p, q]);
  }
  return out;
}

export function solidShapeSegments(e, pt) {
  const tag = e.tagName.toLowerCase();
  if (tag === "line")
    return [
      [
        pt(e.x1.baseVal.value, e.y1.baseVal.value),
        pt(e.x2.baseVal.value, e.y2.baseVal.value),
      ],
    ];
  if (tag === "rect" && !e.rx.baseVal.value && !e.ry.baseVal.value) {
    const x = e.x.baseVal.value,
      y = e.y.baseVal.value,
      w = e.width.baseVal.value,
      h = e.height.baseVal.value;
    if (!(w > 0 && h > 0)) return [];
    const [p1, p2, p3, p4] = [
      pt(x, y),
      pt(x + w, y),
      pt(x + w, y + h),
      pt(x, y + h),
    ];
    return [
      [p1, p2],
      [p2, p3],
      [p3, p4],
      [p4, p1],
    ];
  }
  if (tag === "path") {
    const d = (e.getAttribute("d") ?? "").trim();
    if (/^M\s*[\d.-]+\s+[\d.-]+(?:\s+L\s*[\d.-]+\s+[\d.-]+)+$/u.test(d)) {
      const nums = d.match(/-?\d+(?:\.\d+)?/gu).map(Number);
      const segs = [];
      for (let i = 2; i < nums.length; i += 2)
        segs.push([pt(nums[i - 2], nums[i - 1]), pt(nums[i], nums[i + 1])]);
      return segs;
    }
  }
  return null;
}

export function fastSolidSegments(
  e,
  clip,
  matrix,
  clips,
  strokePainted,
  filled,
  c,
  order,
) {
  if (!strokePainted || filled || clips.length) return null;
  const dash = (getComputedStyle(e).strokeDasharray ?? "").trim().toLowerCase();
  if (dash && dash !== "none") return null;
  const { contains, intersect, occluders, orders, point, bounds, h } = c;
  const b = bounds(e);
  if (
    !contains(clip, { x: b.x, y: b.y }) ||
    !contains(clip, { x: b.x + b.w, y: b.y + b.h })
  )
    return null;
  const myOrder = order ?? orders.get(e);
  if (
    occluders.some(
      (o) =>
        o.hasFill &&
        o.order > myOrder &&
        intersect(o.bbox, b).w > 0 &&
        intersect(o.bbox, b).h > 0,
    )
  )
    return null;
  const pt = (x, y) => {
    const q = new DOMPoint(x, y).matrixTransform(matrix);
    return point(q.x, q.y);
  };
  return h.solidShapeSegments(e, pt);
}

export function circuitStrokeInk(e, clip, matrix, c, order) {
  const { colour, contains, fillPaint, occluders, orders, point, shapeClips } =
    c;
  const { sx, sy, h } = c;
  const strokeInfo = h.strokePaintInfo(e, colour);
  const fill = fillPaint(e);
  const strokePainted =
    strokeInfo.alpha > 0 && strokeInfo.width > 0 && !strokeInfo.background;
  const filled = fill.alpha > 0 && !fill.background;
  const empty = {
    segments: [],
    clips: null,
    clipError: null,
    strokePainted,
    filled,
    strokeInfo,
    fill,
  };
  if (!strokePainted && !filled) return empty;
  let clips;
  try {
    clips = shapeClips(e);
  } catch (err) {
    return { ...empty, clipError: err?.message ?? String(err) };
  }
  if (clips === null) return { ...empty, strokePainted: false, filled: false };
  const fast = h.fastSolidSegments(
    e,
    clip,
    matrix,
    clips,
    strokePainted,
    filled,
    c,
    order,
  );
  if (fast) return { ...empty, segments: fast, clips };
  if (typeof e.getTotalLength !== "function") return { ...empty, clips };
  const length = e.getTotalLength();
  const scale = Math.max(
    Math.hypot(matrix.a * sx, matrix.b * sy),
    Math.hypot(matrix.c * sx, matrix.d * sy),
  );
  const count = Math.min(20000, Math.max(1, Math.ceil((length * scale) / 0.2)));
  const segments = h.strokeIntervals({
    e,
    clip,
    matrix,
    subdivide: true,
    strokePainted,
    filled,
    length,
    count,
    stepMm: (length * scale) / count,
    clips,
    orders,
    order,
    occluders,
    point,
    contains,
    strokeOccluderMode: "none",
    h,
  });
  return { ...empty, segments: h.mergeCollinearSegments(segments), clips };
}
