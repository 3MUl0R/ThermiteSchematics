// Native SVG geometry, never renderer label planners or sourcePortId helpers.
import {
  boxToPolylineDistance,
  painted,
  pointDistance,
  segmentHitsBox,
} from "./review-geometry.mjs";
import { sourceOrderedRoute } from "./net-route-geometry.mjs";
import { survivingRailCaption } from "./net-rail-caption.mjs";
const APPROACH_EPSILON_MM = 0.17;
export const normalizedNetText = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
const isNetLabelCandidate = (t) =>
  (t.labelRole === "net" && t.labelOwnerKind === "edge") ||
  (t.painted !== false &&
    (t.labelRole === "net" || /(?:^|\s)label-net(?:\s|$)/.test(t.role ?? "")));
const labels = (g) =>
  [...g.texts, ...(g.omittedNetLabels ?? [])].filter(isNetLabelCandidate);
const routesFor = (g, label) =>
  g.shapes.filter(
    (s) =>
      s.conductor &&
      s.edgeOwnerKey &&
      s.appearanceScope === label.appearanceScope &&
      JSON.stringify(s.edgeOwnerKey) === JSON.stringify(label.labelOwnerKey),
  );
function hasOwnershipGap(label, routes, source) {
  return (
    label.labelOwnerKind !== "edge" ||
    !Array.isArray(label.labelOwnerKey) ||
    !routes.length ||
    Boolean(source.reason) ||
    routes.some(
      (s) =>
        s.landingOwners?.some((p) => p.landingEnd === "unknown") ||
        s.ownedLandings?.some((p) => p.reason === "missing-route-port-owner"),
    )
  );
}
export function netOwnershipGaps(g, ir) {
  return [
    ...labels(g).flatMap((label) => {
      if (
        label.labelOwnerKind !== "edge" ||
        !Array.isArray(label.labelOwnerKey)
      )
        return [
          {
            element: label.element,
            reason:
              "Net-label source ownership unavailable: missing decodable clip-path edge owner",
          },
        ];
      const routes = routesFor(g, label);
      const source = sourceOrderedRoute(routes, g, ir, label);
      if (hasOwnershipGap(label, routes, source))
        return [
          {
            element: label.element,
            reason: `Net-label source ownership unavailable: ${source.reason ?? "historical route-port keys are unavailable"}`,
          },
        ];
      const frameGap = sourceFrameOwnershipGap(g, label, routes, source);
      return frameGap ? [frameGap] : [];
    }),
    ...(g.netLabelFrameGaps ?? []),
  ];
}
// Locate the painted reservation on the polyline itself. TAIL occupies the
// source half of the route; endpoint owner flags cannot reverse path direction.
function tailPosition(route, label, issue) {
  if (label.omitted) return; // An empty reservation is not a painted label position.
  const points = route.points ?? [];
  if (points.length < 2 || !label.bbox) return;
  const center = {
    x: label.bbox.x + label.bbox.w / 2,
    y: label.bbox.y + label.bbox.h / 2,
  };
  let total = 0,
    best = Infinity,
    at = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      length = pointDistance(a, b);
    if (!length) continue;
    const u = Math.max(
      0,
      Math.min(
        1,
        ((center.x - a.x) * (b.x - a.x) + (center.y - a.y) * (b.y - a.y)) /
          (length * length),
      ),
    );
    const d = pointDistance(center, {
      x: a.x + u * (b.x - a.x),
      y: a.y + u * (b.y - a.y),
    });
    if (d < best) {
      best = d;
      at = total + u * length;
    }
    total += length;
  }
  if (total > 0 && at > total / 2 + 0.05)
    return issue("net-label-not-at-route-source", label, {
      edgeOwnerKey: label.labelOwnerKey,
      routeLength: total,
      labelDistanceAlongRoute: at,
    });
}
function boxIntersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    w: Math.min(a.x + a.w, b.x + b.w) - x,
    h: Math.min(a.y + a.h, b.y + b.h) - y,
  };
}
function pointInBox(p, b, margin = 0) {
  return Boolean(
    p &&
    b &&
    p.x >= b.x - margin &&
    p.x <= b.x + b.w + margin &&
    p.y >= b.y - margin &&
    p.y <= b.y + b.h + margin,
  );
}
function effectiveSourceLandings(routes, source) {
  const directOwners = routes.flatMap((r) =>
    (r.landingOwners ?? []).filter((p) => p.landingEnd === "source"),
  );
  const directLandings = routes.flatMap((r) =>
    (r.ownedLandings ?? []).filter((p) => p.end === "source"),
  );
  return {
    owners: directOwners.length
      ? directOwners
      : source?.sourceLandingOwner
        ? [source.sourceLandingOwner]
        : [],
    landings: directLandings.length
      ? directLandings
      : source?.sourceLanding
        ? [source.sourceLanding]
        : [],
  };
}
function fallbackSourceFrameMatches(g, label, deviceUid, routes, source) {
  const sameUidFrames = (g.shapes ?? []).filter(
    (s) =>
      s.navigationFrame &&
      !s.omitted &&
      s.bbox &&
      s.appearanceScope === label.appearanceScope &&
      s.deviceUid === deviceUid,
  );
  const { owners: allOwners, landings: allLandings } = effectiveSourceLandings(
    routes,
    source,
  );
  const owners = allOwners.filter((p) => p.deviceUid === deviceUid);
  const direct = sameUidFrames.filter(
    (f) =>
      f.ownerGroup && owners.some((o) => o.terminalAppearance === f.ownerGroup),
  );
  if (direct.length === 1)
    return { status: "resolved", frameElement: direct[0].element };
  if (direct.length > 1)
    return {
      status: "ambiguous",
      reason: "multiple same-UID device frames share the source ownerGroup",
    };
  const landings = allLandings.filter(
    (p) => p.anchor && p.deviceUid === deviceUid,
  );
  const hits = sameUidFrames.filter((f) =>
    landings.some((p) => pointInBox(p.anchor, f.bbox, 0.001)),
  );
  if (hits.length === 1)
    return { status: "resolved", frameElement: hits[0].element };
  if (hits.length > 1)
    return {
      status: "ambiguous",
      reason:
        "multiple sibling same-UID device frames geometrically match the source anchor",
    };
  return { status: "none" };
}

