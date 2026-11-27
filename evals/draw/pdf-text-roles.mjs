// Strict physical 1-to-1 PDF-to-SVG text-role mapping and DQ-21 reconciliation.
// Never uses a permissive body default, proximity-only 5 mm match, or unbounded pass.
import { INK_ACCURACY_MM, inside } from "./checks.mjs";
import { isPdfMeasured } from "./pdf-painted.mjs";
import { affirmativeTextRole } from "./text-legibility.mjs";

const EM_TOL_MM = 0.03;
// Derived from E3 300-dpi ink accuracy (2 px = 0.1693 mm -> 0.17 mm).
// Embedded-font SVG vs PDF baselines agree within <= 0.0001 mm across measured corpus runs.
export const BASELINE_TOL_MM = INK_ACCURACY_MM;
// Derived from E3 300-dpi ink accuracy and DQ-21's calibrated 2% advance tolerance.
export const extentToleranceMm = (expectedWidthMm) =>
  Math.max(INK_ACCURACY_MM, Math.max(0, expectedWidthMm) * 0.02);
const TIE_DIST_MM = 0.1;
// Native PDF writing direction must align with SVG writing direction (within 5 deg).
const DIR_COS_TOL = Math.cos((5 * Math.PI) / 180);

const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/gu, " ")
    .trim();
const compact = (s) => norm(s).replace(/\s+/gu, "");
const runEm = (r) => r.emMm ?? r.fontSize;
const exactTrimmed = (o) => String(o.renderedString ?? o.text ?? "").trim();

function svgLineGeometry(t) {
  let dir;
  if (Array.isArray(t.dir) && t.dir.length === 2) dir = t.dir;
  else if (typeof t.angle === "number") {
    const rad = (t.angle * Math.PI) / 180;
    dir = [Math.cos(rad), Math.sin(rad)];
  } else dir = [1, 0];

  const vertical = Math.abs(dir[1]) > Math.abs(dir[0]);
  const origin = t.baselineOrigin
    ? t.baselineOrigin
    : vertical
      ? t.anchor
        ? { x: t.anchor.x, y: t.anchor.y }
        : { x: t.bbox.x + t.bbox.w, y: t.bbox.y + t.bbox.h }
      : {
          x: t.emBbox ? t.emBbox.x : t.bbox.x,
          y: t.anchor
            ? t.anchor.y + (t.baselineShiftMm ?? 0)
            : t.bbox.y + t.bbox.h,
        };
  if (t.charSpans?.ends?.length) {
    const start = Math.min(0, t.charSpans.starts[0]);
    const end = Math.max(t.advance ?? 0, t.charSpans.ends.at(-1));
    return { dir, origin, start, end, width: end - start };
  }
  const boxSpan = vertical
    ? (t.emBbox?.h ?? t.bbox.h)
    : (t.emBbox?.w ?? t.bbox.w);
  const width = Math.max(t.advance ?? 0, boxSpan);
  return { dir, origin, start: 0, end: width, width };
}

function runLineGeometry(run) {
  const dir = Array.isArray(run.dir) && run.dir.length === 2 ? run.dir : [1, 0];
  const origin = run.baselineOrigin ?? {
    x: run.bbox.x,
    y: run.bbox.y + run.bbox.h,
  };
  const advance =
    typeof run.projectedAdvance === "number"
      ? run.projectedAdvance
      : run.bbox.w;
  return { dir, origin, advance };
}

function projectRunToSvg(run, svgG) {
  const runG = runLineGeometry(run);
  const dot = runG.dir[0] * svgG.dir[0] + runG.dir[1] * svgG.dir[1];
  if (dot < DIR_COS_TOL) return null;
  const dx = runG.origin.x - svgG.origin.x;
  const dy = runG.origin.y - svgG.origin.y;
  const baselineDist = Math.abs(-dx * svgG.dir[1] + dy * svgG.dir[0]);
  const start = dx * svgG.dir[0] + dy * svgG.dir[1];
  const end = start + runG.advance;
  return { baselineDist, start, end, advance: runG.advance };
}

function charMatches(svgChar, fragChar) {
  if (svgChar === fragChar) return true;
  return /\s/u.test(svgChar) && /\s/u.test(fragChar);
}

