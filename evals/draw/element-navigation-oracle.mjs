import {
  elementPopulation,
  existingActuationPair,
} from "./element-navigation-source.mjs";
import {
  referenceInk,
  referenceTokens,
  hasReferenceName,
} from "./navigation-reference-ink.mjs";
import { parseSourceHeader } from "./navigation-reference-clauses.mjs";
import { rowZones } from "./m3-zones.mjs";
import { measuredZone } from "./repeat-appearances.mjs";
import { nearestOwner, anchorDistance } from "./navigation-geometry.mjs";
import { finding } from "./review-geometry.mjs";
import { nativeContactRole } from "./contact-role-oracle.mjs";

const deviceDesignation = (ir, uid) =>
  ir.devices.find((d) => d.uid === uid)?.designation;

function sheetDesignations(g, ir) {
  const uids = new Set();
  for (const s of g.shapes ?? []) if (s.deviceUid) uids.add(s.deviceUid);
  for (const t of g.terminals ?? []) if (t.deviceUid) uids.add(t.deviceUid);
  for (const t of g.texts ?? []) if (t.tagOwnerUid) uids.add(t.tagOwnerUid);
  const tags = [];
  for (const d of ir.devices ?? [])
    if (d.designation && (!uids.size || uids.has(d.uid)))
      tags.push(d.designation);
  return tags;
}

function appearanceMatchesZone(g, appearance, zone) {
  const anchorZone = appearance.zone ?? measuredZone(g, appearance.anchor);
  return anchorZone === zone || rowZones(g, appearance.bbox).includes(zone);
}

function selfLocatedOwnerState(prefix, a, appearances, g, ir) {
  const tag = deviceDesignation(ir, a.uid);
  const sourceZone = a.zone ?? measuredZone(g, a.anchor);
  if (!sourceZone) return { ok: false, missingSourceZone: true };
  if (
    !prefix.validToken ||
    !tag ||
    prefix.designation !== tag ||
    prefix.sheet !== a.sheet ||
    prefix.zone !== sourceZone
  )
    return { ok: false, missingSourceZone: false };
  const denotable = appearances.filter(
    (p) =>
      p.sheet === a.sheet &&
      deviceDesignation(ir, p.uid) === prefix.designation &&
      appearanceMatchesZone(g, p, prefix.zone),
  );
  const otherSameTagInZone = (g.shapes ?? []).some(
    (s) =>
      s.deviceUid &&
      s.deviceUid !== a.uid &&
      deviceDesignation(ir, s.deviceUid) === prefix.designation &&
      s.bbox &&
      rowZones(g, s.bbox).includes(prefix.zone),
  );
  return {
    ok: denotable.length === 1 && denotable[0] === a && !otherSameTagInZone,
    missingSourceZone: false,
  };
}

