import { rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { conversionQualifierAudit } from "./qualifier-oracle.mjs";
import {
  compileOracleTempProject,
  expectUnowned,
  makeProbeGeometry,
  pePotential,
  psuCase,
} from "./qualifier-oracle-fixtures.mjs";

const AC = { rating: { voltage_type: "AC" } };
const DC = { rating: { voltage_type: "DC" } };
const LINE = { ...AC, role: "ac_line_input" };
const NEUTRAL = { ...AC, role: "ac_input_return" };
const POSITIVE = { ...DC, role: "dc_positive_output" };
const NEGATIVE = { ...DC, role: "dc_return_output" };
const EARTH_BUS = {
  extraFunctions: { bond: { kind: "bus", terminals: ["B"] } },
  circuitSymbols: { bond: "earth" },
};

const CLOSED_EARTH_ROLES = [
  ["protectiveEarth", "thermite:dc-supply"],
  ["ProtectiveEarth", "iec:dc-power-supply"],
  ["Protective Earth", "iec:dc-power-supply"],
  ["PE", "iec:dc-power-supply"],
  ["pE", "thermite:dc-supply"],
  ["functional_earth", "thermite:dc-supply"],
  ["functionalEarth", "thermite:dc-supply"],
  ["fe", "thermite:dc-supply"],
  ["earth", "thermite:dc-supply"],
  ["chassis-ground", "thermite:dc-supply"],
  ["chassisGround", "iec:dc-power-supply"],
  ["chassis-earth", "thermite:dc-supply"],
];

const UNROLED_EARTH_CASES = [
  {
    label: "IR protective_earth potential excludes unroled load terminal",
    options: {
      inputTerminals: [
        { key: "A", ...AC },
        { key: "B", ...AC },
      ],
      renderedMarks: ["ac-input"],
    },
    mutateIr: (ir) => {
      ir.potentials = [pePotential("p-pe", "PE", "B", "net:pe")];
    },
    expectedEligible: 0,
  },
  {
    label: "IR protective_earth potential excludes unroled source terminal",
    options: {
      functionKey: "dc_output",
      functionKind: "source",
      inputTerminals: [{ key: "A" }, { key: "B" }],
      extraTerminals: [],
      renderedMarks: ["dc-output"],
    },
    mutateIr: (ir) => {
      ir.potentials = [pePotential("p-pe-src", "PE", "B", "net:pe-src")];
    },
    expectedEligible: 0,
  },
  {
    label: "earth bus mark leaves unroled AC-rated load eligible",
    options: {
      inputTerminals: [
        { key: "A", ...AC },
        { key: "B", ...AC },
      ],
      circuitSymbols: { bond: "earth" },
      renderedMarks: ["ac-input"],
    },
    mutateIr: (ir) => {
      ir.deviceTypes[0].functions = [
        { key: "bond", kind: "bus", terminalKeys: ["B"] },
      ];
    },
    expectedEligible: 1,
  },
  {
    label: "earth bus mark leaves AC-return load eligible",
    options: {
      inputTerminals: [
        { key: "A", ...LINE },
        { key: "B", ...NEUTRAL },
      ],
      circuitSymbols: { bond: "earth" },
      renderedMarks: ["ac-input"],
    },
    mutateIr: (ir) => {
      ir.deviceTypes[0].functions = [
        { key: "bond", kind: "bus", terminalKeys: ["B"] },
      ];
    },
    expectedEligible: 1,
  },
  {
    label: "earth bus mark leaves DC-return source eligible",
    options: {
      functionKey: "dc_output",
      functionKind: "source",
      inputTerminals: [
        { key: "A", ...POSITIVE },
        { key: "B", ...NEGATIVE },
      ],
      extraTerminals: [],
      circuitSymbols: { bond: "earth" },
      renderedMarks: ["dc-output"],
    },
    mutateIr: (ir) => {
      ir.deviceTypes[0].functions = [
        { key: "bond", kind: "bus", terminalKeys: ["B"] },
      ];
    },
    expectedEligible: 1,
  },
  {
    label: "oracle ignores non-IR protectiveEarthTerminals field",
    options: {
      inputTerminals: [
        { key: "A", ...AC },
        { key: "B", ...AC },
      ],
      renderedMarks: ["ac-input"],
    },
    mutateIr: (ir) => {
      ir.protectiveEarthTerminals = [{ deviceUid: "D", terminalKey: "B" }];
    },
    expectedEligible: 1,
  },
];

const BIDIRECTIONAL_EARTH_CASES = [
  {
    label: "complete AC role pair + DC-rated protective_earth",
    inputTerminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "PE", role: "protective_earth", ...DC },
    ],
    expectedEligible: 1,
  },
  {
    label: "AC-rated pair + DC-rated camelCase protectiveEarth",
    inputTerminals: [
      { key: "L", ...AC },
      { key: "N", ...AC },
      { key: "PE", role: "protectiveEarth", ...DC },
    ],
    expectedEligible: 1,
  },
  {
    label: "dc_earth is not in closed earth set and vetoes AC",
    inputTerminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "PE", role: "dc_earth", ...DC },
    ],
    expectedEligible: 0,
  },
  {
    label: "complete AC role pair + unroled DC-rated PE potential anchor",
    inputTerminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "E", ...DC },
    ],
    potential: pePotential("p-pe-dc", "PE", "E", "net:pe-dc"),
    expectedEligible: 1,
  },
];

