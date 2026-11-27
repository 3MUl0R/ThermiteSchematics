// Strict affirmative PDF-to-SVG text-role mapping and DQ-21 split reconciliation.
// Never uses a permissive body default; unattributed or conflicting runs fail.
import { INK_ACCURACY_MM, inside } from "./checks.mjs";
import { affirmativeTextRole } from "./text-legibility.mjs";

const EM_TOL_MM = 0.03;
const EXACT_MATCH_MAX_DIST_MM = 5;
const TIE_DIST_MM = 0.1;
const SPLIT_PAD_MM = 1.5;

const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/gu, " ")
    .trim();
const compact = (s) => norm(s).replace(/\s+/gu, "");
const runEm = (r) => r.emMm ?? r.fontSize;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const boxCenter = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const overlapArea = (a, b) => {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
};
const padBox = (b, p) => ({
  x: b.x - p,
  y: b.y - p,
  w: b.w + 2 * p,
  h: b.h + 2 * p,
});
const rolesConflict = (cands) => {
  const first = affirmativeTextRole(cands[0].svg);
  return cands.some((c) => {
    const r = affirmativeTextRole(c.svg);
    return r.role !== first.role || r.floorMm !== first.floorMm;
  });
};

function resolveRunAgainstSvg(run, svg, matchMode) {
  const emMm = runEm(run);
  const role = affirmativeTextRole(svg);
  const resolved = role.role !== "unmapped" && role.floorMm != null;
  return {
    index: run.index,
    text: norm(run.text),
    emMm,
    bbox: run.bbox,
    matchMode,
    svgElement: svg.element,
    roleStatus: resolved ? "resolved" : "unmapped",
    roleCategory: resolved ? role.role : "unmapped",
    roleDetail: role.detail,
    floorMm: role.floorMm,
    passesFloor: resolved && emMm != null && emMm >= role.floorMm - EM_TOL_MM,
  };
}

function unresolvedRun(run, status, detail) {
  return {
    index: run.index,
    text: norm(run.text),
    emMm: runEm(run),
    bbox: run.bbox,
    matchMode: "none",
    svgElement: null,
    roleStatus: status,
    roleCategory: status,
    roleDetail: detail,
    floorMm: null,
    passesFloor: false,
  };
}

function splitCandidatesForRun(run, paintedSvg, exactMatchedSvg) {
  const rc = compact(run.text);
  const runPad = padBox(run.bbox, SPLIT_PAD_MM);
  const rCenter = boxCenter(run.bbox);
  const out = [];
  for (let idx = 0; idx < paintedSvg.length; idx++) {
    if (exactMatchedSvg.has(idx)) continue;
    const t = paintedSvg[idx];
    const area = overlapArea(runPad, t.bbox);
    if (area <= 0) continue;
    const tc = compact(t.text);
    const included =
      tc.includes(rc) ||
      (rc.length === 1 && overlapArea(run.bbox, padBox(t.bbox, 0.8)) > 0);
    if (!included) continue;
    const d = dist(rCenter, boxCenter(t.bbox));
    out.push({ idx, svg: t, area, dist: d });
  }
  return out.sort((a, b) => b.area - a.area || a.dist - b.dist);
}