function elementClauseForOwner(t, a, appearances, g, ir, designations) {
  const prefix = parseSourceHeader(t.text, designations);
  if (!prefix.present) {
    const local =
      nearestOwner(g, a, t.bbox).ownerNearest &&
      anchorDistance(a.anchor, t.bbox) <= 60.01;
    return { ok: local, clauseText: t.text, missingSourceZone: false };
  }
  const state = selfLocatedOwnerState(prefix, a, appearances, g, ir);
  return {
    ok: state.ok,
    clauseText: `${prefix.designation}: ${prefix.body}`,
    missingSourceZone: state.missingSourceZone,
  };
}
function namesFunction(text, fn, ir) {
  const tag = ir.devices.find((d) => d.uid === fn.id.deviceUid)?.designation;
  const role = nativeContactRole(ir, fn).role;
  const states = [...text.matchAll(/\b(NC|NO)\b/gu)].map((m) => m[1]);
  if (states.some((state) => state !== nativeContactRole(ir, fn).state))
    return false;
  const claims = [
    ...text.matchAll(/\b(coil|contact|overload|breaker|fuse)\b/giu),
  ].map((m) => m[1].toLowerCase());
  if (claims.some((c) => c !== role)) return false;
  return (
    !!tag &&
    hasReferenceName(text, tag) &&
    (hasReferenceName(text, tag + "." + fn.id.functionKey) ||
      fn.terminals.every((t) => hasReferenceName(text, t.terminalKey)))
  );
}
function detachedProtectionPair(a, b, ir) {
  const fn = (x) =>
    ir.functions.find(
      (f) => f.id.deviceUid === x.uid && f.id.functionKey === x.functionKey,
    );
  const roles = [
    nativeContactRole(ir, fn(a)).role,
    nativeContactRole(ir, fn(b)).role,
  ];
  return (
    roles.includes("contact") &&
    roles.some((r) => ["overload", "breaker", "fuse"].includes(r))
  );
}
function splitArrowReferences(packet, geometries, ir, findings) {
  for (const [i, sheet] of packet.sheets.entries()) {
    const g = geometries[i];
    if (!g) continue;
    const seen = new Set();
    for (const ink of referenceInk(g, sheetDesignations(g, ir))) {
      const rows = (ink.rows ?? [])
        .slice()
        .sort(
          (a, b) =>
            (a.anchor?.y ?? a.bbox.y) - (b.anchor?.y ?? b.bbox.y) ||
            a.bbox.x - b.bbox.x,
        );
      if (rows.length < 2) continue;
      const key = rows.map((r) => r.element).join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      if (rows.slice(0, -1).some((r) => /(?:→|->)\s*$/u.test(r.text.trim())))
        findings.push({
          ...finding("reference-arrow-split", rows[0], {
            lines: rows.map((r) => r.text),
          }),
          sheet: sheet.number,
        });
    }
  }
}

export function elementNavigationAudit(packet, geometries, ir, request) {
  const {
      appearances,
      failures,
      findings = [],
    } = elementPopulation(packet, geometries, ir, request),
    obligations = [];
  unresolvedElementPointers(appearances, geometries, ir, findings);
  splitArrowReferences(packet, geometries, ir, findings);
  for (const a of appearances) {
    const peers = appearances.filter(
      (b) =>
        a.uid === b.uid &&
        a.functionKey !== b.functionKey &&
        a.sheet !== b.sheet &&
        detachedProtectionPair(a, b, ir) &&
        !existingActuationPair(a, b, ir),
    );
    for (const b of peers) {
      inspectElementPair(
        a,
        b,
        appearances,
        geometries,
        ir,
        findings,
        failures,
        obligations,
      );
    }
  }
  return {
    findings,
    failures,
    obligations,
    eligible: obligations.length,
    appearances,
  };
}

function unresolvedElementPointers(appearances, geometries, ir, findings) {
  for (const a of appearances) {
    const g = geometries[a.geometryIndex];
    const designations = sheetDesignations(g, ir);
    for (const ink of referenceInk(g, designations)) {
      const prefix = parseSourceHeader(ink.text, designations);
      const validPrefix =
        prefix.present &&
        selfLocatedOwnerState(prefix, a, appearances, g, ir).ok;
      const text = validPrefix
        ? `${prefix.designation}: ${prefix.body}`
        : ink.text;
      for (const fn of ir.functions.filter(
        (f) =>
          f.id.deviceUid === a.uid &&
          f.terminals.length &&
          f.id.functionKey !== a.functionKey &&
          detachedProtectionPair(
            a,
            { uid: f.id.deviceUid, functionKey: f.id.functionKey },
            ir,
          ) &&
          !existingActuationPair(
            a,
            { uid: f.id.deviceUid, functionKey: f.id.functionKey },
            ir,
          ) &&
          namesFunction(text, f, ir),
      ))
        for (const token of referenceTokens(text)) {
          if (token.sheet === a.sheet) continue;
          if (
            !appearances.some(
              (b) =>
                b.uid === a.uid &&
                b.functionKey === fn.id.functionKey &&
                b.sheet === token.sheet &&
                rowZones(geometries[b.geometryIndex], b.bbox).includes(
                  token.zone,
                ),
            )
          )
            findings.push({
              ...finding("element-navigation-target-unavailable", ink, {
                deviceUid: a.uid,
                targetFunction: fn.id.functionKey,
                targetSheet: token.sheet,
                zone: token.zone,
              }),
              sheet: a.sheet,
            });
        }
    }
  }
}

