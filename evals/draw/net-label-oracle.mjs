// Native SVG geometry, never renderer label planners or sourcePortId helpers.
import { finding, pointDistance } from "./review-geometry.mjs";
export const normalizedNetText = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
const labels = (g) =>
  [...g.texts, ...(g.omittedNetLabels ?? [])].filter(
    (t) => t.labelRole === "net" && t.labelOwnerKind === "edge",
  );
const routesFor = (g, label) =>
  g.shapes.filter(
    (s) =>
      s.conductor &&
      s.edgeOwnerKey &&
      s.appearanceScope === label.appearanceScope &&
      JSON.stringify(s.edgeOwnerKey) === JSON.stringify(label.labelOwnerKey),
  );
export function netOwnershipGaps(g) {
  return labels(g).flatMap((label) => {
    const routes = routesFor(g, label);
    return !Array.isArray(label.labelOwnerKey) ||
      !routes.length ||
      routes.some(
        (s) =>
          s.landingOwners?.some((p) => p.landingEnd === "unknown") ||
          s.ownedLandings?.some((p) => p.reason === "missing-route-port-owner"),
      )
      ? [
          {
            element: label.element,
            reason: "Historical net-label source ownership is unavailable",
          },
        ]
      : [];
  });
}
function sourceGeometry(route, label) {
  const source = route.ownedLandings?.find((p) => p.end === "source");
  const start = route.points?.[0];
  if (source?.anchor && start && pointDistance(start, source.anchor) > 0.05)
    return finding("net-label-source-geometry-mismatch", label, {
      edgeOwnerKey: label.labelOwnerKey,
      pathStart: start,
      claimedSourceAnchor: source.anchor,
    });
}
// Locate the painted reservation on the polyline itself. TAIL occupies the
// source half of the route; endpoint owner flags cannot reverse path direction.
function tailPosition(route, label) {
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
    return finding("net-label-not-at-route-source", label, {
      edgeOwnerKey: label.labelOwnerKey,
      routeLength: total,
      labelDistanceAlongRoute: at,
    });
}
export function netLabelFindings(g, captionOwnershipFinding) {
  const out = [];
  for (const label of labels(g).filter((t) => Array.isArray(t.labelOwnerKey))) {
    const routes = routesFor(g, label);
    for (const route of routes) {
      const source = sourceGeometry(route, label),
        position = tailPosition(route, label);
      if (source) out.push(source);
      if (position) out.push(position);
    }
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
    if (!text) continue;
    const caption = g.texts.find(
      (t) =>
        t.labelRole === "terminal" &&
        !captionOwnershipFinding(t) &&
        normalizedNetText(t.text) === text &&
        t.appearanceScope === label.appearanceScope &&
        routes.some((s) =>
          s.landingOwners?.some(
            (p) =>
              p.landingEnd === "source" &&
              p.deviceUid === t.deviceUid &&
              p.terminal === t.terminal &&
              p.terminalAppearance === t.terminalAppearance,
          ),
        ),
    );
    if (label.omitted && !caption)
      out.push(
        finding("net-label-suppressed-without-source-caption", label, {
          text,
          edgeOwnerKey: label.labelOwnerKey,
          reason: "no-matching-source-caption",
        }),
      );
    else if (!label.omitted && caption)
      out.push(
        finding("net-label-repeats-terminal-caption", label, {
          text: label.text,
          edgeOwnerKey: label.labelOwnerKey,
          terminal: caption.terminal,
          deviceUid: caption.deviceUid,
          terminalAppearance: caption.terminalAppearance,
          otherElement: caption.element,
          otherBbox: caption.bbox,
        }),
      );
  }
  return out;
}
