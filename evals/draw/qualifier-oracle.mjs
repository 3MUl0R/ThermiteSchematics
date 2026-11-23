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
  "ac_line_input",
  "ac_input_return",
  "ac_neutral",
]);
const AC_THREE_PHASE_ROLE_SETS = [
  ["phase_1_input", "phase_2_input", "phase_3_input"],
  ["phase_u_input", "phase_v_input", "phase_w_input"],
];
function functionTerminalSpecs(t, f) {
  return (f.terminals ?? []).map(({ terminalKey }) =>
    t?.terminals?.find((p) => p.key === terminalKey),
  );
}
function nativeAcInput(t, f) {
  const count = f.terminals?.length ?? 0;
  if (count !== 2 && count !== 3) return false;
  const terminals = functionTerminalSpecs(t, f);
  const voltageTypes = new Set(
    terminals.flatMap((p) =>
      p?.rating?.voltage_type ? [p.rating.voltage_type] : [],
    ),
  );
  if (voltageTypes.has("DC")) return false;
  const roles = terminals.map((p) => p?.role);
  if (roles.some((r) => typeof r === "string" && r.startsWith("dc_")))
    return false;
  const acByRole =
    count === 2
      ? roles.every((r) => r !== undefined && AC_SINGLE_PHASE_ROLES.has(r)) &&
        roles.includes("ac_line_input")
      : AC_THREE_PHASE_ROLE_SETS.some((set) =>
          set.every((role) => roles.includes(role)),
        ) ||
        (roles.includes("ac_line_input") &&
          (roles.includes("ac_input_return") || roles.includes("ac_neutral")) &&
          roles.includes("protective_earth"));
  if (acByRole) return true;
  return voltageTypes.size === 1 && voltageTypes.has("AC");
}
function nativeDcOutput(t, f) {
  if (f.terminals?.length !== 2) return false;
  const terminals = functionTerminalSpecs(t, f);
  return !terminals.some(
    (p) =>
      p?.rating?.voltage_type === "AC" ||
      (typeof p?.role === "string" &&
        (p.role.startsWith("ac_") || p.role.startsWith("phase_"))),
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
  if (f.kind === "source" && nativeDcOutput(t, f)) return "dc-output";
  if (f.kind === "load" && nativeAcInput(t, f)) return "ac-input";
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
function qualifierFinding(g, ir, f, kind) {
  const shapes = g.shapes.filter(
    (s) =>
      s.deviceUid === f.id.deviceUid &&
      s.functionKey === f.id.functionKey &&
      s.markGroup &&
      s.mark === kind,
  );
  const glyph = shapes.filter((s) => s.shapeTag !== "rect"),
    points = glyph.flatMap((s) => s.points ?? []);
  const rects = shapes.filter((s) => s.shapeTag === "rect");
  const body = rects.find(
    (r) => points.length && points.every((p) => inside(p, r.bbox)),
  );
  const enclosures = g.shapes.filter(
    (s) => s.outline && s.deviceUid === f.id.deviceUid,
  );
  const enclosure =
    enclosures.length &&
    extent(
      enclosures.flatMap((s) => [
        s.bbox,
        { x: s.bbox.x + s.bbox.w, y: s.bbox.y + s.bbox.h },
      ]),
    );
  const ports = (g.terminals ?? []).filter(
    (t) =>
      t.deviceUid === f.id.deviceUid &&
      f.terminals.some((e) => e.terminalKey === t.terminal),
  );
  if (
    !body ||
    !enclosure ||
    ports.length < f.terminals.length ||
    !glyph.every((s) => s.inkSegments?.length)
  )
    return finding("conversion-qualifier-geometry-unavailable", shapes[0], {
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
      ...fs
        .map((f) => qualifierFinding(g, ir, f, expected.get(f)))
        .filter(Boolean),
    ],
    eligible: fs.length,
  };
}