function correctElementClause(
  clauseText,
  a,
  b,
  appearances,
  geometries,
  ir,
  zones,
) {
  const tokens = referenceTokens(clauseText),
    named = ir.functions.filter(
      (f) =>
        f.id.deviceUid === a.uid &&
        f.terminals.length &&
        namesFunction(clauseText, f, ir),
    );
  const destinations = appearances.filter(
    (p) =>
      p.uid === b.uid && p.functionKey === b.functionKey && p.sheet !== a.sheet,
  );
  return (
    tokens.filter((p) => p.sheet === b.sheet && zones.includes(p.zone))
      .length === 1 &&
    (tokens.length === 1 || named.length === 1) &&
    tokens.every((p) =>
      destinations.some(
        (q) =>
          q.sheet === p.sheet &&
          rowZones(geometries[q.geometryIndex], q.bbox).includes(p.zone),
      ),
    )
  );
}

function recordElementOutcome(
  a,
  b,
  zones,
  missingSourceZone,
  candidates,
  correct,
  record,
  findings,
  failures,
) {
  if (!zones.length || missingSourceZone)
    failures.push({
      ...finding(
        "element-navigation-zone-geometry-unavailable",
        missingSourceZone ? a : b,
        record,
      ),
      sheet: a.sheet,
    });
  else if (correct.length !== 1)
    findings.push({
      ...finding(
        "detached-element-reference-missing-or-wrong",
        candidates[0]?.t ?? a,
        {
          ...record,
          matches: correct.length,
          printed: candidates.map(({ t }) => t.text),
        },
      ),
      sheet: a.sheet,
    });
}

function inspectElementPair(
  a,
  b,
  appearances,
  geometries,
  ir,
  findings,
  failures,
  obligations,
) {
  const g = geometries[a.geometryIndex],
    target = geometries[b.geometryIndex],
    fn = ir.functions.find(
      (f) => f.id.deviceUid === b.uid && f.id.functionKey === b.functionKey,
    );
  const zones = rowZones(target, b.bbox),
    tag = deviceDesignation(ir, a.uid),
    designations = sheetDesignations(g, ir);
  const evaluated = referenceInk(g, designations).map((t) => ({
    t,
    owner: elementClauseForOwner(t, a, appearances, g, ir, designations),
  }));
  const candidates = evaluated.filter(
    ({ owner }) => owner.ok && namesFunction(owner.clauseText, fn, ir),
  );
  const missingSourceZone = evaluated.some(
    ({ owner }) =>
      owner.missingSourceZone && namesFunction(owner.clauseText, fn, ir),
  );
  // One clause may name several functions at the SAME measured destination;
  // several different destinations need separate named clauses (no swaps).
  const correct = candidates.filter(({ owner }) =>
    correctElementClause(
      owner.clauseText,
      a,
      b,
      appearances,
      geometries,
      ir,
      zones,
    ),
  );
  const record = {
    sheet: a.sheet,
    deviceUid: a.uid,
    designation: tag,
    sourceFunction: a.functionKey,
    targetFunction: b.functionKey,
    targetSheet: b.sheet,
    allowedZones: zones,
    sourceElement: a.element,
    targetElement: b.element,
  };
  obligations.push(record);
  recordElementOutcome(
    a,
    b,
    zones,
    missingSourceZone,
    candidates,
    correct,
    record,
    findings,
    failures,
  );
}
