// Strict physical 1-to-1 PDF-to-SVG text-role mapping and DQ-21 reconciliation.
// Never uses a permissive body default, proximity-only 5 mm match, or unbounded pass.
import { INK_ACCURACY_MM, inside } from "./checks.mjs";
import { affirmativeTextRole } from "./text-legibility.mjs";

const EM_TOL_MM = 0.03;
// Derived from E3 300-dpi ink accuracy (2 px = 0.1693 mm -> 0.17 mm).
// Embedded-font SVG vs PDF baselines agree within <= 0.0001 mm across measured corpus runs.
export const BASELINE_TOL_MM = INK_ACCURACY_MM;
// Derived from E3 300-dpi ink accuracy and DQ-21's calibrated 2% advance tolerance.
export const extentToleranceMm = (expectedWidthMm) =>
  Math.max(INK_ACCURACY_MM, Math.max(0, expectedWidthMm) * 0.02);
const TIE_DIST_MM = 0.1;

const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/gu, " ")
    .trim();
const compact = (s) => norm(s).replace(/\s+/gu, "");
const runEm = (r) => r.emMm ?? r.fontSize;

function svgAxisGeometry(t) {
  const rotated = Math.abs(t.angle ?? 0) > 45;
  if (rotated) {
    const start = t.emBbox ? t.emBbox.y : t.bbox.y;
    const width = Math.max(t.advance ?? 0, t.emBbox?.h ?? t.bbox.h);
    const end = Math.max(
      start + width,
      t.emBbox ? t.emBbox.y + t.emBbox.h : t.bbox.y + t.bbox.h,
    );
    const baseline = t.anchor ? t.anchor.x : t.bbox.x + t.bbox.w;
    return { rotated, baseline, start, end, width: end - start };
  }
  const start = t.emBbox ? t.emBbox.x : t.bbox.x;
  const width = Math.max(t.advance ?? 0, t.emBbox?.w ?? t.bbox.w);
  const end = Math.max(
    start + width,
    t.emBbox ? t.emBbox.x + t.emBbox.w : t.bbox.x + t.bbox.w,
  );
  const baseline = t.anchor
    ? t.anchor.y + (t.baselineShiftMm ?? 0)
    : t.bbox.y + t.bbox.h;
  return { rotated, baseline, start, end, width: end - start };
}

function runAxisGeometry(run, rotated) {
  if (rotated) {
    const start = run.bbox.y;
    const end = run.bbox.y + run.bbox.h;
    return {
      baseline: run.bbox.x + run.bbox.w,
      altBaseline: run.bbox.x,
      start,
      end,
    };
  }
  const start = run.bbox.x;
  const end = run.bbox.x + run.bbox.w;
  return { baseline: run.bbox.y + run.bbox.h, start, end };
}

function baselineDelta(runM, svgM) {
  const d = Math.abs(runM.baseline - svgM.baseline);
  return runM.altBaseline === undefined
    ? d
    : Math.min(d, Math.abs(runM.altBaseline - svgM.baseline));
}

function exactPhysicalFit(run, svg) {
  const svgM = svgAxisGeometry(svg);
  const runM = runAxisGeometry(run, svgM.rotated);
  const dy = baselineDelta(runM, svgM);
  if (dy > BASELINE_TOL_MM) return null;
  const overlap =
    Math.min(runM.end, svgM.end) - Math.max(runM.start, svgM.start);
  if (overlap < -INK_ACCURACY_MM) return null;
  const tol = extentToleranceMm(svgM.width);
  const anchorDx = Math.min(
    Math.abs(runM.start - svgM.start),
    Math.abs(runM.end - svgM.end),
    Math.abs((runM.start + runM.end) / 2 - (svgM.start + svgM.end) / 2),
  );
  if (anchorDx > tol) return null;
  return { dy, anchorDx, dist: Math.hypot(anchorDx, dy) };
}

