// Browser-only exact final-painted-footprint contact probes for physical landings.
// Measures surviving painted ink directly through Chromium hit tests and full
// fill+stroke occlusion, with zero centreline re-inflation.

export function paintedFootprintState(c, e) {
  const v = c.visible(e);
  if (!v) return null;
  const fill = c.fillPaint(e);
  const stroke = c.h.strokePaintInfo(e, c.colour);
  const filled = fill.alpha >= 0.2 && !fill.background;
  const strokePainted =
    stroke.alpha >= 0.2 && stroke.width > 0 && !stroke.background;
  if (!filled && !strokePainted) return null;
  let clips;
  try {
    clips = c.shapeClips(e);
  } catch {
    return null;
  }
  if (clips === null) return null;
  const m = e.getScreenCTM();
  let inverse;
  try {
    inverse = m.inverse();
  } catch {
    return null;
  }
  const scale = Math.max(
    Math.hypot(m.a * c.sx, m.b * c.sy),
    Math.hypot(m.c * c.sx, m.d * c.sy),
  );
  if (!(scale > 0)) return null;
  const strokeMm = strokePainted ? stroke.width * scale : 0;
  const pad = strokePainted ? strokeMm * 2 : 0;
  const bbox =
    pad > 0
      ? {
          x: v.b.x - pad,
          y: v.b.y - pad,
          w: v.b.w + 2 * pad,
          h: v.b.h + 2 * pad,
        }
      : v.b;
  const order = c.orders.get(e);
  const covers = c.occluders.filter(
    (o) =>
      o.order > order &&
      c.intersect(o.bbox, bbox).w >= 0 &&
      c.intersect(o.bbox, bbox).h >= 0,
  );
  return {
    e,
    m,
    inverse,
    scale,
    strokeMm,
    bbox,
    clips: [v.clip, ...clips],
    filled,
    strokePainted,
    circle: c.h.exactCircleSpec(e, stroke.width),
    order,
    covers,
  };
}

export function footprintPaintedAt(c, st, p) {
  if (!c.contains(st.bbox, p) || !st.clips.every((b) => c.contains(b, p)))
    return false;
  const q = new DOMPoint(c.rr.x + p.x / c.sx, c.rr.y + p.y / c.sy);
  const loc = q.matrixTransform(st.inverse);
  let hit;
  if (st.circle) {
    const d = Math.hypot(loc.x - st.circle.cx, loc.y - st.circle.cy);
    hit =
      (st.strokePainted && Math.abs(d - st.circle.r) <= st.circle.sw / 2) ||
      (st.filled && d <= st.circle.r);
  } else {
    hit =
      (st.strokePainted && st.e.isPointInStroke(loc)) ||
      (st.filled && st.e.isPointInFill(loc));
  }
  if (!hit) return false;
  for (const o of st.covers) {
    if (c.h.occluderHit(o, p, q, c.contains)) return false;
  }
  return true;
}

export function footprintNear(c, targetSt, p, tol) {
  const b = targetSt.bbox;
  if (
    p.x < b.x - tol ||
    p.x > b.x + b.w + tol ||
    p.y < b.y - tol ||
    p.y > b.y + b.h + tol
  )
    return false;
  if (c.h.footprintPaintedAt(c, targetSt, p)) return true;
  const half = tol * 0.5;
  const diag = tol * 0.7071067811865476;
  const probes = [
    [tol, 0],
    [-tol, 0],
    [0, tol],
    [0, -tol],
    [diag, diag],
    [diag, -diag],
    [-diag, diag],
    [-diag, -diag],
    [half, 0],
    [-half, 0],
    [0, half],
    [0, -half],
  ];
  for (const [dx, dy] of probes) {
    if (c.h.footprintPaintedAt(c, targetSt, { x: p.x + dx, y: p.y + dy }))
      return true;
  }
  return false;
}

