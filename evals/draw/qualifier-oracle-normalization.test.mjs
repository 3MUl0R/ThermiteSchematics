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
const term = (key, role, ac = false) => ({
  key,
  ...(role ? { role } : {}),
  ...(ac ? AC : {}),
});

const ROLE_SPELLING_TABLE = [
  {
    roleClass: "ac single-phase pair (line + input_return)",
    kind: "load",
    expected: "ac-input",
    styles: {
      snake_case: [term("L", "ac_line_input"), term("N", "ac_input_return")],
      camel: [term("L", "acLineInput"), term("N", "acInputReturn")],
      pascal: [term("L", "AcLineInput"), term("N", "AcInputReturn")],
      kebab: [term("L", "ac-line-input"), term("N", "ac-input-return")],
      spaced: [term("L", "AC Line Input"), term("N", "AC Input Return")],
    },
  },
  {
    roleClass: "ac single-phase pair (line + ac_neutral)",
    kind: "load",
    expected: "ac-input",
    styles: {
      snake_case: [term("L", "ac_line_input"), term("N", "ac_neutral")],
      camel: [term("L", "acLineInput"), term("N", "acNeutral")],
      pascal: [term("L", "AcLineInput"), term("N", "AcNeutral")],
      kebab: [term("L", "ac-line-input"), term("N", "ac-neutral")],
      spaced: [term("L", "AC Line Input"), term("N", "AC Neutral")],
    },
  },
  {
    roleClass: "three-phase numeric input (phase_1/2/3_input)",
    kind: "load",
    expected: "ac-input",
    styles: {
      snake_case: [
        term("L1", "phase_1_input"),
        term("L2", "phase_2_input"),
        term("L3", "phase_3_input"),
      ],
      camel: [
        term("L1", "phase1Input"),
        term("L2", "phase2Input"),
        term("L3", "phase3Input"),
      ],
      pascal: [
        term("L1", "Phase1Input"),
        term("L2", "Phase2Input"),
        term("L3", "Phase3Input"),
      ],
      kebab: [
        term("L1", "phase-1-input"),
        term("L2", "phase-2-input"),
        term("L3", "phase-3-input"),
      ],
      spaced: [
        term("L1", "Phase 1 Input"),
        term("L2", "Phase 2 Input"),
        term("L3", "Phase 3 Input"),
      ],
    },
  },
  {
    roleClass: "three-phase u/v/w input (phase_u/v/w_input)",
    kind: "load",
    expected: "ac-input",
    styles: {
      snake_case: [
        term("U", "phase_u_input"),
        term("V", "phase_v_input"),
        term("W", "phase_w_input"),
      ],
      camel: [
        term("U", "phaseUInput"),
        term("V", "phaseVInput"),
        term("W", "phaseWInput"),
      ],
      pascal: [
        term("U", "PhaseUInput"),
        term("V", "PhaseVInput"),
        term("W", "PhaseWInput"),
      ],
      kebab: [
        term("U", "phase-u-input"),
        term("V", "phase-v-input"),
        term("W", "phase-w-input"),
      ],
      spaced: [
        term("U", "Phase U Input"),
        term("V", "Phase V Input"),
        term("W", "Phase W Input"),
      ],
    },
  },
  {
    roleClass: "dc veto on AC-rated load (dc_return / dcReturn)",
    kind: "load",
    expected: null,
    styles: {
      snake_case: [
        term("L", "ac_line_input", true),
        term("N", "dc_return", true),
      ],
      camel: [term("L", "ac_line_input", true), term("N", "dcReturn", true)],
      pascal: [term("L", "ac_line_input", true), term("N", "DcReturn", true)],
      kebab: [term("L", "ac_line_input", true), term("N", "dc-return", true)],
      spaced: [term("L", "ac_line_input", true), term("N", "DC Return", true)],
    },
  },
  {
    roleClass: "aux veto on AC-rated load (aux_input / auxInput)",
    kind: "load",
    expected: null,
    styles: {
      snake_case: [
        term("L", "ac_line_input", true),
        term("N", "ac_input_return", true),
        term("A", "aux_input", true),
      ],
      camel: [
        term("L", "ac_line_input", true),
        term("N", "ac_input_return", true),
        term("A", "auxInput", true),
      ],
      pascal: [
        term("L", "ac_line_input", true),
        term("N", "ac_input_return", true),
        term("A", "AuxInput", true),
      ],
      kebab: [
        term("L", "ac_line_input", true),
        term("N", "ac_input_return", true),
        term("A", "aux-input", true),
      ],
      spaced: [
        term("L", "ac_line_input", true),
        term("N", "ac_input_return", true),
        term("A", "Aux Input", true),
      ],
    },
  },
  {
    roleClass: "non-power no_connection veto on AC-rated load",
    kind: "load",
    expected: null,
    styles: {
      snake_case: [
        term("L", "ac_line_input", true),
        term("N", "ac_input_return", true),
        term("NC", "no_connection", true),
      ],
      camel: [
        term("L", "ac_line_input", true),
        term("N", "ac_input_return", true),
        term("NC", "noConnection", true),
      ],
      pascal: [
        term("L", "ac_line_input", true),
        term("N", "ac_input_return", true),
        term("NC", "NoConnection", true),
      ],
      kebab: [
        term("L", "ac_line_input", true),
        term("N", "ac_input_return", true),
        term("NC", "no-connection", true),
      ],
      spaced: [
        term("L", "ac_line_input", true),
        term("N", "ac_input_return", true),
        term("NC", "No Connection", true),
      ],
    },
  },
  {
    roleClass: "ac role veto on 2-pin source (ac_line_input / acLineInput)",
    kind: "source",
    expected: null,
    styles: {
      snake_case: [term("A", "dc_positive_output"), term("B", "ac_line_input")],
      camel: [term("A", "dc_positive_output"), term("B", "acLineInput")],
      pascal: [term("A", "dc_positive_output"), term("B", "AcLineInput")],
      kebab: [term("A", "dc_positive_output"), term("B", "ac-line-input")],
      spaced: [term("A", "dc_positive_output"), term("B", "AC Line Input")],
    },
  },
  {
    roleClass: "phase role veto on 2-pin source (phase_1_source)",
    kind: "source",
    expected: null,
    styles: {
      snake_case: [
        term("A", "dc_positive_output"),
        term("B", "phase_1_source"),
      ],
      camel: [term("A", "dc_positive_output"), term("B", "phase1Source")],
      pascal: [term("A", "dc_positive_output"), term("B", "Phase1Source")],
      kebab: [term("A", "dc_positive_output"), term("B", "phase-1-source")],
      spaced: [term("A", "dc_positive_output"), term("B", "Phase 1 Source")],
    },
  },
  {
    roleClass: "aux role veto on 2-pin source (auxiliary_potential)",
    kind: "source",
    expected: null,
    styles: {
      snake_case: [
        term("A", "dc_positive_output"),
        term("B", "auxiliary_potential"),
      ],
      camel: [term("A", "dc_positive_output"), term("B", "auxiliaryPotential")],
      pascal: [
        term("A", "dc_positive_output"),
        term("B", "AuxiliaryPotential"),
      ],
      kebab: [
        term("A", "dc_positive_output"),
        term("B", "auxiliary-potential"),
      ],
      spaced: [
        term("A", "dc_positive_output"),
        term("B", "Auxiliary Potential"),
      ],
    },
  },
  {
    roleClass: "earth exclusion on 2-pin AC-rated load (protective_earth)",
    kind: "load",
    expected: null,
    styles: {
      snake_case: [
        term("A", undefined, true),
        term("B", "protective_earth", true),
      ],
      camel: [term("A", undefined, true), term("B", "protectiveEarth", true)],
      pascal: [term("A", undefined, true), term("B", "ProtectiveEarth", true)],
      kebab: [term("A", undefined, true), term("B", "protective-earth", true)],
      spaced: [term("A", undefined, true), term("B", "Protective Earth", true)],
    },
  },
  {
    roleClass: "earth skip on 3-pin AC load (chassis_ground)",
    kind: "load",
    expected: "ac-input",
    styles: {
      snake_case: [
        term("L", "ac_line_input"),
        term("N", "ac_input_return"),
        term("PE", "chassis_ground"),
      ],
      camel: [
        term("L", "acLineInput"),
        term("N", "acInputReturn"),
        term("PE", "chassisGround"),
      ],
      pascal: [
        term("L", "AcLineInput"),
        term("N", "AcInputReturn"),
        term("PE", "ChassisGround"),
      ],
      kebab: [
        term("L", "ac-line-input"),
        term("N", "ac-input-return"),
        term("PE", "chassis-ground"),
      ],
      spaced: [
        term("L", "AC Line Input"),
        term("N", "AC Input Return"),
        term("PE", "Chassis Ground"),
      ],
    },
  },
];

