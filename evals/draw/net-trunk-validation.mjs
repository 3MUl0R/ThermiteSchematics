// Native IR, junction, and visible-ink validation for DQ-17 shared source trunks.
import {
  hasVisibleConductorInk,
  isVisibleStrokeColour,
} from "./m3-conductor-ink.mjs";
import { pointDistance } from "./review-geometry.mjs";
import { conductorIdentity } from "./tranche3-identities.mjs";

const ANCHOR_TOL_MM = 0.05;
const MIN_VISIBLE_ALPHA = 0.2;
const SOURCE_ROLE_RE = /(?:^|_)(?:output|source)(?:_|$)/iu;
const INPUT_ROLE_RE = /(?:^|_)input(?:_|$)/iu;
const SINK_ROLE_RE =
  /(?:^|_)(?:input|load|coil|supply_positive|supply_return|supply_negative|lamp_supply|lamp_return|sensor_supply)(?:_|$)/iu;

const finite = (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y);
const termKey = (t) =>
  t?.deviceUid && t?.terminalKey
    ? JSON.stringify([t.deviceUid, t.terminalKey])
    : undefined;
const sameTerm = (a, b) =>
  Boolean(
    a?.deviceUid &&
    b?.deviceUid &&
    a.deviceUid === b.deviceUid &&
    a.terminalKey === b.terminalKey,
  );

export function isJunctionNodeId(nodeId) {
  if (typeof nodeId !== "string") return false;
  try {
    const parsed = JSON.parse(nodeId);
    return (
      Array.isArray(parsed) &&
      (parsed[0] === "junction" || parsed[0] === "junction-comb")
    );
  } catch {
    return false;
  }
}

export function routeSemanticConductorId(route) {
  const k = route?.edgeOwnerKey;
  let semantic;
  if (Array.isArray(k)) {
    if (k[0] === "wire" || k[0] === "jumper")
      semantic = conductorIdentity(k[1]);
    else if (k[0] === "cable-conductor") semantic = JSON.stringify(k.slice(1));
  }
  const declared = conductorIdentity(route?.wire);
  if (semantic && declared && semantic !== declared)
    return { id: undefined, conflict: true };
  return { id: semantic ?? declared, conflict: false };
}

function normalizeEndpoint(e) {
  const deviceUid = e?.deviceUid ?? e?.terminal?.deviceUid;
  const terminalKey = e?.terminalKey ?? e?.terminal?.terminalKey;
  return deviceUid && terminalKey ? { deviceUid, terminalKey } : null;
}

function buildUnionFind(conductors) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    for (let c = x; c !== r;) {
      const next = parent.get(c);
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const { endpoints } of conductors.values()) {
    const a = termKey(endpoints[0]),
      b = termKey(endpoints[1]);
    if (a && b) parent.set(find(a), find(b));
  }
  return find;
}

function indexNativeNets(ir) {
  const byCond = new Map(),
    byTerm = new Map();
  for (const net of ir?.nets ?? []) {
    if (!net?.id) continue;
    for (const t of net.terminalIds ?? []) {
      const k = termKey(t);
      if (k) byTerm.set(k, net.id);
    }
    for (const el of net.conductiveElementIds ?? []) {
      const id =
        el?.kind === "wire" || el?.kind === "jumper"
          ? el.uid
          : el?.kind === "cable_conductor"
            ? JSON.stringify([el.cableUid, el.conductorId])
            : undefined;
      if (id) byCond.set(id, net.id);
    }
  }
  return { byCond, byTerm };
}

function endpointPolarity(ep, ir) {
  if (!ep || !ir) return "neutral";
  if ((ir.potentials ?? []).some((p) => sameTerm(p?.terminal, ep)))
    return "source";
  const fns = (ir.functions ?? []).filter((f) =>
    (f.terminals ?? []).some((t) => sameTerm(t, ep)),
  );
  if (
    fns.some(
      (f) =>
        f.kind === "source" ||
        (f.kind === "channel" && f.direction === "output"),
    )
  )
    return "source";
  if (
    fns.some(
      (f) =>
        f.kind === "load" ||
        f.kind === "coil" ||
        (f.kind === "channel" && f.direction === "input"),
    )
  )
    return "sink";
  const term = (ir.terminals ?? []).find((t) => sameTerm(t?.id, ep));
  const role = term?.role ?? "";
  if (role && SOURCE_ROLE_RE.test(role) && !INPUT_ROLE_RE.test(role))
    return "source";
  if (role && SINK_ROLE_RE.test(role)) return "sink";
  return "neutral";
}

