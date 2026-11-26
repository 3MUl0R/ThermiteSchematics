const DASH_NUM_RE = /^[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?(?:px)?$/i;
const DASH_POS_RE = /^(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?(?:px)?$/i;

export function parseDashPattern(dashRaw, offsetRaw) {
  const raw = typeof dashRaw === "string" ? dashRaw.trim().toLowerCase() : "";
  if (!raw || raw === "none") return null;
  const tokens = raw.split(/[\s,]+/u).filter(Boolean);
  if (!tokens.length || tokens.some((t) => !DASH_POS_RE.test(t))) return null;
  const parts = tokens.map((t) => Number.parseFloat(t));
  if (parts.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const total = parts.reduce((sum, v) => sum + v, 0);
  if (!(total > 0)) return null;
  const seq = parts.length % 2 === 1 ? [...parts, ...parts] : parts;
  if (!seq.some((v, i) => i % 2 === 1 && v > 0)) return null;
  let offset = 0;
  if (typeof offsetRaw === "number") {
    if (!Number.isFinite(offsetRaw)) return null;
    offset = offsetRaw;
  } else if (typeof offsetRaw === "string" && offsetRaw.trim()) {
    const trimmed = offsetRaw.trim();
    if (!DASH_NUM_RE.test(trimmed)) return null;
    offset = Number.parseFloat(trimmed);
    if (!Number.isFinite(offset)) return null;
  }
  const period = seq.reduce((sum, v) => sum + v, 0);
  return { seq, period, offset };
}

function projectPoint(m, x, y) {
  return m
    ? { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
    : { x, y };
}

function parseLinearPathGeometry(d, m) {
  const tokens =
    d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/gu) ?? [];
  const segs = [];
  let i = 0,
    cmd = "",
    x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    u = 0,
    totalMm = 0,
    hasSubpath = false;
  const push = (x0, y0, x1, y1) => {
    const du = Math.hypot(x1 - x0, y1 - y0);
    if (!(du > 1e-9)) return;
    const a = projectPoint(m, x0, y0);
    const b = projectPoint(m, x1, y1);
    const lenMm = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, u0: u, u1: u + du, du, lenMm });
    u += du;
    totalMm += lenMm;
  };
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[a-z]$/iu.test(tokens[i])) cmd = tokens[i++];
    const kind = cmd.toUpperCase();
    const rel = cmd !== kind;
    const ox = x,
      oy = y;
    if (kind === "Z") {
      push(ox, oy, sx, sy);
      x = sx;
      y = sy;
      cmd = "";
    } else if (kind === "M" || kind === "L") {
      if (i + 1 >= tokens.length) return null;
      x = num() + (rel ? ox : 0);
      y = num() + (rel ? oy : 0);
      if (kind === "M") {
        if (hasSubpath) {
          const prev = projectPoint(m, ox, oy);
          const next = projectPoint(m, x, y);
          if (Math.hypot(next.x - prev.x, next.y - prev.y) > 0.05) return null;
        }
        hasSubpath = true;
        sx = x;
        sy = y;
        cmd = rel ? "l" : "L";
      } else push(ox, oy, x, y);
    } else if (kind === "H" || kind === "V") {
      if (i >= tokens.length) return null;
      if (kind === "H") x = num() + (rel ? ox : 0);
      else y = num() + (rel ? oy : 0);
      push(ox, oy, x, y);
    } else return null;
  }
  return segs.length && u > 0 ? { segs, totalLocal: u, totalMm } : null;
}

function pointsPathGeometry(points, m) {
  const segs = [];
  const det = m ? m[0] * m[3] - m[1] * m[2] : 1;
  const inv = Math.abs(det) > 1e-12 && m;
  let u = 0,
    totalMm = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const lenMm = Math.hypot(dx, dy);
    if (!(lenMm > 1e-9)) continue;
    const du = inv
      ? Math.hypot(
          (m[3] * dx - m[2] * dy) / det,
          (-m[1] * dx + m[0] * dy) / det,
        )
      : lenMm;
    segs.push({ a, b, u0: u, u1: u + du, du, lenMm });
    u += du;
    totalMm += lenMm;
  }
  return segs.length && u > 0 ? { segs, totalLocal: u, totalMm } : null;
}

export function routeGeometryForShape(s) {
  const parsed =
    typeof s.routePath === "string"
      ? parseLinearPathGeometry(s.routePath, s.routeMatrix)
      : null;
  const geom =
    parsed ??
    (s.points?.length >= 2
      ? pointsPathGeometry(s.points, s.routeMatrix)
      : null);
  if (!geom) return null;
  const m = s.routeMatrix;
  const scale = m
    ? Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]))
    : geom.totalMm / geom.totalLocal;
  return { ...geom, scale: scale > 0 ? scale : 1 };
}

function clipSegmentToRectRange(a, b, rect) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  let t0 = 0,
    t1 = 1;
  const clip = (p, q) => {
    if (Math.abs(p) <= 1e-12) return q >= -1e-9;
    const r = q / p;
    if (p < 0) {
      if (r > t1 + 1e-9) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0 - 1e-9) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (
    !clip(-dx, a.x - rect.x) ||
    !clip(dx, rect.x + rect.w - a.x) ||
    !clip(-dy, a.y - rect.y) ||
    !clip(dy, rect.y + rect.h - a.y)
  )
    return null;
  return [Math.max(0, Math.min(1, t0)), Math.max(0, Math.min(1, t1))];
}

