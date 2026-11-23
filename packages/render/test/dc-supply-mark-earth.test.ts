import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { circuitMark } from "../src/symbols/circuit.js";
import {
  compileTempSupplyProject,
  corePsuFixture,
  makePeAnchorIr,
  makeSupplyFace,
  renderCircuitGroupsHtml,
  type SupplyTerminalSpec,
} from "./dc-supply-mark-helpers.js";

const AC = { rating: { voltage_type: "AC" as const } };
const DC = { rating: { voltage_type: "DC" as const } };
const LINE = { ...AC, role: "ac_line_input" };
const NEUTRAL = { ...AC, role: "ac_input_return" };
const POSITIVE = { ...DC, role: "dc_positive_output" };
const NEGATIVE = { ...DC, role: "dc_return_output" };
const EARTH_BUS = {
  extraFunctions: { bond: { kind: "bus", terminals: ["B"] } },
  circuitSymbols: { bond: "earth" },
};

const CLOSED_EARTH_ROLES = [
  "protective_earth",
  "protectiveEarth",
  "ProtectiveEarth",
  "Protective Earth",
  "pe",
  "PE",
  "pE",
  "functional_earth",
  "functionalEarth",
  "Functional Earth",
  "fe",
  "FE",
  "earth",
  "Earth",
  "chassis_ground",
  "chassis-ground",
  "chassisGround",
  "chassis_earth",
  "chassis-earth",
  "chassisEarth",
] as const;

const NON_EARTH_RETURN_ROLES = [
  "supplyGroundReturn",
  "ground",
  "gnd",
  "return",
] as const;

const EARTH_BUS_CASES: ReadonlyArray<{
  readonly label: string;
  readonly kind: "load" | "source";
  readonly terminals: SupplyTerminalSpec[];
  readonly expected: "ac-input" | "dc-output";
}> = [
  {
    label: "unroled AC-rated load with earth bus mark",
    kind: "load",
    terminals: [
      { key: "A", ...AC },
      { key: "B", ...AC },
    ],
    expected: "ac-input",
  },
  {
    label: "AC-return load with earth bus mark",
    kind: "load",
    terminals: [
      { key: "A", ...LINE },
      { key: "B", ...NEUTRAL },
    ],
    expected: "ac-input",
  },
  {
    label: "DC-return source with earth bus mark",
    kind: "source",
    terminals: [
      { key: "A", ...POSITIVE },
      { key: "B", ...NEGATIVE },
    ],
    expected: "dc-output",
  },
];

const BIDIRECTIONAL_EARTH_CASES: ReadonlyArray<{
  readonly label: string;
  readonly terminals: SupplyTerminalSpec[];
  readonly expected: "ac-input" | "load";
}> = [
  {
    label: "complete AC role pair + DC-rated protective_earth",
    terminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "PE", role: "protective_earth", ...DC },
    ],
    expected: "ac-input",
  },
  {
    label: "two AC-rated pins + DC-rated camelCase protectiveEarth",
    terminals: [
      { key: "L", ...AC },
      { key: "N", ...AC },
      { key: "PE", role: "protectiveEarth", ...DC },
    ],
    expected: "ac-input",
  },
  {
    label: "complete AC role pair + DC-rated functional_earth",
    terminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "FE", role: "functional_earth", ...DC },
    ],
    expected: "ac-input",
  },
  {
    label: "dc_earth is not in the closed earth set and vetoes AC",
    terminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "PE", role: "dc_earth", ...DC },
    ],
    expected: "load",
  },
];

interface Round4Probe {
  readonly id: string;
  readonly symbol?: string;
  readonly kind?: "load" | "source";
  readonly terminals: Record<string, unknown>;
  readonly functionTerminals?: string[];
  readonly extraFunctions?: Record<string, unknown>;
  readonly circuitSymbols?: Record<string, string>;
  readonly pePotentialTerminal?: string;
  readonly expectedMark: string;
}

