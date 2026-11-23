import { extent, painted } from "./review-geometry.mjs";
import { elementKey, routeKey } from "./tranche4-source.mjs";

export function boxGap(a, b) {
  return Math.hypot(
    Math.max(0, b.x - a.x - a.w, a.x - b.x - b.w),
    Math.max(0, b.y - a.y - a.h, a.y - b.y - b.h),
  );
}

function routeIdentity(s) {
  const [kind, ...ids] = s.edgeOwnerKey ?? [];
  const edge =
    kind === "cable-conductor"
      ? JSON.stringify(ids)
      : ["wire", "jumper"].includes(kind)
        ? ids[0]
        : undefined;
  const declaration = routeKey(s);
  if (declaration && edge && declaration !== edge) return undefined;
  return declaration ?? edge;
}

function boundRoute(s, key) {
  return routeIdentity(s) === key;
}

export function conductorInk(g, element) {
  const key = elementKey(element);
  const shapes = (g.shapes ?? []).filter(
    (s) => boundRoute(s, key) && g.tranche3?.routeInk?.[s.element]?.length,
  );
  return {
    runs: shapes.flatMap((s) => g.tranche3.routeInk[s.element]),
    tips: shapes.flatMap((s) =>
      s.points?.length ? [s.points[0], s.points.at(-1)] : [],
    ),
  };
}

const COLLINEAR_TOL_MM = 0.05;
const ANGLE_SIN_TOL = 0.02;
const RUN_THICKNESS_TOL_MM = 0.08;
const RESIDUAL_SLIVER_MM = 0.25;

function subtractSpan(spans, cut0, cut1) {
  const next = [];
  for (const [a, b] of spans) {
    if (cut1 <= a || cut0 >= b) {
      next.push([a, b]);
      continue;
    }
    if (cut0 > a) next.push([a, cut0]);
    if (cut1 < b) next.push([cut1, b]);
  }
  return next;
}

function nonCoincidentRunPieces(run, ownRuns) {
  if (!ownRuns.length) return [run];
  const [a, b] = run;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len <= 1e-6) {
    const pt = { x: a.x, y: a.y, w: 0, h: 0 };
    return ownRuns.some((o) => boxGap(pt, extent(o)) <= COLLINEAR_TOL_MM)
      ? []
      : [run];
  }
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  let spans = [[0, len]];
  let hadOverlap = false;
  for (const [c, d] of ownRuns) {
    const oLen = Math.hypot(d.x - c.x, d.y - c.y);
    if (oLen <= 1e-6) continue;
    const ox = (d.x - c.x) / oLen;
    const oy = (d.y - c.y) / oLen;
    if (Math.abs(ux * oy - uy * ox) > ANGLE_SIN_TOL) continue;
    const perpC = Math.abs((c.x - a.x) * uy - (c.y - a.y) * ux);
    const perpD = Math.abs((d.x - a.x) * uy - (d.y - a.y) * ux);
    if (perpC > COLLINEAR_TOL_MM || perpD > COLLINEAR_TOL_MM) continue;
    const t1 = (c.x - a.x) * ux + (c.y - a.y) * uy;
    const t2 = (d.x - a.x) * ux + (d.y - a.y) * uy;
    const s0 = Math.min(t1, t2);
    const s1 = Math.max(t1, t2);
    const ov = Math.min(len, s1) - Math.max(0, s0);
    if (ov <= COLLINEAR_TOL_MM && ov < len - 1e-4) continue;
    hadOverlap = true;
    spans = subtractSpan(spans, s0 - COLLINEAR_TOL_MM, s1 + COLLINEAR_TOL_MM);
    if (!spans.length) return [];
  }
  if (!hadOverlap) return [run];
  return spans
    .filter(([u0, u1]) => u1 - u0 > RESIDUAL_SLIVER_MM)
    .map(([u0, u1]) => [
      { x: a.x + ux * u0, y: a.y + uy * u0 },
      { x: a.x + ux * u1, y: a.y + uy * u1 },
    ]);
}

