import {
  boxToPolylineDistance,
  crosses,
  pointDistance,
  segmentPointDistance,
} from "./review-geometry.mjs";
import { conductorIdentity } from "./tranche3-identities.mjs";

const INK_MM = 0.17; // Two pixels at 300 dpi, as in the distance check.
const PLATE_GAP_MM = 0.75 + INK_MM;
const DASH_GAP_MM = 0.375 + 2 * 0.025; // Printed dash gap and sampling steps.
const ROUTE_JOIN_MM = 0.05;

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
  if (!g.shapes.some((s) => s.conductor)) return {};
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

export function isNetLabelText(t) {
  return (
    t.labelRole === "net" || /(?:^|\s)label-net(?:\s|$)/.test(t.role ?? "")
  );
}

function textInsidePlate(t) {
  const b = t.bbox,
    p = t.plate?.bbox;
  return Boolean(
    b &&
    p &&
    b.x >= p.x - INK_MM &&
    b.y >= p.y - INK_MM &&
    b.x + b.w <= p.x + p.w + INK_MM &&
    b.y + b.h <= p.y + p.h + INK_MM,
  );
}

export function conductorCaptionBlockKey(t) {
  if (t.wireBlock) return `block:${t.wireBlock}`;
  if (t.textContainer && t.textContainer !== t.appearanceScope)
    return `container:${t.textContainer}`;
  if (t.plate?.element && textInsidePlate(t)) return `plate:${t.plate.element}`;
  return `el:${t.locatorElement ?? t.element}`;
}

function continuousRouteComponents(routes) {
  if (routes.length <= 1) return routes.length ? [routes] : [];
  const ends = routes.map((r) => {
    const pts = r.points ?? [];
    return pts.length >= 2 ? [pts[0], pts.at(-1)] : [];
  });
  const parent = routes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < routes.length; i++)
    for (let j = i + 1; j < routes.length; j++) {
      if (
        ends[i].some((a) =>
          ends[j].some((b) => pointDistance(a, b) <= ROUTE_JOIN_MM),
        )
      )
        parent[find(i)] = find(j);
    }
  const groups = new Map();
  for (let i = 0; i < routes.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(routes[i]);
  }
  return [...groups.values()];
}

function captionComponentIndex(g, block, components) {
  if (components.length <= 1) return 0;
  const plate = enclosingPlate(g, block);
  const routeInk = g.tranche3?.routeInk;
  if (plate && routeInk) {
    const leaders = (g.tranche3?.wirePlatePaint?.leaders ?? []).filter(
      (l) => leaderMatchesOwner(l.wire, block[0].wire) && joinsPlate(l, plate),
    );
    const hit = components.findIndex((comp) =>
      leaders.some((l) =>
        comp.some((r) =>
          (routeInk[r.element] ?? []).some(
            (run) => segmentPointDistance(l.end, ...run) <= INK_MM,
          ),
        ),
      ),
    );
    if (hit !== -1) return hit;
  }
  const inlineIdx = components.findIndex((comp) =>
    block.some(
      (q) =>
        q.plate?.bbox &&
        textInsidePlate(q) &&
        comp.some(
          (r) =>
            boxToPolylineDistance(q.plate.bbox, r.points, r.stroke ?? 0) === 0,
        ),
    ),
  );
  if (inlineIdx !== -1) return inlineIdx;
  let bestIdx = 0,
    bestDist = Infinity;
  for (let i = 0; i < components.length; i++) {
    let d = Infinity;
    for (const t of block) {
      if (!t.bbox) continue;
      for (const r of components[i])
        d = Math.min(d, boxToPolylineDistance(t.bbox, r.points, r.stroke ?? 0));
    }
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function duplicateConductorLabelFindings(g, routes, issue) {
  const byOwner = new Map();
  for (const t of g.texts.filter(
    (q) => q.painted !== false && q.wire && !isNetLabelText(q),
  )) {
    const wire = conductorIdentity(t.wire);
    if (!wire) continue;
    const ownerKey = JSON.stringify([
      t.appearanceScope ?? null,
      t.circuitGroup ?? null,
      wire,
    ]);
    if (!byOwner.has(ownerKey))
      byOwner.set(ownerKey, {
        wire,
        scope: t.appearanceScope,
        group: t.circuitGroup,
        blocks: new Map(),
      });
    const bKey = conductorCaptionBlockKey(t);
    const blocks = byOwner.get(ownerKey).blocks;
    if (!blocks.has(bKey)) blocks.set(bKey, []);
    blocks.get(bKey).push(t);
  }
  const out = [];
  for (const { wire, scope, group, blocks } of byOwner.values()) {
    if (blocks.size <= 1) continue;
    const own = routes.filter(
      (r) =>
        conductorIdentity(r.wire) === wire &&
        r.appearanceScope === scope &&
        r.circuitGroup === group,
    );
    const components = continuousRouteComponents(own);
    if (!components.length) continue;
    const byComponent = new Map();
    for (const block of blocks.values()) {
      const idx = captionComponentIndex(g, block, components);
      if (!byComponent.has(idx)) byComponent.set(idx, []);
      byComponent.get(idx).push(block);
    }
    for (const compBlocks of byComponent.values()) {
      if (compBlocks.length <= 1) continue;
      for (const block of compBlocks.slice(1))
        out.push(
          issue("duplicate-conductor-label", block[0], {
            wire,
            text: block.map((q) => q.text).join(" "),
            blockCount: compBlocks.length,
            routeComponents: components.length,
            elements: compBlocks.map((b) => b[0].element),
          }),
        );
    }
  }
  return out;
}