function clipSegmentToEllipseRange(a, b, cx, cy, rx, ry) {
  if (!(rx > 0 && ry > 0)) return null;
  const ox = (a.x - cx) / rx,
    oy = (a.y - cy) / ry;
  const dx = (b.x - a.x) / rx,
    dy = (b.y - a.y) / ry;
  const A = dx * dx + dy * dy;
  const B = 2 * (ox * dx + oy * dy);
  const C = ox * ox + oy * oy - 1;
  if (A <= 1e-12) return C <= 1e-9 ? [0, 1] : null;
  const disc = B * B - 4 * A * C;
  if (disc < -1e-9) return null;
  const root = Math.sqrt(Math.max(0, disc));
  const lo = Math.max(0, (-B - root) / (2 * A));
  const hi = Math.min(1, (-B + root) / (2 * A));
  return lo <= hi + 1e-9 ? [lo, Math.max(lo, hi)] : null;
}

export function markerExitLocal(geom, mark, fromEnd) {
  let walked = 0,
    exitDist = 0;
  const list = fromEnd ? [...geom.segs].reverse() : geom.segs;
  for (const seg of list) {
    const a = fromEnd ? seg.b : seg.a;
    const b = fromEnd ? seg.a : seg.b;
    const range = clipSegmentToRectRange(a, b, mark);
    if (!range || range[0] > 1e-6) break;
    exitDist = walked + range[1] * seg.du;
    if (range[1] < 1 - 1e-6) break;
    walked += seg.du;
  }
  const u = fromEnd ? geom.totalLocal - exitDist : exitDist;
  return Math.max(0, Math.min(geom.totalLocal, u));
}

export function markerExitLocalCircle(geom, marker, fromEnd) {
  const cx = marker.point.x,
    cy = marker.point.y;
  const rx = marker.bbox.w / 2,
    ry = marker.bbox.h / 2;
  let walked = 0,
    exitDist = 0;
  const list = fromEnd ? [...geom.segs].reverse() : geom.segs;
  for (const seg of list) {
    const a = fromEnd ? seg.b : seg.a;
    const b = fromEnd ? seg.a : seg.b;
    const range = clipSegmentToEllipseRange(a, b, cx, cy, rx, ry);
    if (!range || range[0] > 1e-6) break;
    exitDist = walked + range[1] * seg.du;
    if (range[1] < 1 - 1e-6) break;
    walked += seg.du;
  }
  const u = fromEnd ? geom.totalLocal - exitDist : exitDist;
  return Math.max(0, Math.min(geom.totalLocal, u));
}

export function pointAtLocal(geom, u) {
  if (u <= 0) return geom.segs[0].a;
  if (u >= geom.totalLocal) return geom.segs.at(-1).b;
  for (const seg of geom.segs) {
    if (u <= seg.u1 + 1e-9) {
      const f =
        seg.du > 0 ? Math.max(0, Math.min(1, (u - seg.u0) / seg.du)) : 0;
      return {
        x: seg.a.x + (seg.b.x - seg.a.x) * f,
        y: seg.a.y + (seg.b.y - seg.a.y) * f,
      };
    }
  }
  return geom.segs.at(-1).b;
}

function mergeIntervals(raw) {
  if (!raw.length) return [];
  raw.sort((a, b) => a[0] - b[0]);
  const out = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const last = out.at(-1);
    if (raw[i][0] <= last[1] + 1e-6) last[1] = Math.max(last[1], raw[i][1]);
    else out.push(raw[i]);
  }
  return out;
}

export function predictedDashStarts(geom, pattern, capLocal, uExit, fromEnd) {
  const L = geom.totalLocal;
  const { seq, period, offset } = pattern;
  const loBound = fromEnd ? 0 : uExit;
  const hiBound = fromEnd ? uExit : L;
  if (!(hiBound > loBound + 1e-6)) return [];
  const k0 = Math.floor((uExit + offset) / period);
  const kStart = fromEnd ? k0 - 2 : k0 - 1;
  const kEnd = fromEnd ? k0 + 1 : k0 + 2;
  const raw = [];
  for (let k = kStart; k <= kEnd; k++) {
    let pos = k * period - offset;
    for (let i = 0; i < seq.length; i += 2) {
      const d0 = pos,
        d1 = pos + seq[i];
      pos = d1 + seq[i + 1];
      const c0 = Math.max(0, d0),
        c1 = Math.min(L, d1);
      if (c1 < c0 || (c1 === c0 && !(capLocal > 0))) continue;
      const e0 = Math.max(loBound, Math.max(0, c0 - capLocal));
      const e1 = Math.min(hiBound, Math.min(L, c1 + capLocal));
      if (e1 > e0 + 1e-6) raw.push([e0, e1]);
    }
  }
  const merged = mergeIntervals(raw);
  if (!merged.length) return [];
  const ordered = fromEnd ? merged.reverse() : merged;
  const first = ordered[0];
  const starts = [fromEnd ? first[1] : first[0]];
  const count = Math.min(20000, Math.max(1, Math.ceil(geom.totalMm / 0.2)));
  const stepMm = geom.totalMm / count;
  const minLocal = (2 * stepMm + 0.02) / geom.scale;
  const touchesExit = fromEnd
    ? Math.abs(first[1] - uExit) <= 1e-6
    : Math.abs(first[0] - uExit) <= 1e-6;
  if (touchesExit && first[1] - first[0] <= minLocal && ordered.length > 1)
    starts.push(fromEnd ? ordered[1][1] : ordered[1][0]);
  return starts;
}

export function runGapToPoint(a, b, strokeWidth, pt) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 > 1e-12
      ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2))
      : 0;
  const d = Math.hypot(pt.x - (a.x + dx * t), pt.y - (a.y + dy * t));
  const half = strokeWidth > 0 ? strokeWidth / 2 : 0;
  return len2 > 1e-12 && t > 0 && t < 1 ? Math.max(0, d - half) : d;
}
