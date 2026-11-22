export function frameCaptionStrings(locationCaptions, vis) {
  const inside = locationCaptions.filter((t) => {
    const cx = t.bbox.x + t.bbox.w / 2,
      cy = t.bbox.y + t.bbox.h / 2;
    return (
      cx >= vis.x - 1 &&
      cx <= vis.x + vis.w + 1 &&
      cy >= vis.y - 1 &&
      cy <= vis.y + vis.h + 1
    );
  });
  const grouped = new Map();
  const strings = [];
  for (const t of inside) {
    if (t.fragmentGroupId) {
      const list = grouped.get(t.fragmentGroupId) ?? [];
      list.push(t);
      grouped.set(t.fragmentGroupId, list);
    } else strings.push(t.text);
  }
  for (const lines of grouped.values()) {
    lines.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    strings.push(lines.map((l) => l.text).join(" "));
  }
  return strings;
}

export function collectLocationFrames(c) {
  const { root, visible, intersect, ids, texts, devices } = c;
  const captionEls = new Set(
    root.querySelectorAll(
      ".label-location,.location-fragment-caption,[data-location-fragment-caption]",
    ),
  );
  const locationCaptions = texts
    .filter(
      (t) =>
        t.painted !== false &&
        t.bbox &&
        captionEls.has(c.elementsById.get(t.element)),
    )
    .map((t) => ({
      ...t,
      fragmentGroupId:
        c.elementsById
          .get(t.element)
          ?.getAttribute("data-location-fragment-caption") ?? null,
    }));
  const normalize = (s) =>
    String(s ?? "")
      .replace(/\s+/gu, " ")
      .trim()
      .replace(/\s*\(CONT\.\)$/iu, "")
      .trim();
  return [...root.querySelectorAll("rect.location-frame")].flatMap((e) => {
    const v = visible(e);
    if (!v) return [];
    const vis = intersect(v.b, v.clip);
    if (vis.w <= 0.1 || vis.h <= 0.1) return [];
    const group = e.closest(
      ".location-group,[data-location],[data-virtual-location]",
    );
    const locationName =
      group?.getAttribute("data-location") ??
      group?.getAttribute("data-virtual-location") ??
      null;
    const occupied = devices.some((d) => {
      if (!d.bbox) return false;
      const shared = intersect(d.bbox, vis);
      return shared.w > 0.1 && shared.h > 0.1;
    });
    const captionStrings = c.h.frameCaptionStrings(locationCaptions, vis);
    const expected = locationName !== null ? normalize(locationName) : null;
    return [
      {
        element: ids.get(e),
        bbox: vis,
        occupied,
        locationName,
        foundCaptions: captionStrings,
        hasLocalCaption:
          !!expected && captionStrings.some((s) => normalize(s) === expected),
      },
    ];
  });
}

export function collectZoneColumnRules(c) {
  const { root, visible, ids } = c;
  return [...root.children]
    .filter((e) => e.matches("line,path,rect"))
    .flatMap((e) => {
      const v = visible(e);
      if (!v || v.b.h < 40 || v.b.w > 1 || v.b.x > 30) return [];
      const css = getComputedStyle(e);
      if (
        ["none", "rgb(255, 255, 255)", "rgba(0, 0, 0, 0)"].includes(
          css.stroke,
        ) ||
        !(parseFloat(css.strokeWidth) > 0)
      )
        return [];
      const m = e.getScreenCTM();
      const sw =
        parseFloat(css.strokeWidth) *
        Math.max(
          Math.hypot(m.a * c.sx, m.b * c.sy),
          Math.hypot(m.c * c.sx, m.d * c.sy),
        );
      return [
        {
          element: ids.get(e),
          x: v.b.x,
          right: v.b.x + v.b.w + sw / 2,
          y: v.b.y,
          h: v.b.h,
        },
      ];
    });
}

export function layoutRegionFields(c) {
  const { root, visible, ids, texts } = c;
  const visibleRects = (selector) =>
    [...root.querySelectorAll(selector)].flatMap((e) => {
      const v = visible(e);
      return v && v.b.w > 0.1 && v.b.h > 0.1
        ? [{ element: ids.get(e), bbox: v.b }]
        : [];
    });
  const locationFragmentFallbacks = texts
    .filter((t) => t.painted !== false && t.bbox)
    .flatMap((t) => {
      const el = c.elementsById.get(t.element);
      const kind = el?.getAttribute("data-location-fragment-fallback");
      return kind
        ? [
            {
              element: t.element,
              locationId:
                el.getAttribute("data-location-fragment-caption") ?? null,
              locationName: el.getAttribute("data-location-name") ?? null,
              kind,
              text: t.text,
              bbox: t.bbox,
            },
          ]
        : [];
    });
  return {
    legendBoxes: visibleRects("rect.device-legend-frame"),
    locationFrames: c.h.collectLocationFrames(c),
    assemblyLabelPlates: visibleRects("[data-assembly-label] > rect"),
    locationFragmentFallbacks,
    zoneColumnRules: c.h.collectZoneColumnRules(c),
  };
}

export function potentialRailFields(c) {
  const { root, visible, intersect, ids } = c;
  const potentialRails = [
    ...root.querySelectorAll(
      '[data-symbol-id^="ais:rail-"][data-boundary-kind="potential"]',
    ),
  ].flatMap((e) => {
    const v = visible(e);
    if (!v) return [];
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const shape of e.querySelectorAll("rect,line,circle,path,polyline")) {
      const sv = visible(shape);
      if (!sv) continue;
      const sb = intersect(sv.b, sv.clip);
      if (sb.w <= 0 || sb.h <= 0) continue;
      minX = Math.min(minX, sb.x);
      minY = Math.min(minY, sb.y);
      maxX = Math.max(maxX, sb.x + sb.w);
      maxY = Math.max(maxY, sb.y + sb.h);
    }
    const bbox =
      Number.isFinite(minX) && maxX > minX && maxY > minY
        ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
        : intersect(v.b, v.clip);
    if (bbox.w <= 0.05 || bbox.h <= 0.05) return [];
    return [
      {
        element: ids.get(e),
        deviceUid: e.getAttribute("data-device-uid"),
        potentialUid: e.getAttribute("data-potential-uid"),
        potentialName: e.getAttribute("data-potential-name"),
        netId: e.getAttribute("data-net-id"),
        terminalKey: e.getAttribute("data-terminal-key"),
        bbox,
      },
    ];
  });
  return { potentialRails };
}
