import {
  markerExitLocalCircle,
  parseDashPattern,
  pointAtLocal,
  predictedDashStarts,
  routeGeometryForShape,
  runGapToPoint,
} from "./dash-phase.mjs";
import { hasDashArray, subpathsContinuous } from "./peer-owner-ink.mjs";
import { conductorIdentity } from "./tranche3-identities.mjs";

// Numerical-error-only contact allowance: SVG coordinates are emitted at 0.001 mm
// (max diagonal rounding sqrt(2) * 0.0005 ~= 0.0007 mm) and Chromium screen/viewBox
// transforms add < 0.002 mm float noise. 0.004 mm absorbs only that numerical noise
// and strictly rejects any positive visible gap (including 0.012 mm gaps).
export const NUMERICAL_CONTACT_TOL_MM = 0.004;

// Matches ENDPOINT_LANDING_TOLERANCE_MM in endpoint-landings.mjs solely to avoid
// double-reporting endpoints already reported as endpoint-off-owned-anchor.
const ENDPOINT_DEDUP_TOL_MM = 0.01;
const DASH_END_TOL_MM = 0.03;
const DASH_FAR_TOL_MM = 0.25;

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

export function markerDirRadius(pt, m) {
  const dx = pt.x - m.point.x,
    dy = pt.y - m.point.y;
  const rx = m.bbox.w / 2,
    ry = m.bbox.h / 2;
  const dist = Math.hypot(dx, dy);
  if (dist <= 1e-9) return { dist: 0, rDir: Math.min(rx, ry) };
  if (!(rx > 0 && ry > 0)) return { dist, rDir: 0 };
  return { dist, rDir: dist / Math.hypot(dx / rx, dy / ry) };
}

function pointOnMarkerCircle(
  pt,
  m,
  extraRadius = 0,
  tol = NUMERICAL_CONTACT_TOL_MM,
) {
  const { dist, rDir } = markerDirRadius(pt, m);
  const sw = m.stroke > 0 ? m.stroke : 0;
  return dist <= rDir + sw / 2 + extraRadius + tol;
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

function eligibleLeadsForScope(g, scopeKey, deviceUid, terminal) {
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
        !subpathsContinuous(
          lead.routePath,
          lead.routeMatrix,
          NUMERICAL_CONTACT_TOL_MM,
        )) ||
      (lead.appearanceScope ?? null) !== appScope ||
      (lead.circuitGroup ?? null) !== group ||
      !lead.points?.length ||
      !lead.inkSegments?.length
    )
      continue;
    const pair = parsePair(lead.attachment);
    if (!pair || pair[0] !== deviceUid || pair[1] !== terminal) continue;
    out.push(lead);
  }
  return out;
}

