import {
  INK_ACCURACY_MM,
  distance,
  inside,
  overlap,
  routePoints,
  zoneAt,
} from "./checks.mjs";
import {
  connectorRows,
  identityMatches,
  printedConductor,
  referenceHeader,
  referenceRow,
} from "./continuation-labels.mjs";
import { printedZones } from "./printed-zones.mjs";
import { reportIssue as issue } from "./report-checks.mjs";

// Numerical and SVG-to-mm coordinate serialization noise only (<= 0.01 mm).
// Never a drafting allowance.
export const ZONE_GUTTER_EPSILON_MM = 0.01;
// Minimum clearance from the zone-letter column's inner rule to left-gutter
// continuation glyph ink under the bounded left-continuation contract.
export const LEFT_CONTINUATION_RULE_CLEARANCE_MM = 1.5;
// Matches continuation-pack.ts's isotonic packing limit (3.5 mm).
export const LEFT_CONTINUATION_VERTICAL_ALIGN_MM = 3.5;
export const LEFT_CONTINUATION_EDGE_TOLERANCE_MM = 0.25;
export const LEFT_CONTINUATION_CONDUCTOR_TOLERANCE_MM = 0.25;

function zoneColumnRuleRight(g, zones, fieldLeft, fieldTop, fieldBottom) {
  const letterRight = Math.max(
    ...zones.letters.map((t) => t.bbox.x + t.bbox.w),
  );
  if (typeof g.zoneColumnRuleRight === "number")
    return Math.max(letterRight, g.zoneColumnRuleRight);
  const minSpan = (fieldBottom - fieldTop) * 0.5;
  const rules = (g.zoneColumnRules ?? []).filter(
    (r) =>
      r.right >= letterRight - 0.1 &&
      r.right < fieldLeft - 0.1 &&
      r.h >= minSpan,
  );
  return Math.max(letterRight, ...rules.map((r) => r.right));
}

function polylineDistanceToPoint(points, p) {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    best = Math.min(best, Math.hypot(points[i].x - p.x, points[i].y - p.y));
    if (i > 0) best = Math.min(best, distance(p, points[i - 1], points[i]));
  }
  return best;
}

function conductorMatchesShape(shape, c, expected) {
  if (!shape.conductor || shape.painted === false) return false;
  if (shape.wire) {
    if (
      shape.wire === expected.uid ||
      shape.wire === expected.text ||
      shape.wire === c.conductor
    )
      return true;
    return !!(c.netId && shape.net === c.netId && expected.kind === "core");
  }
  return !!(c.netId && shape.net === c.netId);
}

function conductorLeavesAtAnchor(g, c, expected, anchor, context) {
  const shapes = context?.shapeGeometry?.shapes ?? g.shapes ?? [];
  for (const s of shapes) {
    if (!conductorMatchesShape(s, c, expected)) continue;
    const pts = routePoints(s);
    if (!pts?.length) continue;
    if (
      polylineDistanceToPoint(pts, anchor) <=
      LEFT_CONTINUATION_CONDUCTOR_TOLERANCE_MM
    )
      return true;
  }
  return false;
}

function destinationVerified(c, rows, source, context) {
  const { sheet, packet, geometries } = context;
  const target = packet.sheets?.find((sh) => sh.number === c.toSheet);
  if (!target) return null;
  const back = target.continuations?.some(
    (r) =>
      r !== c &&
      r.id === c.id &&
      r.toSheet === sheet.number &&
      r.conductor === c.conductor &&
      r.netId === c.netId,
  );
  if (!back) return null;
  const ref = referenceRow(rows, c.id);
  const header = referenceHeader(ref, c.id);
  if (!header || header.page !== c.toSheet || !header.zone) return null;
  const targetGeometry = geometries[packet.sheets.indexOf(target)];
  const peers =
    targetGeometry?.connectors?.filter(
      (p) => p !== source && p.id === c.id && p.toSheet === sheet.number,
    ) ?? [];
  if (peers.length !== 1) return null;
  const expectedZone = zoneAt(targetGeometry, peers[0].anchor);
  return expectedZone && header.zone === expectedZone ? header.zone : null;
}

function unionBox(boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}