export function mapPdfRunsToSvgRoles(pdfRuns, svgTexts) {
  const paintedSvg = svgTexts.filter(
    (t) => t.painted !== false && norm(t.text).length > 0,
  );
  const paintedRuns = pdfRuns.filter(
    (r) => r.painted !== false && norm(r.text).length > 0,
  );
  const exactMatchedSvg = new Set();
  const piecesBySvgIdx = new Map();
  const results = new Array(paintedRuns.length);
  const remaining = [];

  for (let ri = 0; ri < paintedRuns.length; ri++) {
    const run = paintedRuns[ri];
    const rt = norm(run.text);
    const cands = [];
    for (let si = 0; si < paintedSvg.length; si++) {
      if (exactMatchedSvg.has(si)) continue;
      const t = paintedSvg[si];
      if (norm(t.text) !== rt) continue;
      const d = dist(run.bbox, t.bbox);
      if (d <= EXACT_MATCH_MAX_DIST_MM)
        cands.push({ idx: si, svg: t, dist: d });
    }
    if (!cands.length) {
      remaining.push(ri);
      continue;
    }
    cands.sort((a, b) => a.dist - b.dist);
    const tied = cands.filter((c) => c.dist - cands[0].dist <= TIE_DIST_MM);
    if (tied.length > 1 && rolesConflict(tied)) {
      results[ri] = unresolvedRun(run, "ambiguous", "ambiguous-exact-svg-role");
      continue;
    }
    exactMatchedSvg.add(cands[0].idx);
    results[ri] = resolveRunAgainstSvg(run, cands[0].svg, "exact");
  }

  for (const ri of remaining) {
    const run = paintedRuns[ri];
    const cands = splitCandidatesForRun(run, paintedSvg, exactMatchedSvg);
    if (!cands.length) {
      results[ri] = unresolvedRun(run, "unmapped", "unmatched-pdf-run");
      continue;
    }
    const tied = cands.filter(
      (c) =>
        Math.abs(c.area - cands[0].area) <= 0.1 &&
        Math.abs(c.dist - cands[0].dist) <= TIE_DIST_MM,
    );
    if (tied.length > 1 && rolesConflict(tied)) {
      results[ri] = unresolvedRun(run, "ambiguous", "ambiguous-split-svg-role");
      continue;
    }
    const best = cands[0];
    if (!piecesBySvgIdx.has(best.idx)) piecesBySvgIdx.set(best.idx, []);
    piecesBySvgIdx.get(best.idx).push(run);
    results[ri] = resolveRunAgainstSvg(run, best.svg, "split");
  }

  return { paintedSvg, runResults: results, exactMatchedSvg, piecesBySvgIdx };
}

