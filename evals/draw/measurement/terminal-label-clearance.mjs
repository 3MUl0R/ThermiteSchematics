// Sample painted glyphs and native SVG stroke hit areas in sheet millimetres.
// The 0.04 mm grid resolves joins and dash gaps below the DQ-02 accuracy.
export function terminalLabelStrokeGap(c, label, shape, region, minimum) {
  const { rr, sx, sy, contains, glyphAt } = c;
  const step = 0.04;
  const ink = [];
  let best = minimum * minimum;
  for (let x = region.x; x <= region.x + region.w; x += step)
    for (let y = region.y; y <= region.y + region.h; y += step) {
      const p = { x, y };
      if (contains(label.bbox, p) && glyphAt(label, p)) ink.push(p);
    }
  if (!ink.length) return minimum;
  for (let x = region.x; x <= region.x + region.w; x += step)
    for (let y = region.y; y <= region.y + region.h; y += step) {
      const p = { x, y };
      if (!shape.clips.every((clip) => contains(clip, p))) continue;
      const screen = new DOMPoint(rr.x + x / sx, rr.y + y / sy);
      if (!shape.e.isPointInStroke(screen.matrixTransform(shape.inverse)))
        continue;
      if (
        shape.covers.some(
          (cover) =>
            contains(cover.bbox, p) &&
            cover.clips.every((clip) => contains(clip, p)) &&
            cover.e.isPointInFill(screen.matrixTransform(cover.inverse)),
        )
      )
        continue;
      for (const q of ink)
        best = Math.min(best, (x - q.x) ** 2 + (y - q.y) ** 2);
      if (best === 0) return best;
    }
  return Math.sqrt(best);
}

export function expandClearanceBox({ x, y, w, h }, pad) {
  return { x: x - pad, y: y - pad, w: w + 2 * pad, h: h + 2 * pad };
}

export function terminalLabelBody(c, owner) {
  const { visible, orders, intersect, sx, sy, h } = c;
  const shapes = owner.querySelectorAll(
    "path,line,polyline,polygon,rect,circle,ellipse",
  );
  return [...shapes].flatMap((e) => {
    if (
      !e.closest(
        "[data-circuit-mark],[data-function-interface],[data-magnetic-association],[data-symbol-id]",
      ) ||
      e.closest("[data-terminal-key],[data-terminal-attachment]") ||
      e.closest("[data-circuit-functions],[data-device-uid]") !== owner ||
      e.matches(".device-frame,.circuit-device-frame")
    )
      return [];
    const v = visible(e),
      css = getComputedStyle(e);
    const rgba = c.colour(css.stroke);
    if (
      !v ||
      !rgba?.[3] ||
      Number(css.opacity) === 0 ||
      Number(css.strokeOpacity) === 0 ||
      c
        .ancestors(e)
        .some((node) => Number(getComputedStyle(node).opacity) === 0)
    )
      return [];
    const m = e.getScreenCTM();
    // Only the broad phase uses a bounding box. Native hit tests resolve ink.
    const radius = Number.parseFloat(css.strokeWidth) / 2;
    const join = css.strokeLinejoin.startsWith("miter")
      ? Math.max(2, Number(css.strokeMiterlimit))
      : 2;
    const pad =
      radius *
      join *
      Math.max(Math.hypot(m.a, m.c) * sx, Math.hypot(m.b, m.d) * sy);
    const bbox = h.expandClearanceBox(v.b, pad);
    return [
      {
        e,
        bbox,
        inverse: m.inverse(),
        clips: [v.clip, ...c.shapeClips(e)],
        covers: c.occluders.filter((o) => {
          const shared = intersect(o.bbox, bbox);
          return o.order > orders.get(e) && shared.w > 0 && shared.h > 0;
        }),
      },
    ];
  });
}

export function terminalLabelClearances(c, minimum) {
  const { texts, elementsById, ids, intersect, h } = c;
  const bodies = new Map();
  return texts.flatMap((text) => {
    const e = elementsById.get(text.element),
      terminal = e?.closest("[data-terminal-key]"),
      owner = terminal?.parentElement?.closest(
        "[data-circuit-functions],[data-device-uid]",
      );
    if (!text.reviewPainted || !owner) return [];
    const label = {
      e,
      text,
      bbox: text.bbox,
      inverse: e.getScreenCTM().inverse(),
    };
    let nearest,
      gapMm = minimum;
    if (!bodies.has(owner)) bodies.set(owner, h.terminalLabelBody(c, owner));
    for (const shape of bodies.get(owner)) {
      const region = intersect(
        h.expandClearanceBox(label.bbox, minimum),
        h.expandClearanceBox(shape.bbox, minimum),
      );
      if (region.w <= 0 || region.h <= 0) continue;
      const gap = h.terminalLabelStrokeGap(c, label, shape, region, gapMm);
      if (gap < gapMm) {
        gapMm = gap;
        nearest = shape;
      }
    }
    if (!nearest) return [];
    return [
      {
        caption: text,
        terminalKey: terminal.getAttribute("data-terminal-key"),
        bodyElement: ids.get(nearest.e),
        gapMm: Math.round(gapMm * 1000) / 1000,
        minimumMm: minimum,
      },
    ];
  });
}
