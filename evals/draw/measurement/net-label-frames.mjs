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
    let clips, clipError;
    try {
      clips = shapeClips(e);
    } catch (error) {
      clipError = error?.message ?? String(error);
    }
    if (!clipError && clips === null) return [];
    const css = getComputedStyle(e);
    const strokeAlpha =
      (colour(css.stroke)?.[3] ?? 0) * Number.parseFloat(css.strokeOpacity);
    const fillAlpha =
      (colour(css.fill)?.[3] ?? 0) * Number.parseFloat(css.fillOpacity);
    const strokePainted =
      strokeAlpha > 0 && Number.parseFloat(css.strokeWidth) > 0;
    if (!strokePainted && !(fillAlpha > 0)) return [];
    const allClips = [v.clip, ...(clips ?? [])];
    const bbox = allClips.reduce((acc, clip) => intersect(acc, clip), v.b);
    if (bbox.w <= 0.001 || bbox.h <= 0.001) return [];
    return [
      {
        e,
        element: ids.get(e),
        deviceUid,
        designation: attr(e, "data-designation") ?? undefined,
        appearanceScope: ids.get(e.closest("svg")),
        ownerEl:
          e.closest("[data-circuit-tag-lane]") ??
          e.closest("[data-circuit-functions],.device-group,[data-device-uid]"),
        ownerGroup: ids.get(
          e.closest("[data-circuit-functions],[data-device-uid]"),
        ),
        rawBbox: v.b,
        bbox,
        clips: allClips,
        ...(clipError ? { clipError } : {}),
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

export function measureLabelAgainstFrames(
  c,
  t,
  el,
  labelClips,
  labelBox,
  frames,
  overlaps,
  gaps,
) {
  const { h, intersect } = c;
  const layer = {
    e: el,
    text: t,
    bbox: t.bbox,
    inverse: el.getScreenCTM().inverse(),
  };
  for (const frame of frames) {
    const shared = intersect(labelBox, frame.bbox);
    if (shared.w <= 0.001 || shared.h <= 0.001) continue;
    if (frame.clipError) {
      gaps.push({
        element: t.element,
        frameElement: frame.element,
        reason: `Net-label frame check unsupported clip/mask on device frame: ${frame.clipError}`,
      });
      continue;
    }
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

export function measureNetLabelFrames(c) {
  const { elementsById, fillPaint, h, intersect, shapeClips, texts } = c;
  const netLabels = texts.filter(
    (t) =>
      t.labelRole === "net" &&
      t.labelOwnerKind === "edge" &&
      !t.omitted &&
      t.painted !== false &&
      t.bbox,
  );
  if (!netLabels.length) return { overlaps: [], gaps: [] };
  const frames = h.visibleDeviceFrames(c);
  if (!frames.length) return { overlaps: [], gaps: [] };
  const overlaps = [];
  const gaps = [];
  for (const t of netLabels) {
    const el = elementsById.get(t.element);
    if (!el) continue;
    const paint = fillPaint(el);
    if (paint.alpha < 0.2 || paint.background) continue;
    let clips;
    try {
      clips = shapeClips(el);
    } catch (error) {
      gaps.push({
        element: t.element,
        reason: `Net-label frame check unsupported clip/mask on label: ${error?.message ?? String(error)}`,
      });
      continue;
    }
    if (clips === null) continue;
    const labelClips = [t.viewport, ...clips].filter(Boolean);
    const labelBox = labelClips.reduce(
      (acc, clip) => intersect(acc, clip),
      t.bbox,
    );
    if (labelBox.w <= 0.001 || labelBox.h <= 0.001) continue;
    h.measureLabelAgainstFrames(
      c,
      t,
      el,
      labelClips,
      labelBox,
      frames,
      overlaps,
      gaps,
    );
  }
  return { overlaps, gaps };
}

export function netLabelFrameOverlaps(c) {
  return c.h.measureNetLabelFrames(c).overlaps;
}

export function uniqueSiblingFrame(anchor, bodyBox, sameUidFrames) {
  const tol = 0.001;
  const pointIn = (p, b) =>
    Boolean(
      p &&
      b &&
      p.x >= b.x - tol &&
      p.x <= b.x + b.w + tol &&
      p.y >= b.y - tol &&
      p.y <= b.y + b.h + tol,
    );
  const boxIn = (inner, outer) =>
    Boolean(
      inner &&
      outer &&
      inner.x >= outer.x - tol &&
      inner.y >= outer.y - tol &&
      inner.x + inner.w <= outer.x + outer.w + tol &&
      inner.y + inner.h <= outer.y + outer.h + tol,
    );
  const anchorHits = anchor
    ? sameUidFrames.filter((f) => pointIn(anchor, f.rawBbox))
    : [];
  if (anchorHits.length === 1)
    return { status: "resolved", frameElement: anchorHits[0].element };
  if (anchorHits.length > 1) {
    const bodyHits = bodyBox
      ? anchorHits.filter((f) => boxIn(bodyBox, f.rawBbox))
      : [];
    return bodyHits.length === 1
      ? { status: "resolved", frameElement: bodyHits[0].element }
      : {
          status: "ambiguous",
          reason:
            "multiple sibling same-UID device frames geometrically match the source appearance",
        };
  }
  const bodyHits = bodyBox
    ? sameUidFrames.filter((f) => boxIn(bodyBox, f.rawBbox))
    : [];
  if (bodyHits.length === 1)
    return { status: "resolved", frameElement: bodyHits[0].element };
  if (bodyHits.length > 1)
    return {
      status: "ambiguous",
      reason:
        "multiple sibling same-UID device frames enclose the source appearance",
    };
  return { status: "none" };
}

export function resolveSourceAppearanceFrame(c, src, sameUidFrames) {
  if (!sameUidFrames.length) return { status: "none" };
  const { bounds, elementsById, h } = c;
  const anchorEl = src.anchorElement
    ? elementsById.get(src.anchorElement)
    : null;
  const bodyEl = src.terminalAppearance
    ? elementsById.get(src.terminalAppearance)
    : null;
  const direct = sameUidFrames.filter((f) =>
    Boolean(
      (f.ownerEl && anchorEl && f.ownerEl.contains(anchorEl)) ||
      (f.ownerEl && bodyEl && f.ownerEl.contains(bodyEl)) ||
      (bodyEl && bodyEl.contains(f.e)),
    ),
  );
  if (direct.length === 1)
    return { status: "resolved", frameElement: direct[0].element };
  if (direct.length > 1)
    return {
      status: "ambiguous",
      reason: "multiple same-UID device frames contain the source appearance",
    };
  const bodyBox = bodyEl ? bounds(bodyEl) : anchorEl ? bounds(anchorEl) : null;
  return h.uniqueSiblingFrame(src.anchor, bodyBox, sameUidFrames);
}

export function routeSourceAppearances(routes) {
  const seen = new Set();
  const out = [];
  for (const r of routes) {
    const owners = (r.landingOwners ?? []).filter(
      (p) => p.landingEnd === "source" && p.deviceUid,
    );
    const landings = (r.ownedLandings ?? []).filter(
      (p) => p.end === "source" && p.deviceUid,
    );
    const sources = landings.length
      ? landings.map((l) => {
          const o = owners.find(
            (p) =>
              (l.anchorElement && p.anchorElement === l.anchorElement) ||
              (p.deviceUid === l.deviceUid && p.terminal === l.terminal),
          );
          return {
            deviceUid: l.deviceUid,
            anchorElement: l.anchorElement ?? o?.anchorElement,
            terminalAppearance: o?.terminalAppearance,
            anchor: l.anchor,
          };
        })
      : owners.map((o) => ({
          deviceUid: o.deviceUid,
          anchorElement: o.anchorElement,
          terminalAppearance: o.terminalAppearance,
          anchor: undefined,
        }));
    for (const src of sources) {
      const dedupKey = JSON.stringify([
        src.deviceUid,
        src.anchorElement ?? null,
        src.terminalAppearance ?? null,
      ]);
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      out.push(src);
    }
  }
  return out;
}

export function netLabelSourceFrames(c, shapes) {
  const { h, texts } = c;
  const netLabels = texts.filter(
    (t) =>
      t.labelRole === "net" &&
      t.labelOwnerKind === "edge" &&
      !t.omitted &&
      Array.isArray(t.labelOwnerKey),
  );
  if (!netLabels.length) return [];
  const frames = h.visibleDeviceFrames(c);
  if (!frames.length) return [];
  const out = [];
  for (const label of netLabels) {
    const key = JSON.stringify(label.labelOwnerKey);
    const routes = (shapes ?? []).filter(
      (s) =>
        s.conductor &&
        s.edgeOwnerKey &&
        s.appearanceScope === label.appearanceScope &&
        JSON.stringify(s.edgeOwnerKey) === key,
    );
    for (const src of h.routeSourceAppearances(routes)) {
      const sameUidFrames = frames.filter(
        (f) =>
          f.appearanceScope === label.appearanceScope &&
          f.deviceUid === src.deviceUid,
      );
      const resolved = h.resolveSourceAppearanceFrame(c, src, sameUidFrames);
      out.push({
        labelElement: label.element,
        deviceUid: src.deviceUid,
        ...resolved,
      });
    }
  }
  return out;
}
