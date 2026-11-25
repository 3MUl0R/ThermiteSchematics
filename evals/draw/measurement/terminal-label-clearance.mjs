// Store horizontal runs on the common sheet-millimetre grid.
export function terminalLabelInkRows(box, step, hit) {
  const rows = [];
  const firstX = Math.ceil(box.x / step),
    lastX = Math.floor((box.x + box.w) / step);
  const firstY = Math.ceil(box.y / step),
    lastY = Math.floor((box.y + box.h) / step);
  for (let row = firstY; row <= lastY; row++) {
    const runs = [];
    let start;
    for (let col = firstX; col <= lastX; col++) {
      if (hit({ x: col * step, y: row * step })) {
        start ??= col;
      } else if (start !== undefined) {
        runs.push([start, col - 1]);
        start = undefined;
      }
    }
    if (start !== undefined) runs.push([start, lastX]);
    if (runs.length) rows.push({ row, runs });
  }
  return rows;
}

export function terminalLabelRunGap(ink, stroke, step, cutoff) {
  const limit = (cutoff / step) ** 2;
  let best = limit,
    first = 0,
    pair;
  for (const { row, runs } of stroke) {
    while (
      first < ink.length &&
      ink[first].row < row &&
      (row - ink[first].row) ** 2 >= best
    )
      first++;
    for (let i = first; i < ink.length; i++) {
      const dy = (row - ink[i].row) ** 2;
      if (dy >= best) break;
      for (const [a, b] of runs)
        for (const [x, y] of ink[i].runs) {
          const dx = Math.max(0, a - y, x - b);
          const d2 = dy + dx * dx;
          if (d2 < best) {
            best = d2;
            const sx = a > y ? a : x > b ? b : Math.max(a, x);
            const lx = a > y ? y : x > b ? x : Math.max(a, x);
            pair = {
              sx: sx * step,
              sy: row * step,
              lx: lx * step,
              ly: ink[i].row * step,
            };
          }
        }
      if (best === 0) return { gap: 0, pair };
    }
  }
  return { gap: best === limit ? cutoff : Math.sqrt(best) * step, pair };
}

export function terminalLabelStrokeHit(c, shape) {
  const { rr, sx, sy, contains } = c;
  return (p) => {
    if (!shape.clips.every((clip) => contains(clip, p))) return false;
    const screen = new DOMPoint(rr.x + p.x / sx, rr.y + p.y / sy);
    return (
      shape.e.isPointInStroke(screen.matrixTransform(shape.inverse)) &&
      !shape.covers.some(
        (cover) =>
          contains(cover.bbox, p) &&
          cover.clips.every((clip) => contains(clip, p)) &&
          cover.e.isPointInFill(screen.matrixTransform(cover.inverse)),
      )
    );
  };
}

export function terminalLabelNearCutoff(ink, stroke, step, cutoff) {
  const limit = (cutoff / step) ** 2;
  let first = 0;
  const inkNear = new Map(),
    strokeNear = new Map();
  const add = (map, row, lo, hi) => {
    let list = map.get(row);
    if (!list) {
      list = [];
      map.set(row, list);
    }
    list.push([lo, hi]);
  };
  for (const { row, runs } of stroke) {
    while (
      first < ink.length &&
      ink[first].row < row &&
      (row - ink[first].row) ** 2 >= limit
    )
      first++;
    for (let i = first; i < ink.length; i++) {
      const dy2 = (row - ink[i].row) ** 2;
      if (dy2 >= limit) break;
      const maxDx = Math.floor(Math.sqrt(limit - dy2));
      for (const [a, b] of runs)
        for (const [x, y] of ink[i].runs) {
          const dx = Math.max(0, a - y, x - b);
          if (dy2 + dx * dx >= limit) continue;
          add(strokeNear, row, Math.max(a, x - maxDx), Math.min(b, y + maxDx));
          add(
            inkNear,
            ink[i].row,
            Math.max(x, a - maxDx),
            Math.min(y, b + maxDx),
          );
        }
    }
  }
  return { inkNear, strokeNear };
}