const PEN_UNIT_CASES = [
  {
    label: "ac_input_return",
    functionKind: "load",
    inputTerminals: [
      term("L", "ac_line_input", true),
      term("N", "ac_input_return", true),
    ],
    anchorKey: "N",
    renderedMarks: ["ac-input"],
    expectedEligible: 1,
  },
  {
    label: "camelCase acInputReturn",
    functionKind: "load",
    inputTerminals: [term("L", "acLineInput"), term("N", "acInputReturn")],
    anchorKey: "N",
    renderedMarks: ["ac-input"],
    expectedEligible: 1,
  },
  {
    label: "neutral",
    functionKind: "load",
    inputTerminals: [
      term("L", "ac_line_input", true),
      term("N", "neutral", true),
    ],
    anchorKey: "N",
    renderedMarks: ["ac-input"],
    expectedEligible: 1,
  },
  {
    label: "return",
    functionKind: "load",
    inputTerminals: [
      term("L", "ac_line_input", true),
      term("N", "return", true),
    ],
    anchorKey: "N",
    renderedMarks: ["ac-input"],
    expectedEligible: 1,
  },
  {
    label: "dc_return_output with PE anchor keeps dc-output",
    functionKind: "source",
    inputTerminals: [
      term("+", "dc_positive_output"),
      term("-", "dc_return_output"),
    ],
    anchorKey: "-",
    renderedMarks: ["dc-output"],
    expectedEligible: 1,
  },
  {
    label: "unroled",
    functionKind: "load",
    inputTerminals: [term("L", undefined, true), term("N", undefined, true)],
    anchorKey: "N",
    renderedMarks: ["ac-input"],
    expectedEligible: 0,
  },
  {
    label: "earth-set role",
    functionKind: "load",
    inputTerminals: [
      term("L", undefined, true),
      term("N", "ProtectiveEarth", true),
    ],
    anchorKey: "N",
    renderedMarks: ["ac-input"],
    expectedEligible: 0,
  },
];

