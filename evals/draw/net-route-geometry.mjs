// Join measured pieces by geometry, never DOM order or renderer route flags.
import { pointDistance } from "./review-geometry.mjs";
const finite = (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y);
const touches = (a, b) => pointDistance(a, b) <= 0.001;
const ANCHOR_TOL_MM = 0.05;

function conductorIdForRoute(route) {
  if (route.wire) return route.wire;
  const k = route.edgeOwnerKey;
  if (!Array.isArray(k)) return undefined;
  if (k[0] === "wire" || k[0] === "jumper") return k[1];
  if (k[0] === "cable-conductor") return JSON.stringify(k.slice(1));
  return undefined;
}

function isJunctionNodeId(nodeId) {
  if (typeof nodeId !== "string") return false;
  try {
    const parsed = JSON.parse(nodeId);
    return (
      Array.isArray(parsed) &&
      (parsed[0] === "junction" || parsed[0] === "junction-comb")
    );
  } catch {
    return false;
  }
}

function nativeEndpointsMatch(route, condId, deviceUid, terminal, ir) {
  const matchesPair = (ends) =>
    ends.some(
      (e) =>
        (e?.deviceUid ?? e?.terminal?.deviceUid) === deviceUid &&
        (e?.terminalKey ?? e?.terminal?.terminalKey) === terminal,
    );
  if (
    Array.isArray(route.endpoints) &&
    route.endpoints.some((e) => e?.deviceUid && e?.terminalKey) &&
    !matchesPair(route.endpoints)
  )
    return false;
  if (!ir || typeof ir !== "object") return true;
  const all = [
    ...(ir.wires ?? []).map((w) => [w.uid, w.endpoints]),
    ...(ir.jumpers ?? []).map((j) => [j.uid, j.endpoints]),
    ...(ir.cableConductors ?? []).map((c) => [
      JSON.stringify([c.id.cableUid, c.id.conductorId]),
      c.endpoints,
    ]),
  ];
  if (!all.length) return true;
  const entry = all.find(([id]) => id === condId);
  return entry ? matchesPair(entry[1] ?? []) : false;
}

function sourceAnchor(routes) {
  const anchors = routes.flatMap((r) =>
    (r.ownedLandings ?? []).filter(
      (p) => p.end === "source" && finite(p.anchor),
    ),
  );
  if (!anchors.length)
    return {
      reason: "Net-label route direction has no verified source anchor",
    };
  const first = anchors[0];
  if (
    anchors.some(
      (p) =>
        !touches(p.anchor, first.anchor) ||
        p.deviceUid !== first.deviceUid ||
        p.terminal !== first.terminal,
    )
  )
    return { reason: "Net-label route direction has ambiguous source anchors" };
  return { anchor: first.anchor };
}

function continueRoute(points, remaining) {
  while (remaining.length) {
    const end = points.at(-1),
      next = remaining.filter(
        (p) => touches(p[0], end) || touches(p.at(-1), end),
      );
    if (next.length !== 1)
      return { reason: "Net-label route pieces are disconnected or ambiguous" };
    const piece = next[0],
      forward = touches(piece[0], end);
    if (forward && touches(piece.at(-1), end))
      return { reason: "Net-label route piece direction is ambiguous" };
    points.push(...(forward ? piece : piece.toReversed()).slice(1));
    remaining.splice(remaining.indexOf(piece), 1);
  }
  return { points };
}

function traceTrunkChain(route, condId, startJunctionId, g) {
  const boundaries = g?.boundaryRoutes ?? [];
  const chain = [];
  const visited = new Set([startJunctionId]);
  let cur = startJunctionId;
  while (cur) {
    const matches = boundaries.filter(
      (b) =>
        b.appearanceScope === route.appearanceScope &&
        b.net === route.net &&
        b.targetPortKey?.[1] === cur &&
        Array.isArray(b.trunkConductors) &&
        b.trunkConductors.includes(condId),
    );
    if (!matches.length)
      return {
        reason: "Net-label route direction has no verified source anchor",
      };
    if (matches.length > 1)
      return {
        reason: "Net-label route direction has ambiguous source anchors",
      };
    const trunk = matches[0];
    chain.unshift(trunk);
    const srcLanding = (trunk.ownedLandings ?? []).find(
      (p) => p.end === "source" && !p.reason && finite(p.anchor),
    );
    if (srcLanding) {
      const srcOwner = (trunk.landingOwners ?? []).find(
        (p) =>
          p.landingEnd === "source" &&
          p.deviceUid === srcLanding.deviceUid &&
          p.terminal === srcLanding.terminal,
      );
      return { chain, sourceLanding: srcLanding, sourceLandingOwner: srcOwner };
    }
    const next = trunk.sourcePortKey?.[1];
    if (!isJunctionNodeId(next) || visited.has(next))
      return {
        reason: "Net-label route direction has no verified source anchor",
      };
    visited.add(next);
    cur = next;
  }
  return { reason: "Net-label route direction has no verified source anchor" };
}