const ROUND4_PROBES = [
  {
    id: "earth-alias-1",
    terminals: { A: AC, B: { ...AC, role: "functional_earth" } },
    expectedMark: null,
  },
  {
    id: "earth-alias-2",
    symbol: "iec:dc-power-supply",
    terminals: { A: AC, B: { ...AC, role: "PE" } },
    expectedMark: null,
  },
  {
    id: "earth-alias-3",
    terminals: { A: AC, B: { ...AC, role: "chassis-ground" } },
    expectedMark: null,
  },
  {
    id: "earth-alias-4",
    symbol: "iec:dc-power-supply",
    terminals: { A: AC, B: { ...AC, role: "Protective Earth" } },
    expectedMark: null,
  },
  {
    id: "earth-alias-5",
    terminals: { A: AC, B: { ...AC, role: "protectiveEarth" } },
    expectedMark: null,
  },
  {
    id: "neutral-only-ac-rated",
    symbol: "iec:dc-power-supply",
    terminals: {
      L: { role: "ac_line_input" },
      N: { role: "neutral", ...AC },
      PE: { role: "protective_earth" },
    },
    expectedMark: null,
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
    expectedMark: null,
  },
  {
    id: "two-terminal-aux-source",
    kind: "source",
    terminals: { D: { role: "dc_positive_output" }, A: { role: "aux" } },
    expectedMark: null,
  },
  {
    id: "camel-functional-earth",
    terminals: { A: AC, B: { ...AC, role: "functionalEarth" } },
    expectedMark: null,
  },
  {
    id: "camel-chassis-ground",
    terminals: { A: AC, B: { ...AC, role: "chassisGround" } },
    expectedMark: null,
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
    expectedMark: null,
  },
  {
    id: "mixed-case-pe-load",
    terminals: { A: AC, B: { ...AC, role: "pE" } },
    expectedMark: null,
  },
  {
    id: "ac-with-rated-aux",
    terminals: { A: LINE, B: NEUTRAL, C: { ...AC, role: "aux" } },
    expectedMark: null,
  },
  {
    id: "ac-with-dc-conflict",
    terminals: { A: LINE, B: { ...DC, role: "ac_input_return" } },
    expectedMark: null,
  },
  {
    id: "pe-potential-anchored",
    terminals: { A: AC, B: AC },
    pePotentialTerminal: "B",
    expectedMark: null,
  },
];

