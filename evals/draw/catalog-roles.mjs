import { distance, lineCross, overlap } from "./checks.mjs";
import { reportIssue } from "./report-checks.mjs";

const TOUCH_EPSILON_MM = 0.03;
const terminalKey = (uid, key) => JSON.stringify([uid, key]);

export const VALID_ELECTRICAL_ROLES = new Set([
  "terminal-lead",
  "terminal-node",
  "contact-blade",
  "contact-path",
  "element-path",
  "coil-body",
  "element-body",
  "functional-boundary",
  "mechanical-operator",
  "qualifier",
  "unspecified",
]);

const BRIDGE_ROLES = new Set([
  "contact-path",
  "element-path",
  "coil-body",
  "element-body",
]);

const MARK_ONLY_ROLES = new Set([
  "contact-path",
  "element-path",
  "coil-body",
  "element-body",
  "contact-blade",
  "terminal-node",
]);

const CIRCUIT_ROLE_EXPECTED = Object.freeze({
  lead: "terminal-lead",
  "earth-stem": "terminal-lead",
  "contact-moving": "contact-blade",
  "contact-fixed": "contact-blade",
  "contact-state": "contact-path",
  operator: "mechanical-operator",
  "operating-link": "mechanical-operator",
  "earth-bar": "qualifier",
});

const NO_CONTACT_SPEC = Object.freeze({
  roles: {
    "terminal-lead": ["line"],
    "contact-blade": ["line"],
    "mechanical-operator": ["line", "polyline"],
  },
});

const NC_CONTACT_SPEC = Object.freeze({
  roles: {
    "terminal-lead": ["line"],
    "contact-blade": ["line"],
    "contact-path": ["line"],
    "mechanical-operator": ["line", "polyline"],
  },
  maxPerMark: { "contact-path": 1 },
});

const RECT_BOUNDARY_SPEC = Object.freeze({
  roles: { "functional-boundary": ["rect"] },
});

const MARK_SPECS = Object.freeze({
  disconnector: {
    roles: { "terminal-lead": ["line"], "contact-blade": ["line"] },
  },
  breaker: {
    roles: {
      "terminal-lead": ["line"],
      "contact-blade": ["line"],
      qualifier: ["line"],
    },
  },
  overload: {
    roles: {
      "terminal-lead": ["line"],
      "element-body": ["rect"],
      "element-path": ["polyline"],
    },
    maxPerMark: { "element-body": 1, "element-path": 1 },
  },
  fuse: {
    roles: { "element-path": ["line"], "element-body": ["rect"] },
    maxPerMark: { "element-path": 1, "element-body": 1 },
  },
  coil: {
    roles: { "terminal-lead": ["line"], "coil-body": ["rect"] },
    maxPerMark: { "coil-body": 1 },
  },
  solenoid: {
    roles: {
      "terminal-lead": ["line"],
      "coil-body": ["rect"],
      qualifier: ["line"],
    },
    maxPerMark: { "coil-body": 1 },
  },
  "contact-no": NO_CONTACT_SPEC,
  "pushbutton-no": NO_CONTACT_SPEC,
  "switch-no": NO_CONTACT_SPEC,
  "estop-no": NO_CONTACT_SPEC,
  "selector-no": NO_CONTACT_SPEC,
  "pressure-no": NO_CONTACT_SPEC,
  "level-no": NO_CONTACT_SPEC,
  "contact-nc": NC_CONTACT_SPEC,
  "pushbutton-nc": NC_CONTACT_SPEC,
  "switch-nc": NC_CONTACT_SPEC,
  "estop-nc": NC_CONTACT_SPEC,
  "selector-nc": NC_CONTACT_SPEC,
  "pressure-nc": NC_CONTACT_SPEC,
  "level-nc": NC_CONTACT_SPEC,
  motor: {
    roles: { "functional-boundary": ["circle"], "terminal-lead": ["line"] },
  },
  heater: {
    roles: { "element-path": ["polyline"] },
    maxPerMark: { "element-path": 1 },
  },
  winding: {
    roles: { "element-path": ["polyline"], "mechanical-operator": ["line"] },
    maxPerMark: { "element-path": 1 },
  },
  source: RECT_BOUNDARY_SPEC,
  load: RECT_BOUNDARY_SPEC,
  interface: RECT_BOUNDARY_SPEC,
  terminal: {
    roles: { "terminal-node": ["circle"], "terminal-lead": ["line"] },
  },
  earth: { roles: { "terminal-lead": ["line"], qualifier: ["line"] } },
  lamp: {
    roles: {
      "element-body": ["circle"],
      qualifier: ["line"],
      "terminal-lead": ["line"],
    },
    maxPerMark: { "element-body": 1 },
  },
  thermocouple: {
    roles: { "element-path": ["polyline"], qualifier: ["circle"] },
    maxPerMark: { "element-path": 1 },
  },
  "level-sensor": {
    roles: { "functional-boundary": ["rect"], qualifier: ["polyline"] },
  },
  "conductivity-probe": {
    roles: { "functional-boundary": ["circle"], qualifier: ["line"] },
  },
  receptacle: {
    roles: {
      "functional-boundary": ["circle"],
      qualifier: ["line", "polyline"],
    },
  },
  "ac-input": {
    roles: { "functional-boundary": ["rect"], qualifier: ["polyline"] },
  },
  "dc-output": {
    roles: { "functional-boundary": ["rect"], qualifier: ["line"] },
  },
  "sensor-3wire": {
    roles: {
      "functional-boundary": ["rect"],
      qualifier: ["circle", "line"],
    },
  },
});