function charsMatchAt(chars, fragChars, startIdx) {
  if (startIdx < 0 || startIdx + fragChars.length > chars.length) return false;
  for (let i = 0; i < fragChars.length; i++) {
    if (!charMatches(chars[startIdx + i], fragChars[i])) return false;
  }
  return true;
}

function charSpanFitAt(charSpans, fragChars, startIdx, proj, posTol) {
  if (!charsMatchAt(charSpans.chars, fragChars, startIdx)) return null;
  const expStart = charSpans.starts[startIdx];
  const expEnd = charSpans.ends[startIdx + fragChars.length - 1];
  const expWidth = expEnd - expStart;
  const startErr = Math.abs(proj.start - expStart);
  const endErr = Math.abs(proj.end - expEnd);
  const advErr = Math.abs(proj.advance - expWidth);
  if (startErr > posTol || endErr > posTol) return null;
  if (advErr > extentToleranceMm(expWidth)) return null;
  return { startErr, endErr, advErr, maxErr: Math.max(startErr, endErr) };
}

function bestCharSpanFit(charSpans, fragText, proj, posTol) {
  const fragChars = Array.from(fragText);
  if (!fragChars.length) return null;
  let best = null;
  for (let i = 0; i <= charSpans.chars.length - fragChars.length; i++) {
    const fit = charSpanFitAt(charSpans, fragChars, i, proj, posTol);
    if (fit && (!best || fit.maxErr < best.maxErr)) best = fit;
  }
  return best;
}

function exactPhysicalFit(run, svg) {
  const svgG = svgLineGeometry(svg);
  const proj = projectRunToSvg(run, svgG);
  if (!proj || proj.baselineDist > BASELINE_TOL_MM) return null;
  const tol = extentToleranceMm(svgG.width);
  const startDx = Math.abs(proj.start - svgG.start);
  const endDx = Math.abs(proj.end - svgG.end);
  if (startDx > tol || endDx > tol) return null;
  const anchorDx = Math.max(startDx, endDx);
  return {
    dy: proj.baselineDist,
    anchorDx,
    dist: Math.hypot(anchorDx, proj.baselineDist),
  };
}