export function terminalLabelFineRows(
  box,
  nearMap,
  coarseStep,
  fineStep,
  pad,
  hit,
) {
  const firstX = Math.ceil(box.x / fineStep),
    lastX = Math.floor((box.x + box.w) / fineStep),
    firstY = Math.ceil(box.y / fineStep),
    lastY = Math.floor((box.y + box.h) / fineStep);
  if (firstX > lastX || firstY > lastY) return [];
  const ratio = Math.round(coarseStep / fineStep),
    padFine = Math.ceil(pad / fineStep),
    byRow = new Map();
  const merge = (list) => {
    list.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [lo, hi] of list) {
      const prev = out.at(-1);
      if (prev && lo <= prev[1] + 1) prev[1] = Math.max(prev[1], hi);
      else out.push([lo, hi]);
    }
    return out;
  };
  for (const [coarseRow, intervals] of nearMap) {
    const merged = merge(intervals);
    const rLo = Math.max(firstY, coarseRow * ratio - padFine),
      rHi = Math.min(lastY, coarseRow * ratio + padFine);
    for (let r = rLo; r <= rHi; r++) {
      let rowList = byRow.get(r);
      if (!rowList) {
        rowList = [];
        byRow.set(r, rowList);
      }
      for (const [lo, hi] of merged) {
        const cLo = Math.max(firstX, lo * ratio - padFine),
          cHi = Math.min(lastX, hi * ratio + padFine);
        if (cLo <= cHi) rowList.push([cLo, cHi]);
      }
    }
  }
  const rows = [];
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    const runs = [];
    let start;
    for (const [cLo, cHi] of merge(byRow.get(row))) {
      for (let col = cLo; col <= cHi; col++) {
        if (hit({ x: col * fineStep, y: row * fineStep })) {
          start ??= col;
        } else if (start !== undefined) {
          runs.push([start, col - 1]);
          start = undefined;
        }
      }
      if (start !== undefined) {
        runs.push([start, cHi]);
        start = undefined;
      }
    }
    if (runs.length) rows.push({ row, runs });
  }
  return rows;
}

export function terminalLabelDirectFineGap(
  h,
  labelRegion,
  strokeRegion,
  fineStep,
  minimum,
  inkHit,
  strokeHit,
) {
  const fineInk = h.terminalLabelInkRows(labelRegion, fineStep, inkHit);
  if (!fineInk.length) return minimum;
  const fineStrokeRows = h.terminalLabelInkRows(
    strokeRegion,
    fineStep,
    strokeHit,
  );
  if (!fineStrokeRows.length) return minimum;
  return h.terminalLabelRunGap(fineInk, fineStrokeRows, fineStep, minimum).gap;
}

export function terminalLabelRefinedGap(
  h,
  ink,
  stroke,
  coarse,
  labelRegion,
  strokeRegion,
  coarseStep,
  fineStep,
  coarseCutoff,
  pad,
  minimum,
  inkHit,
  strokeHit,
) {
  const { inkNear, strokeNear } = h.terminalLabelNearCutoff(
    ink,
    stroke,
    coarseStep,
    coarseCutoff,
  );
  const fineInk = h.terminalLabelFineRows(
    labelRegion,
    inkNear,
    coarseStep,
    fineStep,
    pad,
    inkHit,
  );
  const fineStrokeRows = h.terminalLabelFineRows(
    strokeRegion,
    strokeNear,
    coarseStep,
    fineStep,
    pad,
    strokeHit,
  );
  if (!fineInk.length || !fineStrokeRows.length)
    return Math.min(coarse.gap, minimum);
  return Math.min(
    h.terminalLabelRunGap(fineInk, fineStrokeRows, fineStep, minimum).gap,
    coarse.gap,
  );
}

