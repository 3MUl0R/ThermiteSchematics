import {
  markerExitLocalCircle,
  parseDashPattern,
  pointAtLocal,
  predictedDashStarts,
  routeGeometryForShape,
  runGapToPoint,
} from "./dash-phase.mjs";
import {
  clipSegmentToRect,
  hasDashArray,
  subpathsContinuous,
} from "./peer-owner-ink.mjs";
import { conductorIdentity } from "./tranche3-identities.mjs";

const TIP_TOL_MM = 0.01;
const LEAD_JOIN_TOL_MM = 0.015;
const MARKER_INK_TOL_MM = 0.035;
const DASH_HIT_TOL_MM = 0.25;

function parsePair(raw) {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === "string" &&
      typeof v[1] === "string"
      ? v
      : null;
  } catch {
    return null;
  }
}

function markerDirRadius(pt, m) {
  const dx = pt.x - m.point.x,
    dy = pt.y - m.point.y;
  const rx = m.bbox.w / 2,
    ry = m.bbox.h / 2;
  const dist = Math.hypot(dx, dy);
  if (dist <= 1e-9) return { dist: 0, rDir: Math.min(rx, ry) };
  if (!(rx > 0 && ry > 0)) return { dist, rDir: 0 };
  return { dist, rDir: 1 / Math.hypot(dx / rx, dy / ry) };
}

function pointOnMarkerCircle(pt, m, tol = TIP_TOL_MM) {
  const { dist, rDir } = markerDirRadius(pt, m);
  const sw = m.stroke > 0 ? m.stroke : 0;
  return dist <= rDir + sw / 2 + tol;
}

function pointOutsideMarkerOuter(pt, m, margin = 0.05) {
  const { dist, rDir } = markerDirRadius(pt, m);
  const sw = m.stroke > 0 ? m.stroke : 0;
  return dist > rDir + sw / 2 + margin;
}

function strokeFrame(a, b, strokeWidth, cap) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const half = strokeWidth > 0 ? strokeWidth / 2 : 0;
  const capExt = cap === "round" || cap === "square" ? half : 0;
  if (len <= 1e-9)
    return { a, len: 0, ux: 1, uy: 0, nx: 0, ny: 1, half, capExt };
  const ux = dx / len,
    uy = dy / len;
  return { a, len, ux, uy, nx: -uy, ny: ux, half, capExt };
}

function pointToStrokeRectDist(p, frame) {
  const rx = p.x - frame.a.x,
    ry = p.y - frame.a.y;
  const t = rx * frame.ux + ry * frame.uy;
  const n = rx * frame.nx + ry * frame.ny;
  const dt = Math.max(-frame.capExt - t, 0, t - (frame.len + frame.capExt));
  const dn = Math.max(0, Math.abs(n) - frame.half);
  return Math.hypot(dt, dn);
}

function segmentToLocalRectDist(p0, p1, frame) {
  const x0 = (p0.x - frame.a.x) * frame.ux + (p0.y - frame.a.y) * frame.uy;
  const y0 = (p0.x - frame.a.x) * frame.nx + (p0.y - frame.a.y) * frame.ny;
  const x1 = (p1.x - frame.a.x) * frame.ux + (p1.y - frame.a.y) * frame.uy;
  const y1 = (p1.x - frame.a.x) * frame.nx + (p1.y - frame.a.y) * frame.ny;
  const minX = -frame.capExt,
    maxX = frame.len + frame.capExt;
  const minY = -frame.half,
    maxY = frame.half;
  const rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  if (clipSegmentToRect({ x: x0, y: y0 }, { x: x1, y: y1 }, rect)) return 0;
  const dx = x1 - x0,
    dy = y1 - y0;
  const ptRect = (x, y) =>
    Math.hypot(
      Math.max(minX - x, 0, x - maxX),
      Math.max(minY - y, 0, y - maxY),
    );
  const ptSeg = (cx, cy) => {
    const l2 = dx * dx + dy * dy;
    const f =
      l2 > 1e-12
        ? Math.max(0, Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / l2))
        : 0;
    return Math.hypot(cx - (x0 + dx * f), cy - (y0 + dy * f));
  };
  return Math.min(
    ptRect(x0, y0),
    ptRect(x1, y1),
    ptSeg(minX, minY),
    ptSeg(maxX, minY),
    ptSeg(minX, maxY),
    ptSeg(maxX, maxY),
  );
}