function solidContains(points, p) {
  if (!points?.length) return false;
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i],
      b = points[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      hit = !hit;
  }
  return hit;
}

function segmentPairTouches(a, b, reach) {
  for (const [p, q] of a.segments)
    for (const [r, s] of b.segments) {
      if (lineCross(p, q, r, s)) return true;
      const minDist = Math.min(
        distance(p, r, s),
        distance(q, r, s),
        distance(r, p, q),
        distance(s, p, q),
      );
      if (minDist <= reach) return true;
    }
  return false;
}

function primitivesTouch(a, b) {
  if (a.appearanceScope !== b.appearanceScope) return false;
  const reach = (a.stroke + b.stroke) / 2 + TOUCH_EPSILON_MM;
  if (!overlap(a.bbox, b.bbox, -reach)) return false;
  if (segmentPairTouches(a, b, reach)) return true;
  if (a.filled && b.points?.some((p) => solidContains(a.points, p)))
    return true;
  return Boolean(b.filled && a.points?.some((p) => solidContains(b.points, p)));
}

function primitiveTouchesTerminal(p, t) {
  if (p.appearanceScope !== t.appearanceScope) return false;
  const reach =
    Math.max(t.bbox.w, t.bbox.h) / 2 + p.stroke / 2 + TOUCH_EPSILON_MM;
  if (!overlap(p.bbox, t.bbox, -reach)) return false;
  if (p.segments.some(([a, b]) => distance(t.point, a, b) <= reach))
    return true;
  return Boolean(p.filled && solidContains(p.points, t.point));
}

function resolveNativeFunction(p, functionById) {
  if (!Array.isArray(p.functionId) || p.functionId.length !== 2) return null;
  return (
    functionById.get(terminalKey(p.functionId[0], p.functionId[1])) ?? null
  );
}