// Compare painted ink runs on a 0.005 mm grid and adaptively refine every
// near-cutoff approach on a 0.001 mm grid without rounding toward pass (#481).
export function terminalLabelStrokeGap(c, label, shape, minimum) {
  const { glyphAt, intersect, h } = c;
  const coarseStep = 0.005,
    fineStep = 0.001,
    margin = 0.03,
    pad = 0.015,
    coarseCutoff = minimum + margin;
  const labelRegion = intersect(
    label.bbox,
    h.expandClearanceBox(shape.bbox, coarseCutoff),
  );
  const strokeRegion = intersect(
    shape.bbox,
    h.expandClearanceBox(label.bbox, coarseCutoff),
  );
  if (
    labelRegion.w <= 0 ||
    labelRegion.h <= 0 ||
    strokeRegion.w <= 0 ||
    strokeRegion.h <= 0
  )
    return minimum;
  const inkHit = (p) => glyphAt(label, p);
  const strokeHit = h.terminalLabelStrokeHit(c, shape);
  if (
    labelRegion.w < 2 * coarseStep ||
    labelRegion.h < 2 * coarseStep ||
    strokeRegion.w < 2 * coarseStep ||
    strokeRegion.h < 2 * coarseStep
  )
    return h.terminalLabelDirectFineGap(
      h,
      labelRegion,
      strokeRegion,
      fineStep,
      minimum,
      inkHit,
      strokeHit,
    );
  const ink = h.terminalLabelInkRows(labelRegion, coarseStep, inkHit);
  if (!ink.length) return minimum;
  const stroke = h.terminalLabelInkRows(strokeRegion, coarseStep, strokeHit);
  if (!stroke.length) return minimum;
  const coarse = h.terminalLabelRunGap(ink, stroke, coarseStep, coarseCutoff);
  if (coarse.gap >= coarseCutoff || !coarse.pair) return minimum;
  if (coarse.gap <= minimum - margin) return coarse.gap;
  return h.terminalLabelRefinedGap(
    h,
    ink,
    stroke,
    coarse,
    labelRegion,
    strokeRegion,
    coarseStep,
    fineStep,
    coarseCutoff,
    pad,
    minimum,
    inkHit,
    strokeHit,
  );
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
  const { texts, elementsById, ids, h } = c;
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
      const gap = h.terminalLabelStrokeGap(c, label, shape, gapMm);
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
        gapMm: Math.floor((gapMm + 1e-12) * 1000) / 1000,
        minimumMm: minimum,
      },
    ];
  });
}

// Interior symbol legends (M, 3~, SUP, PWR, I/F) and coil AC/DC qualifiers sit
// inside fixed symbol strokes; test actual stroke crossing rather than AABB
// exclusion, while external owned circuit captions keep the full 0.50 mm cutoff.
export function circuitCaptionCutoff(e, minimum) {
  if (e.closest("[data-circuit-mark]")) return 0.05;
  const fn = e.closest("[data-function-key]");
  if (
    fn &&
    !e.closest("[data-channel-line],[data-contact-caption]") &&
    fn.querySelector('[data-circuit-mark="coil"]')
  )
    return 0.05;
  return minimum;
}

export function circuitCaptionClearances(c, minimum) {
  const { texts, elementsById, ids, h } = c;
  const bodies = new Map();
  return texts.flatMap((text) => {
    const e = elementsById.get(text.element);
    const owner = e?.closest("[data-circuit-functions]");
    if (
      !text.reviewPainted ||
      !owner ||
      owner.hasAttribute("data-circuit-tag-lane") ||
      e.closest(
        '[data-terminal-key],[data-tag-kind="reference"],[data-tag-kind="legend"],.off-view-annotation,[data-navigation-annotation]',
      )
    )
      return [];
    const cutoff = h.circuitCaptionCutoff(e, minimum);
    const label = {
      e,
      text,
      bbox: text.bbox,
      inverse: e.getScreenCTM().inverse(),
    };
    let nearest,
      gapMm = cutoff;
    if (!bodies.has(owner)) bodies.set(owner, h.terminalLabelBody(c, owner));
    for (const shape of bodies.get(owner)) {
      const gap = h.terminalLabelStrokeGap(c, label, shape, gapMm);
      if (gap < gapMm) {
        gapMm = gap;
        nearest = shape;
      }
    }
    if (!nearest) return [];
    return [
      {
        caption: text,
        functionKey:
          e.closest("[data-function-key]")?.getAttribute("data-function-key") ??
          null,
        bodyElement: ids.get(nearest.e),
        gapMm: Math.floor((gapMm + 1e-12) * 1000) / 1000,
        minimumMm: cutoff,
      },
    ];
  });
}
