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

// Near-contact guard (0.05 mm) for recognized interior symbol legends sitting
// inside fixed-size closed symbol bodies (coil AC/DC, motor M / 3~, and
// SUP/PWR/I/F marks). Fixed symbol geometry leaves less than the external
// 0.50 mm caption cutoff (for example, valid TTB coil AC measures 0.480 mm to
// the coil outline), so interior legends are guarded against stroke crossing
// or near-contact while preserving native painted-stroke measurement without
// symbol-AABB exclusion. Displaced legends outside their containing body and
// all external captions/footers retain the full 0.50 mm cutoff.
export const INTERIOR_LEGEND_NEAR_CONTACT_MM = 0.05;

export function paintedGlyphLocalBox(c, e, text = c.textPaintRows?.get(e)) {
  const data = c.textPaintGeometry?.get(e);
  if (
    !data ||
    !(data.width > 0) ||
    !(data.height > 0) ||
    !(data.local?.width > 0) ||
    !(data.local?.height > 0)
  )
    return null;
  let mask = c.glyphMasks?.get(e);
  if (!mask) {
    const rendered = text?.renderedString ?? text?.text ?? e.textContent ?? "";
    const canvas = document.createElement("canvas"),
      pixels = 12;
    canvas.width = Math.max(1, Math.ceil(data.width * pixels));
    canvas.height = Math.max(1, Math.ceil(data.height * pixels));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.scale(pixels, pixels);
    ctx.font = data.font;
    ctx.fillText(rendered, data.left, data.ascent);
    mask = {
      bytes: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      w: canvas.width,
      h: canvas.height,
    };
    c.glyphMasks?.set(e, mask);
  }
  let minX = mask.w,
    maxX = -1,
    minY = mask.h,
    maxY = -1;
  for (let y = 0; y < mask.h; y++) {
    const rowOffset = y * mask.w;
    for (let x = 0; x < mask.w; x++) {
      if (mask.bytes[(rowOffset + x) * 4 + 3] >= 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return {
    x: data.local.x + (minX / mask.w) * data.local.width,
    y: data.local.y + (minY / mask.h) * data.local.height,
    width: ((maxX + 1 - minX) / mask.w) * data.local.width,
    height: ((maxY + 1 - minY) / mask.h) * data.local.height,
  };
}

export function boxInsideContainer(c, e, container, text) {
  const local = c.h.paintedGlyphLocalBox(c, e, text);
  if (
    !container ||
    !local ||
    !(local.width > 0) ||
    !(local.height > 0) ||
    !c.visible(container)
  )
    return false;
  const textCtm = e.getScreenCTM(),
    containerCtm = container.getScreenCTM();
  if (!textCtm || !containerCtm) return false;
  let toContainer;
  try {
    toContainer = containerCtm.inverse().multiply(textCtm);
  } catch {
    return false;
  }
  const corners = [
    [local.x, local.y],
    [local.x + local.width, local.y],
    [local.x, local.y + local.height],
    [local.x + local.width, local.y + local.height],
  ];
  return corners.every(([x, y]) => {
    const p = new DOMPoint(x, y).matrixTransform(toContainer);
    return (
      Number.isFinite(p.x) && Number.isFinite(p.y) && container.isPointInFill(p)
    );
  });
}

// Recognize only closed interior legends emitted by the circuit renderer whose
// tight painted glyph ink box lies inside their actual containing symbol body geometry.
export function circuitInteriorLegendMark(c, e, text) {
  const { h } = c;
  const value = (text.text ?? "").trim();
  const mark = e.closest("[data-circuit-mark]");
  if (mark) {
    const roles = {
      motor: { shape: "circle", texts: ["M", "3~"] },
      source: { shape: "rect", texts: ["SUP"] },
      load: { shape: "rect", texts: ["PWR"] },
      interface: { shape: "rect", texts: ["I/F"] },
    };
    const role = roles[mark.getAttribute("data-circuit-mark")];
    if (!role || !role.texts.includes(value)) return null;
    const container = mark.querySelector(role.shape);
    return h.boxInsideContainer(c, e, container, text) ? mark : null;
  }
  const fn = e.closest("[data-function-key]");
  if (
    fn &&
    e.parentElement === fn &&
    !e.closest("[data-channel-line],[data-contact-caption],[data-tag-kind]") &&
    (value === "AC" || value === "DC")
  ) {
    const coils = fn.querySelectorAll('[data-circuit-mark="coil"]');
    return (
      [...coils].find((coil) =>
        h.boxInsideContainer(c, e, coil.querySelector("rect"), text),
      ) ?? null
    );
  }
  return null;
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
    const interiorMark = h.circuitInteriorLegendMark(c, e, text);
    const label = {
      e,
      text,
      bbox: text.bbox,
      inverse: e.getScreenCTM().inverse(),
    };
    let nearest,
      nearestCutoff = minimum,
      gapMm = minimum;
    if (!bodies.has(owner)) bodies.set(owner, h.terminalLabelBody(c, owner));
    for (const shape of bodies.get(owner)) {
      const cutoff =
        interiorMark && interiorMark.contains(shape.e)
          ? h.INTERIOR_LEGEND_NEAR_CONTACT_MM
          : minimum;
      const limit = nearest ? Math.min(cutoff, gapMm) : cutoff;
      if (limit <= 0) break;
      const gap = h.terminalLabelStrokeGap(c, label, shape, limit);
      if (gap < limit) {
        gapMm = gap;
        nearest = shape;
        nearestCutoff = cutoff;
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
        minimumMm: nearestCutoff,
      },
    ];
  });
}