function catalogRoleConflict(p, fn) {
  const role = p.electricalRole;
  if (p.circuitRole && CIRCUIT_ROLE_EXPECTED[p.circuitRole] !== role)
    return `Role "${role}" contradicts data-circuit-role="${p.circuitRole}"`;
  if (p.mark) {
    const spec = MARK_SPECS[p.mark];
    if (!spec) return `Unknown circuit mark "${p.mark}"`;
    const tags = spec.roles[role];
    if (!tags || !tags.includes(p.shapeTag))
      return `Mark "${p.mark}" does not allow "${role}" on <${p.shapeTag}>`;
  } else if (p.functionInterface) {
    const expected =
      p.shapeTag === "rect"
        ? "functional-boundary"
        : p.shapeTag === "line"
          ? "terminal-lead"
          : null;
    if (role !== expected)
      return `Interface "${p.functionInterface}" <${p.shapeTag}> requires "${expected ?? "none"}", got "${role}"`;
  } else if (p.attachment) {
    if (role !== "terminal-lead")
      return `Terminal attachment requires "terminal-lead", got "${role}"`;
  } else if (p.sourceEnclosure || p.deviceFrame) {
    if (role !== "functional-boundary")
      return `Device enclosure requires "functional-boundary", got "${role}"`;
  } else if (p.magneticAssociation || p.mechanicalAssociation) {
    if (role !== "mechanical-operator")
      return `Association primitive requires "mechanical-operator", got "${role}"`;
  } else if (MARK_ONLY_ROLES.has(role)) {
    return `Role "${role}" is only valid inside a matching circuit mark`;
  }
  return bridgeNativeConflict(p, fn);
}

function bridgeNativeConflict(p, fn) {
  const role = p.electricalRole;
  if (!BRIDGE_ROLES.has(role)) return null;
  if (!fn) return `Role "${role}" has no matching native IR function`;
  if (role === "contact-path") {
    if (
      fn.kind !== "contact" ||
      fn.normal_state !== "closed" ||
      fn.terminals.length !== 2
    )
      return `Role "contact-path" contradicts native function ${fn.id.functionKey} (${fn.kind}/${fn.normal_state ?? "n/a"}/${fn.terminals.length})`;
  } else if (role === "coil-body") {
    if (fn.kind !== "coil" || fn.terminals.length !== 2)
      return `Role "coil-body" contradicts native function ${fn.id.functionKey} (${fn.kind}/${fn.terminals.length})`;
  } else if (role === "element-path") {
    const ok =
      fn.terminals.length === 2 ||
      (p.mark === "heater" && fn.terminals.length === 3);
    if (!ok)
      return `Role "element-path" contradicts native function terminal count (${fn.terminals.length})`;
  } else if (role === "element-body" && fn.terminals.length !== 2) {
    return `Role "element-body" contradicts native function terminal count (${fn.terminals.length})`;
  }
  return null;
}

function unionBbox(items) {
  const xs1 = items.map((s) => s.bbox.x),
    ys1 = items.map((s) => s.bbox.y);
  const xs2 = items.map((s) => s.bbox.x + s.bbox.w),
    ys2 = items.map((s) => s.bbox.y + s.bbox.h);
  const x = Math.min(...xs1),
    y = Math.min(...ys1);
  return { x, y, w: Math.max(...xs2) - x, h: Math.max(...ys2) - y };
}

function collectSheetTerminals(g, ir) {
  const netByTerminal = new Map(
    (ir.nets ?? []).flatMap((n) =>
      n.terminalIds.map((t) => [terminalKey(t.deviceUid, t.terminalKey), n.id]),
    ),
  );
  const knownTerminals = new Set(
    (ir.terminals ?? []).map((t) =>
      terminalKey(t.id.deviceUid, t.id.terminalKey),
    ),
  );
  const byElement = new Map();
  const add = (item, uid, key) => {
    if (!item?.bbox || !item?.point || !uid || !key) return;
    if (byElement.has(item.element)) return;
    const k = terminalKey(uid, key);
    const nativeNet =
      netByTerminal.get(k) ??
      (knownTerminals.has(k) ? `isolated:${uid}/${key}` : null);
    if (!nativeNet) return;
    byElement.set(item.element, {
      element: item.element,
      appearanceScope: item.appearanceScope,
      deviceUid: uid,
      terminal: key,
      terminalKey: k,
      nativeNet,
      bbox: item.bbox,
      point: item.point,
    });
  };
  for (const t of g.terminals ?? [])
    if (t.painted !== false) add(t, t.deviceUid, t.terminal);
  for (const t of g.wireTerminals ?? [])
    if (Array.isArray(t.terminal)) add(t, t.terminal[0], t.terminal[1]);
  return [...byElement.values()];
}