const ROUND4_PROBES: readonly Round4Probe[] = [
  {
    id: "earth-alias-1",
    terminals: { A: AC, B: { ...AC, role: "functional_earth" } },
    expectedMark: "load",
  },
  {
    id: "earth-alias-2",
    symbol: "iec:dc-power-supply",
    terminals: { A: AC, B: { ...AC, role: "PE" } },
    expectedMark: "load",
  },
  {
    id: "earth-alias-3",
    terminals: { A: AC, B: { ...AC, role: "chassis-ground" } },
    expectedMark: "load",
  },
  {
    id: "earth-alias-4",
    symbol: "iec:dc-power-supply",
    terminals: { A: AC, B: { ...AC, role: "Protective Earth" } },
    expectedMark: "load",
  },
  {
    id: "earth-alias-5",
    terminals: { A: AC, B: { ...AC, role: "protectiveEarth" } },
    expectedMark: "load",
  },
  {
    id: "neutral-only-ac-rated",
    symbol: "iec:dc-power-supply",
    terminals: {
      L: { role: "ac_line_input" },
      N: { role: "neutral", ...AC },
      PE: { role: "protective_earth" },
    },
    expectedMark: "load",
  },
  {
    id: "complete-ac-roles",
    terminals: {
      L: { role: "ac_line_input" },
      N: { role: "ac_neutral", ...AC },
      PE: { role: "protective_earth" },
    },
    expectedMark: "ac-input",
  },
  {
    id: "all-ac-alternate-pe",
    symbol: "iec:dc-power-supply",
    terminals: { L: AC, N: AC, PE: { role: "Functional Earth" } },
    expectedMark: "ac-input",
  },
  {
    id: "dc-rated-earth",
    terminals: {
      L: { role: "ac_line_input" },
      N: { role: "ac_input_return" },
      PE: { role: "protective_earth", ...DC },
    },
    expectedMark: "ac-input",
  },
  {
    id: "three-phase-separate-pe",
    symbol: "iec:dc-power-supply",
    terminals: {
      A: { role: "phase_1_input" },
      B: { role: "phase_2_input" },
      C: { role: "phase_3_input" },
      PE: { role: "protective_earth" },
    },
    functionTerminals: ["A", "B", "C"],
    expectedMark: "ac-input",
  },
  {
    id: "two-terminal-pe-source",
    symbol: "iec:dc-power-supply",
    kind: "source",
    terminals: {
      D: { role: "dc_positive_output" },
      PE: { role: "protective_earth" },
    },
    expectedMark: "source",
  },
  {
    id: "two-terminal-aux-source",
    kind: "source",
    terminals: { D: { role: "dc_positive_output" }, A: { role: "aux" } },
    expectedMark: "source",
  },
  {
    id: "camel-functional-earth",
    terminals: { A: AC, B: { ...AC, role: "functionalEarth" } },
    expectedMark: "load",
  },
  {
    id: "camel-chassis-ground",
    terminals: { A: AC, B: { ...AC, role: "chassisGround" } },
    expectedMark: "load",
  },
  {
    id: "camel-supply-ground-return",
    terminals: {
      A: LINE,
      B: {
        ...AC,
        role: "supplyGroundReturn",
        description: "Supply ground return",
      },
    },
    expectedMark: "ac-input",
  },
  {
    id: "supply-ground-description-control",
    terminals: {
      A: LINE,
      B: { ...AC, role: "return", description: "Supply ground return" },
    },
    expectedMark: "ac-input",
  },
  {
    id: "ground-return-ac-rated",
    terminals: { A: LINE, B: { ...AC, role: "ground" } },
    expectedMark: "ac-input",
  },
  {
    id: "gnd-return-ac-rated",
    terminals: { A: LINE, B: { ...AC, role: "gnd" } },
    expectedMark: "ac-input",
  },
  {
    id: "earth-bus-unroled",
    terminals: { A: AC, B: AC },
    ...EARTH_BUS,
    expectedMark: "ac-input",
  },
  {
    id: "earth-bus-ac-return",
    terminals: { A: LINE, B: NEUTRAL },
    ...EARTH_BUS,
    expectedMark: "ac-input",
  },
  {
    id: "earth-bus-dc-return",
    kind: "source",
    terminals: { A: POSITIVE, B: NEGATIVE },
    ...EARTH_BUS,
    expectedMark: "dc-output",
  },
  {
    id: "explicit-ac-binding",
    terminals: { A: LINE, B: NEUTRAL },
    ...EARTH_BUS,
    circuitSymbols: { bond: "earth", face: "ac-input" },
    expectedMark: "ac-input",
  },
  {
    id: "mixed-case-pe-source",
    kind: "source",
    terminals: { A: POSITIVE, B: { role: "pE" } },
    expectedMark: "source",
  },
  {
    id: "mixed-case-pe-load",
    terminals: { A: AC, B: { ...AC, role: "pE" } },
    expectedMark: "load",
  },
  {
    id: "ac-with-rated-aux",
    terminals: { A: LINE, B: NEUTRAL, C: { ...AC, role: "aux" } },
    expectedMark: "load",
  },
  {
    id: "ac-with-dc-conflict",
    terminals: { A: LINE, B: { ...DC, role: "ac_input_return" } },
    expectedMark: "load",
  },
  {
    id: "pe-potential-anchored",
    terminals: { A: AC, B: AC },
    pePotentialTerminal: "B",
    expectedMark: "load",
  },
];

