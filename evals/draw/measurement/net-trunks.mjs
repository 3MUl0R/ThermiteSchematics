// Browser-only measurement helpers for DQ-17 shared source trunks and DQ-16 identity.
export function parsePortKey(e, name, attr, ownerKey) {
  const raw = attr(e, name);
  if (raw === null || raw === undefined) return undefined;
  try {
    const port = ownerKey(raw, "port");
    return Array.isArray(port) && port[0] === "port" ? port : undefined;
  } catch {
    return undefined;
  }
}

export function routePortFields(e, conductor, attr, ownerKey, h) {
  if (!conductor) return {};
  return {
    routeSourcePortKey: h.parsePortKey(
      e,
      "data-route-source-port-key",
      attr,
      ownerKey,
    ),
    routeTargetPortKey: h.parsePortKey(
      e,
      "data-route-target-port-key",
      attr,
      ownerKey,
    ),
  };
}

export function conductorIdentityFields(e, attr) {
  const declaredConductor =
    e.getAttribute("data-conductor") ??
    e.closest("text")?.getAttribute("data-conductor") ??
    undefined;
  const cableRoute =
    e.matches("path,line,polyline") &&
    e.hasAttribute("data-cable-uid") &&
    e.hasAttribute("data-conductor-id")
      ? JSON.stringify([
          e.getAttribute("data-cable-uid"),
          e.getAttribute("data-conductor-id"),
        ])
      : undefined;
  return {
    declaredConductor,
    wire:
      declaredConductor ??
      attr(e, "data-wire-label") ??
      attr(e, "data-wire-uid") ??
      attr(e, "data-jumper-uid") ??
      cableRoute ??
      attr(e, "data-circuit-conductor") ??
      attr(e, "data-wiring-conductor") ??
      attr(e, "data-loop-conductor"),
  };
}

export function parseTrunkConductors(e) {
  const raw = e.getAttribute("data-trunk-conductors");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) &&
      parsed.every((v) => typeof v === "string" && v.length > 0)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export function sampleRoutePoints(e, m, point, sx, sy) {
  if (typeof e.getTotalLength !== "function") return [];
  const length = e.getTotalLength();
  const count = Math.min(
    4000,
    Math.max(1, Math.ceil((length * Math.hypot(m.a * sx, m.b * sy)) / 0.2)),
  );
  return Array.from({ length: count + 1 }, (_, i) => {
    const q = e.getPointAtLength((length * i) / count);
    const p = new DOMPoint(q.x, q.y).matrixTransform(m);
    return point(p.x, p.y);
  });
}

export function collectJunctionDots(c) {
  const { attr, ids, ownerKey, point, root, visible } = c;
  return [...root.querySelectorAll("circle.junction-dot")].flatMap((e) => {
    const v = visible(e);
    if (!v) return [];
    let junctionId;
    try {
      const parsed = ownerKey(
        (e.id ?? "").replace(/^.*?(junction-)/, "$1"),
        "junction",
      );
      junctionId = Array.isArray(parsed) ? JSON.stringify(parsed) : undefined;
    } catch {
      junctionId = undefined;
    }
    const b = e.getBBox();
    const q = new DOMPoint(
      b.x + b.width / 2,
      b.y + b.height / 2,
    ).matrixTransform(e.getScreenCTM());
    return [
      {
        element: ids.get(e),
        appearanceScope: ids.get(e.closest("svg")),
        junctionId,
        deviceUid: attr(e, "data-device-uid") ?? undefined,
        terminal: attr(e, "data-terminal-key") ?? undefined,
        net: attr(e, "data-net-id") ?? undefined,
        anchor: point(q.x, q.y),
      },
    ];
  });
}

export function boundaryRouteEntry(c, e) {
  const {
    attr,
    h,
    ids,
    landingOwners,
    ownedLandings,
    ownerKey,
    point,
    rr,
    sx,
    sy,
    visible,
  } = c;
  const v = visible(e);
  if (!v) return null;
  const css = getComputedStyle(e);
  if (
    ["none", "white", "rgb(255, 255, 255)", "rgba(0, 0, 0, 0)"].includes(
      css.stroke,
    )
  )
    return null;
  const m = e.getScreenCTM();
  const stroke =
    parseFloat(css.strokeWidth) *
    Math.max(Math.hypot(m.a * sx, m.b * sy), Math.hypot(m.c * sx, m.d * sy));
  const endpoints = ["source", "target"].map((end) => ({
    deviceUid: attr(e, `data-${end}-device-uid`),
    terminalKey: attr(e, `data-${end}-terminal-key`),
  }));
  let edgeOwnerKey;
  try {
    const raw = attr(e, "data-edge-key");
    edgeOwnerKey = raw ? ownerKey(raw, "edge") : undefined;
  } catch {}
  const ports = h.routePortFields(e, true, attr, ownerKey, h);
  return {
    element: ids.get(e),
    appearanceScope: ids.get(e.closest("svg")),
    net: attr(e, "data-net-id") ?? undefined,
    stroke: css.stroke === "none" ? 0 : stroke,
    bbox: v.b,
    viewport: v.clip,
    points: h.sampleRoutePoints(e, m, point, sx, sy),
    routePath: e.getAttribute("d") ?? undefined,
    routeMatrix: [
      m.a * sx,
      m.b * sy,
      m.c * sx,
      m.d * sy,
      (m.e - rr.x) * sx,
      (m.f - rr.y) * sy,
    ],
    edgeOwnerKey,
    sourcePortKey: ports.routeSourcePortKey,
    targetPortKey: ports.routeTargetPortKey,
    endpoints,
    trunkConductors: h.parseTrunkConductors(e),
    landingOwners: landingOwners(e, endpoints),
    ownedLandings: ownedLandings(e, endpoints, v.clip),
  };
}

export function collectBoundaryRoutes(c) {
  const selector =
    "path.boundary-path,line.boundary-path,polyline.boundary-path";
  return [...c.root.querySelectorAll(selector)]
    .map((e) => c.h.boundaryRouteEntry(c, e))
    .filter(Boolean);
}

export function sourceTrunkFields(c) {
  return {
    junctionDots: c.h.collectJunctionDots(c),
    boundaryRoutes: c.h.collectBoundaryRoutes(c),
  };
}