function unionBox(runs) {
  const x0 = Math.min(...runs.map((r) => r.bbox.x));
  const y0 = Math.min(...runs.map((r) => r.bbox.y));
  const x1 = Math.max(...runs.map((r) => r.bbox.x + r.bbox.w));
  const y1 = Math.max(...runs.map((r) => r.bbox.y + r.bbox.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function evaluateSplitLabel(svg, pieces, frame) {
  const rotated = Math.abs(svg.angle ?? 0) > 45;
  const ordered = [...pieces].sort((a, b) =>
    rotated ? a.bbox.y - b.bbox.y : a.bbox.x - b.bbox.x,
  );
  const role = affirmativeTextRole(svg);
  const joined = ordered.map((p) => norm(p.text)).join(" ");
  const contentExact =
    ordered.length > 0 &&
    (compact(joined) === compact(svg.text) || norm(joined) === norm(svg.text));
  const union = ordered.length ? unionBox(ordered) : null;
  const containers = [frame, svg.viewport, svg.cell, svg.clip].filter(Boolean);
  const fitsContainer017Mm =
    union != null &&
    containers.every((box) => inside(union, box, INK_ACCURACY_MM));
  const minEmMm = ordered.length
    ? Math.min(...ordered.map((p) => runEm(p) ?? 0))
    : null;
  const emOk =
    ordered.length > 0 &&
    role.floorMm != null &&
    ordered.every((p) => (runEm(p) ?? 0) >= role.floorMm - EM_TOL_MM);

  let rawStatus = "reconciled_split_ok";
  if (!ordered.length) rawStatus = "missing_pdf_run";
  else if (!contentExact) rawStatus = "content_mismatch";
  else if (role.role === "unmapped" || role.floorMm == null)
    rawStatus = "unmapped_svg_role";
  else if (!emOk) rawStatus = "below_role_em_floor";
  else if (!fitsContainer017Mm) rawStatus = "container_overflow_0.17mm";

  return {
    element: svg.element,
    text: norm(svg.text),
    pieceCount: ordered.length,
    roleCategory: role.role,
    roleDetail: role.detail,
    floorMm: role.floorMm,
    minEmMm,
    contentExact,
    emOk,
    fitsContainer017Mm,
    unionBbox: union,
    rawStatus,
  };
}

export function reconcileDq21SplitLabels(
  paintedSvg,
  pdfMetrics,
  piecesBySvgIdx,
  frame,
) {
  const usedMetric = new Set();
  const matchedSvgIdx = new Set();
  const matchedViolations = [];
  for (let si = 0; si < paintedSvg.length; si++) {
    const t = paintedSvg[si];
    const tt = norm(t.text);
    const cands = pdfMetrics
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => !usedMetric.has(i) && norm(p.text) === tt)
      .sort((a, b) => dist(a.p.bbox, t.bbox) - dist(b.p.bbox, t.bbox));
    const best = cands[0];
    if (!best) continue;
    usedMetric.add(best.i);
    matchedSvgIdx.add(si);
    const advance = t.advance ?? t.bbox.w;
    const delta = Math.abs(best.p.bbox.w - advance);
    if (delta > Math.max(0.15, advance * 0.02))
      matchedViolations.push({
        element: t.element,
        text: tt,
        svgWidthMm: advance,
        pdfWidthMm: best.p.bbox.w,
        deltaMm: delta,
      });
  }

  const splitLabels = [];
  for (let si = 0; si < paintedSvg.length; si++) {
    if (matchedSvgIdx.has(si)) continue;
    splitLabels.push(
      evaluateSplitLabel(paintedSvg[si], piecesBySvgIdx.get(si) ?? [], frame),
    );
  }
  return {
    matchedCount: matchedSvgIdx.size,
    matchedViolations,
    splitLabels,
  };
}

export function auditPdfTextRoles(pdfRuns, g, pdfMetrics = pdfRuns) {
  const { paintedSvg, runResults, piecesBySvgIdx } = mapPdfRunsToSvgRoles(
    pdfRuns,
    g.texts ?? [],
  );
  const byRole = {
    designation: 0,
    body: 0,
    secondary: 0,
    unmapped: 0,
    ambiguous: 0,
  };
  for (const r of runResults) byRole[r.roleCategory] += 1;
  const unresolvedRoles = runResults.filter((r) => r.roleStatus !== "resolved");
  const belowFloor = runResults.filter(
    (r) => r.roleStatus === "resolved" && !r.passesFloor,
  );
  const { matchedCount, matchedViolations, splitLabels } =
    reconcileDq21SplitLabels(paintedSvg, pdfMetrics, piecesBySvgIdx, g.frame);
  const unresolvedSplitLabels = splitLabels.filter(
    (s) => s.rawStatus !== "reconciled_split_ok",
  );
  return {
    paintedSvgCount: paintedSvg.length,
    runCount: runResults.length,
    runResults,
    byRole,
    unresolvedRoles,
    belowFloor,
    matchedCount,
    matchedViolations,
    splitLabels,
    unresolvedSplitLabels,
    clean:
      unresolvedRoles.length === 0 &&
      belowFloor.length === 0 &&
      matchedViolations.length === 0 &&
      unresolvedSplitLabels.length === 0,
  };
}

export function dq21SplitFindings(audit) {
  return audit.unresolvedSplitLabels.map((s) => ({
    kind: `dq21-split-${s.rawStatus.replaceAll("_", "-")}`,
    element: s.element,
    text: s.text,
    roleCategory: s.roleCategory,
    roleDetail: s.roleDetail,
    floorMm: s.floorMm,
    minEmMm: s.minEmMm,
    pieceCount: s.pieceCount,
    rawStatus: s.rawStatus,
    medium: "pdf",
  }));
}