function recordBridgePrimitive(p, fn, desig, state) {
  const { findings, validBridges, nonBridge, bridgeCounts } = state;
  const ck = `${p.markScope ?? p.element}/${p.electricalRole}`;
  const count = (bridgeCounts.get(ck) ?? 0) + 1;
  bridgeCounts.set(ck, count);
  const max = MARK_SPECS[p.mark]?.maxPerMark?.[p.electricalRole] ?? 1;
  if (count > max) {
    findings.push(
      reportIssue(
        "forged-electrical-role",
        { ...p, designation: desig },
        {
          electricalRole: p.electricalRole,
          mark: p.mark,
          reason: `Mark "${p.mark}" allows at most ${max} "${p.electricalRole}" primitive(s)`,
        },
      ),
    );
    nonBridge.push(p);
    return;
  }
  validBridges.push({ p, fn });
}

function validateOnePrimitive(p, state, functionById, designations) {
  const { findings, notMeasured, unannotated, nonBridge } = state;
  const desig = designations.get(p.deviceUid) ?? p.designation ?? "circuit";
  if (!p.electricalRoleDeclared || p.electricalRole === "unspecified") {
    notMeasured.push({
      reason: p.electricalRoleDeclared
        ? "unspecified-electrical-role"
        : "missing-electrical-role",
      element: p.element,
      mark: p.mark ?? p.functionInterface ?? null,
      deviceUid: p.deviceUid ?? null,
      designation: desig,
      functionKey: p.functionId?.[1] ?? null,
      bbox: p.bbox,
    });
    unannotated.push(p);
    return;
  }
  if (!VALID_ELECTRICAL_ROLES.has(p.electricalRole)) {
    findings.push(
      reportIssue(
        "invalid-electrical-role",
        { ...p, designation: desig },
        {
          electricalRole: p.electricalRole,
          mark: p.mark ?? p.functionInterface ?? null,
        },
      ),
    );
    nonBridge.push(p);
    return;
  }
  const fn = resolveNativeFunction(p, functionById);
  const conflict = catalogRoleConflict(p, fn);
  if (conflict) {
    findings.push(
      reportIssue(
        "forged-electrical-role",
        { ...p, designation: desig },
        {
          electricalRole: p.electricalRole,
          mark: p.mark ?? p.functionInterface ?? null,
          reason: conflict,
        },
      ),
    );
    nonBridge.push(p);
    return;
  }
  if (BRIDGE_ROLES.has(p.electricalRole))
    recordBridgePrimitive(p, fn, desig, state);
  else nonBridge.push(p);
}

function validateAllPrimitives(primitives, functionById, designations) {
  const state = {
    findings: [],
    notMeasured: [],
    validBridges: [],
    unannotated: [],
    nonBridge: [],
    bridgeCounts: new Map(),
  };
  for (const p of primitives)
    validateOnePrimitive(p, state, functionById, designations);
  return state;
}

function buildComponents(items) {
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (primitivesTouch(items[i], items[j])) parent[find(i)] = find(j);
  const groups = new Map();
  items.forEach((item, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(item);
  });
  return [...groups.values()];
}

function isOuterMechanicalFrame(p) {
  return Boolean(p.deviceFrame || (p.sourceEnclosure && p.dash === "none"));
}