function assembleTrunkRoute(
  chain,
  branchPoints,
  junctionAnchor,
  sourceLanding,
) {
  const trunkPoints = [];
  for (const trunk of chain) {
    const pts = trunk.points ?? [];
    if (pts.length < 2 || !pts.every(finite))
      return { reason: "Net-label route direction lacks a measured polyline" };
    if (!trunkPoints.length) {
      if (pointDistance(pts[0], sourceLanding.anchor) > ANCHOR_TOL_MM)
        return {
          mismatch: {
            pathStart: pts[0],
            claimedSourceAnchor: sourceLanding.anchor,
          },
        };
      trunkPoints.push(...pts);
    } else {
      if (pointDistance(trunkPoints.at(-1), pts[0]) > ANCHOR_TOL_MM)
        return {
          reason: "Net-label route pieces are disconnected or ambiguous",
        };
      trunkPoints.push(...pts.slice(1));
    }
  }
  if (
    pointDistance(trunkPoints.at(-1), junctionAnchor) > ANCHOR_TOL_MM ||
    pointDistance(trunkPoints.at(-1), branchPoints[0]) > ANCHOR_TOL_MM
  )
    return {
      mismatch: {
        pathStart: branchPoints[0],
        claimedSourceAnchor: junctionAnchor,
      },
    };
  return { points: [...trunkPoints, ...branchPoints.slice(1)] };
}

function sharedTrunkRoute(routes, g, ir) {
  if (!g?.boundaryRoutes?.length || !g?.junctionDots?.length) return null;
  const junctionRoutes = routes.filter((r) =>
    isJunctionNodeId(r.routeSourcePortKey?.[1]),
  );
  if (junctionRoutes.length !== 1) return null;
  const route = junctionRoutes[0];
  const condId = conductorIdForRoute(route);
  if (!condId) return null;
  const jId = route.routeSourcePortKey[1];
  const dots = g.junctionDots.filter(
    (d) =>
      d.appearanceScope === route.appearanceScope &&
      d.junctionId === jId &&
      finite(d.anchor),
  );
  if (dots.length !== 1) return null;
  const pieces = routes.map((r) => r.points ?? []);
  if (pieces.some((p) => p.length < 2 || !p.every(finite)))
    return { reason: "Net-label route direction lacks a measured polyline" };
  const branch = continueRoute(
    [...route.points],
    pieces.filter((p) => p !== route.points),
  );
  if (branch.reason) return branch;
  const traced = traceTrunkChain(route, condId, jId, g);
  if (traced.reason) return traced;
  const { chain, sourceLanding, sourceLandingOwner } = traced;
  if (
    !nativeEndpointsMatch(
      route,
      condId,
      sourceLanding.deviceUid,
      sourceLanding.terminal,
      ir,
    )
  )
    return {
      mismatch: {
        reason: "trunk-source-endpoint-mismatch",
        claimedSourceDeviceUid: sourceLanding.deviceUid,
        claimedSourceTerminal: sourceLanding.terminal,
      },
    };
  const combined = assembleTrunkRoute(
    chain,
    branch.points,
    dots[0].anchor,
    sourceLanding,
  );
  if (combined.reason || combined.mismatch) return combined;
  return {
    points: combined.points,
    trunkElements: new Set(chain.map((t) => t.element)),
    trunkStrokes: chain.map((t) => t.stroke ?? 0),
    sourceLanding,
    sourceLandingOwner,
  };
}

export function sourceOrderedRoute(routes, g, ir) {
  const source = sourceAnchor(routes);
  if (source.reason) {
    const trunk = sharedTrunkRoute(routes, g, ir);
    if (trunk) return trunk;
    return source;
  }
  const pieces = routes.map((r) => r.points ?? []);
  if (!pieces.length || pieces.some((p) => p.length < 2 || !p.every(finite)))
    return { reason: "Net-label route direction lacks a measured polyline" };
  const starts = pieces.filter(
    (p) => pointDistance(p[0], source.anchor) <= ANCHOR_TOL_MM,
  );
  if (!starts.length)
    return {
      mismatch: { pathStart: pieces[0][0], claimedSourceAnchor: source.anchor },
    };
  if (starts.length !== 1)
    return { reason: "Net-label route source piece is ambiguous" };
  return continueRoute(
    [...starts[0]],
    pieces.filter((p) => p !== starts[0]),
  );
}