function strokeRectCorners(frame) {
  const { a, len, ux, uy, nx, ny, half, capExt } = frame;
  const pt = (t, n) => ({ x: a.x + ux * t + nx * n, y: a.y + uy * t + ny * n });
  return [
    pt(-capExt, -half),
    pt(len + capExt, -half),
    pt(len + capExt, half),
    pt(-capExt, half),
  ];
}

function strokeRectToRectDist(f1, f2) {
  const c1 = strokeRectCorners(f1);
  const c2 = strokeRectCorners(f2);
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    best = Math.min(
      best,
      segmentToLocalRectDist(c1[i], c1[(i + 1) % 4], f2),
      segmentToLocalRectDist(c2[i], c2[(i + 1) % 4], f1),
    );
    if (best === 0) return 0;
  }
  return best;
}

function runTouchesMarkerInk(run, strokeWidth, cap, marker) {
  const frame = strokeFrame(run[0], run[1], strokeWidth, cap);
  const mHalf = marker.stroke > 0 ? marker.stroke / 2 : 0;
  for (const [q0, q1] of marker.inkSegments) {
    const d = Math.max(0, segmentToLocalRectDist(q0, q1, frame) - mHalf);
    if (d <= MARKER_INK_TOL_MM) return true;
  }
  return false;
}

function routeLengthMm(s) {
  const pts = s.points ?? [];
  let sum = 0;
  for (let i = 1; i < pts.length; i++)
    sum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return sum;
}

function endInkContactsMarker(s, endRuns, endpoint, cap, marker) {
  if (!pointOnMarkerCircle(endpoint, marker, TIP_TOL_MM)) return false;
  const w = s.stroke > 0 ? s.stroke : 0;
  const shortRoute = routeLengthMm(s) <= Math.max(marker.bbox.w, marker.bbox.h);
  return endRuns.some(
    (run) =>
      runTouchesMarkerInk(run, w, cap, marker) &&
      (shortRoute ||
        pointOutsideMarkerOuter(run[0], marker) ||
        pointOutsideMarkerOuter(run[1], marker)),
  );
}

function indexPhysicalMarkers(g) {
  const byScopeTerm = new Map();
  for (const m of g.tranche4?.markers ?? []) {
    if (
      m.junction ||
      m.landingAlias ||
      !m.painted ||
      !m.inkSegments?.length ||
      !m.deviceUid ||
      !m.terminal ||
      !m.bbox ||
      !(m.bbox.w > 0 && m.bbox.h > 0)
    )
      continue;
    const key = JSON.stringify([
      m.appearanceScope ?? null,
      m.circuitGroup ?? null,
      m.deviceUid,
      m.terminal,
    ]);
    const list = byScopeTerm.get(key) ?? [];
    list.push(m);
    byScopeTerm.set(key, list);
  }
  return byScopeTerm;
}

