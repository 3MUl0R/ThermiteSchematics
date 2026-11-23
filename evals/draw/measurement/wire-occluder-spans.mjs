// Browser-only painted fill coverage along straight conductor runs for DQ-16 (#529).
export function wirePlateRoutePoints(s) {
  if (!s.routePath) return s.points;
  const tokens = s.routePath.match(
    /[MLHVmlhv]|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gu,
  );
  if (!tokens) return null;
  const pts = [];
  let i = 0,
    cmd = "",
    x = 0,
    y = 0;
  while (i < tokens.length) {
    if (/^[MLHVmlhv]$/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === "M" || cmd === "L" || cmd === "m" || cmd === "l") {
      const nx = Number(tokens[i++]),
        ny = Number(tokens[i++]);
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
      x = cmd === "m" || cmd === "l" ? x + nx : nx;
      y = cmd === "m" || cmd === "l" ? y + ny : ny;
      pts.push({ x, y });
      if (cmd === "M") cmd = "L";
      else if (cmd === "m") cmd = "l";
    } else if (cmd === "H" || cmd === "h" || cmd === "V" || cmd === "v") {
      const n = Number(tokens[i++]);
      if (!Number.isFinite(n)) return null;
      if (cmd === "H") x = n;
      else if (cmd === "h") x += n;
      else if (cmd === "V") y = n;
      else y += n;
      pts.push({ x, y });
    } else return null;
  }
  const [a, b, mC, d, mE, f] = s.routeMatrix ?? [1, 0, 0, 1, 0, 0];
  return pts.map((p) => ({
    x: a * p.x + mC * p.y + mE,
    y: b * p.x + d * p.y + f,
  }));
}

export function wirePlateSegmentSpans(horizontal, across, lo, hi, coveredAt) {
  const refine = (a, b, insideA) => {
    let l = a,
      r = b;
    for (let i = 0; i < 6; i++) {
      const mid = (l + r) / 2;
      if (coveredAt(horizontal, across, mid) === insideA) l = mid;
      else r = mid;
    }
    return (l + r) / 2;
  };
  const list = [];
  const steps = Math.max(2, Math.ceil((hi - lo) / 0.1));
  const dt = (hi - lo) / steps;
  let prevT = lo,
    prevIn = coveredAt(horizontal, across, lo),
    start = prevIn ? lo : null;
  for (let k = 1; k <= steps; k++) {
    const curT = k === steps ? hi : lo + k * dt;
    const curIn = coveredAt(horizontal, across, curT);
    if (!prevIn && curIn) start = refine(prevT, curT, false);
    else if (prevIn && !curIn && start !== null) {
      const end = refine(prevT, curT, true);
      if (end > start + 1e-5)
        list.push({ horizontal, across, lo: start, hi: end });
      start = null;
    }
    prevT = curT;
    prevIn = curIn;
  }
  if (prevIn && start !== null && hi > start + 1e-5)
    list.push({ horizontal, across, lo: start, hi });
  return list;
}

export function wirePlateOccluderSpans(c, e, paint, conductorShapes, strokes) {
  if (typeof e.isPointInFill !== "function") return undefined;
  let inv;
  try {
    inv = e.getScreenCTM()?.inverse();
  } catch {
    return undefined;
  }
  if (!inv) return undefined;
  const clip = paint.clip ?? paint.bbox;
  const pointIn = (xMm, yMm) => {
    if (
      xMm < clip.x ||
      xMm > clip.x + clip.w ||
      yMm < clip.y ||
      yMm > clip.y + clip.h
    )
      return false;
    const sx = c.rr.left + xMm / c.sx,
      sy = c.rr.top + yMm / c.sy;
    return e.isPointInFill(
      new DOMPoint(
        inv.a * sx + inv.c * sy + inv.e,
        inv.b * sx + inv.d * sy + inv.f,
      ),
    );
  };
  const spans = {};
  for (const s of conductorShapes) {
    const half = (s.stroke ?? 0) / 2;
    const pts = c.h.wirePlateRoutePoints(s);
    if (
      paint.order <= (strokes[s.element]?.order ?? Infinity) ||
      !s.bbox ||
      half <= 0 ||
      !pts?.length ||
      paint.bbox.x >= s.bbox.x + s.bbox.w + half ||
      paint.bbox.x + paint.bbox.w <= s.bbox.x - half ||
      paint.bbox.y >= s.bbox.y + s.bbox.h + half ||
      paint.bbox.y + paint.bbox.h <= s.bbox.y - half
    )
      continue;
    const eps = Math.min(0.02, half * 0.25);
    const coveredAt = (h, across, t) =>
      [-half + eps, 0, half - eps].every((d) =>
        pointIn(h ? t : across + d, h ? across + d : t),
      );
    const list = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1],
        b = pts[i];
      const h = Math.abs(a.y - b.y) <= 0.01,
        v = Math.abs(a.x - b.x) <= 0.01;
      if (!h && !v) continue;
      const across = h ? a.y : a.x;
      const pLo = h ? paint.bbox.x : paint.bbox.y,
        pHi = h ? paint.bbox.x + paint.bbox.w : paint.bbox.y + paint.bbox.h;
      const lo = Math.max(Math.min(h ? a.x : a.y, h ? b.x : b.y), pLo);
      const hi = Math.min(Math.max(h ? a.x : a.y, h ? b.x : b.y), pHi);
      if (hi > lo + 1e-5)
        list.push(...c.h.wirePlateSegmentSpans(h, across, lo, hi, coveredAt));
    }
    if (list.length) spans[s.element] = list;
  }
  return spans;
}
