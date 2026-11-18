// Capture plate paint and drawing order separately from the legacy DQ-16
// distance exemption. The actual preceding fill, including clip and alpha,
// supplies the mask. Neither a renderer flag nor label text supplies a mask.
export function wirePlateGeometry(c) {
  const {
    texts,
    shapes,
    elementsById,
    visible,
    shapeClips,
    intersect,
    fillPaint,
    ids,
    orders,
  } = c;
  const plates = [];
  for (const t of texts) {
    const e = elementsById.get(t.element);
    if (
      !e?.closest("[data-wire-label],[data-wiring-conductor]") &&
      !e?.classList.contains("label-conductor")
    )
      continue;
    let rect = e.previousElementSibling;
    while (rect?.localName === "text") rect = rect.previousElementSibling;
    if (rect?.localName !== "rect") continue;
    const v = visible(rect),
      clips = shapeClips(rect),
      fill = fillPaint(rect);
    if (!v || !clips || fill.alpha < 0.999 || !fill.background) continue;
    const bbox = clips.reduce(
      (box, b) => intersect(box, b),
      intersect(v.b, v.clip),
    );
    if (bbox.w <= 0 || bbox.h <= 0) continue;
    plates.push({
      text: t.element,
      element: ids.get(rect),
      order: orders.get(rect),
      bbox,
    });
  }
  if (!plates.length) return { plates, strokes: {}, junctions: [] };
  const strokes = {};
  for (const s of shapes) {
    if (!s.conductor || !s.stroke) continue;
    const e = elementsById.get(s.element),
      css = getComputedStyle(e);
    const rgba = c.colour(css.stroke);
    let alpha = ((rgba?.[3] ?? 0) / 255) * Number(css.strokeOpacity);
    for (let p = e; p; p = p.parentElement)
      alpha *= Number(getComputedStyle(p).opacity);
    if (alpha < 0.2) continue;
    const clips = shapeClips(e);
    if (!clips) continue;
    strokes[s.element] = {
      order: orders.get(e),
      clip: clips.reduce((box, b) => intersect(box, b), s.viewport),
    };
  }
  return { plates, strokes, junctions: c.h.wirePlateJunctions(c) };
}

export function wirePlateJunctions(c) {
  const { root, visible, shapeClips, intersect, fillPaint, orders } = c;
  return [
    ...root.querySelectorAll(
      "circle.junction-dot,circle[data-wiring-junction],circle[data-circuit-junction]",
    ),
  ].flatMap((e) => {
    const v = visible(e),
      fill = fillPaint(e);
    if (!v || fill.background || fill.alpha < 0.2) return [];
    const clips = shapeClips(e);
    if (!clips) return [];
    const box = clips.reduce(
      (box, b) => intersect(box, b),
      intersect(v.b, v.clip),
    );
    return box.w > 0 && box.h > 0
      ? [{ bbox: v.b, clip: box, order: orders.get(e) }]
      : [];
  });
}