function validatedLeadsForScope(
  g,
  markersByScope,
  scopeKey,
  deviceUid,
  terminal,
) {
  const markers = markersByScope.get(scopeKey) ?? [];
  if (!markers.length) return [];
  const [appScope, group] = JSON.parse(scopeKey);
  const out = [];
  for (const lead of g.shapes ?? []) {
    if (
      !lead.attachment ||
      !(lead.stroke > 0) ||
      hasDashArray(lead.dash) ||
      !["path", "line", "polyline"].includes(lead.shapeTag) ||
      (lead.shapeTag === "path" &&
        typeof lead.routePath === "string" &&
        !subpathsContinuous(lead.routePath, lead.routeMatrix)) ||
      (lead.appearanceScope ?? null) !== appScope ||
      (lead.circuitGroup ?? null) !== group ||
      !lead.points?.length ||
      !lead.inkSegments?.length
    )
      continue;
    const pair = parsePair(lead.attachment);
    if (!pair || pair[0] !== deviceUid || pair[1] !== terminal) continue;
    const ends = [lead.points[0], lead.points.at(-1)];
    for (const [markEnd, tipEnd] of [
      [ends[0], ends[1]],
      [ends[1], ends[0]],
    ]) {
      const marker = markers.find((m) => pointOnMarkerCircle(markEnd, m));
      if (!marker) continue;
      for (const iv of lead.inkSegments) {
        const frame = strokeFrame(iv[0], iv[1], lead.stroke, "butt");
        const touchesTip =
          pointToStrokeRectDist(tipEnd, frame) <= LEAD_JOIN_TOL_MM;
        const touchesMarker =
          runTouchesMarkerInk(iv, lead.stroke, "butt", marker) &&
          (pointOutsideMarkerOuter(iv[0], marker) ||
            pointOutsideMarkerOuter(iv[1], marker));
        if (touchesTip && touchesMarker)
          out.push({ tip: tipEnd, frame, marker });
      }
    }
  }
  return out;
}

function endInkContactsLead(s, endRuns, endpoint, cap, leads) {
  const w = s.stroke > 0 ? s.stroke : 0;
  for (const lead of leads) {
    if (
      Math.hypot(endpoint.x - lead.tip.x, endpoint.y - lead.tip.y) >
      LEAD_JOIN_TOL_MM
    )
      continue;
    for (const run of endRuns) {
      const rFrame = strokeFrame(run[0], run[1], w, cap);
      if (strokeRectToRectDist(rFrame, lead.frame) <= LEAD_JOIN_TOL_MM)
        return true;
    }
  }
  return false;
}

function dashedEndLands(g, s, landing, markers, leads, runs) {
  if (!runs.length) return false;
  const scope = g.outsideRouteScopes?.[s.element];
  const pattern = parseDashPattern(s.dash, scope?.dashOffset ?? s.dashOffset);
  if (!pattern) return false;
  const geom = routeGeometryForShape(s);
  if (!geom) return false;
  const cap = scope?.lineCap ?? s.lineCap;
  const capLocal =
    (cap === "round" || cap === "square") && s.stroke > 0
      ? s.stroke / (2 * geom.scale)
      : 0;
  const fromEnd = landing.end === "target";
  const pt = fromEnd ? geom.segs.at(-1).b : geom.segs[0].a;
  if (Math.hypot(pt.x - landing.endpoint.x, pt.y - landing.endpoint.y) > 0.02)
    return false;
  const exits = [];
  for (const m of markers)
    if (pointOnMarkerCircle(pt, m, TIP_TOL_MM))
      exits.push(markerExitLocalCircle(geom, m, fromEnd));
  for (const lead of leads)
    if (Math.hypot(pt.x - lead.tip.x, pt.y - lead.tip.y) <= LEAD_JOIN_TOL_MM)
      exits.push(fromEnd ? geom.totalLocal : 0);
  return exits.some((uExit) =>
    predictedDashStarts(geom, pattern, capLocal, uExit, fromEnd).some(
      (uPred) => {
        const predPt = pointAtLocal(geom, uPred);
        return runs.some(
          ([a, b]) => runGapToPoint(a, b, s.stroke, predPt) <= DASH_HIT_TOL_MM,
        );
      },
    ),
  );
}

function nativeConductorMap(ir) {
  if (!ir || typeof ir !== "object") return null;
  const hasAny =
    Array.isArray(ir.wires) ||
    Array.isArray(ir.jumpers) ||
    Array.isArray(ir.cableConductors);
  if (!hasAny) return null;
  const map = new Map();
  const put = (key, row) => {
    const ends = (row.endpoints ?? []).map((e) => e?.terminal).filter(Boolean);
    if (key && ends.length === 2) map.set(key, { key, ends });
  };
  for (const w of ir.wires ?? []) put(w.uid, w);
  for (const j of ir.jumpers ?? []) put(j.uid, j);
  for (const c of ir.cableConductors ?? [])
    if (c.id?.cableUid && c.id?.conductorId)
      put(JSON.stringify([c.id.cableUid, c.id.conductorId]), c);
  return map;
}