export function footprintStrokeFrameAt(c, st, u, totalLen) {
  const q0 = st.e.getPointAtLength(u).matrixTransform(st.m);
  const p = c.point(q0.x, q0.y);
  const d = Math.min(totalLen * 0.01, 0.005 / st.scale, 1e-3);
  const qA = st.e.getPointAtLength(Math.max(0, u - d)).matrixTransform(st.m);
  const qB = st.e
    .getPointAtLength(Math.min(totalLen, u + d))
    .matrixTransform(st.m);
  const a = c.point(qA.x, qA.y);
  const b = c.point(qB.x, qB.y);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const tx = len > 1e-9 ? (b.x - a.x) / len : 1;
  const ty = len > 1e-9 ? (b.y - a.y) / len : 0;
  return { p, tx, ty, nx: -ty, ny: tx };
}

export function footprintPointOutsideMarker(p, m) {
  const dx = p.x - m.point.x;
  const dy = p.y - m.point.y;
  const rx = m.bbox.w / 2;
  const ry = m.bbox.h / 2;
  const dist = Math.hypot(dx, dy);
  if (!(rx > 0 && ry > 0)) return true;
  const rDir =
    dist <= 1e-9 ? Math.min(rx, ry) : dist / Math.hypot(dx / rx, dy / ry);
  const sw = m.stroke > 0 ? m.stroke : 0;
  return dist > rDir + sw / 2 + 0.05;
}

export function footprintTrackOffsets(strokeMm) {
  const half = strokeMm / 2;
  if (!(half > 0)) return [0];
  const edge = Math.max(0, half - Math.min(0.001, half * 0.1));
  return [0, -edge, edge, -half * 0.5, half * 0.5];
}

export function footprintSampleAxis(st, u0, u1, denseStepMm, sparseStepMm) {
  const lo = Math.min(u0, u1);
  const hi = Math.max(u0, u1);
  const spanMm = (hi - lo) * st.scale;
  const epsLocal = Math.min((hi - lo) * 0.25, 0.0005 / st.scale);
  const out = [lo, hi];
  if (epsLocal > 0) out.push(lo + epsLocal, hi - epsLocal);
  const stepMm = spanMm <= 3.2 ? denseStepMm : sparseStepMm;
  const n = Math.min(600, Math.max(1, Math.ceil(spanMm / stepMm)));
  for (let i = 1; i < n; i++) out.push(lo + ((hi - lo) * i) / n);
  if (spanMm > 3.2) {
    const endSpan = Math.min(hi - lo, 1.5 / st.scale);
    const endSteps = Math.max(1, Math.ceil((endSpan * st.scale) / denseStepMm));
    for (let i = 1; i < endSteps; i++) {
      out.push(lo + (endSpan * i) / endSteps);
      out.push(hi - (endSpan * i) / endSteps);
    }
  }
  out.sort((a, b) => a - b);
  return u0 <= u1 ? out : out.reverse();
}

export function footprintRefineEdge(c, st, uPainted, uUnpainted, v, totalLen) {
  let a = uPainted;
  let b = uUnpainted;
  for (let i = 0; i < 8; i++) {
    const mid = (a + b) / 2;
    const f = c.h.footprintStrokeFrameAt(c, st, mid, totalLen);
    const pt = { x: f.p.x + f.nx * v, y: f.p.y + f.ny * v };
    if (c.h.footprintPaintedAt(c, st, pt)) a = mid;
    else b = mid;
  }
  const f = c.h.footprintStrokeFrameAt(c, st, a, totalLen);
  return { x: f.p.x + f.nx * v, y: f.p.y + f.ny * v };
}

export function footprintWalkTrack(c, st, us, v, totalLen, onPoint) {
  let prevPainted = false;
  let prevU = us[0];
  let acc = onPoint(null, null, "reset");
  for (const u of us) {
    const f = c.h.footprintStrokeFrameAt(c, st, u, totalLen);
    const pt = { x: f.p.x + f.nx * v, y: f.p.y + f.ny * v };
    const painted = c.h.footprintPaintedAt(c, st, pt);
    if (painted && !prevPainted) {
      acc = onPoint(null, null, "reset");
      if (u !== us[0]) {
        const edge = c.h.footprintRefineEdge(c, st, u, prevU, v, totalLen);
        acc = onPoint(edge, acc, "hit");
      }
    } else if (!painted && prevPainted) {
      const edge = c.h.footprintRefineEdge(c, st, prevU, u, v, totalLen);
      acc = onPoint(edge, acc, "hit");
      if (acc.done) return true;
      acc = onPoint(null, null, "reset");
    }
    if (painted) {
      acc = onPoint(pt, acc, "hit");
      if (acc.done) return true;
    }
    prevPainted = painted;
    prevU = u;
  }
  return prevPainted && Boolean(acc.done);
}

