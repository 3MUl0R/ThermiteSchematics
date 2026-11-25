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

export function suffixOwnerClips(e, start, end, fillPaint, shapeClips) {
  const clips = [];
  const stack = [...e.childNodes].reverse();
  let offset = 0;
  while (stack.length) {
    const node = stack.pop();
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? "";
      const s = Math.max(start, offset);
      const t = Math.min(end, offset + text.length);
      if (s < t && /\S/u.test(text.slice(s - offset, t - offset))) {
        const owner = node.parentElement ?? e;
        const paint = fillPaint(owner);
        if (paint.alpha < 0.2 || paint.background) return null;
        try {
          const ownClips = shapeClips(owner);
          if (ownClips === null) return null;
          clips.push(...ownClips);
        } catch {
          return null;
        }
      }
      offset += text.length;
    } else if (node.nodeType === 1) {
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        stack.push(node.childNodes[i]);
    }
  }
  return clips;
}

export function classifyOutsideCountPaint(c) {
  const { bounds, elementsById, fillPaint, h, occlusion, shapeClips, texts } =
    c;
  for (const t of texts ?? []) {
    const rendered = t.renderedString ?? t.text ?? "";
    const renMatch = rendered.match(/\[\s*\+\d+\s*\]\s*$/u);
    if (!renMatch) continue;
    if (!t.reviewPainted) {
      t.outsideCountPainted = false;
      continue;
    }
    const e = elementsById.get(t.element);
    const raw = e?.textContent ?? "";
    const rawMatch = raw.match(/\[\s*\+\d+\s*\]\s*$/u);
    if (!e || !rawMatch || typeof e.getNumberOfChars !== "function") {
      t.outsideCountPainted = false;
      continue;
    }
    const ownerClips = h.suffixOwnerClips(
      e,
      rawMatch.index,
      rawMatch.index + rawMatch[0].length,
      fillPaint,
      shapeClips,
    );
    if (!ownerClips) {
      t.outsideCountPainted = false;
      continue;
    }
    const allClips = [t.viewport, ...ownerClips].filter(Boolean);
    const count = e.getNumberOfChars();
    const s0 = renMatch.index;
    const s1 = s0 + renMatch[0].length;
    let ok = count >= s1;
    for (let i = s0; ok && i < s1; i++) {
      if (/\s/u.test(rendered[i])) continue;
      const box = bounds(e, e.getExtentOfChar(i));
      const inClips =
        box.w > 0 &&
        box.h > 0 &&
        allClips.every(
          (b) =>
            box.x >= b.x - 0.001 &&
            box.y >= b.y - 0.001 &&
            box.x + box.w <= b.x + b.w + 0.001 &&
            box.y + box.h <= b.y + b.h + 0.001,
        );
      if (!inClips || occlusion({ ...t, bbox: box }) > 0.5) ok = false;
    }
    t.outsideCountPainted = ok;
  }
}

export function terminalOutsideBodies(c) {
  const { attr, h, ids, root, shapeClips, visible } = c;
  h.classifyOutsideCountPaint(c);
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
