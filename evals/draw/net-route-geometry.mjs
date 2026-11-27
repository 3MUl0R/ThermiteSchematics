// Join measured pieces by geometry, never DOM order or renderer route flags.
import { pointDistance } from "./review-geometry.mjs";
import {
  ANCHOR_TOL_MM,
  buildNativeIrIndex,
  hasVisibleTrunkInk,
  isJunctionNodeId,
  routeSemanticConductorId,
  validateBranchApproachContinuity,
  validateJunctionDot,
  validateTrunkInkContinuity,
  validateTrunkMembership,
  validateTrunkSourceEndpoint,
  visibleJunctionDotsById,
} from "./net-trunk-validation.mjs";

const finite = (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y);
const touches = (a, b) => pointDistance(a, b) <= 0.001;

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

function traceTrunkChain(route, condId, startJunctionId, g, irIndex) {
  const boundaries = (g?.boundaryRoutes ?? []).filter(hasVisibleTrunkInk);
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
    const memberCheck = validateTrunkMembership(
      trunk,
      route,
      condId,
      g,
      irIndex,
    );
    if (memberCheck.reason) return memberCheck;
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
    const nextDot = validateJunctionDot(next, route, condId, g, irIndex);
    if (nextDot.reason) return nextDot;
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

function sharedTrunkRoute(routes, g, ir, label) {
  const junctionRoutes = routes.filter((r) =>
    isJunctionNodeId(r.routeSourcePortKey?.[1]),
  );
  if (junctionRoutes.length !== 1) return null;
  const route = junctionRoutes[0];
  const semantic = routeSemanticConductorId(route);
  if (semantic.conflict || !semantic.id)
    return {
      reason:
        "Net-label route conductor identity conflicts with semantic edge identity",
    };
  const irIndex = buildNativeIrIndex(ir);
  if (!irIndex)
    return { reason: "Net-label shared trunk requires native IR verification" };
  const condId = semantic.id;
  const jId = route.routeSourcePortKey[1];
  const dotCheck = validateJunctionDot(jId, route, condId, g, irIndex);
  if (dotCheck.reason) return dotCheck;
  const pieces = routes.map((r) => r.points ?? []);
  if (pieces.some((p) => p.length < 2 || !p.every(finite)))
    return { reason: "Net-label route direction lacks a measured polyline" };
  const branch = continueRoute(
    [...route.points],
    pieces.filter((p) => p !== route.points),
  );
  if (branch.reason) return branch;
  const traced = traceTrunkChain(route, condId, jId, g, irIndex);
  if (traced.reason) return traced;
  const { chain, sourceLanding, sourceLandingOwner } = traced;
  const srcCheck = validateTrunkSourceEndpoint(
    route,
    condId,
    sourceLanding,
    dotCheck.dot,
    irIndex,
  );
  if (srcCheck.reason || srcCheck.mismatch) return srcCheck;
  const combined = assembleTrunkRoute(
    chain,
    branch.points,
    dotCheck.dot.anchor,
    sourceLanding,
  );
  if (combined.reason || combined.mismatch) return combined;
  const dotsById = visibleJunctionDotsById(route.appearanceScope, g);
  const trunkInk = validateTrunkInkContinuity(
    chain,
    sourceLanding,
    dotsById,
    route.appearanceScope,
    g,
  );
  if (trunkInk.reason) return trunkInk;
  const branchInk = validateBranchApproachContinuity(
    branch.points,
    routes,
    dotCheck.dot,
    label,
    g,
  );
  if (branchInk.reason) return branchInk;
  return {
    points: combined.points,
    trunkElements: new Set(chain.map((t) => t.element)),
    trunkStrokes: chain.map((t) => t.stroke ?? 0),
    sourceLanding,
    sourceLandingOwner,
  };
}

export function sourceOrderedRoute(routes, g, ir, label) {
  const source = sourceAnchor(routes);
  if (source.reason) {
    const trunk = sharedTrunkRoute(routes, g, ir, label);
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