function hasGutterCollision(rows, source, g, fieldLeft, context) {
  const otherTexts = (g.texts ?? []).filter(
    (t) =>
      t.painted !== false && t.bbox && t.continuationLink !== source.element,
  );
  const shapes = context?.shapeGeometry?.shapes ?? g.shapes ?? [];
  for (const r of rows) {
    if (otherTexts.some((o) => overlap(r.bbox, o.bbox, 0))) return true;
    for (const s of shapes) {
      if (s.painted === false || !s.bbox) continue;
      if (s.bbox.x + s.bbox.w >= fieldLeft - 0.1) continue;
      if (overlap(r.bbox, s.bbox, 0)) return true;
    }
  }
  return false;
}

function isLeftEdgeStub(source, rows, fieldLeft) {
  const leftSide =
    source.side === "left" ||
    (source.stubEnd &&
      source.stubEnd.x < source.anchor.x - 0.5 &&
      Math.abs(source.stubEnd.y - source.anchor.y) <= 0.05);
  return (
    !!leftSide &&
    Math.abs(source.anchor.x - fieldLeft) <=
      LEFT_CONTINUATION_EDGE_TOLERANCE_MM &&
    rows.every(
      (r) => r.bbox.x + r.bbox.w <= source.anchor.x + ZONE_GUTTER_EPSILON_MM,
    )
  );
}

function evaluateLeftContinuation(
  c,
  occurrence,
  g,
  context,
  fieldLeft,
  ruleRight,
) {
  const { source, rows } = connectorRows(g, c, occurrence);
  if (!source || !rows.length) return null;
  if (!rows.some((r) => r.bbox.x < fieldLeft - ZONE_GUTTER_EPSILON_MM))
    return null;
  const owned = (g.texts ?? []).filter(
    (t) => t.painted !== false && t.continuationLink === source.element,
  );
  const reject = (reason) => ({ ok: false, owned, reason });
  if (!isLeftEdgeStub(source, rows, fieldLeft))
    return reject("continuation-not-left-edge");
  const expected = printedConductor(c, context.ir);
  if (!expected || !identityMatches(rows, c, expected))
    return reject("continuation-unverified-conductor");
  if (!conductorLeavesAtAnchor(g, c, expected, source.anchor, context))
    return reject("continuation-no-edge-conductor");
  const destZone = destinationVerified(c, rows, source, context);
  if (!destZone) return reject("continuation-unverified-destination");
  const blockBox = unionBox(rows.map((r) => r.bbox));
  if (
    !inside(blockBox, g.frame, ZONE_GUTTER_EPSILON_MM) ||
    blockBox.y < g.headerRule.y - ZONE_GUTTER_EPSILON_MM ||
    (g.titleBlock &&
      blockBox.y + blockBox.h > g.titleBlock.y + ZONE_GUTTER_EPSILON_MM)
  )
    return reject("continuation-outside-frame");
  const clearanceMm = blockBox.x - ruleRight;
  if (blockBox.x < ruleRight - ZONE_GUTTER_EPSILON_MM)
    return reject("continuation-in-zone-letter-column");
  if (
    clearanceMm <
    LEFT_CONTINUATION_RULE_CLEARANCE_MM - ZONE_GUTTER_EPSILON_MM
  )
    return reject("continuation-rule-clearance");
  const blockMidY = blockBox.y + blockBox.h / 2;
  const verticalOffsetMm = Math.abs(blockMidY - source.anchor.y);
  if (
    verticalOffsetMm >
    LEFT_CONTINUATION_VERTICAL_ALIGN_MM + ZONE_GUTTER_EPSILON_MM
  )
    return reject("continuation-vertical-misalignment");
  if (hasGutterCollision(rows, source, g, fieldLeft, context))
    return reject("continuation-collision");
  return {
    ok: true,
    owned,
    record: {
      id: c.id,
      conductor: expected.text,
      toSheet: c.toSheet,
      destinationZone: destZone,
      element: source.element,
      leftMm: blockBox.x,
      ruleRightMm: ruleRight,
      clearanceMm,
      fieldLeftMm: fieldLeft,
      anchorY: source.anchor.y,
      blockMidY,
      verticalOffsetMm,
    },
  };
}

function collectVerifiedContinuations(g, context, fieldLeft, ruleRight) {
  const allowedElements = new Set();
  const rejectionReasons = new Map();
  const contracted = [];
  if (
    !context?.sheet ||
    !context?.packet ||
    !context?.geometries ||
    !context?.ir
  )
    return { allowedElements, rejectionReasons, contracted };
  const used = new Map();
  for (const c of context.sheet.continuations ?? []) {
    const occurrence = used.get(c.id) ?? 0;
    used.set(c.id, occurrence + 1);
    const res = evaluateLeftContinuation(
      c,
      occurrence,
      g,
      context,
      fieldLeft,
      ruleRight,
    );
    if (!res) continue;
    if (res.ok) {
      for (const t of res.owned) allowedElements.add(t.element);
      contracted.push(res.record);
    } else {
      for (const t of res.owned)
        if (!rejectionReasons.has(t.element))
          rejectionReasons.set(t.element, res.reason);
    }
  }
  return { allowedElements, rejectionReasons, contracted };
}

