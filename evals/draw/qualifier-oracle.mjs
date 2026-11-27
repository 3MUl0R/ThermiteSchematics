import { finding, extent } from "./review-geometry.mjs";
const inside = (p, b) =>
  p.x >= b.x - 0.17 &&
  p.x <= b.x + b.w + 0.17 &&
  p.y >= b.y - 0.17 &&
  p.y <= b.y + b.h + 0.17;
const DC_SUPPLY_SYMBOLS = new Set([
  "thermite:dc-supply",
  "iec:dc-power-supply",
]);
const AC_SINGLE_PHASE_ROLES = new Set([
  "aclineinput",
  "acinputreturn",
  "acneutral",
]);
const AC_THREE_PHASE_ROLE_SETS = [
  ["phase1input", "phase2input", "phase3input"],
  ["phaseuinput", "phasevinput", "phasewinput"],
];
/**
 * Closed set of normalized earth roles for `thermite:dc-supply` qualifier
 * classification (exact match after lowercasing and stripping non-alphanumeric
 * characters; never tokenized or substring-matched). Combines the canonical
 * protective-earth boundary role (`protective_earth` -> `protectiveearth`) with
 * the explicit earth role aliases. Intentionally maintained as an independent
 * copy from `packages/render/src/symbols/circuit.ts` (zero renderer imports).
 * Do not add "ground" or "gnd": a supply ground can be a return.
 */