function splitPhysicalFit(run, svg) {
  const svgM = svgAxisGeometry(svg);
  const runM = runAxisGeometry(run, svgM.rotated);
  const dy = baselineDelta(runM, svgM);
  if (dy > BASELINE_TOL_MM) return null;
  const tol = extentToleranceMm(svgM.width);
  const leftOver = svgM.start - runM.start;
  const rightOver = runM.end - svgM.end;
  if (leftOver > tol || rightOver > tol) return null;
  const overlap =
    Math.min(runM.end, svgM.end) - Math.max(runM.start, svgM.start);
  if (overlap < -INK_ACCURACY_MM) return null;
  const overshoot = Math.max(0, leftOver, rightOver);
  return { dy, overshoot, overlap };
}

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
    font: run.font ?? svg.font ?? "pdf",
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
    font: run.font ?? "pdf",
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

function exactCandidatesForRun(run, paintedSvg, exactMatchedSvg) {
  const rt = norm(run.text);
  const cands = [];
  for (let si = 0; si < paintedSvg.length; si++) {
    if (exactMatchedSvg.has(si)) continue;
    const t = paintedSvg[si];
    if (norm(t.text) !== rt) continue;
    const fit = exactPhysicalFit(run, t);
    if (fit) cands.push({ idx: si, svg: t, ...fit });
  }
  return cands.sort((a, b) => a.dist - b.dist || a.dy - b.dy);
}

function splitCandidatesForRun(run, paintedSvg, exactMatchedSvg) {
  const rc = compact(run.text);
  if (!rc) return [];
  const out = [];
  for (let idx = 0; idx < paintedSvg.length; idx++) {
    if (exactMatchedSvg.has(idx)) continue;
    const t = paintedSvg[idx];
    if (!compact(t.text).includes(rc)) continue;
    const fit = splitPhysicalFit(run, t);
    if (fit) out.push({ idx, svg: t, ...fit });
  }
  return out.sort(
    (a, b) => a.dy - b.dy || a.overshoot - b.overshoot || b.overlap - a.overlap,
  );
}