function subtractCoincidentBox(foreign, ownBoxes) {
  const horiz = foreign.h <= RUN_THICKNESS_TOL_MM && foreign.w > foreign.h;
  const vert =
    !horiz && foreign.w <= RUN_THICKNESS_TOL_MM && foreign.h > foreign.w;
  if (!horiz && !vert) return [foreign];
  const center = horiz ? foreign.y + foreign.h / 2 : foreign.x + foreign.w / 2;
  const f0 = horiz ? foreign.x : foreign.y;
  const f1 = f0 + (horiz ? foreign.w : foreign.h);
  let spans = [[f0, f1]];
  let hadOverlap = false;
  for (const o of ownBoxes) {
    const oMatch = horiz
      ? o.h <= RUN_THICKNESS_TOL_MM && o.w > o.h
      : o.w <= RUN_THICKNESS_TOL_MM && o.h > o.w;
    if (!oMatch) continue;
    const oCenter = horiz ? o.y + o.h / 2 : o.x + o.w / 2;
    if (Math.abs(oCenter - center) > COLLINEAR_TOL_MM) continue;
    const o0 = horiz ? o.x : o.y;
    const o1 = o0 + (horiz ? o.w : o.h);
    if (Math.min(f1, o1) - Math.max(f0, o0) <= COLLINEAR_TOL_MM) continue;
    hadOverlap = true;
    spans = subtractSpan(spans, o0 - COLLINEAR_TOL_MM, o1 + COLLINEAR_TOL_MM);
    if (!spans.length) return [];
  }
  if (!hadOverlap) return [foreign];
  return spans
    .filter(([a, b]) => b - a > RESIDUAL_SLIVER_MM)
    .map(([a, b]) =>
      horiz
        ? { x: a, y: foreign.y, w: b - a, h: foreign.h }
        : { x: foreign.x, y: a, w: foreign.w, h: b - a },
    );
}

export function excludeCoincidentBoxes(foreignBoxes, ownBoxes) {
  if (!foreignBoxes.length || !ownBoxes.length) return foreignBoxes;
  return foreignBoxes.flatMap((box) => subtractCoincidentBox(box, ownBoxes));
}

export function foreignConductorBoxes(
  g,
  element,
  ownRuns = conductorInk(g, element).runs,
) {
  const ownKey = elementKey(element);
  const boxes = [];
  for (const s of g.shapes ?? []) {
    const runs = g.tranche3?.routeInk?.[s.element];
    if (!runs?.length) continue;
    const id = routeIdentity(s);
    if (!id || id === ownKey) continue;
    for (const run of runs)
      for (const piece of nonCoincidentRunPieces(run, ownRuns))
        boxes.push(extent(piece));
  }
  return boxes;
}

export function paintedToBothEnds({ runs, tips }, a, b) {
  const ink = runs.map(extent);
  return [a, b].every((marks) =>
    marks?.some(
      (m) =>
        tips.some((p) => boxGap({ ...p, w: 0, h: 0 }, m) <= 0.05) &&
        ink.some((stroke) => boxGap(stroke, m) <= 0.25),
    ),
  );
}

export function continuationInk(sheet, g, element, runs) {
  const native = new Set(
    (sheet.continuations ?? [])
      .filter((c) => elementKey(c.provenance) === elementKey(element))
      .map((c) => c.id),
  );
  const links = new Set(
    (g.connectors ?? [])
      .filter(
        (c) =>
          native.has(c.id) &&
          runs.some(
            (run) => boxGap({ ...c.anchor, w: 0, h: 0 }, extent(run)) <= 0.6,
          ),
      )
      .map((c) => c.element),
  );
  return g.texts.flatMap((t) =>
    painted(t) && t.bbox && links.has(t.continuationLink) ? [t.bbox] : [],
  );
}

function noteRegion(lines) {
  return extent(
    lines.flatMap(({ bbox: b }) => [b, { x: b.x + b.w, y: b.y + b.h }]),
  );
}

// Chromium ink boxes are quantized. Allow 0.15 mm for the comparison.
export function noteOwnerGap(lines, obligation, named) {
  if (!lines.every((t) => t.bbox)) return Infinity;
  const region = noteRegion(lines);
  const supports = named
    ? [...obligation.owners, ...(obligation.supports ?? [])]
    : obligation.owners;
  return Math.min(...supports.map((owner) => boxGap(region, owner)));
}

export function inOwnerReach(gap, named) {
  return gap <= (named ? 6.25 : 2.25);
}
