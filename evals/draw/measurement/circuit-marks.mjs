export function circuitRouteFields(e, endpoints, conductor, attr, ownerKey, h) {
  return {
    endpoints,
    circuitFanIn: endpoints
      ? (e.getAttribute("data-circuit-fan-in") ?? undefined)
      : undefined,
    ...(h && conductor
      ? h.routePortFields(e, conductor, attr, ownerKey, h)
      : {}),
  };
}

export function circuitCaptionFallbacks({ root, identity, visible }) {
  const selector = "[data-circuit-caption-fallback]";
  const markers = [...root.querySelectorAll(selector)];
  if (root.matches(selector)) markers.unshift(root);
  return markers.map((e) => ({
    ...identity(e),
    bbox: visible(e)?.b,
    fallback: e.getAttribute("data-circuit-caption-fallback"),
    text: e.textContent.trim(),
  }));
}

export function fanInPhysicalTerminal(c) {
  const { all, anchor, anchorElement, deviceUid, e, h, scope, terminal } = c;
  const port = anchorElement?.getAttribute("data-circuit-landing-for");
  if (!port) return anchor;
  const group = e.closest("[data-circuit-group]");
  const candidates = all.filter(
    (element) =>
      element.getAttribute("data-layout-port") === port &&
      element.closest("svg") === scope &&
      element.closest("[data-circuit-group]") === group,
  );
  const physical = { ...c, candidates };
  h.measureLandingAnchor(physical);
  if (physical.deviceUid === deviceUid && physical.terminal === terminal)
    return physical.anchor;
}

export function circuitPrimitiveFunctionId(e, attr) {
  const raw = attr(e, "data-function-id");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        typeof parsed[0] === "string" &&
        typeof parsed[1] === "string"
      )
        return parsed;
    } catch {}
  }
  const uid = attr(e, "data-device-uid"),
    fk = attr(e, "data-function-key");
  return uid && fk ? [uid, fk] : null;
}

export function isCircuitPrimitiveElement(e) {
  const cls = e.getAttribute("class") ?? "";
  if (
    e.closest(
      '[data-tag-kind="reference"],.off-view-annotation,[data-navigation-annotation],[data-report-row]',
    ) ||
    e.hasAttribute("data-terminal-marker") ||
    cls.includes("terminal-marker") ||
    cls.includes("junction-dot") ||
    cls.includes("label-background") ||
    e.hasAttribute("data-circuit-junction") ||
    e.hasAttribute("data-wiring-junction") ||
    cls.includes("net-path") ||
    cls.includes("boundary-path") ||
    e.closest(
      "[data-circuit-conductor],[data-wiring-conductor],[data-wire-uid],[data-loop-conductor]",
    )
  )
    return false;
  if (e.closest("[data-symbol-id]") && !e.closest("[data-circuit-mark]"))
    return false;
  return Boolean(
    e.hasAttribute("data-electrical-role") ||
    cls.includes("circuit-device-frame") ||
    e.closest(
      "[data-circuit-mark],[data-function-interface],[data-terminal-attachment],[data-magnetic-association],[data-mechanical-association],[data-source-enclosure],[data-function-id],[data-function-key],[data-circuit-functions]",
    ),
  );
}

export function collectCircuitPrimitives(c) {
  const { attr, fillPaint, h, ids, point, root, strokeInk, sx, sy, visible } =
    c;
  if (!root.querySelector("[data-circuit-mark]")) return [];
  return Array.from(
    root.querySelectorAll("path,line,polyline,polygon,rect,circle,ellipse"),
  ).flatMap((e) => {
    if (!h.isCircuitPrimitiveElement(e)) return [];
    const v = visible(e);
    if (!v) return [];
    const css = getComputedStyle(e),
      m = e.getScreenCTM();
    const fill = fillPaint(e),
      filled = fill.alpha >= 0.2 && !fill.background;
    const segments = strokeInk(e, v.clip, m, true);
    if (!segments.length && !filled) return [];
    const scale = Math.max(
      Math.hypot(m.a * sx, m.b * sy),
      Math.hypot(m.c * sx, m.d * sy),
    );
    const stroke =
      css.stroke === "none" ? 0 : parseFloat(css.strokeWidth) * scale;
    let points = [];
    if (filled && typeof e.getTotalLength === "function") {
      const len = e.getTotalLength(),
        n = Math.min(200, Math.max(4, Math.ceil((len * scale) / 0.5)));
      points = Array.from({ length: n + 1 }, (_, i) => {
        const q = e.getPointAtLength((len * i) / n).matrixTransform(m);
        return point(q.x, q.y);
      });
    }
    const cls = e.getAttribute("class") ?? "";
    return [
      {
        element: ids.get(e),
        shapeTag: e.tagName.toLowerCase(),
        bbox: v.b,
        stroke,
        dash: css.strokeDasharray,
        segments,
        filled,
        points,
        electricalRole: e.getAttribute("data-electrical-role"),
        electricalRoleDeclared: e.hasAttribute("data-electrical-role"),
        mark: attr(e, "data-circuit-mark"),
        markScope: ids.get(e.closest("[data-circuit-mark]")),
        functionInterface: attr(e, "data-function-interface"),
        attachment: attr(e, "data-terminal-attachment"),
        sourceEnclosure: !!e.closest("[data-source-enclosure]"),
        deviceFrame: cls.includes("circuit-device-frame"),
        magneticAssociation: attr(e, "data-magnetic-association"),
        mechanicalAssociation: attr(e, "data-mechanical-association"),
        circuitRole: e.getAttribute("data-circuit-role"),
        functionId: h.circuitPrimitiveFunctionId(e, attr),
        deviceUid: attr(e, "data-device-uid"),
        designation: attr(e, "data-designation"),
        appearanceScope: ids.get(e.closest("svg")),
      },
    ];
  });
}
