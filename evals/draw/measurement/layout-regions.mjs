export function layoutRegionFields(c) {
  const { root, visible, intersect, ids, texts, devices } = c;
  const visibleRects = (selector) =>
    [...root.querySelectorAll(selector)].flatMap((e) => {
      const v = visible(e);
      return v && v.b.w > 0.1 && v.b.h > 0.1
        ? [{ element: ids.get(e), bbox: v.b }]
        : [];
    });
  const legendBoxes = visibleRects("rect.device-legend-frame");
  const assemblyLabelPlates = visibleRects("[data-assembly-label] > rect");
  const captionEls = new Set(
    root.querySelectorAll(
      ".label-location,.location-fragment-caption,[data-location-fragment-caption]",
    ),
  );
  const locationCaptions = texts.filter(
    (t) =>
      t.painted !== false && captionEls.has(c.elementsById.get(t.element)),
  );
  const locationFrames = [...root.querySelectorAll("rect.location-frame")]
    .flatMap((e) => {
      const v = visible(e);
      if (!v) return [];
      const vis = intersect(v.b, v.clip);
      if (vis.w <= 0.1 || vis.h <= 0.1) return [];
      const occupied = devices.some((d) => {
        if (!d.bbox) return false;
        const shared = intersect(d.bbox, vis);
        return shared.w > 0.1 && shared.h > 0.1;
      });
      const hasLocalCaption = locationCaptions.some((t) => {
        const cx = t.bbox.x + t.bbox.w / 2,
          cy = t.bbox.y + t.bbox.h / 2;
        return (
          cx >= vis.x - 1 &&
          cx <= vis.x + vis.w + 1 &&
          cy >= vis.y - 1 &&
          cy <= vis.y + vis.h + 1
        );
      });
      return [
        {
          element: ids.get(e),
          bbox: vis,
          occupied,
          hasLocalCaption,
        },
      ];
    });
  return { legendBoxes, locationFrames, assemblyLabelPlates };
}
