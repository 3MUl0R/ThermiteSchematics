// Native Chromium painted-ink check for conductor or terminal-lead strokes
// crossing any painted terminal-label text run (#667, sibling to 5.35).
// All exported functions are serialized into the browser via measurementHelpers,
// so helpers are invoked strictly through c.h with no module-scope closures.

export function isTerminalLabelElement(text, e) {
  if (!text?.reviewPainted || !e) return false;
  if (text.labelRole === "net" || text.role?.includes("label-net"))
    return false;
  if (text.tagKind === "reference" || text.tagKind === "legend") return false;
  if (
    e.closest(
      '[data-tag-kind="reference"],[data-tag-kind="legend"],.off-view-annotation,[data-navigation-annotation],[data-report-row],[data-strip-inventory-label]',
    )
  )
    return false;
  return Boolean(
    text.labelRole === "terminal" ||
    text.role?.includes("label-terminal") ||
    text.terminal ||
    e.closest("[data-terminal-key]"),
  );
}

export function isConductorOrLeadStroke(e) {
  if (
    e.matches(".device-frame,.circuit-device-frame") ||
    e.closest("[data-terminal-key],[data-source-enclosure]")
  )
    return false;
  if (
    e.classList.contains("net-path") ||
    e.getAttribute("data-electrical-role") === "terminal-lead" ||
    e.closest(
      "[data-circuit-conductor],[data-wiring-conductor],[data-wire-uid],[data-loop-conductor],[data-terminal-attachment],[data-communication-link]",
    )
  )
    return true;
  return (
    e.tagName.toLowerCase() === "line" &&
    Boolean(e.closest("[data-function-interface]"))
  );
}

export function paintedNonWhiteStroke(c, e, css) {
  const rgba = c.colour(css.stroke);
  if (!rgba || !(rgba[3] > 0)) return false;
  if (rgba[0] >= 255 && rgba[1] >= 255 && rgba[2] >= 255) return false;
  if (
    !(Number.parseFloat(css.strokeWidth) > 0) ||
    Number(css.opacity) === 0 ||
    Number(css.strokeOpacity) === 0
  )
    return false;
  return !c
    .ancestors(e)
    .some((node) => Number(getComputedStyle(node).opacity) === 0);
}

export function buildConductorStrokeRecord(c, e) {
  const { visible, orders, intersect, sx, sy, h } = c;
  const v = visible(e);
  if (!v) return null;
  const css = getComputedStyle(e);
  if (!h.paintedNonWhiteStroke(c, e, css)) return null;
  const shapeClips = c.shapeClips(e);
  if (shapeClips === null) return null;
  const m = e.getScreenCTM();
  if (!m) return null;
  const radius = Number.parseFloat(css.strokeWidth) / 2;
  const join = css.strokeLinejoin.startsWith("miter")
    ? Math.max(2, Number(css.strokeMiterlimit))
    : 2;
  const pad =
    radius *
    join *
    Math.max(Math.hypot(m.a, m.c) * sx, Math.hypot(m.b, m.d) * sy);
  const bbox = h.expandClearanceBox(v.b, pad);
  const isLead =
    e.getAttribute("data-electrical-role") === "terminal-lead" ||
    Boolean(e.closest("[data-terminal-attachment],[data-function-interface]"));
  return {
    e,
    bbox,
    inverse: m.inverse(),
    clips: [v.clip, ...shapeClips],
    covers: c.occluders.filter((o) => {
      const shared = intersect(o.bbox, bbox);
      return o.order > orders.get(e) && shared.w > 0 && shared.h > 0;
    }),
    kind: isLead ? "terminal-lead" : "conductor",
    attachment: c.attr(e, "data-terminal-attachment") ?? null,
    conductorId:
      c.attr(e, "data-circuit-conductor") ??
      c.attr(e, "data-wiring-conductor") ??
      c.attr(e, "data-loop-conductor") ??
      c.attr(e, "data-wire-uid") ??
      c.attr(e, "data-communication-link") ??
      null,
  };
}