function splitPhysicalFit(run, svg) {
  const svgG = svgLineGeometry(svg);
  const proj = projectRunToSvg(run, svgG);
  if (!proj || proj.baselineDist > BASELINE_TOL_MM) return null;
  const tol = extentToleranceMm(svgG.width);
  const leftOver = svgG.start - proj.start;
  const rightOver = proj.end - svgG.end;
  if (leftOver > tol || rightOver > tol) return null;
  const overlap =
    Math.min(proj.end, svgG.end) - Math.max(proj.start, svgG.start);
  if (overlap < -INK_ACCURACY_MM) return null;
  if (svg.charSpans?.chars?.length) {
    const fragText = String(run.text ?? "").trim();
    const spanFit = bestCharSpanFit(svg.charSpans, fragText, proj, tol);
    if (!spanFit) return null;
    return { dy: proj.baselineDist, overshoot: spanFit.maxErr, overlap };
  }
  const overshoot = Math.max(0, leftOver, rightOver);
  return { dy: proj.baselineDist, overshoot, overlap };
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

function exactStringsEqual(run, svg) {
  if (svg.renderedString !== undefined) {
    return exactTrimmed(run) === exactTrimmed(svg);
  }
  return norm(svg.text) === norm(run.text);
}

function exactCandidatesForRun(run, paintedSvg, exactMatchedSvg) {
  const cands = [];
  for (let si = 0; si < paintedSvg.length; si++) {
    if (exactMatchedSvg.has(si)) continue;
    const t = paintedSvg[si];
    if (!exactStringsEqual(run, t)) continue;
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

function validateCharSpanSequence(svg, svgG, projected) {
  const { chars } = svg.charSpans;
  const tol = extentToleranceMm(svgG.width);
  let ci = 0;
  let geometryOk = true;
  let prevEnd = -Infinity;
  for (const { piece, proj } of projected) {
    if (!proj || proj.baselineDist > BASELINE_TOL_MM)
      return { geometryOk: false, contentExact: false };
    if (proj.start < prevEnd - INK_ACCURACY_MM) geometryOk = false;
    prevEnd = Math.max(prevEnd, proj.end);
    while (ci < chars.length && /\s/u.test(chars[ci])) ci += 1;
    const fragChars = Array.from(String(piece.text ?? "").trim());
    if (!fragChars.length || !charsMatchAt(chars, fragChars, ci)) {
      return { geometryOk, contentExact: false };
    }
    if (!charSpanFitAt(svg.charSpans, fragChars, ci, proj, tol)) {
      geometryOk = false;
    }
    ci += fragChars.length;
  }
  while (ci < chars.length && /\s/u.test(chars[ci])) ci += 1;
  return { geometryOk, contentExact: ci === chars.length };
}

function validateFallbackSequence(svg, svgG, projected) {
  const ordered = projected.map((x) => x.piece);
  const tol = extentToleranceMm(svgG.width);
  let geometryOk = true;
  let prevEnd = -Infinity;
  for (const { piece, proj } of projected) {
    if (!proj || !splitPhysicalFit(piece, svg)) geometryOk = false;
    if (!proj || proj.start < prevEnd - INK_ACCURACY_MM) geometryOk = false;
    if (proj) prevEnd = Math.max(prevEnd, proj.end);
  }
  const first = projected[0]?.proj;
  const last = projected.at(-1)?.proj;
  if (
    !first ||
    !last ||
    Math.abs(first.start - svgG.start) > tol ||
    Math.abs(last.end - svgG.end) > tol
  ) {
    geometryOk = false;
  }
  return {
    geometryOk,
    contentExact: orderedCharactersMatch(svg.text, ordered),
  };
}

function evaluateSplitLabel(svg, pieces, frame) {
  const svgG = svgLineGeometry(svg);
  const projected = pieces
    .map((piece) => ({ piece, proj: projectRunToSvg(piece, svgG) }))
    .sort((a, b) => (a.proj?.start ?? Infinity) - (b.proj?.start ?? Infinity));
  const ordered = projected.map((x) => x.piece);
  const role = affirmativeTextRole(svg);
  const { geometryOk, contentExact } = ordered.length
    ? svg.charSpans?.chars?.length
      ? validateCharSpanSequence(svg, svgG, projected)
      : validateFallbackSequence(svg, svgG, projected)
    : { geometryOk: false, contentExact: false };
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
    svgBbox: svg.bbox,
    svgFont: svg.font,
    rawStatus,
  };
}

function matchingMetricRun(svg, matchedRun, pdfMetrics, usedMetric) {
  if (pdfMetrics === null) return matchedRun;
  let best = null;
  for (let i = 0; i < pdfMetrics.length; i++) {
    if (usedMetric.has(i)) continue;
    const p = pdfMetrics[i];
    if (!exactStringsEqual(p, svg)) continue;
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

export function auditMeasuredPdfSheet(pdf, g, pdfMetrics) {
  const runs = Array.isArray(pdf) ? pdf : [];
  const metrics = pdfMetrics === undefined ? runs : pdfMetrics;
  const measured =
    Array.isArray(pdf) &&
    (pdf.length > 0 ||
      isPdfMeasured(pdf) ||
      isPdfMeasured(pdfMetrics) ||
      Array.isArray(pdfMetrics));
  return {
    runs,
    metrics,
    audit: measured ? auditPdfTextRoles(runs, g, metrics) : null,
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

function unresolvedSplitLegibilityFinding(s) {
  if (s.rawStatus === "missing_pdf_run") {
    return {
      kind: "pdf-missing-text-run",
      element: s.element,
      text: s.text,
      bbox: s.svgBbox ?? null,
      font: s.svgFont ?? "pdf",
      roleCategory: s.roleCategory,
      roleDetail: s.roleDetail,
      medium: "pdf",
    };
  }
  if (
    s.rawStatus === "fragment_geometry_mismatch" ||
    s.rawStatus === "content_mismatch"
  ) {
    return {
      kind: "pdf-split-geometry-mismatch",
      element: s.element,
      text: s.text,
      bbox: s.unionBbox ?? s.svgBbox ?? null,
      font: s.svgFont ?? "pdf",
      roleCategory: s.roleCategory,
      roleDetail: s.roleDetail,
      rawStatus: s.rawStatus,
      medium: "pdf",
    };
  }
  return null;
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
  for (const s of audit.unresolvedSplitLabels) {
    const f = unresolvedSplitLegibilityFinding(s);
    if (f) out.push(f);
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
      "Strict 1-to-1 physical PDF-to-SVG role audit and split/shaped label reconciliation by baseline/direction, per-character expected positions, ordered characters, affirmative role, role em floor, and 0.17 mm container bounds.",
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
