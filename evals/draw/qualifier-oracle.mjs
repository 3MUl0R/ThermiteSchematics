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
function fragmentEnclosure(g, deviceUid, scope) {
  const scoped = (s) =>
    s.deviceUid === deviceUid &&
    (scope === undefined || s.nativeFunctionScope === scope);
  let enclosures = g.shapes.filter((s) => s.outline && scoped(s));
  if (!enclosures.length)
    enclosures = g.shapes.filter(
      (s) => s.shapeTag === "rect" && !s.mark && !s.markGroup && scoped(s),
    );
  return (
    enclosures.length > 0 &&
    extent(
      enclosures.flatMap((s) => [
        s.bbox,
        { x: s.bbox.x + s.bbox.w, y: s.bbox.y + s.bbox.h },
      ]),
    )
  );
}
function fragmentScopes(g, f, kind) {
  const fKey = JSON.stringify(f.id);
  const scopes = new Set();
  for (const s of g.shapes) {
    const declares = (s.circuitFunctions ?? []).some(
      (id) => JSON.stringify(id) === fKey,
    );
    const matchesMark =
      s.deviceUid === f.id.deviceUid &&
      s.functionKey === f.id.functionKey &&
      s.markGroup &&
      s.mark === kind;
    if ((declares || matchesMark) && s.nativeFunctionScope)
      scopes.add(s.nativeFunctionScope);
  }
  return scopes.size ? [...scopes] : [undefined];
}
function qualifierFinding(g, ir, f, kind, scope) {
  const shapes = g.shapes.filter(
    (s) =>
      s.deviceUid === f.id.deviceUid &&
      s.functionKey === f.id.functionKey &&
      s.markGroup &&
      s.mark === kind &&
      (scope === undefined || s.nativeFunctionScope === scope),
  );
  const glyph = shapes.filter((s) => s.shapeTag !== "rect"),
    points = glyph.flatMap((s) => s.points ?? []);
  const rects = shapes.filter((s) => s.shapeTag === "rect");
  const body = rects.find(
    (r) => points.length && points.every((p) => inside(p, r.bbox)),
  );
  const enclosure = fragmentEnclosure(g, f.id.deviceUid, scope);
  const ports = (g.terminals ?? []).filter(
    (t) =>
      t.deviceUid === f.id.deviceUid &&
      (scope === undefined || t.nativeFunctionScope === scope) &&
      f.terminals.some((e) => e.terminalKey === t.terminal),
  );
  const anchor =
    shapes[0] ??
    (scope === undefined
      ? undefined
      : g.shapes.find(
          (s) =>
            s.deviceUid === f.id.deviceUid && s.nativeFunctionScope === scope,
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
