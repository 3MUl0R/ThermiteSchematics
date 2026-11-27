import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import {
  compileProject,
  lockProject,
  type ElectricalIr,
} from "@thermite/compiler";
import { isTerminalStripType } from "@thermite/schema";
import { prepareCircuitView, type CircuitViewRequest } from "../src/circuit.js";
import {
  renderSchematicPacket,
  type SchematicPacketRequest,
} from "../src/sheets.js";
import {
  isProtectiveEarthFunction,
  partitionProtectiveEarthFunctions,
  preservesAuthoredCircuitOrder,
} from "../src/symbols/project-mappings.js";
import { compileCoreFixture } from "./fixtures.js";

const testRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testRoot, "../../..");
const FLOWS = ["left-to-right", "top-to-bottom"] as const;

let rm3Ir: ElectricalIr;
let coreIr: ElectricalIr;

beforeAll(async () => {
  const rm3 = await compileProject(
    join(repoRoot, "packages/core-library/test/fixtures/rm3"),
  );
  if (!rm3.ok) throw new Error(JSON.stringify(rm3.diagnostics));
  rm3Ir = rm3.ir;
  coreIr = await compileCoreFixture();
});

function parseTranslate(value: string | null): { x: number; y: number } {
  const match = value?.match(
    /translate\(\s*([-\d.]+)(?:[\s,]+([-\d.]+))?\s*\)/u,
  );
  return {
    x: match ? Number(match[1]) : 0,
    y: match && match[2] !== undefined ? Number(match[2]) : 0,
  };
}

function circuitNodeElement(svg: string, deviceUid: string) {
  const doc = parseHTML(`<svg>${svg}</svg>`).document;
  const host = [
    ...doc.querySelectorAll(`[data-device-uid="${deviceUid}"]`),
  ].find((el) => el.hasAttribute("data-circuit-functions"));
  if (!host) throw new Error(`Missing circuit node for ${deviceUid}`);
  return host;
}

function terminalPositions(
  svg: string,
  deviceUid: string,
): Map<string, { x: number; y: number }> {
  const host = circuitNodeElement(svg, deviceUid);
  const result = new Map<string, { x: number; y: number }>();
  for (const pin of host.querySelectorAll("g[data-terminal-key]")) {
    const key = pin.getAttribute("data-terminal-key");
    const circle = pin.querySelector("circle[data-terminal-marker]");
    if (!key || !circle) continue;
    let x = Number(circle.getAttribute("cx") ?? 0);
    let y = Number(circle.getAttribute("cy") ?? 0);
    let current = pin.parentElement;
    while (current && current.tagName.toLowerCase() !== "svg") {
      const t = parseTranslate(current.getAttribute("transform"));
      x += t.x;
      y += t.y;
      current = current.parentElement;
    }
    result.set(key, { x, y });
  }
  return result;
}

function functionRowOrder(svg: string, deviceUid: string): string[] {
  const host = circuitNodeElement(svg, deviceUid);
  return [...host.querySelectorAll("g[data-function-key]")].map(
    (el) => el.getAttribute("data-function-key") ?? "",
  );
}

function expectIncreasingAlongFlow(
  positions: ReadonlyMap<string, { x: number; y: number }>,
  keys: readonly string[],
  flow: (typeof FLOWS)[number],
): void {
  const axis = flow === "top-to-bottom" ? "x" : "y";
  const coords = keys.map((key) => {
    const pos = positions.get(key);
    if (!pos) throw new Error(`Missing terminal ${key}`);
    return pos[axis];
  });
  for (let i = 1; i < coords.length; i++) {
    expect(
      coords[i],
      `${flow}: expected ${keys[i]} (${coords[i]}) > ${keys[i - 1]} (${coords[i - 1]})`,
    ).toBeGreaterThan(coords[i - 1]!);
  }
}

function singleGroupView(
  title: string,
  id: string,
  flow: (typeof FLOWS)[number],
  selectors: readonly [string, string][],
): CircuitViewRequest {
  return {
    format: "circuit-view-request/0.1",
    title,
    flow,
    groups: [
      {
        id,
        label: title,
        functions: selectors.map(([device, key]) => ({
          device: { by: "designation", value: device },
          key,
        })),
        conductors: [],
      },
    ],
  };
}

