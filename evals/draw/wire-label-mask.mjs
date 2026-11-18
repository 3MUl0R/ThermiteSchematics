import { routePoints, segments, finding } from "./tranche3-geometry.mjs";

// Precision of the existing route-point / terminal coincidence check.
const COINCIDENCE_MM = 0.01;

function axis([a, b]) {
  if (Math.abs(a.y - b.y) <= COINCIDENCE_MM)
    return {
      horizontal: true,
      across: a.y,
      lo: Math.min(a.x, b.x),
      hi: Math.max(a.x, b.x),
    };
  if (Math.abs(a.x - b.x) <= COINCIDENCE_MM)
    return {
      horizontal: false,
      across: a.x,
      lo: Math.min(a.y, b.y),
      hi: Math.max(a.y, b.y),
    };
}

function span(box, horizontal) {
  return horizontal
    ? { lo: box.x, hi: box.x + box.w, bottom: box.y, top: box.y + box.h }
    : { lo: box.y, hi: box.y + box.h, bottom: box.x, top: box.x + box.w };
}

function straightRuns(points) {
  const runs = [];
  for (const segment of segments(points)) {
    const previous = runs.at(-1);
    const a = previous && axis(previous),
      b = axis(segment);
    const collinear =
      a &&
      b &&
      a.horizontal === b.horizontal &&
      Math.abs(a.across - b.across) <= COINCIDENCE_MM;
    const direction = ([p, q]) => (a?.horizontal ? q.x - p.x : q.y - p.y);
    if (previous && collinear && direction(previous) * direction(segment) > 0)
      previous[1] = segment[1];
    else runs.push(segment);
  }
  return runs;
}

function coveredRun(segment, plate, clip) {
  const run = axis(segment);
  if (!run) return undefined;
  const p = span(plate, run.horizontal),
    c = span(clip, run.horizontal);
  if (
    run.across < c.bottom ||
    run.across > c.top ||
    run.across < p.bottom - COINCIDENCE_MM ||
    run.across > p.top + COINCIDENCE_MM
  )
    return undefined;
  const lo = Math.max(run.lo, c.lo),
    hi = Math.min(run.hi, c.hi),
    covered = Math.min(hi, p.hi) - Math.max(lo, p.lo);
  if (covered <= COINCIDENCE_MM) return undefined;
  return { ...run, lo, hi, covered, beforeMm: p.lo - lo, afterMm: hi - p.hi };
}

function junctionCovered(junctions, plate) {
  return junctions.some(({ bbox, clip, order }) => {
    if (order >= plate.order) return false;
    const left = Math.max(clip.x, plate.bbox.x),
      right = Math.min(clip.x + clip.w, plate.bbox.x + plate.bbox.w),
      top = Math.max(clip.y, plate.bbox.y),
      bottom = Math.min(clip.y + clip.h, plate.bbox.y + plate.bbox.h);
    if (right <= left || bottom <= top) return false;
    const x = bbox.x + bbox.w / 2,
      y = bbox.y + bbox.h / 2,
      dx = Math.max(left - x, x - right, 0),
      dy = Math.max(top - y, y - bottom, 0);
    return Math.hypot(dx / (bbox.w / 2), dy / (bbox.h / 2)) < 1;
  });
}

export function wireLabelMaskFinding(texts, g, routes, nativeOwner) {
  const measurement = g.tranche3?.wirePlatePaint;
  if (!measurement) return undefined;
  const ids = new Set(texts.map((t) => t.element));
  for (const plate of measurement.plates.filter((p) => ids.has(p.text))) {
    const hits = routes.flatMap((r) => {
      const stroke = measurement.strokes[r.element];
      if (!stroke || stroke.order >= plate.order) return [];
      return straightRuns(routePoints(r)).flatMap((s) => {
        const hit = coveredRun(s, plate.bbox, stroke.clip);
        return hit ? [{ ...hit, wire: r.wire, element: r.element }] : [];
      });
    });
    const junction = junctionCovered(measurement.junctions ?? [], plate);
    if (!hits.length && !junction) continue;
    const safe =
      !junction &&
      hits.length === 1 &&
      nativeOwner &&
      hits[0].wire === texts[0].wire &&
      hits[0].beforeMm > COINCIDENCE_MM &&
      hits[0].afterMm > COINCIDENCE_MM;
    if (safe) continue;
    return finding("wire-label-plate-masks-conductor", texts[0], {
      wire: texts[0].wire,
      text: texts.map((t) => t.text).join(" "),
      plate: plate.bbox,
      reason: junction
        ? "junction"
        : hits.some((r) => r.wire !== texts[0].wire)
          ? "foreign-conductor"
          : hits.length > 1
            ? "elbow-or-branch"
            : "approach",
      hits,
    });
  }
}