export function buildNativeIrIndex(ir) {
  if (!ir || typeof ir !== "object") return null;
  const conductors = new Map();
  const add = (id, endpoints) => {
    const eps = (endpoints ?? []).map(normalizeEndpoint).filter(Boolean);
    if (id && eps.length === 2) conductors.set(id, { endpoints: eps });
  };
  for (const w of ir.wires ?? []) add(w.uid, w.endpoints);
  for (const j of ir.jumpers ?? []) add(j.uid, j.endpoints);
  for (const c of ir.cableConductors ?? [])
    add(JSON.stringify([c.id.cableUid, c.id.conductorId]), c.endpoints);
  if (!conductors.size) return null;
  const find = buildUnionFind(conductors);
  const { byCond, byTerm } = indexNativeNets(ir);
  const nativeNetId = (id) => {
    if (byCond.has(id)) return byCond.get(id);
    const eps = conductors.get(id)?.endpoints;
    return eps
      ? (byTerm.get(termKey(eps[0])) ?? byTerm.get(termKey(eps[1])))
      : undefined;
  };
  const comp = (id) => {
    const ep = conductors.get(id)?.endpoints?.[0];
    return ep ? find(termKey(ep)) : undefined;
  };
  const hasNativeRoles = Boolean(
    ir.functions?.length || ir.terminals?.length || ir.potentials?.length,
  );
  return {
    conductors,
    hasNativeRoles,
    nativeNetId,
    sameNativeNet: (a, b) => {
      const ca = comp(a),
        cb = comp(b);
      if (!ca || ca !== cb) return false;
      const na = nativeNetId(a),
        nb = nativeNetId(b);
      return !(na && nb && na !== nb);
    },
    polarity: (ep) => endpointPolarity(ep, ir),
  };
}

export function hasVisibleTrunkInk(trunk) {
  if (!trunk) return false;
  return hasVisibleConductorInk(
    trunk.shapeTag ? trunk : { ...trunk, shapeTag: "path" },
  );
}

export function hasVisibleJunctionInk(dot) {
  if (!dot || dot.painted === false || !finite(dot.anchor)) return false;
  if (dot.radius !== undefined && !(dot.radius > 0)) return false;
  const fillOk =
    isVisibleStrokeColour(dot.fillColour) &&
    (dot.fillAlpha === undefined || dot.fillAlpha >= MIN_VISIBLE_ALPHA);
  const strokeOk =
    Number.isFinite(dot.stroke) &&
    dot.stroke > 0 &&
    isVisibleStrokeColour(dot.strokeColour) &&
    (dot.strokeAlpha === undefined || dot.strokeAlpha >= MIN_VISIBLE_ALPHA);
  return fillOk || strokeOk;
}

export function validateJunctionDot(jId, route, condId, g, irIndex) {
  const visibleDots = (g?.junctionDots ?? []).filter(
    (d) =>
      d.appearanceScope === route.appearanceScope && hasVisibleJunctionInk(d),
  );
  const matches = visibleDots.filter((d) => d.junctionId === jId);
  if (matches.length !== 1)
    return {
      reason: "Net-label junction dot is missing, invisible, or ambiguous",
    };
  const dot = matches[0];
  const nativeNet = irIndex.nativeNetId(condId);
  if (!dot.net || dot.net !== route.net || (nativeNet && dot.net !== nativeNet))
    return {
      reason: "Net-label junction dot net identity does not match native net",
    };
  try {
    const parsed = JSON.parse(jId);
    if (parsed[0] === "junction" && parsed[1] !== dot.net)
      return {
        reason: "Net-label junction identifier conflicts with junction net",
      };
  } catch {
    return { reason: "Net-label junction identifier is invalid" };
  }
  const collision = visibleDots.some((other) => {
    if (other === dot) return false;
    const tol = Math.max(
      ANCHOR_TOL_MM,
      (dot.radius ?? 0) + (other.radius ?? 0),
    );
    return (
      pointDistance(other.anchor, dot.anchor) <= tol &&
      (other.net !== route.net || other.junctionId !== jId)
    );
  });
  if (collision)
    return {
      reason: "Net-label junction coincides with a conflicting junction",
    };
  return { dot };
}