async function compileSyntheticProject(
  types: readonly Record<string, unknown>[],
  devices: readonly Record<string, unknown>[],
): Promise<ElectricalIr> {
  const dir = await mkdtemp(join(tmpdir(), "thermite-pe-order-"));
  const write = (path: string, value: unknown) =>
    writeFile(join(dir, path), JSON.stringify(value, null, 2));
  try {
    await mkdir(join(dir, "library"));
    await write("system.json", {
      format: "electrical-system/0.1",
      project: { name: "PE order synthetic fixture" },
      sources: ["source.json"],
      libraries: [{ name: "pe-fixture", version: "0.1.0", path: "library" }],
    });
    await write("library/library.json", {
      name: "pe-fixture",
      version: "0.1.0",
      sources: ["types.json"],
    });
    await write("library/types.json", { types });
    await write("source.json", {
      objects: devices.map((d) => ({ kind: "device", ...d })),
    });
    await lockProject(dir);
    const compiled = await compileProject(dir);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    return compiled.ir;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function supplyAndDecoyFixture() {
  return compileSyntheticProject(
    [
      {
        kind: "device_type",
        id: "pe-fixture:supply",
        symbol: "thermite:power-source",
        terminals: {
          L1: { role: "phase_1_source" },
          L2: { role: "phase_2_source" },
          L3: { role: "phase_3_source" },
          PE: { role: "protective_earth" },
        },
        functions: {
          bond_ground: { kind: "bus", terminals: ["PE"] },
          mains: { kind: "source", terminals: ["L1", "L2", "L3"] },
        },
      },
      {
        kind: "device_type",
        id: "pe-fixture:decoy",
        symbol: "thermite:io-module",
        terminals: {
          PE: { role: "common" },
          IN1: { role: "digital_input" },
        },
        functions: {
          protective_earth: { kind: "bus", terminals: ["PE"] },
          ch1: { kind: "channel", direction: "input", terminals: ["IN1"] },
        },
      },
    ],
    [
      {
        uid: "11111111-1111-4111-8111-111111111111",
        designation: "S1",
        type: "pe-fixture:supply",
      },
      {
        uid: "22222222-2222-4222-8222-222222222222",
        designation: "D1",
        type: "pe-fixture:decoy",
      },
    ],
  );
}

function mixedOrderFixture() {
  return compileSyntheticProject(
    [
      {
        kind: "device_type",
        id: "pe-fixture:mixed",
        symbol: "thermite:io-module",
        terminals: {
          E1: { role: "protective_earth" },
          E2: { role: "protective_earth" },
          Z: { role: "digital_input" },
          A: { role: "digital_input" },
          M: { role: "digital_input" },
        },
        functions: {
          pe_first: { kind: "bus", terminals: ["E1"] },
          pe_second: { kind: "bus", terminals: ["E2"] },
          fn_z: { kind: "channel", direction: "input", terminals: ["Z"] },
          fn_a: { kind: "channel", direction: "input", terminals: ["A"] },
          fn_m: { kind: "channel", direction: "input", terminals: ["M"] },
        },
      },
    ],
    [
      {
        uid: "33333333-3333-4333-8333-333333333333",
        designation: "U1",
        type: "pe-fixture:mixed",
      },
    ],
  );
}

function terminalStripFixture() {
  return compileSyntheticProject(
    [
      {
        kind: "device_type",
        id: "pe-fixture:strip",
        symbol: "thermite:terminal-strip",
        terminalOrder: ["PE", "1", "2"],
        terminals: {
          PE: { role: "protective_earth" },
          "1": { role: "common" },
          "2": { role: "common" },
        },
        functions: {
          t_pe: { kind: "bus", terminals: ["PE"] },
          t_1: { kind: "bus", terminals: ["1"] },
          t_2: { kind: "bus", terminals: ["2"] },
        },
      },
    ],
    [
      {
        uid: "44444444-4444-4444-8444-444444444444",
        designation: "TB9",
        type: "pe-fixture:strip",
      },
    ],
  );
}

function busOrderType(
  id: string,
  symbol: string,
  extra: Record<string, unknown> = {},
) {
  return {
    kind: "device_type",
    id: `pe-fixture:${id}`,
    symbol,
    terminals: {
      PE: { role: "protective_earth" },
      A: { role: "common" },
      B: { role: "common" },
    },
    functions: {
      e: { kind: "bus", terminals: ["PE"] },
      a: { kind: "bus", terminals: ["A"] },
      b: { kind: "bus", terminals: ["B"] },
    },
    ...extra,
  };
}

function authoredOrderTableTypes() {
  const ordered = { terminalOrder: ["PE", "A", "B"] };
  return [
    busOrderType("strip", "thermite:terminal-strip", ordered),
    busOrderType("legacy-strip", "iec:terminal-block", ordered),
    busOrderType("category-strip", "thermite:io-module", {
      category: "terminal-strip",
    }),
    busOrderType("category-strip-ordered", "thermite:io-module", {
      category: "terminal-strip",
      ...ordered,
    }),
    busOrderType("explicit-order", "thermite:io-module", ordered),
    busOrderType("connector", "thermite:io-module", {
      ...ordered,
      connectorPorts: {
        MATE: {
          connector: "synthetic",
          pins: {
            PE: { terminal: "PE" },
            A: { terminal: "A" },
            B: { terminal: "B" },
          },
        },
      },
    }),
    {
      kind: "device_type",
      id: "pe-fixture:roles",
      symbol: "thermite:io-module",
      terminals: {
        PE: { role: "protective_earth" },
        FE: { role: "functional_earth" },
        SH: { role: "shield" },
        "0V": { role: "dc_return_output" },
        A: { role: "common" },
        B: { role: "common" },
      },
      functions: {
        earth: { kind: "bus", terminals: ["PE"] },
        fe: { kind: "bus", terminals: ["FE"] },
        shield: { kind: "bus", terminals: ["SH"] },
        zero: { kind: "bus", terminals: ["0V"] },
        common: { kind: "bus", terminals: ["A"] },
        other: { kind: "bus", terminals: ["B"] },
      },
    },
    {
      kind: "device_type",
      id: "pe-fixture:combined",
      symbol: "thermite:io-module",
      terminals: {
        PE: { role: "protective_earth" },
        A: { role: "common" },
        B: { role: "common" },
      },
      functions: {
        mixed: { kind: "other", terminals: ["PE", "A"] },
        b: { kind: "bus", terminals: ["B"] },
      },
    },
  ];
}

function authoredOrderTableFixture() {
  const types = authoredOrderTableTypes();
  const devices = types.map((t, i) => ({
    uid: `55555555-5555-4555-8555-${String(i + 1).padStart(12, "0")}`,
    designation: `U${i + 1}`,
    type: t.id,
  }));
  return { types, devices, irPromise: compileSyntheticProject(types, devices) };
}

function paginationFixture(withTerminalOrder: boolean) {
  const keys = [
    "earth",
    ...Array.from(
      { length: 32 },
      (_, i) => `f${String(i + 1).padStart(2, "0")}`,
    ),
  ];
  const type = {
    kind: "device_type",
    id: withTerminalOrder ? "pe-fixture:many-ordered" : "pe-fixture:many",
    symbol: "thermite:io-module",
    ...(withTerminalOrder ? { terminalOrder: keys } : {}),
    terminals: Object.fromEntries(
      keys.map((k) => [
        k,
        { role: k === "earth" ? "protective_earth" : "common" },
      ]),
    ),
    functions: Object.fromEntries(
      keys.map((k) => [k, { kind: "bus", terminals: [k] }]),
    ),
  };
  return {
    keys,
    irPromise: compileSyntheticProject(
      [type],
      [
        {
          uid: "66666666-6666-4666-8666-000000000001",
          designation: "U1",
          type: type.id,
        },
      ],
    ),
  };
}

function paginatedPartRows(sheets: readonly { svg: string }[]): string[][] {
  return sheets.flatMap((sheet) =>
    [
      ...parseHTML(sheet.svg).document.querySelectorAll("[data-circuit-part]"),
    ].map((part) =>
      [...part.querySelectorAll("g[data-function-key]")].map(
        (el) => el.getAttribute("data-function-key") ?? "",
      ),
    ),
  );
}

function paginatedLetterRequest(
  flow: (typeof FLOWS)[number],
  keys: readonly string[],
): SchematicPacketRequest {
  return {
    format: "schematic-packet-request/0.1",
    page: {
      size: "letter",
      orientation: flow === "left-to-right" ? "landscape" : "portrait",
      marginMm: 10,
    },
    views: [
      singleGroupView(
        "Order",
        "g",
        flow,
        keys.map((k) => ["U1", k]),
      ),
    ],
  };
}

describe("circuit view protective-earth ordering (#654)", () => {
  it("classifies only single-terminal bus functions with protective_earth role", () => {
    const supplyType = rm3Ir.deviceTypes.find(
      (t) => t.id === "core:supply-480v-3ph",
    )!;
    const peFn = supplyType.functions.find(
      (f) => f.key === "protective_earth",
    )!;
    const phaseFn = supplyType.functions.find(
      (f) => f.key === "three_phase_source",
    )!;
    expect(isProtectiveEarthFunction(supplyType, peFn)).toBe(true);
    expect(isProtectiveEarthFunction(supplyType, phaseFn)).toBe(false);
    expect(
      isProtectiveEarthFunction(supplyType, {
        kind: "bus",
        terminalKeys: ["PE", "L1"],
      }),
    ).toBe(false);
    expect(
      isProtectiveEarthFunction(supplyType, {
        kind: "load",
        terminalKeys: ["PE"],
      }),
    ).toBe(false);
    expect(
      isProtectiveEarthFunction(supplyType, {
        kind: "bus",
        terminalKeys: ["L1"],
      }),
    ).toBe(false);
    expect(
      partitionProtectiveEarthFunctions(supplyType, [peFn, phaseFn]).map(
        (f) => f.key,
      ),
    ).toEqual(["three_phase_source", "protective_earth"]);
    expect(isTerminalStripType({ symbol: "thermite:terminal-strip" })).toBe(
      true,
    );
    expect(isTerminalStripType({ symbol: "iec:terminal-block" })).toBe(true);
    expect(
      isTerminalStripType({
        category: "terminal-strip",
        symbol: "thermite:io-module",
      }),
    ).toBe(true);
    expect(isTerminalStripType(supplyType)).toBe(false);
    expect(preservesAuthoredCircuitOrder(supplyType)).toBe(false);
    expect(
      preservesAuthoredCircuitOrder({
        ...supplyType,
        terminalOrder: ["PE", "L1", "L2", "L3"],
      }),
    ).toBe(true);
    const src1 = rm3Ir.devices.find((d) => d.designation === "SRC1")!;
    expect(
      preservesAuthoredCircuitOrder(supplyType, {
        ...src1,
        terminalOrder: ["PE", "L1", "L2", "L3"],
      }),
    ).toBe(true);
  });

  it("renders rm3 SRC1 in L1, L2, L3, PE order in both flows without mutating IR", async () => {
    const before = JSON.stringify(rm3Ir);
    const src1 = rm3Ir.devices.find((d) => d.designation === "SRC1")!;
    const irKeys = rm3Ir.functions
      .filter((f) => f.id.deviceUid === src1.uid)
      .map((f) => f.id.functionKey);
    expect(irKeys).toEqual(["protective_earth", "three_phase_source"]);

    for (const flow of FLOWS) {
      const view = singleGroupView("SRC1", "interface", flow, [
        ["SRC1", "protective_earth"],
        ["SRC1", "three_phase_source"],
      ]);
      const content = (await prepareCircuitView(rm3Ir, view)).groups[0]!
        .content;
      expect(functionRowOrder(content, src1.uid)).toEqual([
        "three_phase_source",
        "protective_earth",
      ]);
      expectIncreasingAlongFlow(
        terminalPositions(content, src1.uid),
        ["L1", "L2", "L3", "PE"],
        flow,
      );
    }
    expect(JSON.stringify(rm3Ir)).toBe(before);
  });

  it("classifies PE by native bus role rather than key strings in both flows", async () => {
    const ir = await supplyAndDecoyFixture();
    const s1Uid = "11111111-1111-4111-8111-111111111111";
    const d1Uid = "22222222-2222-4222-8222-222222222222";
    for (const flow of FLOWS) {
      const supply = await prepareCircuitView(
        ir,
        singleGroupView("Minimal supply", "s1", flow, [
          ["S1", "bond_ground"],
          ["S1", "mains"],
        ]),
      );
      const supplySvg = supply.groups[0]!.content;
      expect(functionRowOrder(supplySvg, s1Uid)).toEqual([
        "mains",
        "bond_ground",
      ]);
      expectIncreasingAlongFlow(
        terminalPositions(supplySvg, s1Uid),
        ["L1", "L2", "L3", "PE"],
        flow,
      );

      // Decoy key named "protective_earth" with role "common" must stay first.
      const decoy = await prepareCircuitView(
        ir,
        singleGroupView("Decoy key", "d1", flow, [
          ["D1", "protective_earth"],
          ["D1", "ch1"],
        ]),
      );
      expect(functionRowOrder(decoy.groups[0]!.content, d1Uid)).toEqual([
        "protective_earth",
        "ch1",
      ]);
    }
  });

  it("stably partitions multiple non-PE and PE functions without disturbing relative order", async () => {
    const ir = await mixedOrderFixture();
    const u1Uid = "33333333-3333-4333-8333-333333333333";
    for (const flow of FLOWS) {
      const prepared = await prepareCircuitView(
        ir,
        singleGroupView("Mixed order", "mixed", flow, [
          ["U1", "pe_first"],
          ["U1", "fn_z"],
          ["U1", "fn_a"],
          ["U1", "pe_second"],
          ["U1", "fn_m"],
        ]),
      );
      const svg = prepared.groups[0]!.content;
      expect(functionRowOrder(svg, u1Uid)).toEqual([
        "fn_z",
        "fn_a",
        "fn_m",
        "pe_first",
        "pe_second",
      ]);
      expectIncreasingAlongFlow(
        terminalPositions(svg, u1Uid),
        ["Z", "A", "M", "E1", "E2"],
        flow,
      );
    }
  });

  it("preserves authored order for terminal strips (#336) and non-PE groups", async () => {
    const stripIr = await terminalStripFixture();
    const tbUid = "44444444-4444-4444-8444-444444444444";
    const k1 = coreIr.devices.find((d) => d.designation === "K1")!;
    for (const flow of FLOWS) {
      const stripView = await prepareCircuitView(
        stripIr,
        singleGroupView("Strip authored order", "strip", flow, [
          ["TB9", "t_pe"],
          ["TB9", "t_1"],
          ["TB9", "t_2"],
        ]),
      );
      expect(functionRowOrder(stripView.groups[0]!.content, tbUid)).toEqual([
        "t_pe",
        "t_1",
        "t_2",
      ]);

      const noPeView = await prepareCircuitView(
        coreIr,
        singleGroupView("No PE", "k1", flow, [
          ["K1", "pole3"],
          ["K1", "coil"],
          ["K1", "pole1"],
        ]),
      );
      expect(functionRowOrder(noPeView.groups[0]!.content, k1.uid)).toEqual([
        "pole3",
        "coil",
        "pole1",
      ]);
    }
  });

  it("keeps already-last PE geometry unchanged and preserves multi-device node order", async () => {
    const m1 = coreIr.devices.find((d) => d.designation === "M1")!;
    for (const flow of FLOWS) {
      const peLast = await prepareCircuitView(
        coreIr,
        singleGroupView("M1 PE last", "m1", flow, [
          ["M1", "motor_load"],
          ["M1", "protective_earth"],
        ]),
      );
      const peFirst = await prepareCircuitView(
        coreIr,
        singleGroupView("M1 PE first", "m1", flow, [
          ["M1", "protective_earth"],
          ["M1", "motor_load"],
        ]),
      );
      expectIncreasingAlongFlow(
        terminalPositions(peLast.groups[0]!.content, m1.uid),
        ["U", "V", "W", "PE"],
        flow,
      );
      expect(terminalPositions(peFirst.groups[0]!.content, m1.uid)).toEqual(
        terminalPositions(peLast.groups[0]!.content, m1.uid),
      );
    }

    const src1 = coreIr.devices.find((d) => d.designation === "SRC1")!;
    const k1 = coreIr.devices.find((d) => d.designation === "K1")!;
    const multi = await prepareCircuitView(
      coreIr,
      singleGroupView("Multi device", "multi", "left-to-right", [
        ["SRC1", "protective_earth"],
        ["K1", "pole1"],
        ["SRC1", "three_phase_source"],
      ]),
    );
    expect(multi.groups[0]!.references.map((r) => r.deviceUid)).toEqual([
      src1.uid,
      k1.uid,
    ]);
    expectIncreasingAlongFlow(
      terminalPositions(multi.groups[0]!.content, src1.uid),
      ["L1", "L2", "L3", "PE"],
      "left-to-right",
    );
  });

  it("preserves STAHL XP authored terminalOrder in both flows without mutating IR", async () => {
    const project = join(
      repoRoot,
      "libraries/stahl-pilot/examples/component-check",
    );
    const compiled = await compileProject(project);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const before = JSON.stringify(compiled.ir);
    const packetReq = JSON.parse(
      await readFile(join(project, "packet.json"), "utf8"),
    );
    const xpView = packetReq.views.find(
      (v: { format?: string; groups?: { id?: string }[] }) =>
        v.format === "circuit-view-request/0.1" &&
        v.groups?.some((g) => g.id === "XP"),
    );
    const xp = compiled.ir.devices.find((d) => d.designation === "XP")!;
    const expected = ["C.P1", "C.P2", "C.PE", "M.P1", "M.P2", "M.PE"];
    for (const flow of FLOWS) {
      const prepared = await prepareCircuitView(compiled.ir, {
        ...xpView,
        flow,
      });
      const svg = prepared.groups[0]!.content;
      expect(functionRowOrder(svg, xp.uid)).toEqual(expected);
      expectIncreasingAlongFlow(terminalPositions(svg, xp.uid), expected, flow);
    }
    expect(JSON.stringify(compiled.ir)).toBe(before);
  });

  it("respects authored terminalOrder and category-declared strips across the order table", async () => {
    const { devices, irPromise } = authoredOrderTableFixture();
    const ir = await irPromise;
    const expectedById: Record<string, [string[], string[]]> = {
      "pe-fixture:strip": [
        ["e", "a", "b"],
        ["e", "a", "b"],
      ],
      "pe-fixture:legacy-strip": [
        ["e", "a", "b"],
        ["e", "a", "b"],
      ],
      "pe-fixture:category-strip": [
        ["e", "a", "b"],
        ["e", "a", "b"],
      ],
      "pe-fixture:category-strip-ordered": [
        ["e", "a", "b"],
        ["e", "a", "b"],
      ],
      "pe-fixture:explicit-order": [
        ["e", "a", "b"],
        ["e", "a", "b"],
      ],
      "pe-fixture:connector": [
        ["e", "a", "b"],
        ["e", "a", "b"],
      ],
      "pe-fixture:roles": [
        ["earth", "fe", "shield", "zero", "common", "other"],
        ["fe", "shield", "zero", "common", "other", "earth"],
      ],
      "pe-fixture:combined": [
        ["mixed", "b"],
        ["mixed", "b"],
      ],
    };
    for (const device of devices) {
      const [requestKeys, expected] = expectedById[device.type]!;
      for (const flow of FLOWS) {
        const prepared = await prepareCircuitView(
          ir,
          singleGroupView(
            device.type,
            "order",
            flow,
            requestKeys.map((k) => [device.designation, k]),
          ),
        );
        expect(
          functionRowOrder(prepared.groups[0]!.content, device.uid),
          `${device.type} (${flow})`,
        ).toEqual(expected);
      }
    }
  });

  it("preserves Siemens CPU 1212C authored terminalOrder in both flows", async () => {
    const compiled = await compileProject(
      join(repoRoot, "examples/machine-demo"),
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const plc = compiled.ir.devices.find((d) => d.designation === "PLC1")!;
    const keys = [
      "supply",
      "functional_earth",
      "sensor_supply",
      "digital_common",
    ];
    for (const flow of FLOWS) {
      const prepared = await prepareCircuitView(
        compiled.ir,
        singleGroupView(
          "CPU",
          "g",
          flow,
          keys.map((k) => ["PLC1", k]),
        ),
      );
      expect(functionRowOrder(prepared.groups[0]!.content, plc.uid)).toEqual(
        keys,
      );
    }
  });

  it("partitions PE after all functions across paginated parts of a group in both flows", async () => {
    const unordered = paginationFixture(false);
    const ordered = paginationFixture(true);
    const [unorderedIr, orderedIr] = await Promise.all([
      unordered.irPromise,
      ordered.irPromise,
    ]);
    const expectedUnordered = [...unordered.keys.slice(1), "earth"];
    for (const flow of FLOWS) {
      const req = paginatedLetterRequest(flow, unordered.keys);
      const unorderedResult = await renderSchematicPacket(unorderedIr, req);
      expect(unorderedResult.ok).toBe(true);
      if (!unorderedResult.ok) continue;
      const unorderedParts = paginatedPartRows(unorderedResult.value.sheets);
      expect(unorderedParts.length).toBeGreaterThan(1);
      expect(unorderedParts.flat()).toEqual(expectedUnordered);

      const orderedResult = await renderSchematicPacket(orderedIr, req);
      expect(orderedResult.ok).toBe(true);
      if (!orderedResult.ok) continue;
      const orderedParts = paginatedPartRows(orderedResult.value.sheets);
      expect(orderedParts.length).toBeGreaterThan(1);
      expect(orderedParts.flat()).toEqual(ordered.keys);
    }
  });
});