export function mapPdfRunsToSvgRoles(pdfRuns, svgTexts) {
  const paintedSvg = svgTexts.filter(
    (t) => t.painted !== false && norm(t.text).length > 0,
  );
  const paintedRuns = pdfRuns.filter(
    (r) => r.painted !== false && norm(r.text).length > 0,
  );
  const exactMatches = new Map();
  const piecesBySvgIdx = new Map();
  const results = new Array(paintedRuns.length);
  const remaining = [];

  for (let ri = 0; ri < paintedRuns.length; ri++) {
    const run = paintedRuns[ri];
    const cands = exactCandidatesForRun(run, paintedSvg, exactMatches);
    if (!cands.length) {
      remaining.push(ri);
      continue;
    }
    const tied = cands.filter((c) => c.dist - cands[0].dist <= TIE_DIST_MM);
    if (tied.length > 1 && rolesConflict(tied)) {
      results[ri] = unresolvedRun(run, "ambiguous", "ambiguous-exact-svg-role");
      continue;
    }
    exactMatches.set(cands[0].idx, run);
    results[ri] = resolveRunAgainstSvg(run, cands[0].svg, "exact");
  }

  for (const ri of remaining) {
    const run = paintedRuns[ri];
    const cands = splitCandidatesForRun(run, paintedSvg, exactMatches);
    if (!cands.length) {
      results[ri] = unresolvedRun(run, "unmapped", "unmatched-pdf-run");
      continue;
    }
    const tied = cands.filter(
      (c) =>
        Math.abs(c.dy - cands[0].dy) <= TIE_DIST_MM &&
        Math.abs(c.overshoot - cands[0].overshoot) <= TIE_DIST_MM,
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

  return {
    paintedSvg,
    runResults: results,
    exactMatches,
    exactMatchedSvg: new Set(exactMatches.keys()),
    piecesBySvgIdx,
  };
}

function unionBox(runs) {
  const x0 = Math.min(...runs.map((r) => r.bbox.x));
  const y0 = Math.min(...runs.map((r) => r.bbox.y));
  const x1 = Math.max(...runs.map((r) => r.bbox.x + r.bbox.w));
  const y1 = Math.max(...runs.map((r) => r.bbox.y + r.bbox.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function orderedCharactersMatch(svgText, ordered) {
  if (!ordered.length) return false;
  const target = norm(svgText);
  let pos = 0;
  for (const piece of ordered) {
    while (target[pos] === " ") pos += 1;
    const frag = norm(piece.text);
    if (!frag || !target.startsWith(frag, pos)) return false;
    pos += frag.length;
  }
  return pos === target.length;
}

function fragmentsPhysicallyValid(svg, ordered) {
  if (!ordered.length) return false;
  const svgM = svgAxisGeometry(svg);
  let prevEnd = -Infinity;
  for (const piece of ordered) {
    if (!splitPhysicalFit(piece, svg)) return false;
    const runM = runAxisGeometry(piece, svgM.rotated);
    if (runM.start < prevEnd - INK_ACCURACY_MM) return false;
    prevEnd = Math.max(prevEnd, runM.end);
  }
  return true;
}

function evaluateSplitLabel(svg, pieces, frame) {
  const rotated = Math.abs(svg.angle ?? 0) > 45;
  const ordered = [...pieces].sort((a, b) =>
    rotated ? a.bbox.y - b.bbox.y : a.bbox.x - b.bbox.x,
  );
  const role = affirmativeTextRole(svg);
  const geometryOk = fragmentsPhysicallyValid(svg, ordered);
  const contentExact = orderedCharactersMatch(svg.text, ordered);
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
  else if (!geometryOk) rawStatus = "fragment_geometry_mismatch";
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
    geometryOk,
    contentExact,
    emOk,
    fitsContainer017Mm,
    unionBbox: union,
    rawStatus,
  };
}

function matchingMetricRun(svg, matchedRun, pdfMetrics, usedMetric) {
  if (pdfMetrics === null) return matchedRun;
  const tt = norm(svg.text);
  let best = null;
  for (let i = 0; i < pdfMetrics.length; i++) {
    if (usedMetric.has(i)) continue;
    const p = pdfMetrics[i];
    if (norm(p.text) !== tt) continue;
    const fit = exactPhysicalFit(p, svg);
    if (!fit) continue;
    if (!best || fit.dist < best.dist) best = { p, i, dist: fit.dist };
  }
  if (!best) return null;
  usedMetric.add(best.i);
  return best.p;
}

export function reconcileDq21SplitLabels(
  paintedSvg,
  pdfMetrics,
  exactMatches,
  piecesBySvgIdx,
  frame,
  sameMetrics = false,
) {
  const usedMetric = new Set();
  const matchedViolations = [];
  const splitLabels = [];
  for (let si = 0; si < paintedSvg.length; si++) {
    const t = paintedSvg[si];
    const matchedRun = exactMatches.get(si);
    if (matchedRun) {
      const metric = sameMetrics
        ? matchedRun
        : matchingMetricRun(t, matchedRun, pdfMetrics, usedMetric);
      if (metric) {
        const advance = t.advance ?? t.bbox.w;
        const delta = Math.abs(metric.bbox.w - advance);
        if (delta > Math.max(0.15, advance * 0.02))
          matchedViolations.push({
            element: t.element,
            text: norm(t.text),
            svgWidthMm: advance,
            pdfWidthMm: metric.bbox.w,
            deltaMm: delta,
          });
      }
      continue;
    }
    splitLabels.push(
      evaluateSplitLabel(t, piecesBySvgIdx.get(si) ?? [], frame),
    );
  }
  return {
    matchedCount: exactMatches.size,
    matchedViolations,
    splitLabels,
  };
}

export function auditPdfTextRoles(pdfRuns, g, pdfMetrics = pdfRuns) {
  const { paintedSvg, runResults, exactMatches, piecesBySvgIdx } =
    mapPdfRunsToSvgRoles(pdfRuns, g.texts ?? []);
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
    reconcileDq21SplitLabels(
      paintedSvg,
      pdfMetrics,
      exactMatches,
      piecesBySvgIdx,
      g.frame,
      pdfMetrics === pdfRuns,
    );
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

function unresolvedRoleFinding(r, reportedRole, fallbackIndex) {
  const el = r.svgElement ?? `pdf-run-${r.index ?? fallbackIndex}`;
  const base = {
    element: el,
    text: r.text,
    bbox: r.bbox,
    font: r.font,
    roleDetail: r.roleDetail,
    medium: "pdf",
  };
  if (r.roleStatus === "ambiguous")
    return { kind: "pdf-ambiguous-text-role", ...base };
  if (r.roleDetail === "unmatched-pdf-run")
    return { kind: "pdf-unmapped-text-run", ...base };
  if (reportedRole.has(el)) return null;
  const kind =
    r.roleDetail === "invalid-text-role"
      ? "invalid-text-legibility-role"
      : "unmapped-text-legibility-role";
  return { kind, ...base };
}

export function pdfRoleLegibilityFindings(audit, existing = []) {
  const reportedRole = new Set(
    existing
      .filter((f) =>
        [
          "unmapped-text-legibility-role",
          "invalid-text-legibility-role",
        ].includes(f.kind),
      )
      .map((f) => f.element),
  );
  const reportedFloor = new Set(
    existing
      .filter((f) => f.kind === "text-below-minimum-em")
      .map((f) => f.element),
  );
  const out = [];
  for (const r of audit.unresolvedRoles) {
    const f = unresolvedRoleFinding(r, reportedRole, out.length);
    if (f) out.push(f);
  }
  for (const r of audit.belowFloor) {
    const el = r.svgElement ?? `pdf-run-${r.index ?? out.length}`;
    if (reportedFloor.has(el)) continue;
    reportedFloor.add(el);
    out.push({
      kind: "text-below-minimum-em",
      element: el,
      text: r.text,
      fontSizeMm: r.emMm,
      minimumMm: r.floorMm,
      roleCategory: r.roleCategory,
      roleDetail: r.roleDetail,
      font: r.font,
      bbox: r.bbox,
      medium: "pdf",
    });
  }
  return out;
}

export function pdfAuditObservation(c, s, pdfAudit, unmatched, obs) {
  if (!pdfAudit)
    return obs("DQ-21", [], {
      id: `${c.id}/DQ-21/unmatched-${s.number}`,
      status: "not-implemented",
      reason:
        "Needs a PDF text-run to SVG-label association, or per-glyph advances for split/shaped labels.",
      unmatchedLabels: unmatched,
    });
  return obs("DQ-21", dq21SplitFindings(pdfAudit), {
    id: `${c.id}/DQ-21/unmatched-${s.number}`,
    scope:
      "Strict 1-to-1 physical PDF-to-SVG role audit and split/shaped label reconciliation by baseline/extent, ordered characters, affirmative role, role em floor, and 0.17 mm container bounds.",
    unmatchedLabels: unmatched,
    splitReconciled:
      pdfAudit.splitLabels.length - pdfAudit.unresolvedSplitLabels.length,
    splitUnresolved: pdfAudit.unresolvedSplitLabels.length,
    unresolvedPdfRuns: pdfAudit.unresolvedRoles.length,
    belowFloorPdfRuns: pdfAudit.belowFloor.length,
  });
}

export function dq21SplitFindings(audit) {
  const out = audit.unresolvedSplitLabels.map((s) => ({
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
  for (const r of audit.unresolvedRoles)
    out.push({
      kind: `dq21-pdf-${r.roleStatus}`,
      element: r.svgElement ?? `pdf-run-${r.index ?? out.length}`,
      text: r.text,
      roleStatus: r.roleStatus,
      roleDetail: r.roleDetail,
      bbox: r.bbox,
      medium: "pdf",
    });
  for (const r of audit.belowFloor)
    out.push({
      kind: "dq21-pdf-below-role-em-floor",
      element: r.svgElement ?? `pdf-run-${r.index ?? out.length}`,
      text: r.text,
      roleCategory: r.roleCategory,
      roleDetail: r.roleDetail,
      emMm: r.emMm,
      floorMm: r.floorMm,
      bbox: r.bbox,
      medium: "pdf",
    });
  return out;
}