const penUid = (i) => `f9000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const PEN_LINE = { role: "ac_line_input", ...AC };
const PEN_RET = { role: "ac_input_return", ...AC };

const PEN_PROJECT_SPEC = {
  projectName: "Oracle Round 5 PEN Probes",
  libraryName: "r5-pen",
  types: [
    {
      kind: "device_type",
      id: "r5-pen:pen-direct-anchor",
      symbol: "thermite:dc-supply",
      terminals: { L: PEN_LINE, N: PEN_RET },
      functions: { face: { kind: "load", terminals: ["L", "N"] } },
    },
    {
      kind: "device_type",
      id: "r5-pen:pen-remote-anchor",
      symbol: "thermite:dc-supply",
      terminals: { L: PEN_LINE, N: PEN_RET },
      functions: { face: { kind: "load", terminals: ["L", "N"] } },
    },
    {
      kind: "device_type",
      id: "r5-pen:bond-point",
      terminals: { PE: { role: "protective_earth" } },
      functions: { bond: { kind: "bus", terminals: ["PE"] } },
    },
  ],
  objects: [
    {
      kind: "device",
      uid: penUid(1),
      designation: "P1",
      type: "r5-pen:pen-direct-anchor",
    },
    {
      kind: "device",
      uid: penUid(2),
      designation: "P2",
      type: "r5-pen:pen-remote-anchor",
    },
    {
      kind: "device",
      uid: penUid(11),
      designation: "PE1",
      type: "r5-pen:bond-point",
    },
    {
      kind: "device",
      uid: penUid(12),
      designation: "PE2",
      type: "r5-pen:bond-point",
    },
    {
      kind: "wire",
      uid: penUid(21),
      designation: "BOND1",
      endpoints: [
        { device: "P1", terminal: "N" },
        { device: "PE1", terminal: "PE" },
      ],
    },
    {
      kind: "wire",
      uid: penUid(22),
      designation: "BOND2",
      endpoints: [
        { device: "P2", terminal: "N" },
        { device: "PE2", terminal: "PE" },
      ],
    },
    {
      kind: "potential",
      uid: penUid(31),
      name: "PEN1",
      at: { device: "P1", terminal: "N" },
      electrical: { polarity: "protective_earth" },
    },
    {
      kind: "potential",
      uid: penUid(32),
      name: "PEN2",
      at: { device: "PE2", terminal: "PE" },
      electrical: { polarity: "protective_earth" },
    },
  ],
};

function assertRoleSpelling(functionKind, inputTerminals, expectedMark, label) {
  const base = {
    functionKey: "face",
    functionKind,
    inputTerminals,
    extraTerminals: [],
  };
  if (expectedMark) {
    const pass = psuCase({ ...base, renderedMarks: [expectedMark] });
    expect(
      conversionQualifierAudit(pass.g, pass.ir, pass.sheet),
      label,
    ).toEqual({
      findings: [],
      eligible: 1,
    });
    return;
  }
  const unmarked = psuCase({ ...base, renderedMarks: [] });
  expect(
    conversionQualifierAudit(unmarked.g, unmarked.ir, unmarked.sheet),
    `${label} unmarked`,
  ).toEqual({ findings: [], eligible: 0 });
  const spuriousMark = functionKind === "source" ? "dc-output" : "ac-input";
  const spurious = psuCase({ ...base, renderedMarks: [spuriousMark] });
  expectUnowned(
    conversionQualifierAudit(spurious.g, spurious.ir, spurious.sheet),
    `${label} spurious`,
  );
}

it.each(ROLE_SPELLING_TABLE)(
  "DQ-10 5.42 (#553 round 5): normalizes $roleClass identically across snake, camel, Pascal, kebab and spaced spellings",
  (row) => {
    for (const [style, terminals] of Object.entries(row.styles)) {
      assertRoleSpelling(
        row.kind,
        terminals,
        row.expected,
        `${row.roleClass} ${style}`,
      );
    }
  },
);

it.each(PEN_UNIT_CASES)(
  "DQ-10 5.42 (#553 round 5): PEN anchor precedence ($label)",
  (row) => {
    const c = psuCase({
      functionKey: "face",
      functionKind: row.functionKind,
      inputTerminals: row.inputTerminals,
      extraTerminals: [],
      renderedMarks: row.renderedMarks,
    });
    c.ir.potentials = [pePotential("p-pen", "PEN", row.anchorKey, "net:pen")];
    const audit = conversionQualifierAudit(c.g, c.ir, c.sheet);
    if (row.expectedEligible === 1) {
      expect(audit, row.label).toEqual({ findings: [], eligible: 1 });
    } else {
      expectUnowned(audit, row.label);
    }
  },
);

it("DQ-10 5.42 (#553 round 5): compiled PEN direct and remote anchors keep ac-input", async () => {
  const { dir, compiled } = await compileOracleTempProject(
    "thermite-oracle-r5-",
    PEN_PROJECT_SPEC,
  );
  try {
    for (const [idx, label] of [
      [1, "pen-direct-anchor"],
      [2, "pen-remote-anchor"],
    ]) {
      const deviceUid = penUid(idx);
      const fn = compiled.ir.functions.find(
        (f) => f.id.deviceUid === deviceUid && f.id.functionKey === "face",
      );
      const sheet = {
        view: { kind: "circuit" },
        references: [{ deviceUid, functions: ["face"] }],
      };
      expect(
        conversionQualifierAudit(
          makeProbeGeometry(deviceUid, fn, "ac-input"),
          compiled.ir,
          sheet,
        ),
        label,
      ).toEqual({ findings: [], eligible: 1 });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