function junctionComponent(trunk, g) {
  const boundaries = (g?.boundaryRoutes ?? []).filter(
    (b) =>
      b.appearanceScope === trunk.appearanceScope &&
      b.net === trunk.net &&
      hasVisibleTrunkInk(b),
  );
  const seeds = [trunk.sourcePortKey?.[1], trunk.targetPortKey?.[1]].filter(
    isJunctionNodeId,
  );
  const component = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.pop();
    for (const b of boundaries) {
      const a = b.sourcePortKey?.[1],
        c = b.targetPortKey?.[1];
      if (a === cur && isJunctionNodeId(c) && !component.has(c)) {
        component.add(c);
        queue.push(c);
      } else if (c === cur && isJunctionNodeId(a) && !component.has(a)) {
        component.add(a);
        queue.push(a);
      }
    }
  }
  return component;
}

export function validateTrunkMembership(trunk, route, condId, g, irIndex) {
  const listed = trunk.trunkConductors;
  if (!Array.isArray(listed) || !listed.length)
    return { reason: "Shared source trunk lacks declared conductor list" };
  const listedSet = new Set(listed);
  if (listedSet.size !== listed.length || !listedSet.has(condId))
    return { reason: "Shared source trunk conductor list is invalid" };
  const nativeNet = irIndex.nativeNetId(condId);
  if (nativeNet && (trunk.net !== nativeNet || route.net !== nativeNet))
    return { reason: "Shared source trunk net conflicts with native IR net" };
  const component = junctionComponent(trunk, g);
  const drawnSiblings = new Set();
  for (const s of g?.shapes ?? []) {
    if (!s.conductor || s.appearanceScope !== route.appearanceScope) continue;
    const srcJ = s.routeSourcePortKey?.[1],
      tgtJ = s.routeTargetPortKey?.[1];
    if (!component.has(srcJ) && !component.has(tgtJ)) continue;
    if (s.net !== route.net)
      return { reason: "Cross-net conductor attached to shared source trunk" };
    const sid = routeSemanticConductorId(s);
    if (sid.conflict || !sid.id)
      return {
        reason: "Conflicting conductor identity on shared source trunk",
      };
    drawnSiblings.add(sid.id);
  }
  for (const id of listedSet) {
    if (
      !irIndex.conductors.has(id) ||
      !irIndex.sameNativeNet(condId, id) ||
      !drawnSiblings.has(id)
    )
      return {
        reason:
          "Shared source trunk declares unverified or non-sibling conductor",
      };
  }
  for (const id of drawnSiblings) {
    if (
      !irIndex.conductors.has(id) ||
      !irIndex.sameNativeNet(condId, id) ||
      !listedSet.has(id)
    )
      return {
        reason: "Shared source trunk omits a real sibling conductor",
      };
  }
  return { ok: true };
}

export function validateTrunkSourceEndpoint(
  route,
  condId,
  sourceLanding,
  dot,
  irIndex,
) {
  const entry = irIndex.conductors.get(condId);
  if (!entry)
    return { reason: "Net-label conductor is missing from native IR" };
  const src = {
    deviceUid: sourceLanding.deviceUid,
    terminalKey: sourceLanding.terminal,
  };
  const mismatch = () => ({
    mismatch: {
      reason: "trunk-source-endpoint-mismatch",
      claimedSourceDeviceUid: src.deviceUid,
      claimedSourceTerminal: src.terminalKey,
    },
  });
  const matchIdx = entry.endpoints.findIndex((e) => sameTerm(e, src));
  if (matchIdx === -1) return mismatch();
  const routeEnds = (route.endpoints ?? [])
    .map(normalizeEndpoint)
    .filter(Boolean);
  if (routeEnds.length && !routeEnds.some((e) => sameTerm(e, src)))
    return mismatch();
  const other = entry.endpoints[1 - matchIdx];
  const targetLanding = (route.ownedLandings ?? []).find(
    (p) => p.end === "target" && !p.reason && p.deviceUid && p.terminal,
  );
  if (
    targetLanding &&
    !sameTerm(
      {
        deviceUid: targetLanding.deviceUid,
        terminalKey: targetLanding.terminal,
      },
      other,
    )
  )
    return mismatch();
  if (
    dot?.deviceUid &&
    dot?.terminal &&
    !sameTerm({ deviceUid: dot.deviceUid, terminalKey: dot.terminal }, src)
  )
    return mismatch();
  const srcPol = irIndex.polarity(src),
    otherPol = irIndex.polarity(other);
  if (srcPol === "sink" || (otherPol === "source" && srcPol !== "source"))
    return mismatch();
  if (irIndex.hasNativeRoles) {
    if (srcPol !== "source")
      return {
        reason: "Net-label trunk origin has no verified native source role",
      };
  } else if (matchIdx !== 0) {
    return mismatch();
  }
  return { ok: true };
}
