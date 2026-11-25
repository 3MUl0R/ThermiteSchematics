// Browser-only measurement helpers for DQ-17 net-label vs foreign device-frame checks.
export function visibleDeviceFrames(c) {
  const { attr, colour, ids, intersect, root, shapeClips, visible } = c;
  const selector = "rect.device-frame,rect.circuit-device-frame";
  return [...root.querySelectorAll(selector)].flatMap((e) => {
    if (
      e.closest(
        '[data-source-enclosure],[data-tag-kind="reference"],.off-view-annotation',
      )
    )
      return [];
    const deviceUid = attr(e, "data-device-uid");
    if (!deviceUid) return [];
    const v = visible(e);
    if (!v) return [];
    let clips;
    try {
      clips = shapeClips(e);
    } catch {
      return [];
    }
    if (clips === null) return [];
    const css = getComputedStyle(e);
    const strokeAlpha =
      (colour(css.stroke)?.[3] ?? 0) * Number.parseFloat(css.strokeOpacity);
    const fillAlpha =
      (colour(css.fill)?.[3] ?? 0) * Number.parseFloat(css.fillOpacity);
    const strokePainted =
      strokeAlpha > 0 && Number.parseFloat(css.strokeWidth) > 0;
    if (!strokePainted && !(fillAlpha > 0)) return [];
    const allClips = [v.clip, ...clips];
    const bbox = allClips.reduce((acc, clip) => intersect(acc, clip), v.b);
    if (bbox.w <= 0.001 || bbox.h <= 0.001) return [];
    return [
      {
        e,
        element: ids.get(e),
        deviceUid,
        designation: attr(e, "data-designation") ?? undefined,
        appearanceScope: ids.get(e.closest("svg")),
        ownerGroup: ids.get(
          e.closest("[data-circuit-functions],[data-device-uid]"),
        ),
        rawBbox: v.b,
        bbox,
        clips: allClips,
        inverse: e.getScreenCTM().inverse(),
      },
    ];
  });
}

export function glyphIntersectsFrameInterior(
  c,
  labelLayer,
  labelClips,
  frame,
  shared,
) {
  const { contains, glyphAt, rr, sx, sy } = c;
  const step = 0.1;
  const nx = Math.min(200, Math.max(2, Math.ceil(shared.w / step)));
  const ny = Math.min(80, Math.max(2, Math.ceil(shared.h / step)));
  for (let ix = 0; ix < nx; ix++) {
    const x = shared.x + ((ix + 0.5) / nx) * shared.w;
    for (let iy = 0; iy < ny; iy++) {
      const p = { x, y: shared.y + ((iy + 0.5) / ny) * shared.h };
      if (
        !labelClips.every((b) => contains(b, p)) ||
        !frame.clips.every((b) => contains(b, p))
      )
        continue;
      const local = new DOMPoint(
        rr.x + p.x / sx,
        rr.y + p.y / sy,
      ).matrixTransform(frame.inverse);
      if (frame.e.isPointInFill(local) && glyphAt(labelLayer, p)) return true;
    }
  }
  return false;
}

export function netLabelFrameOverlaps(c) {
  const { elementsById, h, intersect, shapeClips, texts } = c;
  const netLabels = texts.filter(
    (t) =>
      t.labelRole === "net" &&
      t.labelOwnerKind === "edge" &&
      !t.omitted &&
      t.painted !== false &&
      t.reviewPainted !== false &&
      t.bbox,
  );
  if (!netLabels.length) return [];
  const frames = h.visibleDeviceFrames(c);
  if (!frames.length) return [];
  const overlaps = [];
  for (const t of netLabels) {
    const el = elementsById.get(t.element);
    if (!el) continue;
    let clips;
    try {
      clips = shapeClips(el);
    } catch {
      continue;
    }
    if (clips === null) continue;
    const labelClips = [t.viewport, ...clips].filter(Boolean);
    const labelBox = labelClips.reduce(
      (acc, clip) => intersect(acc, clip),
      t.bbox,
    );
    if (labelBox.w <= 0.001 || labelBox.h <= 0.001) continue;
    const layer = {
      e: el,
      text: t,
      bbox: t.bbox,
      inverse: el.getScreenCTM().inverse(),
    };
    for (const frame of frames) {
      const shared = intersect(labelBox, frame.bbox);
      if (shared.w <= 0.001 || shared.h <= 0.001) continue;
      if (!h.glyphIntersectsFrameInterior(c, layer, labelClips, frame, shared))
        continue;
      overlaps.push({
        labelElement: t.element,
        frameElement: frame.element,
        deviceUid: frame.deviceUid,
        designation: frame.designation,
        appearanceScope: frame.appearanceScope,
        ownerGroup: frame.ownerGroup,
        rawBbox: frame.rawBbox,
        bbox: frame.bbox,
        overlapBox: shared,
      });
    }
  }
  return overlaps;
}