const DC_SUPPLY_EARTH_ROLES = new Set([
  "protectiveearth",
  "pe",
  "functionalearth",
  "fe",
  "earth",
  "chassisground",
  "chassisearth",
]);
function normalizeRole(role) {
  return typeof role === "string"
    ? role.toLowerCase().replace(/[^a-z0-9]+/gu, "")
    : "";
}
function sameTerminal(a, b) {
  return a?.deviceUid === b?.deviceUid && a?.terminalKey === b?.terminalKey;
}
function isEarthRole(role) {
  return DC_SUPPLY_EARTH_ROLES.has(normalizeRole(role));
}
function isAuxiliaryOrNonPowerRole(role) {
  const normalized = normalizeRole(role);
  return (
    normalized.startsWith("aux") ||
    normalized.startsWith("shield") ||
    normalized === "noconnection"
  );
}
function isDcRole(role) {
  return normalizeRole(role).startsWith("dc");
}
function isAcRole(role) {
  const normalized = normalizeRole(role);
  return normalized.startsWith("ac") || normalized.startsWith("phase");
}
function isCurrentCarryingRole(role) {
  const normalized = normalizeRole(role);
  if (!normalized || isAuxiliaryOrNonPowerRole(role)) return false;
  return (
    isAcRole(role) ||
    isDcRole(role) ||
    normalized.startsWith("neutral") ||
    normalized.endsWith("neutral") ||
    normalized.startsWith("return") ||
    normalized.endsWith("return")
  );
}
function functionTerminalFacts(ir, t, f) {
  return (f.terminals ?? []).map((id) => {
    const spec = t?.terminals?.find((p) => p.key === id.terminalKey);
    const irTerminal = ir?.terminals?.find((p) => sameTerminal(p.id, id));
    const roles = [
      ...new Set(
        [spec?.role, irTerminal?.role].filter((r) => typeof r === "string"),
      ),
    ];
    return {
      id,
      spec,
      irTerminal,
      role: spec?.role ?? irTerminal?.role,
      roles,
      rating: spec?.rating ?? irTerminal?.rating,
    };
  });
}
function isEarthTerminal(ir, terminal) {
  if (terminal.roles.some((role) => isEarthRole(role))) return true;
  if (terminal.roles.some((role) => isCurrentCarryingRole(role))) return false;
  return (ir?.potentials ?? []).some(
    (p) =>
      p?.electrical?.polarity === "protective_earth" &&
      sameTerminal(p.terminal, terminal.id),
  );
}
function nativeAcInput(ir, t, f) {
  const count = f.terminals?.length ?? 0;
  if (count !== 2 && count !== 3) return false;
  const terminals = functionTerminalFacts(ir, t, f);
  const currentTerminals = terminals.filter((p) => !isEarthTerminal(ir, p));
  if (currentTerminals.length < 2) return false;
  if (
    currentTerminals.some(
      (p) =>
        p.rating?.voltage_type === "DC" ||
        p.roles.some((r) => isDcRole(r) || isAuxiliaryOrNonPowerRole(r)),
    )
  )
    return false;
  const currentRoles = currentTerminals.map((p) => normalizeRole(p.role));
  const acByRole =
    currentTerminals.length === 2
      ? currentRoles.every((r) => AC_SINGLE_PHASE_ROLES.has(r)) &&
        currentRoles.includes("aclineinput")
      : currentTerminals.length === 3 &&
        AC_THREE_PHASE_ROLE_SETS.some((set) =>
          set.every((role) => currentRoles.includes(role)),
        );
  if (acByRole) return true;
  return currentTerminals.every((p) => p.rating?.voltage_type === "AC");
}
function nativeDcOutput(ir, t, f) {
  if (f.terminals?.length !== 2) return false;
  const terminals = functionTerminalFacts(ir, t, f);
  return !terminals.some(
    (p) =>
      isEarthTerminal(ir, p) ||
      p.roles.some((r) => isAuxiliaryOrNonPowerRole(r) || isAcRole(r)) ||
      p.rating?.voltage_type === "AC",
  );
}
function expectedQualifier(ir, f) {
  const d = ir.devices?.find((d) => d.uid === f.id.deviceUid),
    t = ir.deviceTypes?.find((t) => t.id === d?.typeId);
  if (
    t?.circuitSymbols &&
    Object.hasOwn(t.circuitSymbols, f.id.functionKey) &&
    t.circuitSymbols[f.id.functionKey] !== undefined
  ) {
    const mark = t.circuitSymbols[f.id.functionKey];
    return mark === "ac-input" || mark === "dc-output" ? mark : undefined;
  }
  if (!DC_SUPPLY_SYMBOLS.has(t?.symbol)) return undefined;
  if (f.kind === "source" && nativeDcOutput(ir, t, f)) return "dc-output";
  if (f.kind === "load" && nativeAcInput(ir, t, f)) return "ac-input";
}
function dcUpright(lines) {
  if (
    !lines.length ||
    !lines.every(
      ([a, b]) => Math.abs(a.y - b.y) <= 0.01 && Math.abs(b.x - a.x) > 0.01,
    )
  )
    return false;
  const levels = [
    ...new Set(lines.map(([a]) => Math.round(a.y * 100) / 100)),
  ].sort((a, b) => a - b);
  if (levels.length !== 2 || levels[1] - levels[0] <= 0.17) return false;
  const at = (y) =>
    lines
      .filter(([a]) => Math.abs(a.y - y) < 0.01)
      .map(([a, b]) => [Math.min(a.x, b.x), Math.max(a.x, b.x)])
      .sort((a, b) => a[0] - b[0]);
  const top = at(levels[0]),
    bottom = at(levels[1]);
  return (
    top.length === 1 &&
    bottom.length >= 3 &&
    bottom.every(
      (p, i) =>
        p[0] >= top[0][0] - 0.01 &&
        p[1] <= top[0][1] + 0.01 &&
        (!i || p[0] > bottom[i - 1][1] + 0.01),
    )
  );
}
function upright(shapes, kind) {
  const glyph = shapes.filter((s) => s.shapeTag !== "rect"),
    points = glyph.flatMap((s) => s.points ?? []);
  if (kind !== "ac-input")
    return dcUpright(glyph.flatMap((s) => s.inkSegments ?? []));
  const wave = glyph.filter(
    (s) => s.shapeTag === "polyline" || s.shapeTag === "path",
  );
  if (wave.length !== 1 || !points.length) return false;
  const ps = wave[0].points,
    baseline = (ps[0].y + ps.at(-1).y) / 2;
  return (
    Math.abs(ps.at(-1).x - ps[0].x) > 0.17 &&
    Math.abs(ps[0].y - ps.at(-1).y) <= 0.17 &&
    extent(points).w > extent(points).h &&
    points.some((p) => p.y < baseline - 0.01) &&
    points.some((p) => p.y > baseline + 0.01)
  );
}
function isBodyShape(s, deviceUid) {
  return (
    !s.terminal &&
    !s.conductor &&
    !s.attachment &&
    !s.attachmentCandidate &&
    s.deviceUid === deviceUid
  );
}
function scopeMatches(s, spec) {
  if (spec.kind === "all") return true;
  if (spec.kind === "scoped") return s.nativeFunctionScope === spec.scope;
  return !s.nativeFunctionScope;
}
const PORT_ADJACENCY_MM = 2.0;
function boxesTouch(a, b, tol = 0.17) {
  return (
    a.x <= b.x + b.w + tol &&
    b.x <= a.x + a.w + tol &&
    a.y <= b.y + b.h + tol &&
    b.y <= a.y + a.h + tol
  );
}
function boxExtent(shapes) {
  return extent(
    shapes.flatMap((s) => [
      s.bbox,
      { x: s.bbox.x + s.bbox.w, y: s.bbox.y + s.bbox.h },
    ]),
  );
}
function boxDistance(a, b) {
  const dx =
    a.x + a.w < b.x
      ? b.x - (a.x + a.w)
      : a.x > b.x + b.w
        ? a.x - (b.x + b.w)
        : 0;
  const dy =
    a.y + a.h < b.y
      ? b.y - (a.y + a.h)
      : a.y > b.y + b.h
        ? a.y - (b.y + b.h)
        : 0;
  return Math.hypot(dx, dy);
}
function terminalDistance(t, b) {
  if (t.bbox) return boxDistance(t.bbox, b);
  if (!t.point) return Infinity;
  return boxDistance({ x: t.point.x, y: t.point.y, w: 0, h: 0 }, b);
}
function enclosureCandidates(g, deviceUid, spec) {
  const scoped = (s) => isBodyShape(s, deviceUid) && scopeMatches(s, spec);
  const outlines = g.shapes.filter((s) => s.outline && scoped(s));
  if (outlines.length) return outlines;
  return g.shapes.filter(
    (s) => s.shapeTag === "rect" && !s.mark && !s.markGroup && scoped(s),
  );
}
function enclosureComponents(shapes) {
  const seen = new Set(),
    boxes = [];
  for (const seed of shapes) {
    if (seen.has(seed) || !seed.bbox) continue;
    const group = [seed];
    seen.add(seed);
    for (let i = 0; i < group.length; i++)
      for (const other of shapes) {
        if (seen.has(other) || !other.bbox) continue;
        if (boxesTouch(group[i].bbox, other.bbox)) {
          seen.add(other);
          group.push(other);
        }
      }
    boxes.push(boxExtent(group));
  }
  return boxes;
}
function markTouchesBox(shapes, box) {
  const pts = shapes
    .filter((s) => s.shapeTag !== "rect")
    .flatMap((s) => s.points ?? []);
  if (pts.length && pts.every((p) => inside(p, box))) return true;
  return shapes.some(
    (s) => s.shapeTag === "rect" && s.bbox && boxesTouch(s.bbox, box),
  );
}
function pairUnscopedEnclosure(g, f, kind, spec, points, body) {
  const components = enclosureComponents(
    enclosureCandidates(g, f.id.deviceUid, spec),
  );
  if (!components.length) return { enclosure: false, components };
  const byArea = (a, b) => a.w * a.h - b.w * b.h;
  const containing = components.filter(
    (c) => points.length && points.every((p) => inside(p, c)),
  );
  if (containing.length)
    return { enclosure: containing.sort(byArea)[0], components };
  const overlapping = body
    ? components.filter((c) => boxesTouch(body.bbox, c))
    : [];
  if (overlapping.length === 1)
    return { enclosure: overlapping[0], components };
  const otherGroups = new Map();
  for (const s of g.shapes) {
    if (
      s.deviceUid !== f.id.deviceUid ||
      s.functionKey !== f.id.functionKey ||
      s.mark !== kind ||
      s.nativeFunctionScope ||
      !s.markGroup ||
      s.markGroup === spec.markGroup
    )
      continue;
    if (!otherGroups.has(s.markGroup)) otherGroups.set(s.markGroup, []);
    otherGroups.get(s.markGroup).push(s);
  }
  const unclaimed = components.filter(
    (c) => ![...otherGroups.values()].some((grp) => markTouchesBox(grp, c)),
  );
  const otherDisplaced = [...otherGroups.values()].filter(
    (grp) => !components.some((c) => markTouchesBox(grp, c)),
  );
  return {
    enclosure:
      unclaimed.length === 1 && !otherDisplaced.length ? unclaimed[0] : false,
    components,
  };
}
function fragmentEnclosure(g, f, kind, spec, points, body) {
  if (spec.kind === "unscoped")
    return pairUnscopedEnclosure(g, f, kind, spec, points, body);
  const enclosures = enclosureCandidates(g, f.id.deviceUid, spec);
  return {
    enclosure: enclosures.length > 0 && boxExtent(enclosures),
    components: [],
  };
}
function fragmentPorts(g, f, spec, enclosure, components) {
  const base = (g.terminals ?? []).filter(
    (t) =>
      t.deviceUid === f.id.deviceUid &&
      scopeMatches(t, spec) &&
      f.terminals.some((e) => e.terminalKey === t.terminal),
  );
  if (spec.kind !== "unscoped") return base;
  if (!enclosure) return [];
  return base.filter((t) => {
    const dist = terminalDistance(t, enclosure);
    return (
      dist <= PORT_ADJACENCY_MM &&
      components.every((c) => c === enclosure || dist <= terminalDistance(t, c))
    );
  });
}
function fragmentScopes(g, f, kind) {
  const fKey = JSON.stringify(f.id);
  const scopes = new Set();
  const unscopedMarkGroups = new Set();
  let hasUnscopedMark = false;
  for (const s of g.shapes) {
    if (s.deviceUid !== f.id.deviceUid) continue;
    const matchesMark = s.functionKey === f.id.functionKey && s.mark === kind;
    if (matchesMark && !s.nativeFunctionScope) {
      hasUnscopedMark = true;
      if (s.markGroup) unscopedMarkGroups.add(s.markGroup);
    }
    if (!isBodyShape(s, f.id.deviceUid)) continue;
    const declares = (s.circuitFunctions ?? []).some(
      (id) => JSON.stringify(id) === fKey,
    );
    if ((declares || (matchesMark && s.markGroup)) && s.nativeFunctionScope)
      scopes.add(s.nativeFunctionScope);
  }
  const specs = [...scopes].map((scope) => ({ kind: "scoped", scope }));
  if (hasUnscopedMark) {
    if (unscopedMarkGroups.size)
      for (const markGroup of unscopedMarkGroups)
        specs.push({ kind: "unscoped", markGroup });
    else specs.push({ kind: "unscoped", markGroup: undefined });
  }
  return specs.length ? specs : [{ kind: "all" }];
}
function qualifierFinding(g, ir, f, kind, spec) {
  const shapes = g.shapes.filter(
    (s) =>
      s.deviceUid === f.id.deviceUid &&
      s.functionKey === f.id.functionKey &&
      s.markGroup &&
      s.mark === kind &&
      scopeMatches(s, spec) &&
      (spec.kind !== "unscoped" || s.markGroup === spec.markGroup),
  );
  const glyph = shapes.filter((s) => s.shapeTag !== "rect"),
    points = glyph.flatMap((s) => s.points ?? []);
  const rects = shapes.filter((s) => s.shapeTag === "rect");
  const body = rects.find(
    (r) => points.length && points.every((p) => inside(p, r.bbox)),
  );
  const { enclosure, components } = fragmentEnclosure(
    g,
    f,
    kind,
    spec,
    points,
    body,
  );
  const ports = fragmentPorts(g, f, spec, enclosure, components);
  const anchor =
    shapes[0] ??
    (spec.kind === "all"
      ? undefined
      : g.shapes.find(
          (s) => s.deviceUid === f.id.deviceUid && scopeMatches(s, spec),
        ));
  if (
    !body ||
    !enclosure ||
    ports.length < f.terminals.length ||
    !f.terminals.every((e) =>
      ports.some((t) => t.terminal === e.terminalKey),
    ) ||
    !glyph.every((s) => s.inkSegments?.length)
  )
    return finding("conversion-qualifier-geometry-unavailable", anchor, {
      function: f.id,
      qualifier: kind,
    });
  if (!upright(shapes, kind))
    return finding("conversion-qualifier-not-upright", shapes[0], {
      function: f.id,
      qualifier: kind,
      segments: glyph.flatMap((s) => s.inkSegments ?? []),
    });
  if (!points.every((p) => inside(p, enclosure)))
    return finding("conversion-qualifier-outside-own-body", shapes[0], {
      function: f.id,
      qualifier: kind,
      enclosure,
    });
}
export function conversionQualifierAudit(g, ir, sheet) {
  if (sheet.view?.kind !== "circuit") return { findings: [], eligible: 0 };
  const ids = new Set(
    g.shapes.flatMap((s) =>
      (s.circuitFunctions ?? []).map((id) => JSON.stringify(id)),
    ),
  );
  for (const r of sheet.references ?? [])
    for (const key of r.functions ?? [])
      ids.add(JSON.stringify({ deviceUid: r.deviceUid, functionKey: key }));
  const expected = new Map(
    (ir.functions ?? [])
      .filter((f) => ids.has(JSON.stringify(f.id)))
      .map((f) => [f, expectedQualifier(ir, f)])
      .filter(([, kind]) => kind),
  );
  const fs = [...expected.keys()];
  const unresolved = g.shapes.filter(
    (s) =>
      ["ac-input", "dc-output"].includes(s.mark) &&
      !fs.some(
        (f) =>
          f.id.deviceUid === s.deviceUid &&
          f.id.functionKey === s.functionKey &&
          expected.get(f) === s.mark,
      ),
  );
  return {
    findings: [
      ...(unresolved.length
        ? [
            finding(
              "conversion-qualifier-native-owner-unavailable",
              unresolved[0],
            ),
          ]
        : []),
      ...fs.flatMap((f) =>
        fragmentScopes(g, f, expected.get(f))
          .map((scope) => qualifierFinding(g, ir, f, expected.get(f), scope))
          .filter(Boolean),
      ),
    ],
    eligible: fs.length,
  };
}
