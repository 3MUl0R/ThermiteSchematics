import { crosses, pointDistance } from "./review-geometry.mjs";

const INK_MM = 0.17; // Two pixels at 300 dpi, as in the distance check.
const PLATE_GAP_MM = 0.75 + INK_MM;
const DASH_GAP_MM = 0.375 + 2 * 0.025; // Printed dash gap and sampling steps.

function enclosingPlate(g, block) {
  const ids = new Set(block.map((t) => t.element));
  return g.tranche3?.wirePlatePaint?.plates?.find(
    (p) =>
      ids.has(p.text) &&
      p.clip &&
      block.every(
        ({ bbox: b }) =>
          b.x >= p.bbox.x - INK_MM &&
          b.y >= p.bbox.y - INK_MM &&
          b.x + b.w <= p.bbox.x + p.bbox.w + INK_MM &&
          b.y + b.h <= p.bbox.y + p.bbox.h + INK_MM,
      ),
  );
}

function joinsPlate(leader, plate) {
  const { start, end, segments } = leader;
  const p = plate.bbox;
  return (
    Math.hypot(
      Math.max(p.x - start.x, 0, start.x - p.x - p.w),
      Math.max(p.y - start.y, 0, start.y - p.y - p.h),
    ) <= PLATE_GAP_MM &&
    segments.length > 0 &&
    pointDistance(start, segments[0][0]) <= INK_MM &&
    pointDistance(end, segments.at(-1)[1]) <= INK_MM &&
    segments.every(
      ([a], i) =>
        !i || pointDistance(segments[i - 1][1], a) <= DASH_GAP_MM + 1e-5,
    )
  );
}

function leaderMatchesOwner(leaderWire, ownerWire) {
  if (!leaderWire || !ownerWire) return false;
  if (leaderWire === ownerWire) return true;
  try {
    const parsed = JSON.parse(leaderWire);
    if (!Array.isArray(parsed)) return false;
    if (
      (parsed[0] === "wire" || parsed[0] === "jumper") &&
      parsed[1] === ownerWire
    )
      return true;
    if (
      parsed[0] === "cable-conductor" &&
      JSON.stringify(parsed.slice(1)) === ownerWire
    )
      return true;
  } catch {}
  return false;
}

/** Verify an offset label's annotation using the painted plate, leader and
 * landing. The declared owner locates a candidate and supplies no exemption. */
export function measuredPlateLeader(g, block, own, foreign, distance) {
  const plate = enclosingPlate(g, block);
  if (!plate) return false;
  const { wirePlatePaint, routeInk } = g.tranche3;
  const ink = (routes) => routes.flatMap((r) => routeInk?.[r.element] ?? []);
  return (
    wirePlatePaint.leaders?.some(
      (leader) =>
        leaderMatchesOwner(leader.wire, block[0].wire) &&
        joinsPlate(leader, plate) &&
        ink(own).some((run) => distance(leader.end, ...run) <= INK_MM) &&
        !ink(foreign).some(
          (run) =>
            distance(leader.end, ...run) <= INK_MM ||
            leader.segments.some((segment) => crosses(segment, run)),
        ),
    ) ?? false
  );
}

export function wirePlacementCoverage(g) {
  if (!g.shapes.some((s) => s.conductor)) return {};
  const visible = g.texts.filter((t) => t.painted !== false);
  const unowned = visible.some(
    (t) =>
      !t.wire &&
      (["net", "conductor"].includes(t.labelRole) ||
        /(?:^|\s)label-(?:net|conductor)(?:\s|$)/.test(t.role ?? "") ||
        t.wireBlock),
  );
  if (unowned)
    return {
      status: "not-implemented",
      reasonCode: "label-identity-unavailable",
      reason:
        "Visible conductor labels need exported label-to-conductor identity.",
    };
  if (visible.some((t) => t.wire)) return {};
  return {
    status: "not-implemented",
    reasonCode: "no-visible-conductor-labels",
    reason: "No visible conductor labels to measure on this sheet.",
  };
}

export function wireIdentityIssue(t, own, issue) {
  if (t.conductorIdentityConflict)
    return issue("ambiguous-wire-label", t, {
      reason: "conductor-identity-conflict",
      wire: t.wire,
      text: t.text,
    });
  if (!own.length && t.declaredConductor)
    return issue("ambiguous-wire-label", t, {
      reason: "missing-owned-conductor-route",
      wire: t.wire,
      text: t.text,
    });
  return null;
}

export function wireLabelBlock(g, t) {
  return t.wireBlock
    ? g.texts.filter((q) => q.wireBlock === t.wireBlock && q.wire === t.wire)
    : [t];
}