function shapeNativeKey(s) {
  const [kind, ...ids] = s.edgeOwnerKey ?? [];
  const edge =
    kind === "cable-conductor"
      ? JSON.stringify(ids)
      : kind === "wire" || kind === "jumper"
        ? conductorIdentity(ids[0])
        : undefined;
  const declared = conductorIdentity(s.wire ?? s.loopConductor);
  if (declared && edge && declared !== edge) return { conflict: true };
  return { key: declared ?? edge, conflict: false };
}

function nativeOwnershipReason(s, landing, catalog) {
  if (!catalog) return null;
  const { key, conflict } = shapeNativeKey(s);
  if (conflict) return "conflicting-native-conductor-identity";
  if (!key) return "missing-native-conductor-identity";
  const native = catalog.get(key);
  if (!native) return "unknown-native-conductor";
  const matchesEnd = native.ends.some(
    (t) =>
      t.deviceUid === landing.deviceUid && t.terminalKey === landing.terminal,
  );
  return matchesEnd ? null : "forged-native-endpoint-ownership";
}

function makeFinding(s, landing, reason) {
  return {
    kind: "endpoint-unpainted-to-physical-terminal",
    element: s.element,
    designation: s.designation ?? s.wire ?? landing.deviceUid ?? "conductor",
    ...(s.bbox ? { bbox: s.bbox } : { sheetLevel: true }),
    end: landing.end,
    deviceUid: landing.deviceUid,
    terminal: landing.terminal,
    endpoint: landing.endpoint,
    anchor: landing.anchor,
    reason,
  };
}

export function paintedPhysicalLandingFindings(g, ir) {
  if (!g.tranche3?.routeInk) return [];
  const markersByScope = indexPhysicalMarkers(g);
  const catalog = nativeConductorMap(ir);
  const leadCache = new Map();
  const findings = [];
  for (const s of g.shapes ?? []) {
    if (!s.conductor) continue;
    const runs = g.tranche3.routeInk[s.element] ?? [];
    const endInk = g.tranche3.routeEndInk?.[s.element];
    const cap = g.outsideRouteScopes?.[s.element]?.lineCap ?? s.lineCap;
    for (const landing of s.ownedLandings ?? []) {
      if (
        landing.reason ||
        !landing.anchor ||
        !landing.deviceUid ||
        !landing.terminal
      )
        continue;
      const offsetMm = Math.hypot(
        landing.endpoint.x - landing.anchor.x,
        landing.endpoint.y - landing.anchor.y,
      );
      if (!Number.isFinite(offsetMm) || offsetMm > TIP_TOL_MM) continue;
      const ownReason = nativeOwnershipReason(s, landing, catalog);
      if (ownReason) {
        findings.push(makeFinding(s, landing, ownReason));
        continue;
      }
      const scopeKey = JSON.stringify([
        landing.appearanceScope ?? s.appearanceScope ?? null,
        s.circuitGroup ?? null,
        landing.deviceUid,
        landing.terminal,
      ]);
      const markers = markersByScope.get(scopeKey) ?? [];
      if (!leadCache.has(scopeKey))
        leadCache.set(
          scopeKey,
          validatedLeadsForScope(
            g,
            markersByScope,
            scopeKey,
            landing.deviceUid,
            landing.terminal,
          ),
        );
      const leads = leadCache.get(scopeKey);
      const endRuns = endInk?.[landing.end] ?? runs;
      const ok =
        markers.length > 0 &&
        (markers.some((m) =>
          endInkContactsMarker(s, endRuns, landing.endpoint, cap, m),
        ) ||
          endInkContactsLead(s, endRuns, landing.endpoint, cap, leads) ||
          dashedEndLands(g, s, landing, markers, leads, runs));
      if (!ok) {
        const reason = !markers.length
          ? "missing-painted-physical-terminal"
          : !runs.length
            ? "missing-painted-route-ink"
            : "route-ink-detached-from-physical-terminal";
        findings.push(makeFinding(s, landing, reason));
      }
    }
  }
  return findings;
}
