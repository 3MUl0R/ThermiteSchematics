// Browser-only measurement helper; dependencies arrive explicitly from the caller.
export function hasPaintedStroke(el, visible, h) {
  const shapes = [
    ...(el.matches("path,line,polyline") ? [el] : []),
    ...el.querySelectorAll("path,line,polyline"),
  ];
  return shapes.some((p) => {
    const v = visible(p);
    if (!v) return false;
    const css = getComputedStyle(p);
    return h.paintColorAlpha(css.stroke) > 0 && parseFloat(css.strokeWidth) > 0;
  });
}

export function selectionScopeConductors(scopeEl, c, cache) {
  const { h, ids, visible } = c;
  const scopeId = ids.get(scopeEl);
  if (cache.has(scopeId)) return cache.get(scopeId);
  const skip =
    'defs,clipPath,mask,symbol,[data-tag-kind="reference"],.off-view-annotation';
  const conductors = new Set();
  for (const el of scopeEl.querySelectorAll(
    "[data-circuit-conductor],[data-wiring-conductor],[data-loop-conductor]",
  )) {
    if (el.closest(skip)) continue;
    const raw =
      el.getAttribute("data-circuit-conductor") ??
      el.getAttribute("data-wiring-conductor") ??
      el.getAttribute("data-loop-conductor");
    if (raw && h.hasPaintedStroke(el, visible, h)) conductors.add(raw);
  }
  const cables = new Set();
  for (const el of scopeEl.querySelectorAll("[data-cable-assembly]")) {
    if (el.closest(skip)) continue;
    const uid = el.getAttribute("data-cable-assembly");
    if (uid && h.hasPaintedStroke(el, visible, h)) cables.add(uid);
  }
  const info = {
    selectionScope: scopeId,
    conductors: [...conductors],
    cables: [...cables],
  };
  cache.set(scopeId, info);
  return info;
}

export function terminalOutsideBodies(c) {
  const { attr, h, ids, root, shapeClips, visible } = c;
  const cache = new Map();
  const seen = new Map();
  for (const e of root.querySelectorAll(
    "circle[data-terminal-key],circle[data-loop-terminal],g[data-terminal-id] > circle[data-terminal-marker],g[data-loop-terminal] > circle[data-terminal-marker],g[data-layout-port][data-terminal-key] > circle[data-terminal-marker]",
  )) {
    if (!h.isEligibleWireTerminalCircle(e)) continue;
    if (
      e.closest(
        "g[data-symbol-id],[data-terminal-strip],[data-communication-port],[data-connector-port]",
      )
    )
      continue;
    const v = h.wireTerminalCirclePainted(e, visible, shapeClips, h);
    if (!v) continue;
    const terminal = h.wireTerminalIdentity(e, attr, h);
    if (!Array.isArray(terminal) || !terminal[0] || !terminal[1]) continue;
    const circuitBody = e.closest("[data-circuit-functions]");
    const bodyEl = circuitBody ?? e.closest("[data-device-uid]");
    if (!bodyEl) continue;
    const kind = circuitBody
      ? "circuit"
      : e.closest("[data-loop-terminal]") ||
          e.hasAttribute("data-loop-terminal")
        ? "signal-loop"
        : "wiring";
    const scopeEl = circuitBody
      ? (bodyEl.closest("[data-circuit-group]") ??
        bodyEl.closest("[data-circuit-part]") ??
        bodyEl.closest("[data-navigation-view]") ??
        bodyEl.closest("svg"))
      : (bodyEl.closest("[data-navigation-view]") ?? bodyEl.closest("svg"));
    if (!scopeEl) continue;
    const bodyScope = ids.get(bodyEl);
    const key = JSON.stringify([bodyScope, terminal[0], terminal[1]]);
    if (seen.has(key)) continue;
    const scope = h.selectionScopeConductors(scopeEl, c, cache);
    seen.set(key, {
      kind,
      deviceUid: terminal[0],
      terminal: terminal[1],
      bodyScope,
      bodyToken: bodyEl.getAttribute("data-terminal-body") ?? undefined,
      selectionScope: scope.selectionScope,
      selectedConductors: scope.conductors,
      selectedCables: scope.cables,
      element: ids.get(e),
      bbox: v.b,
    });
  }
  return [...seen.values()];
}