export function probeRouteEndToMarker(
  c,
  routeSt,
  marker,
  markerSt,
  isTarget,
  tol,
) {
  const totalLen = routeSt.e.getTotalLength();
  if (!(totalLen > 0)) return null;
  const windowLocal = Math.min(totalLen, 2.5 / routeSt.scale);
  const uStart = isTarget ? totalLen : 0;
  const uEnd = isTarget ? Math.max(0, totalLen - windowLocal) : windowLocal;
  const shortRoute =
    totalLen * routeSt.scale <= Math.max(marker.bbox.w, marker.bbox.h);
  const us = c.h.footprintSampleAxis(routeSt, uStart, uEnd, 0.015, 0.015);
  const onPoint = (pt, acc, mode) => {
    if (mode === "reset")
      return { touched: false, exited: shortRoute, done: false };
    const touched = acc.touched || c.h.footprintNear(c, markerSt, pt, tol);
    const exited = acc.exited || c.h.footprintPointOutsideMarker(pt, marker);
    return { touched, exited, done: touched && exited };
  };
  for (const v of c.h.footprintTrackOffsets(routeSt.strokeMm)) {
    if (c.h.footprintWalkTrack(c, routeSt, us, v, totalLen, onPoint))
      return { touchesMarkerInk: true, extendsOutsideMarker: true };
  }
  return { touchesMarkerInk: false, extendsOutsideMarker: false };
}

export function probeLeadBridge(
  c,
  leadSt,
  marker,
  markerSt,
  routeSt,
  endpoint,
  tol,
) {
  const totalLen = leadSt.e.getTotalLength();
  if (!(totalLen > 0)) return false;
  const mb = markerSt.bbox;
  const pad = tol + 0.05;
  const endReach = Math.max(leadSt.strokeMm, routeSt.strokeMm) / 2 + tol + 0.02;
  if (
    leadSt.bbox.x > mb.x + mb.w + pad ||
    leadSt.bbox.x + leadSt.bbox.w < mb.x - pad ||
    leadSt.bbox.y > mb.y + mb.h + pad ||
    leadSt.bbox.y + leadSt.bbox.h < mb.y - pad ||
    endpoint.x < leadSt.bbox.x - endReach ||
    endpoint.x > leadSt.bbox.x + leadSt.bbox.w + endReach ||
    endpoint.y < leadSt.bbox.y - endReach ||
    endpoint.y > leadSt.bbox.y + leadSt.bbox.h + endReach
  )
    return false;
  const us = c.h.footprintSampleAxis(
    leadSt,
    0,
    totalLen,
    0.015,
    leadSt.covers.length ? 0.01 : 0.2,
  );
  const onPoint = (pt, acc, mode) => {
    if (mode === "reset")
      return { mark: false, out: false, route: false, done: false };
    const mark = acc.mark || c.h.footprintNear(c, markerSt, pt, tol);
    const out = acc.out || c.h.footprintPointOutsideMarker(pt, marker);
    const route =
      acc.route ||
      (Math.hypot(pt.x - endpoint.x, pt.y - endpoint.y) <= endReach &&
        c.h.footprintNear(c, routeSt, pt, tol));
    return { mark, out, route, done: mark && out && route };
  };
  for (const v of c.h.footprintTrackOffsets(leadSt.strokeMm)) {
    if (c.h.footprintWalkTrack(c, leadSt, us, v, totalLen, onPoint))
      return true;
  }
  return false;
}