function buildRound4ProjectSpec() {
  const types = ROUND4_PROBES.map((p) => ({
    kind: "device_type",
    id: `r4-oracle:${p.id}`,
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
  const objects = ROUND4_PROBES.map((p, idx) => ({
    kind: "device",
    uid: `f6000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
    designation: `Q${idx + 1}`,
    type: `r4-oracle:${p.id}`,
  }));
  for (const [idx, p] of ROUND4_PROBES.entries()) {
    if (p.pePotentialTerminal) {
      objects.push({
        kind: "potential",
        uid: `f7000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
        name: `PE_${idx + 1}`,
        at: { device: `Q${idx + 1}`, terminal: p.pePotentialTerminal },
        electrical: { polarity: "protective_earth" },
      });
    }
  }
  return {
    projectName: "Oracle Round 4 Probes",
    libraryName: "r4-oracle",
    types,
    objects,
  };
}

function assertRound4Probe(ir, p, idx) {
  const uid = `f6000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`;
  const fn = ir.functions.find(
    (f) => f.id.deviceUid === uid && f.id.functionKey === "face",
  );
  const sheet = {
    view: { kind: "circuit" },
    references: [{ deviceUid: uid, functions: ["face"] }],
  };
  if (p.expectedMark) {
    const pass = conversionQualifierAudit(
      makeProbeGeometry(uid, fn, p.expectedMark),
      ir,
      sheet,
    );
    expect(pass, `${p.id} expected ${p.expectedMark}`).toEqual({
      findings: [],
      eligible: 1,
    });
    return;
  }
  const unmarked = conversionQualifierAudit(
    makeProbeGeometry(uid, fn, null),
    ir,
    sheet,
  );
  expect(unmarked, `${p.id} unmarked`).toEqual({ findings: [], eligible: 0 });
  const spuriousMark = p.kind === "source" ? "dc-output" : "ac-input";
  expectUnowned(
    conversionQualifierAudit(
      makeProbeGeometry(uid, fn, spuriousMark),
      ir,
      sheet,
    ),
    `${p.id} spurious ${spuriousMark}`,
  );
}

it.each(CLOSED_EARTH_ROLES)(
  "DQ-10 5.42 (#553 round 4): closed earth role %s (%s) never supplies the second AC rating or dc-output",
  (role, symbol) => {
    const loadTerminals = [
      { key: "A", ...AC },
      { key: "B", role, ...AC },
    ];
    const unmarked = psuCase({
      symbol,
      inputTerminals: loadTerminals,
      renderedMarks: [],
    });
    expect(
      conversionQualifierAudit(unmarked.g, unmarked.ir, unmarked.sheet),
    ).toEqual({ findings: [], eligible: 0 });

    const marked = psuCase({
      symbol,
      inputTerminals: loadTerminals,
      renderedMarks: ["ac-input"],
    });
    expectUnowned(conversionQualifierAudit(marked.g, marked.ir, marked.sheet));

    const srcMarked = psuCase({
      symbol,
      functionKey: "dc_output",
      functionKind: "source",
      inputTerminals: [
        { key: "+", role: "dc_positive_output" },
        { key: "PE", role },
      ],
      extraTerminals: [],
      renderedMarks: ["dc-output"],
    });
    expectUnowned(
      conversionQualifierAudit(srcMarked.g, srcMarked.ir, srcMarked.sheet),
    );
  },
);

it("DQ-10 5.42 (#553 round 4): only IR protective_earth potential (never drawing marks or synthetic lists) classifies unroled earth", () => {
  for (const row of UNROLED_EARTH_CASES) {
    const c = psuCase(row.options);
    row.mutateIr(c.ir);
    const audit = conversionQualifierAudit(c.g, c.ir, c.sheet);
    if (row.expectedEligible === 1) {
      expect(audit, row.label).toEqual({ findings: [], eligible: 1 });
    } else {
      expectUnowned(audit, row.label);
    }
  }
});

it("DQ-10 5.42 (#553 round 4): earth terminals are ignored in both directions (never veto AC)", () => {
  for (const row of BIDIRECTIONAL_EARTH_CASES) {
    const c = psuCase({
      inputTerminals: row.inputTerminals,
      renderedMarks: ["ac-input"],
    });
    if (row.potential) c.ir.potentials = [row.potential];
    const audit = conversionQualifierAudit(c.g, c.ir, c.sheet);
    if (row.expectedEligible === 1) {
      expect(audit, row.label).toEqual({ findings: [], eligible: 1 });
    } else {
      expectUnowned(audit, row.label);
    }
  }
});

it("DQ-10 5.42 (#553 round 4): compiled reviewer probes match the closed earth rule", async () => {
  const { dir, compiled } = await compileOracleTempProject(
    "thermite-oracle-r4-",
    buildRound4ProjectSpec(),
  );
  try {
    for (const [idx, p] of ROUND4_PROBES.entries()) {
      assertRound4Probe(compiled.ir, p, idx);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