export function terminalLabelConductorStrokes(c) {
  const { h } = c;
  const shapes = c.root.querySelectorAll("path,line,polyline");
  const out = [];
  for (const e of shapes) {
    if (!h.isConductorOrLeadStroke(e)) continue;
    const record = h.buildConductorStrokeRecord(c, e);
    if (record) out.push(record);
  }
  return out;
}

export function terminalLabelRunEnvelope(c, text, e) {
  const local = c.h.paintedGlyphLocalBox(c, e, text);
  let box = local ? c.bounds(e, local) : text.bbox;
  const clips = c.shapeClips(e);
  if (clips === null) return null;
  for (const clip of [...(text.viewport ? [text.viewport] : []), ...clips])
    box = c.intersect(box, clip);
  return box.w > 0 && box.h > 0 ? box : null;
}

export function hitOnRunPerimeter(x0, y0, x1, y1, hit) {
  const edgeStep = 0.005;
  const round = (v) => Math.round(v * 1000) / 1000;
  const test = (x, y) => (hit({ x, y }) ? { x: round(x), y: round(y) } : null);
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
    [(x0 + x1) / 2, (y0 + y1) / 2],
  ]) {
    const found = test(x, y);
    if (found) return found;
  }
  for (let x = x0; x <= x1; x += edgeStep) {
    const top = test(x, y0);
    if (top) return top;
    const bottom = test(x, y1);
    if (bottom) return bottom;
  }
  for (let y = y0; y <= y1; y += edgeStep) {
    const left = test(x0, y);
    if (left) return left;
    const right = test(x1, y);
    if (right) return right;
  }
  return null;
}

export function strokeCrossesRunEnvelope(c, runBox, shape) {
  const overlap = c.intersect(runBox, shape.bbox);
  if (overlap.w <= 0 || overlap.h <= 0) return null;
  const hit = c.h.terminalLabelStrokeHit(c, shape);
  const x0 = overlap.x,
    y0 = overlap.y,
    x1 = overlap.x + overlap.w,
    y1 = overlap.y + overlap.h;
  const edgeHit = c.h.hitOnRunPerimeter(x0, y0, x1, y1, hit);
  if (edgeHit) return edgeHit;
  const step = Math.min(
    0.05,
    Math.max(0.005, Math.min(overlap.w, overlap.h) / 4),
  );
  const round = (v) => Math.round(v * 1000) / 1000;
  for (let y = y0 + step; y < y1; y += step)
    for (let x = x0 + step; x < x1; x += step)
      if (hit({ x, y })) return { x: round(x), y: round(y) };
  return null;
}

export function terminalLabelConductorCrossings(c) {
  const { texts, elementsById, ids, h } = c;
  const strokes = h.terminalLabelConductorStrokes(c);
  if (!strokes.length) return [];
  const round = (v) => Math.round(v * 1000) / 1000;
  const findings = [];
  for (const text of texts) {
    const e = elementsById.get(text.element);
    if (!h.isTerminalLabelElement(text, e)) continue;
    const runBox = h.terminalLabelRunEnvelope(c, text, e);
    if (!runBox) continue;
    const terminalKey =
      text.terminal ??
      e.closest("[data-terminal-key]")?.getAttribute("data-terminal-key") ??
      null;
    for (const shape of strokes) {
      const crossingPoint = h.strokeCrossesRunEnvelope(c, runBox, shape);
      if (!crossingPoint) continue;
      findings.push({
        caption: text,
        terminalKey,
        strokeElement: ids.get(shape.e),
        strokeKind: shape.kind,
        ...(shape.conductorId ? { conductorId: shape.conductorId } : {}),
        ...(shape.attachment ? { attachment: shape.attachment } : {}),
        crossingPoint,
        runBbox: {
          x: round(runBox.x),
          y: round(runBox.y),
          w: round(runBox.w),
          h: round(runBox.h),
        },
      });
    }
  }
  return findings;
}