function buildRound4ProjectSpec() {
  const types = ROUND4_PROBES.map((p) => ({
    kind: "device_type",
    id: `r4-probes:${p.id}`,
    symbol: p.symbol ?? "thermite:dc-supply",
    terminals: p.terminals,
    functions: {
      face: {
        kind: p.kind ?? "load",
        terminals: p.functionTerminals ?? Object.keys(p.terminals),
      },
      ...(p.extraFunctions ?? {}),
    },
    ...(p.circuitSymbols ? { circuitSymbols: p.circuitSymbols } : {}),
  }));
  const objects: unknown[] = ROUND4_PROBES.map((p, idx) => ({
    kind: "device",
    uid: `f4000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
    designation: `P${idx + 1}`,
    type: `r4-probes:${p.id}`,
  }));
  for (const [idx, p] of ROUND4_PROBES.entries()) {
    if (p.pePotentialTerminal) {
      objects.push({
        kind: "potential",
        uid: `f5000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
        name: `PE_${idx + 1}`,
        at: { device: `P${idx + 1}`, terminal: p.pePotentialTerminal },
        electrical: { polarity: "protective_earth" },
      });
    }
  }
  return {
    projectName: "PS1MARK Round 4 Probes",
    libraryName: "r4-probes",
    types,
    objects,
  };
}