function netJoiningIssue(items, touched, reason, designations) {
  const first = items[0];
  const desig =
    designations.get(first.deviceUid) ?? first.designation ?? "circuit";
  return reportIssue(
    "symbol-primitive-joins-independent-nets",
    { ...first, designation: desig, bbox: unionBbox(items) },
    {
      reason,
      mark: first.mark ?? first.functionInterface ?? null,
      roles: [
        ...new Set(items.map((p) => p.electricalRole ?? "missing")),
      ].sort(),
      netIds: [...new Set(touched.map((t) => t.nativeNet))].sort(),
      terminals: [
        ...new Set(touched.map((t) => `${t.deviceUid}/${t.terminal}`)),
      ].sort(),
      elements: items.map((p) => p.element),
    },
  );
}

function checkBridgeComponents(
  validBridges,
  nonBridgeComps,
  directTerminals,
  netByTerminal,
  designations,
  findings,
) {
  const byMarkScope = new Map();
  for (const entry of validBridges) {
    const k = entry.p.markScope ?? entry.p.element;
    if (!byMarkScope.has(k)) byMarkScope.set(k, []);
    byMarkScope.get(k).push(entry);
  }
  for (const group of byMarkScope.values()) {
    const { fn } = group[0];
    const ownTermKeys = new Set(
      fn.terminals.map((t) => terminalKey(t.deviceUid, t.terminalKey)),
    );
    const ownNets = new Set(
      fn.terminals.map(
        (t) =>
          netByTerminal.get(terminalKey(t.deviceUid, t.terminalKey)) ??
          `isolated:${t.deviceUid}/${t.terminalKey}`,
      ),
    );
    const canBridgeTwo = fn.terminals.length === 2;
    const items = group.map((e) => e.p);
    const touched = [];
    for (const b of items) touched.push(...(directTerminals.get(b) ?? []));
    for (const comp of nonBridgeComps) {
      if (comp.items.some((s) => items.some((b) => primitivesTouch(b, s)))) {
        items.push(...comp.items);
        touched.push(...comp.touched);
      }
    }
    const crossBridge = validBridges.some(
      (other) =>
        !group.includes(other) &&
        group.some((g) => primitivesTouch(g.p, other.p)),
    );
    const nets = new Set(touched.map((t) => t.nativeNet));
    const foreignNets = [...nets].filter((n) => !ownNets.has(n));
    const illegal =
      crossBridge ||
      (canBridgeTwo
        ? foreignNets.length > 0 ||
          (nets.size > 1 &&
            touched.some(
              (t) =>
                !ownTermKeys.has(t.terminalKey) && !ownNets.has(t.nativeNet),
            ))
        : nets.size > 1);
    if (illegal)
      findings.push(
        netJoiningIssue(
          items,
          touched,
          crossBridge
            ? "Declared bridge touches another function's bridge primitive"
            : `Declared ${group[0].p.electricalRole} touches net(s) outside its owning function`,
          designations,
        ),
      );
  }
}

function checkUnannotatedComponents(
  unannotated,
  nonBridgeComps,
  directTerminals,
  functionById,
  designations,
  findings,
) {
  if (!unannotated.length) return;
  const active = unannotated.filter((p) => !isOuterMechanicalFrame(p));
  for (const comp of buildComponents(active)) {
    const items = [...comp];
    const touched = comp.flatMap((p) => directTerminals.get(p) ?? []);
    for (const nb of nonBridgeComps) {
      if (nb.items.some((s) => comp.some((u) => primitivesTouch(u, s)))) {
        items.push(...nb.items);
        touched.push(...nb.touched);
      }
    }
    const nets = new Set(touched.map((t) => t.nativeNet));
    if (nets.size <= 1) continue;
    const ownerFns = new Set(
      comp.map((p) => resolveNativeFunction(p, functionById)).filter(Boolean),
    );
    const singleFn = ownerFns.size === 1 ? [...ownerFns][0] : null;
    const ownKeys = singleFn
      ? new Set(
          singleFn.terminals.map((t) =>
            terminalKey(t.deviceUid, t.terminalKey),
          ),
        )
      : new Set();
    const withinSingleTwoTerminalFn =
      singleFn &&
      singleFn.terminals.length === 2 &&
      nets.size === 2 &&
      touched.every((t) => ownKeys.has(t.terminalKey));
    if (!withinSingleTwoTerminalFn)
      findings.push(
        netJoiningIssue(
          items,
          touched,
          "Unannotated symbol primitive joins independent nets outside a single declared two-terminal function",
          designations,
        ),
      );
  }
}