function dashedEndLands(g, s, landing, markers, leads, endRuns, runs) {
  if (!hasDashArray(s.dash) || !runs.length) return false;
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
  if (
    Math.hypot(pt.x - landing.endpoint.x, pt.y - landing.endpoint.y) >
    NUMERICAL_CONTACT_TOL_MM
  )
    return false;
  const exits = [];
  const halfStroke = s.stroke > 0 ? s.stroke / 2 : 0;
  for (const m of markers)
    if (pointOnMarkerCircle(pt, m, halfStroke, NUMERICAL_CONTACT_TOL_MM))
      exits.push(markerExitLocalCircle(geom, m, fromEnd));
  for (const lead of leads) {
    const ends = [lead.points[0], lead.points.at(-1)];
    for (const [markEnd, tipEnd] of [
      [ends[0], ends[1]],
      [ends[1], ends[0]],
    ]) {
      if (
        markers.some((m) =>
          pointOnMarkerCircle(markEnd, m, 0, NUMERICAL_CONTACT_TOL_MM),
        ) &&
        Math.hypot(pt.x - tipEnd.x, pt.y - tipEnd.y) <= NUMERICAL_CONTACT_TOL_MM
      )
        exits.push(fromEnd ? geom.totalLocal : 0);
    }
  }
  return exits.some((uExit) =>
    predictedDashStarts(geom, pattern, capLocal, uExit, fromEnd).some(
      (uPred) => {
        const predPt = pointAtLocal(geom, uPred);
        const distFromEnd = fromEnd
          ? (geom.totalLocal - uPred) * geom.scale
          : uPred * geom.scale;
        const useFine = endRuns && distFromEnd <= 2.9;
        const pool = useFine ? endRuns : runs;
        const tol = useFine ? DASH_END_TOL_MM : DASH_FAR_TOL_MM;
        return pool.some(
          ([a, b]) => runGapToPoint(a, b, s.stroke, predPt) <= tol,
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

function endpointMultiset(pairs) {
  const counts = new Map();
  for (const [d, t] of pairs) {
    const k = JSON.stringify([d, t]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function declaredMatchesNative(s, nativeCounts) {
  const decl = (s.endpoints ?? []).filter(
    (p) =>
      typeof p?.deviceUid === "string" &&
      p.deviceUid.length > 0 &&
      typeof p?.terminalKey === "string" &&
      p.terminalKey.length > 0,
  );
  if (!decl.length) return true;
  const declCounts = endpointMultiset(
    decl.map((p) => [p.deviceUid, p.terminalKey]),
  );
  for (const [k, n] of declCounts) {
    if (n > (nativeCounts.get(k) ?? 0)) return false;
  }
  if (decl.length === 2) {
    for (const [k, n] of nativeCounts) {
      if ((declCounts.get(k) ?? 0) !== n) return false;
    }
  }
  return true;
}

function nativeOwnershipErrors(s, validLandings, catalog) {
  const errors = new Map();
  if (!catalog || !validLandings.length) return errors;
  const { key, conflict } = shapeNativeKey(s);
  const baseReason = conflict
    ? "conflicting-native-conductor-identity"
    : !key
      ? "missing-native-conductor-identity"
      : !catalog.has(key)
        ? "unknown-native-conductor"
        : null;
  if (baseReason) {
    for (const l of validLandings) errors.set(l, baseReason);
    return errors;
  }
  const nativeCounts = endpointMultiset(
    catalog.get(key).ends.map((t) => [t.deviceUid, t.terminalKey]),
  );
  if (!declaredMatchesNative(s, nativeCounts)) {
    for (const l of validLandings)
      errors.set(l, "forged-native-endpoint-ownership");
    return errors;
  }
  const remaining = new Map(nativeCounts);
  for (const l of validLandings) {
    const k = JSON.stringify([l.deviceUid, l.terminal]);
    const avail = remaining.get(k) ?? 0;
    if (avail > 0) remaining.set(k, avail - 1);
    else
      errors.set(
        l,
        nativeCounts.has(k)
          ? "duplicate-native-endpoint-ownership"
          : "forged-native-endpoint-ownership",
      );
  }
  return errors;
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

function landingFootprintOk(g, s, landing, markers, leads, endRuns, runs) {
  if (!markers.length) return false;
  const markerById = new Map(markers.map((m) => [m.element, m]));
  const leadIdSet = new Set(leads.map((l) => l.element));
  const halfStroke = s.stroke > 0 ? s.stroke / 2 : 0;
  const measured = g.tranche3.landingContacts?.[s.element]?.[landing.end];
  const directOk = Boolean(
    measured?.markerContacts?.some((c) => {
      const m = markerById.get(c.markerElement);
      return (
        m &&
        c.touchesMarkerInk &&
        c.extendsOutsideMarker &&
        pointOnMarkerCircle(
          landing.endpoint,
          m,
          halfStroke,
          NUMERICAL_CONTACT_TOL_MM,
        )
      );
    }),
  );
  if (directOk) return true;
  const leadOk = Boolean(
    measured?.leadContacts?.some(
      (c) =>
        leadIdSet.has(c.leadElement) &&
        markerById.has(c.markerElement) &&
        c.continuousFromMarkerToRoute,
    ),
  );
  if (leadOk) return true;
  return dashedEndLands(g, s, landing, markers, leads, endRuns, runs);
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
    const validLandings = (s.ownedLandings ?? []).filter((landing) => {
      if (
        landing.reason ||
        !landing.anchor ||
        !landing.deviceUid ||
        !landing.terminal
      )
        return false;
      const offsetMm = Math.hypot(
        landing.endpoint.x - landing.anchor.x,
        landing.endpoint.y - landing.anchor.y,
      );
      return Number.isFinite(offsetMm) && offsetMm <= ENDPOINT_DEDUP_TOL_MM;
    });
    const ownErrors = nativeOwnershipErrors(s, validLandings, catalog);
    for (const landing of validLandings) {
      const ownReason = ownErrors.get(landing);
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
          eligibleLeadsForScope(
            g,
            scopeKey,
            landing.deviceUid,
            landing.terminal,
          ),
        );
      const leads = leadCache.get(scopeKey);
      const ok = landingFootprintOk(
        g,
        s,
        landing,
        markers,
        leads,
        endInk?.[landing.end],
        runs,
      );
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
