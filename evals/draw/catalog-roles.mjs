import { distance, lineCross, overlap } from "./checks.mjs";
import { reportIssue } from "./report-checks.mjs";
import {
  TOUCH_EPSILON_MM,
  clipErrorReason,
  computeExpectedMark,
  contactRolePortConflict,
  expectedInterfaceValid,
  isNonElectricalEnclosure,
  normalizeIrForMarkSelection,
  parseAttachmentKey,
  resolveNativeConductors,
  splitDashedConductors,
  terminalKey,
} from "./catalog-roles-native.mjs";

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
  maxPerMark: { "terminal-lead": 2, "contact-blade": 2 },
});

const NC_CONTACT_SPEC = Object.freeze({
  roles: {
    "terminal-lead": ["line"],
    "contact-blade": ["line"],
    "contact-path": ["line"],
    "mechanical-operator": ["line", "polyline"],
  },
  maxPerMark: { "terminal-lead": 2, "contact-blade": 2, "contact-path": 1 },
});

const RECT_BOUNDARY_SPEC = Object.freeze({
  roles: { "functional-boundary": ["rect"] },
});

const MARK_SPECS = Object.freeze({
  disconnector: {
    roles: { "terminal-lead": ["line"], "contact-blade": ["line"] },
    maxPerMark: { "terminal-lead": 2, "contact-blade": 2 },
  },
  breaker: {
    roles: {
      "terminal-lead": ["line"],
      "contact-blade": ["line"],
      qualifier: ["line"],
    },
    maxPerMark: { "terminal-lead": 2, "contact-blade": 1 },
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

function bridgeNativeConflict(p, fn, expectedMark) {
  const role = p.electricalRole;
  if (!BRIDGE_ROLES.has(role)) return null;
  if (!fn) return `Role "${role}" has no matching native IR function`;
  if (role === "contact-path") {
    if (
      fn.kind !== "contact" ||
      fn.normal_state !== "closed" ||
      fn.terminals.length !== 2 ||
      !expectedMark?.endsWith("-nc")
    )
      return `Role "contact-path" contradicts native function ${fn.id.functionKey} (${fn.kind}/${fn.normal_state ?? "n/a"}/${fn.terminals.length})`;
  } else if (role === "coil-body") {
    if (
      fn.kind !== "coil" ||
      fn.terminals.length !== 2 ||
      !["coil", "solenoid"].includes(expectedMark)
    )
      return `Role "coil-body" contradicts native function ${fn.id.functionKey} (${fn.kind}/${fn.terminals.length})`;
  } else if (role === "element-path") {
    const ok =
      ["overload", "fuse", "heater", "winding", "thermocouple"].includes(
        expectedMark,
      ) &&
      (fn.terminals.length === 2 ||
        (expectedMark === "heater" && fn.terminals.length === 3));
    if (!ok)
      return `Role "element-path" contradicts native function ${fn.id.functionKey} (${expectedMark ?? "none"}/${fn.terminals.length})`;
  } else if (role === "element-body") {
    if (
      !["overload", "fuse", "lamp"].includes(expectedMark) ||
      fn.terminals.length !== 2
    )
      return `Role "element-body" contradicts native function ${fn.id.functionKey} (${expectedMark ?? "none"}/${fn.terminals.length})`;
  }
  return null;
}

function markAndContainerValidation(p, fn, ctx) {
  const role = p.electricalRole;
  if (p.circuitRole && CIRCUIT_ROLE_EXPECTED[p.circuitRole] !== role)
    return {
      kind: "forged",
      reason: `Role "${role}" contradicts data-circuit-role="${p.circuitRole}"`,
    };
  if (p.mark) {
    const expected = computeExpectedMark(fn, ctx);
    if (!expected)
      return { kind: "not-measured", reason: "native-mark-uncomputable" };
    if (p.mark !== expected.name)
      return {
        kind: "forged",
        reason: `Declared mark "${p.mark}" contradicts native expected mark "${expected.name}" for ${fn.id.functionKey}`,
      };
    const spec = MARK_SPECS[expected.name];
    const tags = spec?.roles[role];
    if (!tags || !tags.includes(p.shapeTag))
      return {
        kind: "forged",
        reason: `Native mark "${expected.name}" does not allow "${role}" on <${p.shapeTag}>`,
      };
    const bridgeErr = bridgeNativeConflict(p, fn, expected.name);
    if (bridgeErr) return { kind: "forged", reason: bridgeErr };
    const portCheck = contactRolePortConflict(
      p,
      fn,
      expected.name,
      ctx,
      primitivesTouch,
      primitiveTouchesTerminal,
    );
    if (portCheck) return portCheck;
    return { kind: "ok", expectedMark: expected.name };
  }
  if (p.functionInterface) {
    const expected = computeExpectedMark(fn, ctx);
    if (!expected)
      return { kind: "not-measured", reason: "native-mark-uncomputable" };
    if (
      !expectedInterfaceValid(fn, expected) ||
      p.functionInterface !== expected.name
    )
      return {
        kind: "forged",
        reason: `Interface "${p.functionInterface}" contradicts native expected mark "${expected.name}"`,
      };
    const want =
      p.shapeTag === "rect"
        ? "functional-boundary"
        : p.shapeTag === "line"
          ? "terminal-lead"
          : null;
    if (role !== want)
      return {
        kind: "forged",
        reason: `Interface "${p.functionInterface}" <${p.shapeTag}> requires "${want ?? "none"}", got "${role}"`,
      };
    return { kind: "ok", expectedMark: expected.name };
  }
  return containerOnlyValidation(p, fn, ctx);
}

function containerOnlyValidation(p, fn, ctx) {
  const role = p.electricalRole;
  if (p.attachment) {
    if (role !== "terminal-lead")
      return {
        kind: "forged",
        reason: `Terminal attachment requires "terminal-lead", got "${role}"`,
      };
    const attKey = parseAttachmentKey(p.attachment);
    if (!attKey || !ctx.knownTerminals.has(attKey))
      return {
        kind: "forged",
        reason: `Terminal attachment "${p.attachment}" does not match a native IR terminal`,
      };
    if (
      fn &&
      !fn.terminals.some(
        (t) => terminalKey(t.deviceUid, t.terminalKey) === attKey,
      )
    )
      return {
        kind: "forged",
        reason: `Terminal attachment "${p.attachment}" does not belong to native function ${fn.id.functionKey}`,
      };
  } else if (p.sourceEnclosure || p.deviceFrame) {
    if (role !== "functional-boundary")
      return {
        kind: "forged",
        reason: `Device enclosure requires "functional-boundary", got "${role}"`,
      };
  } else if (p.magneticAssociation || p.mechanicalAssociation) {
    if (role !== "mechanical-operator")
      return {
        kind: "forged",
        reason: `Association primitive requires "mechanical-operator", got "${role}"`,
      };
  } else if (MARK_ONLY_ROLES.has(role)) {
    return {
      kind: "forged",
      reason: `Role "${role}" is only valid inside a matching circuit mark`,
    };
  }
  return { kind: "ok", expectedMark: null };
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
  return { terminals: [...byElement.values()], netByTerminal, knownTerminals };
}

function recordNotMeasured(p, reason, desig, state) {
  state.notMeasured.push({
    reason,
    element: p.element,
    mark: p.mark ?? p.functionInterface ?? null,
    deviceUid: p.deviceUid ?? null,
    designation: desig,
    functionKey: p.functionId?.[1] ?? null,
    bbox: p.bbox,
  });
}

function recordMarkRoleCount(p, expectedMark, desig, state) {
  if (!expectedMark || !p.markScope) return true;
  const max = MARK_SPECS[expectedMark]?.maxPerMark?.[p.electricalRole];
  if (max === undefined) return true;
  const ck = `${p.markScope}/${p.electricalRole}`;
  const count = (state.roleCounts.get(ck) ?? 0) + 1;
  state.roleCounts.set(ck, count);
  if (count <= max) return true;
  state.findings.push(
    reportIssue(
      "forged-electrical-role",
      { ...p, designation: desig },
      {
        electricalRole: p.electricalRole,
        mark: expectedMark,
        reason: `Native mark "${expectedMark}" allows at most ${max} "${p.electricalRole}" primitive(s)`,
      },
    ),
  );
  return false;
}

function validateOnePrimitive(p, state, ctx) {
  const desig = ctx.designations.get(p.deviceUid) ?? p.designation ?? "circuit";
  if (p.clipError) {
    recordNotMeasured(p, clipErrorReason(p.clipError), desig, state);
    return;
  }
  if (!p.electricalRoleDeclared || p.electricalRole === "unspecified") {
    recordNotMeasured(
      p,
      p.electricalRoleDeclared
        ? "unspecified-electrical-role"
        : "missing-electrical-role",
      desig,
      state,
    );
    state.nonBridge.push(p);
    return;
  }
  if (!VALID_ELECTRICAL_ROLES.has(p.electricalRole)) {
    state.findings.push(
      reportIssue(
        "invalid-electrical-role",
        { ...p, designation: desig },
        {
          electricalRole: p.electricalRole,
          mark: p.mark ?? p.functionInterface ?? null,
        },
      ),
    );
    state.nonBridge.push(p);
    return;
  }
  const fn = resolveNativeFunction(p, ctx.functionById);
  const verdict = markAndContainerValidation(p, fn, ctx);
  if (verdict.kind === "not-measured") {
    recordNotMeasured(p, verdict.reason, desig, state);
    state.nonBridge.push(p);
    return;
  }
  if (verdict.kind === "forged") {
    state.findings.push(
      reportIssue(
        "forged-electrical-role",
        { ...p, designation: desig },
        {
          electricalRole: p.electricalRole,
          mark: p.mark ?? p.functionInterface ?? null,
          reason: verdict.reason,
        },
      ),
    );
    state.nonBridge.push(p);
    return;
  }
  if (!recordMarkRoleCount(p, verdict.expectedMark, desig, state)) {
    state.nonBridge.push(p);
    return;
  }
  if (BRIDGE_ROLES.has(p.electricalRole))
    state.validBridges.push({ p, fn, expectedMark: verdict.expectedMark });
  else state.nonBridge.push(p);
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
      elements: [...new Set(items.map((p) => p.element))],
    },
  );
}

function bridgeGroupInfo(entries, netByTerminal) {
  const byFn = new Map();
  for (const e of entries) {
    const fk = terminalKey(e.fn.id.deviceUid, e.fn.id.functionKey);
    if (!byFn.has(fk)) {
      const ownTermKeys = new Set(
        e.fn.terminals.map((t) => terminalKey(t.deviceUid, t.terminalKey)),
      );
      const ownNets = new Set(
        e.fn.terminals.map(
          (t) =>
            netByTerminal.get(terminalKey(t.deviceUid, t.terminalKey)) ??
            `isolated:${t.deviceUid}/${t.terminalKey}`,
        ),
      );
      byFn.set(fk, {
        fk,
        fn: e.fn,
        canBridge: e.fn.terminals.length === 2,
        ownTermKeys,
        ownNets,
        items: [],
      });
    }
    byFn.get(fk).items.push(e.p);
  }
  return [...byFn.values()];
}

function checkBridgeTouchConstraints(
  bridgeGroups,
  nonBridgeSubs,
  directTerminals,
) {
  for (let i = 0; i < bridgeGroups.length; i++)
    for (let j = i + 1; j < bridgeGroups.length; j++)
      if (
        bridgeGroups[i].items.some((a) =>
          bridgeGroups[j].items.some((b) => primitivesTouch(a, b)),
        )
      )
        return "Declared bridge touches another native function's bridge primitive";
  for (const bg of bridgeGroups) {
    const bgDirect = bg.items.flatMap((p) => directTerminals.get(p) ?? []);
    const bgDirectNets = new Set(bgDirect.map((t) => t.nativeNet));
    if (!bg.canBridge && bgDirectNets.size > 1)
      return `Declared ${bg.items[0].electricalRole} joins nets outside a 2-terminal function`;
    if ([...bgDirectNets].some((n) => !bg.ownNets.has(n)))
      return `Declared ${bg.items[0].electricalRole} touches net(s) outside its owning function`;
  }
  for (const sub of nonBridgeSubs) {
    const touchingBridges = bridgeGroups.filter((bg) =>
      bg.items.some((b) => sub.items.some((s) => primitivesTouch(b, s))),
    );
    if (!touchingBridges.length) continue;
    if (sub.nets.size === 1) {
      const [onlyNet] = [...sub.nets];
      for (const bg of touchingBridges) {
        if (!bg.canBridge || !bg.ownNets.has(onlyNet))
          return `Declared ${bg.items[0].electricalRole} reaches foreign net through connected ink`;
      }
    }
    if (touchingBridges.length > 1) {
      if (sub.nets.size === 0)
        return "Connected ink joins distinct native functions' bridges without a shared native terminal net";
      const anchored = touchingBridges.every((bg) =>
        [...sub.termKeys].some((tk) => bg.ownTermKeys.has(tk)),
      );
      if (!anchored)
        return "Connected ink bridges distinct native functions outside a shared same-net terminal";
    }
  }
  return null;
}

function componentFailureReason(
  comp,
  bridgeEntryByPiece,
  directTerminals,
  ctx,
) {
  const bridgeEntries = [];
  const nonBridgePieces = [];
  for (const piece of comp) {
    const be = bridgeEntryByPiece.get(piece);
    if (be) bridgeEntries.push(be);
    else nonBridgePieces.push(piece);
  }
  const nonBridgeSubs = buildComponents(nonBridgePieces).map((items) => {
    const touched = items.flatMap((p) => directTerminals.get(p) ?? []);
    return {
      items,
      touched,
      nets: new Set(touched.map((t) => t.nativeNet)),
      termKeys: new Set(touched.map((t) => t.terminalKey).filter(Boolean)),
    };
  });
  for (const sub of nonBridgeSubs) {
    if (sub.nets.size > 1)
      return "Non-bridging or unattributed symbol ink joins terminals on independent native nets";
  }
  const bridgeGroups = bridgeGroupInfo(bridgeEntries, ctx.netByTerminal);
  if (!bridgeGroups.length)
    return "Symbol ink joins terminals on independent native nets without a validated bridge";
  return checkBridgeTouchConstraints(
    bridgeGroups,
    nonBridgeSubs,
    directTerminals,
  );
}

function checkConductivityComponents(
  validBridges,
  nonBridge,
  nativeConductors,
  ctx,
  findings,
) {
  const bridgeEntryByPiece = new Map();
  const conductingPieces = [];
  for (const entry of validBridges) {
    if (isNonElectricalEnclosure(entry.p)) continue;
    bridgeEntryByPiece.set(entry.p, entry);
    conductingPieces.push(entry.p);
  }
  for (const p of nonBridge) {
    if (isNonElectricalEnclosure(p)) continue;
    for (const piece of splitDashedConductors(p)) conductingPieces.push(piece);
  }
  const directTerminals = new Map();
  for (const piece of conductingPieces) {
    const terms = ctx.terminals.filter((t) =>
      primitiveTouchesTerminal(piece, t),
    );
    const wires = nativeConductors
      .filter((w) => primitivesTouch(piece, w))
      .map((w) => ({
        nativeNet: w.nativeNet,
        deviceUid: "conductor",
        terminal: w.conductorId ?? w.element,
        terminalKey: null,
      }));
    directTerminals.set(piece, [...terms, ...wires]);
  }
  for (const comp of buildComponents(conductingPieces)) {
    const touched = comp.flatMap((piece) => directTerminals.get(piece) ?? []);
    const netCount = new Set(touched.map((t) => t.nativeNet)).size;
    const hasBridge = comp.some((piece) => bridgeEntryByPiece.has(piece));
    if (netCount === 0 || (netCount <= 1 && !hasBridge)) continue;
    const reason = componentFailureReason(
      comp,
      bridgeEntryByPiece,
      directTerminals,
      ctx,
    );
    if (reason)
      findings.push(netJoiningIssue(comp, touched, reason, ctx.designations));
  }
}

export function auditCatalogRoles(g, ir) {
  const primitives = g.circuitPrimitives ?? [];
  const sheetInk = g.circuitSheetInk ?? [];
  const conductors = g.circuitConductors ?? [];
  const { terminals, netByTerminal, knownTerminals } = collectSheetTerminals(
    g,
    ir,
  );
  const ctx = {
    primitives,
    terminals,
    netByTerminal,
    knownTerminals,
    knownNets: new Set((ir.nets ?? []).map((n) => n.id)),
    normalizedIr: normalizeIrForMarkSelection(ir),
    designations: new Map(
      (ir.devices ?? []).map((d) => [d.uid, d.designation]),
    ),
    deviceByUid: new Map((ir.devices ?? []).map((d) => [d.uid, d])),
    typeById: new Map((ir.deviceTypes ?? []).map((t) => [t.id, t])),
    functionById: new Map(
      (ir.functions ?? []).map((f) => [
        terminalKey(f.id.deviceUid, f.id.functionKey),
        f,
      ]),
    ),
  };
  const state = {
    findings: [],
    notMeasured: [],
    validBridges: [],
    nonBridge: [],
    roleCounts: new Map(),
  };
  for (const p of primitives) validateOnePrimitive(p, state, ctx);
  for (const p of sheetInk) {
    if (p.clipError)
      recordNotMeasured(p, clipErrorReason(p.clipError), "sheet", state);
    else state.nonBridge.push(p);
  }
  const nativeConductors = resolveNativeConductors(
    conductors,
    ctx,
    state,
    primitiveTouchesTerminal,
    recordNotMeasured,
    netJoiningIssue,
  );
  checkConductivityComponents(
    state.validBridges,
    state.nonBridge,
    nativeConductors,
    ctx,
    state.findings,
  );
  const summary = {
    primitiveCount: primitives.length,
    measuredCount: Math.max(0, primitives.length - state.notMeasured.length),
    unspecifiedCount: state.notMeasured.length,
    bridgeCount: state.validBridges.length,
    terminalCount: terminals.length,
  };
  return { findings: state.findings, notMeasured: state.notMeasured, summary };
}

export function catalogRoleObservation(c, s, g, ir, obs) {
  const { findings, notMeasured, summary } = auditCatalogRoles(g, ir);
  const id = `${c.id}/DQ-03/catalog-roles-${s.number}`;
  const scope =
    "Renderer-declared circuit primitive electrical roles natively validated against owning function mark selection, declared terminal ports, and native IR nets over connected conducting ink. Dashed or enclosure-grey non-electrical enclosures are excluded; legacy source-port checks and manual visual legend review remain separate.";
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
      reason: `${notMeasured.length} circuit symbol primitive(s) could not be natively validated (${[...new Set(notMeasured.map((m) => m.reason))].sort().join(", ")}).`,
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