export function auditCatalogRoles(g, ir) {
  const primitives = g.circuitPrimitives ?? [];
  const designations = new Map(
    (ir.devices ?? []).map((d) => [d.uid, d.designation]),
  );
  const functionById = new Map(
    (ir.functions ?? []).map((f) => [
      terminalKey(f.id.deviceUid, f.id.functionKey),
      f,
    ]),
  );
  const netByTerminal = new Map(
    (ir.nets ?? []).flatMap((n) =>
      n.terminalIds.map((t) => [terminalKey(t.deviceUid, t.terminalKey), n.id]),
    ),
  );
  const { findings, notMeasured, validBridges, unannotated, nonBridge } =
    validateAllPrimitives(primitives, functionById, designations);
  const terminals = collectSheetTerminals(g, ir);
  const activeNonBridge = nonBridge.filter((p) => !isOuterMechanicalFrame(p));
  const directTerminals = new Map();
  for (const p of [
    ...activeNonBridge,
    ...validBridges.map((e) => e.p),
    ...unannotated.filter((p) => !isOuterMechanicalFrame(p)),
  ])
    directTerminals.set(
      p,
      terminals.filter((t) => primitiveTouchesTerminal(p, t)),
    );
  const nonBridgeComps = buildComponents(activeNonBridge).map((items) => ({
    items,
    touched: items.flatMap((p) => directTerminals.get(p) ?? []),
  }));
  for (const comp of nonBridgeComps) {
    if (new Set(comp.touched.map((t) => t.nativeNet)).size > 1)
      findings.push(
        netJoiningIssue(
          comp.items,
          comp.touched,
          "Non-bridging symbol primitive joins terminals on independent native nets",
          designations,
        ),
      );
  }
  checkBridgeComponents(
    validBridges,
    nonBridgeComps,
    directTerminals,
    netByTerminal,
    designations,
    findings,
  );
  checkUnannotatedComponents(
    unannotated,
    nonBridgeComps,
    directTerminals,
    functionById,
    designations,
    findings,
  );
  const summary = {
    primitiveCount: primitives.length,
    measuredCount: primitives.length - notMeasured.length,
    unspecifiedCount: notMeasured.length,
    bridgeCount: validBridges.length,
    terminalCount: terminals.length,
  };
  return { findings, notMeasured, summary };
}

export function catalogRoleObservation(c, s, g, ir, obs) {
  const { findings, notMeasured, summary } = auditCatalogRoles(g, ir);
  const id = `${c.id}/DQ-03/catalog-roles-${s.number}`;
  const scope =
    "Circuit catalog per-primitive electrical roles verified against catalog definitions and native IR nets. Outer mechanical device frames are excluded; independent legacy source-port strokes and the manual visual legend review remain separate.";
  if (findings.length)
    return obs("DQ-03", findings, {
      id,
      scope,
      evidence: {
        findingCount: findings.length,
        findings,
        ...(notMeasured.length ? { notMeasured } : {}),
        measurement: summary,
      },
    });
  if (notMeasured.length)
    return obs("DQ-03", [], {
      id,
      status: "not-measured",
      reason: `${notMeasured.length} circuit symbol primitive(s) lack a defined electrical role (${[...new Set(notMeasured.map((m) => m.reason))].sort().join(", ")}).`,
      scope,
      evidence: {
        findingCount: 0,
        findings: [],
        notMeasured,
        measurement: summary,
      },
    });
  return obs("DQ-03", [], {
    id,
    scope,
    evidence: {
      findingCount: 0,
      findings: [],
      measurement: summary,
    },
  });
}
