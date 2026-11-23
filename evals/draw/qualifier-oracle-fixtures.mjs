import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  compileProject,
  lockProject,
} from "../../packages/compiler/dist/index.js";
import { segments } from "./tranche3-geometry.mjs";
import { end, nativeIr } from "./tranche3-fixtures.mjs";

export const kinds = (audit) => audit.findings.map((f) => f.kind);

export function expectUnowned(audit, label) {
  expect(audit.eligible, label).toBe(0);
  expect(kinds(audit), label).toEqual([
    "conversion-qualifier-native-owner-unavailable",
  ]);
}

export function pePotential(
  uid,
  name,
  terminalKey,
  netId = "net:pe",
  deviceUid = "D",
) {
  return {
    uid,
    name,
    electrical: { polarity: "protective_earth" },
    terminal: { deviceUid, terminalKey },
    netId,
  };
}

export function makeMarkShapes(deviceUid, fn, mark, startSerial = 0) {
  let serial = startSerial;
  const base = {
    deviceUid,
    functionKey: fn.id.functionKey,
    mark,
    markGroup: "glyph",
    circuitFunctions: [fn.id],
  };
  const shape = (tag, points) => ({
    ...base,
    element: `${mark}-${tag}-${serial++}`,
    shapeTag: tag,
    points,
    inkSegments: segments(points),
    bbox: { x: 8, y: 11, w: 8, h: 8 },
  });
  const rect = shape("rect", [
    { x: 8, y: 11 },
    { x: 16, y: 19 },
  ]);
  const glyph =
    mark === "ac-input"
      ? [
          shape("polyline", [
            { x: 10, y: 15 },
            { x: 11, y: 14 },
            { x: 12, y: 16 },
            { x: 14, y: 15 },
          ]),
        ]
      : [
          [9, 15, 12],
          [9, 10, 16],
          [11, 12, 16],
          [13, 15, 16],
        ].map(([x1, x2, y]) =>
          shape("line", [
            { x: x1, y },
            { x: x2, y },
          ]),
        );
  return { shapes: [rect, ...glyph], nextSerial: serial };
}

export function makeProbeGeometry(deviceUid, fn, mark) {
  const shapes = [
    {
      deviceUid,
      outline: true,
      circuitFunctions: [fn.id],
      bbox: { x: 0, y: 0, w: 50, h: 30 },
    },
  ];
  if (mark) shapes.push(...makeMarkShapes(deviceUid, fn, mark).shapes);
  return {
    shapes,
    terminals: fn.terminals.map((t, i) => ({
      deviceUid,
      terminal: t.terminalKey,
      point: { x: 0, y: i * 10 },
    })),
  };
}

const DEFAULT_INPUT_TERMINALS = [
  { key: "L", role: "ac_line_input" },
  { key: "N", role: "ac_input_return" },
];
const DEFAULT_EXTRA_TERMINALS = [
  {
    key: "+",
    role: "dc_positive_output",
    rating: { voltage_type: "DC", nominal_voltage: 24 },
  },
  {
    key: "-",
    role: "dc_return_output",
    rating: { voltage_type: "DC", nominal_voltage: 24 },
  },
];

export function psuCase({
  symbol = "thermite:dc-supply",
  circuitSymbols,
  functionKey = "ac_input",
  functionKind = "load",
  inputTerminals = DEFAULT_INPUT_TERMINALS,
  extraTerminals = DEFAULT_EXTRA_TERMINALS,
  description = "AC-input power supply with a regulated 24 VDC output",
  renderedMarks = ["ac-input"],
} = {}) {
  const ir = nativeIr();
  const fn = {
    id: { deviceUid: "D", functionKey },
    kind: functionKind,
    terminals: inputTerminals.map((t) => end("D", t.key)),
  };
  ir.functions = [fn];
  const type = {
    id: "type",
    symbol,
    description,
    terminals: [...inputTerminals, ...extraTerminals],
  };
  if (circuitSymbols !== undefined) type.circuitSymbols = circuitSymbols;
  ir.deviceTypes = [type];

  let serial = 0;
  const markShapes = renderedMarks.flatMap((mark) => {
    const built = makeMarkShapes("D", fn, mark, serial);
    serial = built.nextSerial;
    return built.shapes;
  });
  const g = {
    shapes: [
      {
        deviceUid: "D",
        outline: true,
        circuitFunctions: [fn.id],
        bbox: { x: 0, y: 0, w: 50, h: 30 },
      },
      ...markShapes,
    ],
    terminals: inputTerminals.map((t, i) => ({
      deviceUid: "D",
      terminal: t.key,
      point: { x: 0, y: i * 10 },
    })),
  };
  const sheet = {
    view: { kind: "circuit" },
    references: [{ deviceUid: "D", functions: [functionKey] }],
  };
  return { ir, g, sheet };
}

export async function compileOracleTempProject(
  prefix,
  { projectName, libraryName, types, objects },
) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, "library"), { recursive: true });
  await writeFile(
    join(dir, "system.json"),
    JSON.stringify({
      format: "electrical-system/0.1",
      project: { name: projectName },
      sources: ["source.json"],
      libraries: [{ name: libraryName, version: "0.1.0", path: "library" }],
    }),
  );
  await writeFile(
    join(dir, "library/library.json"),
    JSON.stringify({
      name: libraryName,
      version: "0.1.0",
      sources: ["types.json"],
    }),
  );
  await writeFile(join(dir, "library/types.json"), JSON.stringify({ types }));
  await writeFile(join(dir, "source.json"), JSON.stringify({ objects }));
  const locked = await lockProject(dir);
  expect(locked.ok, JSON.stringify(locked)).toBe(true);
  const compiled = await compileProject(dir);
  expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
  return { dir, compiled };
}