function isZoneGridMark(t, zoneSet, fieldRight, fieldBottom) {
  return (
    zoneSet.has(t) ||
    (t.sheetText &&
      !t.nested &&
      !t.deviceUid &&
      !t.wire &&
      !t.row &&
      !t.continuation &&
      t.tagField == null &&
      ((/^[1-9]\d*$/.test(t.text) &&
        t.bbox.y >= fieldBottom - INK_ACCURACY_MM) ||
        (/^[A-Z]+$/.test(t.text) && t.bbox.x >= fieldRight - INK_ACCURACY_MM)))
  );
}

/** Audit non-zone body glyph ink against the measured left zone boundary
 * (fieldLeft = zones.numbers[0].anchor.x - colW / 2).
 *
 * Bounded left-continuation contract: only true left-edge sheet continuation
 * references verified against the model/IR (conductor leaves at that edge,
 * real reciprocal destination, >= 1.5 mm right of the zone-letter column's
 * inner rule, inside the sheet frame, vertically aligned with their own
 * conductor, and collision-free) may sit between the zone-letter column and
 * fieldLeft. Every qualifying reference is counted and returned in `contracted`.
 * All other classes (legends, notices, tables, strip keys, peer notes, top and
 * bottom continuations, or unverified/false continuation markers) have zero
 * exemption at x < fieldLeft. */
export function zoneGutterAudit(g, context) {
  const zones = printedZones(g);
  if (
    !g.frame ||
    !g.headerRule ||
    zones.numbers.length < 2 ||
    zones.letters.length < 2
  )
    return { findings: [], contracted: [] };
  const colW =
    (zones.numbers.at(-1).anchor.x - zones.numbers[0].anchor.x) /
    (zones.numbers.length - 1);
  const rowH =
    (zones.letters.at(-1).anchor.y - zones.letters[0].anchor.y) /
    (zones.letters.length - 1);
  if (colW <= 0 || rowH <= 0) return { findings: [], contracted: [] };
  const fieldLeft = zones.numbers[0].anchor.x - colW / 2;
  const fieldRight = zones.numbers.at(-1).anchor.x + colW / 2;
  const fieldTop = zones.letters[0].anchor.y - rowH / 2;
  const fieldBottom = zones.letters.at(-1).anchor.y + rowH / 2;
  const ruleRight = zoneColumnRuleRight(
    g,
    zones,
    fieldLeft,
    fieldTop,
    fieldBottom,
  );
  const { allowedElements, rejectionReasons, contracted } =
    collectVerifiedContinuations(g, context, fieldLeft, ruleRight);
  const zoneSet = new Set([...zones.numbers, ...zones.letters]);
  const findings = [];
  for (const t of g.texts) {
    if (
      t.painted === false ||
      !t.bbox ||
      isZoneGridMark(t, zoneSet, fieldRight, fieldBottom) ||
      t.bbox.y + t.bbox.h <= g.headerRule.y + INK_ACCURACY_MM ||
      (g.titleBlock && t.bbox.y >= g.titleBlock.y - INK_ACCURACY_MM) ||
      t.bbox.y >= fieldBottom - INK_ACCURACY_MM ||
      t.bbox.x >= fieldLeft - ZONE_GUTTER_EPSILON_MM ||
      allowedElements.has(t.element)
    )
      continue;
    findings.push(
      issue("text-in-zone-gutter", t, {
        text: t.text,
        leftMm: t.bbox.x,
        fieldLeftMm: fieldLeft,
        ruleRightMm: ruleRight,
        intrusionMm: fieldLeft - t.bbox.x,
        toleranceMm: ZONE_GUTTER_EPSILON_MM,
        reason:
          rejectionReasons.get(t.element) ??
          (t.continuation
            ? "false-continuation-marker"
            : "non-continuation-in-gutter"),
      }),
    );
  }
  return { findings, contracted };
}

export function textInZoneGutter(g, context) {
  return zoneGutterAudit(g, context).findings;
}