describe("thermite:dc-supply closed earth classification (#553 round 4)", () => {
  it("classifies earth roles via the closed exact-match set and keeps non-earth returns eligible", async () => {
    const { type, ps1 } = await corePsuFixture();
    for (const role of CLOSED_EARTH_ROLES) {
      const load = makeSupplyFace(type, ps1.uid, "load", [
        { key: "A", ...AC },
        { key: "B", role, ...AC },
      ]);
      expect(circuitMark(load.t, load.fn), role).toBe("load");
      const src = makeSupplyFace(
        type,
        ps1.uid,
        "source",
        [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role, ...AC },
        ],
        { functionKey: "dc_output" },
      );
      expect(circuitMark(src.t, src.fn), `source ${role}`).toBe("source");
    }
    for (const returnRole of NON_EARTH_RETURN_ROLES) {
      const retLoad = makeSupplyFace(type, ps1.uid, "load", [
        { key: "A", ...LINE },
        { key: "B", role: returnRole, ...AC },
      ]);
      expect(circuitMark(retLoad.t, retLoad.fn), returnRole).toBe("ac-input");
    }
  });

  it("classifies unroled earth via IR protective_earth potential and ignores drawing marks", async () => {
    const { ir, type, ps1, acInput } = await corePsuFixture();
    const anchored = makePeAnchorIr(
      ir,
      type.id,
      ps1.uid,
      [
        { key: "A", ...AC },
        { key: "B", ...AC },
      ],
      "B",
      {
        functionKey: acInput.id.functionKey,
        potentialUid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    );
    const potFn = anchored.ir.functions.find(
      (f) =>
        f.id.deviceUid === ps1.uid &&
        f.id.functionKey === acInput.id.functionKey,
    )!;
    potFn.terminals = anchored.fn.terminals;
    expect(circuitMark(anchored.t, potFn, { ir: anchored.ir })).toBe("load");
    for (const flow of ["left-to-right", "top-to-bottom"] as const) {
      const doc = await renderCircuitGroupsHtml(
        anchored.ir,
        "Potential-anchored PE probe",
        flow,
        [
          {
            id: "pe-potential",
            label: "pe-potential",
            deviceUid: ps1.uid,
            key: "ac_input",
          },
        ],
      );
      expect(doc.querySelector('[data-circuit-mark="ac-input"]')).toBeNull();
      expect(doc.querySelector('[data-circuit-mark="load"]')).not.toBeNull();
    }

    for (const row of EARTH_BUS_CASES) {
      const { t, fn } = makeSupplyFace(type, ps1.uid, row.kind, row.terminals, {
        circuitSymbols: { bond: "earth" },
      });
      t.functions = [
        ...t.functions,
        { key: "bond", kind: "bus", terminalKeys: ["B"], source: t.source },
      ];
      expect(circuitMark(t, fn), row.label).toBe(row.expected);
    }
  });

  it("ignores earth terminals completely in both directions: neither establishes nor vetoes AC (#553 round 4)", async () => {
    const { ir, type, ps1 } = await corePsuFixture();
    for (const row of BIDIRECTIONAL_EARTH_CASES) {
      const { t, fn } = makeSupplyFace(type, ps1.uid, "load", row.terminals);
      expect(circuitMark(t, fn), row.label).toBe(row.expected);
    }
    const anchored = makePeAnchorIr(
      ir,
      type.id,
      ps1.uid,
      [
        { key: "L", role: "ac_line_input" },
        { key: "N", role: "ac_input_return" },
        { key: "E", ...DC },
      ],
      "E",
      {
        potentialUid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        netId: "net:pe-dc",
        replaceTerminals: false,
      },
    );
    expect(circuitMark(anchored.t, anchored.fn, { ir: anchored.ir })).toBe(
      "ac-input",
    );
  });

  it("reproduces every round-2 and round-3 reviewer probe on a compiled project in both flows (#553 round 4)", async () => {
    const { dir, ir } = await compileTempSupplyProject(
      "thermite-ps1mark-r4-",
      buildRound4ProjectSpec(),
    );
    try {
      for (const flow of ["left-to-right", "top-to-bottom"] as const) {
        const doc = await renderCircuitGroupsHtml(
          ir,
          `PS1MARK round-4 probes (${flow})`,
          flow,
          ROUND4_PROBES.map((p, idx) => ({
            id: p.id,
            label: p.id,
            deviceUid: `f4000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
            key: "face",
          })),
        );
        for (const p of ROUND4_PROBES) {
          const group = doc.querySelector(
            `[data-circuit-group="${p.id}"] [data-function-key="face"]`,
          );
          expect(group, `${flow} ${p.id} rendered group`).not.toBeNull();
          const marks = [...group!.querySelectorAll("[data-circuit-mark]")].map(
            (el) => el.getAttribute("data-circuit-mark"),
          );
          expect(marks, `${flow} ${p.id}`).toEqual([p.expectedMark]);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