export function indexLandingScopes(c, markers) {
  const markersByScope = new Map();
  for (const m of markers ?? []) {
    if (
      m.junction ||
      m.landingAlias ||
      !m.painted ||
      !m.deviceUid ||
      !m.terminal
    )
      continue;
    const key = JSON.stringify([
      m.appearanceScope ?? null,
      m.circuitGroup ?? null,
      m.deviceUid,
      m.terminal,
    ]);
    const list = markersByScope.get(key) ?? [];
    list.push(m);
    markersByScope.set(key, list);
  }
  const leadsByScope = new Map();
  for (const s of c.shapes ?? []) {
    if (
      !s.attachment ||
      !(s.stroke > 0) ||
      !["path", "line", "polyline"].includes(s.shapeTag)
    )
      continue;
    let pair;
    try {
      pair = JSON.parse(s.attachment);
    } catch {
      pair = null;
    }
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const key = JSON.stringify([
      s.appearanceScope ?? null,
      s.circuitGroup ?? null,
      pair[0],
      pair[1],
    ]);
    const list = leadsByScope.get(key) ?? [];
    list.push(s);
    leadsByScope.set(key, list);
  }
  return { markersByScope, leadsByScope };
}

export function probeLandingContacts(
  c,
  routeSt,
  landing,
  scopeMarkers,
  scopeLeads,
  getState,
  tol,
) {
  const markerContacts = [];
  const leadContacts = [];
  const isTarget = landing.end === "target";
  const ep = landing.endpoint;
  const reach = 2.6 + routeSt.strokeMm;
  for (const m of scopeMarkers) {
    const mSt = getState(m.element);
    if (!mSt) continue;
    const mb = mSt.bbox;
    if (
      ep.x >= mb.x - reach &&
      ep.x <= mb.x + mb.w + reach &&
      ep.y >= mb.y - reach &&
      ep.y <= mb.y + mb.h + reach
    ) {
      const hit = c.h.probeRouteEndToMarker(c, routeSt, m, mSt, isTarget, tol);
      if (hit?.touchesMarkerInk)
        markerContacts.push({ markerElement: m.element, ...hit });
    }
    for (const lead of scopeLeads) {
      const lSt = getState(lead.element);
      if (!lSt || typeof lSt.e.getTotalLength !== "function") continue;
      if (c.h.probeLeadBridge(c, lSt, m, mSt, routeSt, ep, tol)) {
        leadContacts.push({
          leadElement: lead.element,
          markerElement: m.element,
          continuousFromMarkerToRoute: true,
        });
      }
    }
  }
  return { markerContacts, leadContacts };
}

export function trancheLandingContacts(c, markers) {
  const TOL = 0.004;
  const contacts = {};
  const stateCache = new Map();
  const getState = (elId) => {
    if (!stateCache.has(elId)) {
      const el = c.elementsById.get(elId);
      stateCache.set(elId, el ? c.h.paintedFootprintState(c, el) : null);
    }
    return stateCache.get(elId);
  };
  const { markersByScope, leadsByScope } = c.h.indexLandingScopes(c, markers);
  for (const s of c.shapes ?? []) {
    if (!s.conductor || !s.ownedLandings?.length) continue;
    const routeSt = getState(s.element);
    if (!routeSt || typeof routeSt.e.getTotalLength !== "function") continue;
    const endMap = {};
    for (const landing of s.ownedLandings) {
      if (
        landing.reason ||
        !landing.anchor ||
        !landing.deviceUid ||
        !landing.terminal
      )
        continue;
      const scopeKey = JSON.stringify([
        landing.appearanceScope ?? s.appearanceScope ?? null,
        s.circuitGroup ?? null,
        landing.deviceUid,
        landing.terminal,
      ]);
      endMap[landing.end] = c.h.probeLandingContacts(
        c,
        routeSt,
        landing,
        markersByScope.get(scopeKey) ?? [],
        leadsByScope.get(scopeKey) ?? [],
        getState,
        TOL,
      );
    }
    contacts[s.element] = endMap;
  }
  return contacts;
}