function sourceFrameOwnershipGap(g, label, routes, source) {
  if (Array.isArray(g.netLabelSourceFrames)) {
    const ambiguous = g.netLabelSourceFrames.find(
      (e) => e.labelElement === label.element && e.status === "ambiguous",
    );
    return ambiguous
      ? {
          element: label.element,
          reason: `Net-label source device-frame ownership ambiguous: ${ambiguous.reason}`,
        }
      : null;
  }
  const { owners, landings } = effectiveSourceLandings(routes, source);
  const uids = new Set(
    [...landings, ...owners].filter((p) => p.deviceUid).map((p) => p.deviceUid),
  );
  for (const uid of uids) {
    const res = fallbackSourceFrameMatches(g, label, uid, routes, source);
    if (res.status === "ambiguous")
      return {
        element: label.element,
        reason: `Net-label source device-frame ownership ambiguous: ${res.reason}`,
      };
  }
  return null;
}

function isSourceDeviceFrame(g, frame, label, routes, source) {
  if (frame.appearanceScope !== label.appearanceScope || !frame.deviceUid)
    return false;
  if (Array.isArray(g.netLabelSourceFrames))
    return g.netLabelSourceFrames.some(
      (e) =>
        e.labelElement === label.element &&
        e.deviceUid === frame.deviceUid &&
        e.status === "resolved" &&
        e.frameElement === frame.frameElement,
    );
  const res = fallbackSourceFrameMatches(
    g,
    label,
    frame.deviceUid,
    routes,
    source,
  );
  return res.status === "resolved" && res.frameElement === frame.frameElement;
}
function fallbackFrameOverlaps(g, label) {
  const labelBox = label.viewport
    ? boxIntersection(label.bbox, label.viewport)
    : label.bbox;
  if (labelBox.w <= 0.001 || labelBox.h <= 0.001) return [];
  const hits = [];
  for (const s of g.shapes ?? []) {
    if (!s.navigationFrame || !s.deviceUid || !s.bbox || s.omitted) continue;
    const frameBox = s.viewport ? boxIntersection(s.bbox, s.viewport) : s.bbox;
    if (frameBox.w <= 0.001 || frameBox.h <= 0.001) continue;
    const overlapBox = boxIntersection(labelBox, frameBox);
    if (overlapBox.w <= 0.001 || overlapBox.h <= 0.001) continue;
    hits.push({
      labelElement: label.element,
      frameElement: s.element,
      deviceUid: s.deviceUid,
      designation: s.designation,
      appearanceScope: s.appearanceScope,
      ownerGroup: s.ownerGroup,
      rawBbox: s.bbox,
      bbox: frameBox,
      overlapBox,
    });
  }
  return hits;
}
function foreignRouteHitsLabel(foreign, label) {
  let ink = label.bbox;
  for (const clip of [foreign.viewport, label.viewport])
    if (clip) ink = boxIntersection(ink, clip);
  if (ink.w <= 0 || ink.h <= 0) return false;
  const half = (foreign.stroke ?? 0) / 2;
  const expanded = {
    x: ink.x - half,
    y: ink.y - half,
    w: ink.w + 2 * half,
    h: ink.h + 2 * half,
  };
  return foreign.points.some(
    (b, i) => i && segmentHitsBox(foreign.points[i - 1], b, expanded),
  );
}
function netLabelApproachFindings(g, label, routes, source, issue) {
  if (
    label.omitted ||
    !label.bbox ||
    label.painted === false ||
    !painted(label)
  )
    return [];
  const ownRouteEls = new Set(routes.map((r) => r.element));
  const ownTrunkEls = source.trunkElements ?? new Set();
  const foreignRoutes = [
    ...(g.shapes ?? []).filter(
      (s) =>
        s.conductor &&
        s.appearanceScope === label.appearanceScope &&
        !ownRouteEls.has(s.element) &&
        (s.points?.length ?? 0) >= 2,
    ),
    ...(g.boundaryRoutes ?? []).filter(
      (b) =>
        b.appearanceScope === label.appearanceScope &&
        !ownTrunkEls.has(b.element) &&
        (b.points?.length ?? 0) >= 2,
    ),
  ];
  if (!foreignRoutes.length) return [];
  const ownStroke = Math.max(
    0,
    ...routes.map((r) => r.stroke ?? 0),
    ...(source.trunkStrokes ?? []),
  );
  const ownDist = boxToPolylineDistance(label.bbox, source.points, ownStroke);
  let nearestForeign = null,
    nearestDist = Infinity;
  for (const foreign of foreignRoutes) {
    if (foreignRouteHitsLabel(foreign, label))
      return [
        issue("net-label-foreign-ink", label, {
          edgeOwnerKey: label.labelOwnerKey,
          foreignElement: foreign.element,
          foreignWire: foreign.wire,
        }),
      ];
    const d = boxToPolylineDistance(
      label.bbox,
      foreign.points,
      foreign.stroke ?? 0,
    );
    if (d < nearestDist) {
      nearestDist = d;
      nearestForeign = foreign;
    }
  }
  return nearestForeign && nearestDist + APPROACH_EPSILON_MM < ownDist
    ? [
        issue("net-label-nearer-foreign-route", label, {
          edgeOwnerKey: label.labelOwnerKey,
          ownDistanceMm: ownDist,
          nearestForeignMm: nearestDist,
          foreignElement: nearestForeign.element,
          foreignWire: nearestForeign.wire,
        }),
      ]
    : [];
}
function netLabelForeignFrameFinding(g, label, routes, source, issue) {
  const browserMeasured = Array.isArray(g.netLabelFrameOverlaps);
  if (
    label.omitted ||
    !label.bbox ||
    (browserMeasured ? label.painted === false : !painted(label))
  )
    return;
  if (
    hasOwnershipGap(label, routes, source) ||
    sourceFrameOwnershipGap(g, label, routes, source)
  )
    return;
  const candidates = browserMeasured
    ? g.netLabelFrameOverlaps.filter((o) => o.labelElement === label.element)
    : fallbackFrameOverlaps(g, label);
  const foreign = candidates.find(
    (frame) => !isSourceDeviceFrame(g, frame, label, routes, source),
  );
  if (!foreign) return;
  return issue("net-label-in-foreign-device-frame", label, {
    edgeOwnerKey: label.labelOwnerKey,
    foreignFrameElement: foreign.frameElement,
    foreignDeviceUid: foreign.deviceUid,
    foreignDesignation: foreign.designation,
    foreignFrameBbox: foreign.bbox,
    overlapBbox: foreign.overlapBox,
  });
}
export function netLabelFindings(g, captionOwnershipFinding, issue, ir) {
  const out = [];
  for (const label of labels(g).filter(
    (t) => t.labelOwnerKind === "edge" && Array.isArray(t.labelOwnerKey),
  )) {
    if (label.conductorIdentityConflict)
      out.push(
        issue("net-label-owner-mismatch", label, {
          edgeOwnerKey: label.labelOwnerKey,
          declaredConductor: label.declaredConductor,
        }),
      );
    const routes = routesFor(g, label),
      source = sourceOrderedRoute(routes, g, ir, label);
    if (source.mismatch)
      out.push(
        issue("net-label-source-geometry-mismatch", label, {
          edgeOwnerKey: label.labelOwnerKey,
          ...source.mismatch,
        }),
      );
    else if (source.points) {
      const position = tailPosition(source, label, issue);
      if (position) out.push(position);
      out.push(...netLabelApproachFindings(g, label, routes, source, issue));
    }
    const foreignFrame = netLabelForeignFrameFinding(
      g,
      label,
      routes,
      source,
      issue,
    );
    if (foreignFrame) out.push(foreignFrame);
    const repeated = netRepetitionFinding(
      g,
      label,
      routes,
      source,
      captionOwnershipFinding,
      issue,
      ir,
    );
    if (repeated) out.push(repeated);
  }
  return out;
}
function netRepetitionFinding(
  g,
  label,
  routes,
  source,
  captionOwnershipFinding,
  issue,
  ir,
) {
  const names = [
    ...new Set(
      routes.map((s) => normalizedNetText(s.potentialName)).filter(Boolean),
    ),
  ];
  const text = label.omitted
    ? names.length === 1
      ? names[0]
      : undefined
    : normalizedNetText(label.text);
  if (!text) return;
  const { owners } = effectiveSourceLandings(routes, source);
  const caption = g.texts.find(
    (t) =>
      t.labelRole === "terminal" &&
      !captionOwnershipFinding(t) &&
      normalizedNetText(t.text) === text &&
      t.appearanceScope === label.appearanceScope &&
      owners.some(
        (p) =>
          p.deviceUid === t.deviceUid &&
          p.terminal === t.terminal &&
          p.terminalAppearance === t.terminalAppearance,
      ),
  );
  if (
    label.omitted &&
    !caption &&
    !survivingRailCaption(g, label, routes, text, ir)
  )
    return issue("net-label-suppressed-without-source-caption", label, {
      text,
      edgeOwnerKey: label.labelOwnerKey,
      reason: "no-matching-source-caption",
    });
  else if (!label.omitted && caption)
    return issue("net-label-repeats-terminal-caption", label, {
      text: label.text,
      edgeOwnerKey: label.labelOwnerKey,
      terminal: caption.terminal,
      deviceUid: caption.deviceUid,
      terminalAppearance: caption.terminalAppearance,
      otherElement: caption.element,
      otherBbox: caption.bbox,
    });
}
