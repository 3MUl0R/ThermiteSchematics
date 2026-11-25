// Browser-only measurement helper; dependencies arrive explicitly from the caller.
export function outsideScopeIds(el, ids, isCircuit) {
  const nav = el.closest("[data-navigation-view]");
  const svg = el.closest("svg");
  const viewEl = nav && nav.closest("svg") === svg ? nav : svg;
  const viewScope = ids.get(viewEl);
  if (!isCircuit) return { viewScope, selectionScope: viewScope };
  const scopeEl =
    el.closest("[data-circuit-group]") ??
    el.closest("[data-circuit-part]") ??
    viewEl;
  return { viewScope, selectionScope: ids.get(scopeEl) };
}

export function paintedScopeCables(scopeEl, c, cache) {
  const { ids, strokeInk, visible } = c;
  const scopeId = ids.get(scopeEl);
  if (cache.has(scopeId)) return cache.get(scopeId);
  const skip =
    'defs,clipPath,mask,symbol,[data-tag-kind="reference"],.off-view-annotation';
  const cables = new Set();
  for (const el of scopeEl.querySelectorAll("[data-cable-assembly]")) {
    if (el.closest(skip)) continue;
    const uid = el.getAttribute("data-cable-assembly");
    if (!uid) continue;
    const shapes = [
      ...(el.matches("path,line,polyline") ? [el] : []),
      ...el.querySelectorAll("path,line,polyline"),
    ];
    if (
      shapes.some((p) => {
        const v = visible(p);
        return v && strokeInk(p, v.clip, p.getScreenCTM(), true).length > 0;
      })
    )
      cables.add(uid);
  }
  const list = [...cables];
  cache.set(scopeId, list);
  return list;
}

export function outsideRouteScopes(c) {
  const { elementsById, h, ids, shapes } = c;
  const scopes = {};
  for (const s of shapes ?? []) {
    if (!s.conductor && !s.loopConductor && !s.loopCandidate) continue;
    const el = elementsById.get(s.element);
    if (!el) continue;
    scopes[s.element] = h.outsideScopeIds(el, ids, true);
  }
  return scopes;
}

export function terminalOutsideBodies(c) {
  const { attr, h, ids, root, shapeClips, visible } = c;
  const cableCache = new Map();
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
    const { viewScope, selectionScope } = h.outsideScopeIds(
      bodyEl,
      ids,
      Boolean(circuitBody),
    );
    if (!selectionScope) continue;
    const bodyScope = ids.get(bodyEl);
    const key = JSON.stringify([bodyScope, terminal[0], terminal[1]]);
    const existing = seen.get(key);
    if (existing) {
      existing.markerBoxes.push(v.b);
      continue;
    }
    const scopeEl = c.elementsById.get(selectionScope);
    seen.set(key, {
      kind,
      deviceUid: terminal[0],
      terminal: terminal[1],
      bodyScope,
      bodyToken: bodyEl.getAttribute("data-terminal-body") ?? undefined,
      viewScope,
      selectionScope,
      selectedCables: scopeEl
        ? h.paintedScopeCables(scopeEl, c, cableCache)
        : [],
      element: ids.get(e),
      bbox: v.b,
      markerBoxes: [v.b],
    });
  }
  return [...seen.values()];
}
