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
const term = (key: string, role?: string, ac = false): SupplyTerminalSpec => ({
  key,
  ...(role ? { role } : {}),
  ...(ac ? AC : {}),
});

interface RoleSpellingRow {
  readonly roleClass: string;
  readonly kind: "load" | "source";
  readonly expected: string;
  readonly snake: SupplyTerminalSpec[];
  readonly variants: Record<
    "camel" | "pascal" | "kebab" | "spaced",
    SupplyTerminalSpec[]
  >;
}

const ROLE_SPELLING_TABLE: readonly RoleSpellingRow[] = [
  {
    roleClass: "ac single-phase pair (line + input_return)",
    kind: "load",
    expected: "ac-input",
    snake: [term("L", "ac_line_input"), term("N", "ac_input_return")],
    variants: {
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
    snake: [term("L", "ac_line_input"), term("N", "ac_neutral")],
    variants: {
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
    snake: [
      term("L1", "phase_1_input"),
      term("L2", "phase_2_input"),
      term("L3", "phase_3_input"),
    ],
    variants: {
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
    snake: [
      term("U", "phase_u_input"),
      term("V", "phase_v_input"),
      term("W", "phase_w_input"),
    ],
    variants: {
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
    expected: "load",
    snake: [term("L", "ac_line_input", true), term("N", "dc_return", true)],
    variants: {
      camel: [term("L", "ac_line_input", true), term("N", "dcReturn", true)],
      pascal: [term("L", "ac_line_input", true), term("N", "DcReturn", true)],
      kebab: [term("L", "ac_line_input", true), term("N", "dc-return", true)],
      spaced: [term("L", "ac_line_input", true), term("N", "DC Return", true)],
    },
  },
  {
    roleClass: "aux veto on AC-rated load (aux_input / auxInput)",
    kind: "load",
    expected: "load",
    snake: [
      term("L", "ac_line_input", true),
      term("N", "ac_input_return", true),
      term("A", "aux_input", true),
    ],
    variants: {
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
    expected: "load",
    snake: [
      term("L", "ac_line_input", true),
      term("N", "ac_input_return", true),
      term("NC", "no_connection", true),
    ],
    variants: {
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
    expected: "source",
    snake: [term("A", "dc_positive_output"), term("B", "ac_line_input")],
    variants: {
      camel: [term("A", "dc_positive_output"), term("B", "acLineInput")],
      pascal: [term("A", "dc_positive_output"), term("B", "AcLineInput")],
      kebab: [term("A", "dc_positive_output"), term("B", "ac-line-input")],
      spaced: [term("A", "dc_positive_output"), term("B", "AC Line Input")],
    },
  },
  {
    roleClass: "phase role veto on 2-pin source (phase_1_source)",
    kind: "source",
    expected: "source",
    snake: [term("A", "dc_positive_output"), term("B", "phase_1_source")],
    variants: {
      camel: [term("A", "dc_positive_output"), term("B", "phase1Source")],
      pascal: [term("A", "dc_positive_output"), term("B", "Phase1Source")],
      kebab: [term("A", "dc_positive_output"), term("B", "phase-1-source")],
      spaced: [term("A", "dc_positive_output"), term("B", "Phase 1 Source")],
    },
  },
  {
    roleClass: "aux role veto on 2-pin source (auxiliary_potential)",
    kind: "source",
    expected: "source",
    snake: [term("A", "dc_positive_output"), term("B", "auxiliary_potential")],
    variants: {
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
    expected: "load",
    snake: [term("A", undefined, true), term("B", "protective_earth", true)],
    variants: {
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
    snake: [
      term("L", "ac_line_input"),
      term("N", "ac_input_return"),
      term("PE", "chassis_ground"),
    ],
    variants: {
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

const PEN_UNIT_CASES: ReadonlyArray<{
  readonly label: string;
  readonly kind: "load" | "source";
  readonly terminals: SupplyTerminalSpec[];
  readonly anchorKey: string;
  readonly expected: string;
}> = [
  {
    label: "ac_input_return with PE anchor",
    kind: "load",
    terminals: [
      term("L", "ac_line_input", true),
      term("N", "ac_input_return", true),
    ],
    anchorKey: "N",
    expected: "ac-input",
  },
  {
    label: "camelCase acInputReturn with PE anchor",
    kind: "load",
    terminals: [term("L", "acLineInput"), term("N", "acInputReturn")],
    anchorKey: "N",
    expected: "ac-input",
  },
  {
    label: "neutral with PE anchor",
    kind: "load",
    terminals: [term("L", "ac_line_input", true), term("N", "neutral", true)],
    anchorKey: "N",
    expected: "ac-input",
  },
  {
    label: "return with PE anchor",
    kind: "load",
    terminals: [term("L", "ac_line_input", true), term("N", "return", true)],
    anchorKey: "N",
    expected: "ac-input",
  },
  {
    label: "dc_return_output with PE anchor keeps dc-output",
    kind: "source",
    terminals: [term("+", "dc_positive_output"), term("-", "dc_return_output")],
    anchorKey: "-",
    expected: "dc-output",
  },
  {
    label: "unroled terminal with PE anchor stays earth",
    kind: "load",
    terminals: [term("L", undefined, true), term("N", undefined, true)],
    anchorKey: "N",
    expected: "load",
  },
  {
    label: "earth-set role with PE anchor stays earth",
    kind: "load",
    terminals: [term("L", undefined, true), term("N", "ProtectiveEarth", true)],
    anchorKey: "N",
    expected: "load",
  },
];

const r5Uid = (i: number) =>
  `f8000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

const ROUND5_EDGE_CASES = [
  {
    name: "aux-camel",
    kind: "load",
    terminals: {
      L: { role: "ac_line_input", ...AC },
      N: { role: "ac_input_return", ...AC },
      A: { role: "auxInput", ...AC },
    },
    expected: "load",
  },
  {
    name: "dc-camel",
    kind: "load",
    terminals: {
      L: { role: "ac_line_input", ...AC },
      N: { role: "dcReturn", ...AC },
    },
    expected: "load",
  },
  {
    name: "ac-camel-source",
    kind: "source",
    terminals: {
      A: { role: "dc_positive_output" },
      B: { role: "acLineInput" },
    },
    expected: "source",
  },
  {
    name: "pen-direct-anchor",
    kind: "load",
    terminals: {
      L: { role: "ac_line_input", ...AC },
      N: { role: "ac_input_return", ...AC },
    },
    expected: "ac-input",
  },
  {
    name: "pen-remote-anchor",
    kind: "load",
    terminals: {
      L: { role: "ac_line_input", ...AC },
      N: { role: "ac_input_return", ...AC },
    },
    expected: "ac-input",
  },
] as const;

function buildRound5EdgeProjectSpec() {
  const types = [
    ...ROUND5_EDGE_CASES.map((c) => ({
      kind: "device_type",
      id: `r5-edges:${c.name}`,
      symbol: "thermite:dc-supply",
      terminals: c.terminals,
      functions: {
        face: { kind: c.kind, terminals: Object.keys(c.terminals) },
      },
    })),
    {
      kind: "device_type",
      id: "r5-edges:bond-point",
      terminals: { PE: { role: "protective_earth" } },
      functions: { bond: { kind: "bus", terminals: ["PE"] } },
    },
  ];
  const objects: unknown[] = ROUND5_EDGE_CASES.map((c, i) => ({
    kind: "device",
    uid: r5Uid(i + 1),
    designation: `P${i + 1}`,
    type: `r5-edges:${c.name}`,
  }));
  for (const [idx, anchorOnReturn] of [true, false].entries()) {
    const serial = idx + 1;
    const returnTerminal = {
      device: `P${ROUND5_EDGE_CASES.length - 1 + idx}`,
      terminal: "N",
    };
    const peTerminal = { device: `PE${serial}`, terminal: "PE" };
    objects.push(
      {
        kind: "device",
        uid: r5Uid(10 + serial),
        designation: peTerminal.device,
        type: "r5-edges:bond-point",
      },
      {
        kind: "wire",
        uid: r5Uid(20 + serial),
        designation: `BOND${serial}`,
        endpoints: [returnTerminal, peTerminal],
      },
      {
        kind: "potential",
        uid: r5Uid(30 + serial),
        name: `PEN${serial}`,
        at: anchorOnReturn ? returnTerminal : peTerminal,
        electrical: { polarity: "protective_earth" },
      },
    );
  }
  return {
    projectName: "PS1MARK Round 5 Edge Probes",
    libraryName: "r5-edges",
    types,
    objects,
  };
}

describe("thermite:dc-supply role normalization and PEN precedence (#553 round 5)", () => {
  it.each(ROLE_SPELLING_TABLE)(
    "normalizes $roleClass identically across snake, camel, Pascal, kebab and spaced spellings",
    async (row) => {
      const { type, ps1 } = await corePsuFixture();
      const base = makeSupplyFace(type, ps1.uid, row.kind, row.snake);
      const baseline = circuitMark(base.t, base.fn);
      expect(baseline, `${row.roleClass} snake_case`).toBe(row.expected);
      for (const [style, terminals] of Object.entries(row.variants)) {
        const variant = makeSupplyFace(type, ps1.uid, row.kind, terminals);
        expect(
          circuitMark(variant.t, variant.fn),
          `${row.roleClass} ${style}`,
        ).toBe(baseline);
      }
    },
  );

  it.each(PEN_UNIT_CASES)("PEN precedence unit check: $label", async (row) => {
    const { ir, type, ps1 } = await corePsuFixture();
    const anchored = makePeAnchorIr(
      ir,
      type.id,
      ps1.uid,
      row.terminals,
      row.anchorKey,
      {
        kind: row.kind,
        potentialUid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        potentialName: "PEN",
        netId: "net:pen",
      },
    );
    expect(
      circuitMark(anchored.t, anchored.fn, { ir: anchored.ir }),
      row.label,
    ).toBe(row.expected);
  });

  it("renders round-5 camelCase and PEN edge probes identically in both flows", async () => {
    const { dir, ir } = await compileTempSupplyProject(
      "thermite-ps1mark-r5-",
      buildRound5EdgeProjectSpec(),
    );
    try {
      for (const flow of ["left-to-right", "top-to-bottom"] as const) {
        const doc = await renderCircuitGroupsHtml(
          ir,
          `PS1MARK round-5 edges (${flow})`,
          flow,
          ROUND5_EDGE_CASES.map((c, i) => ({
            id: c.name,
            label: c.name,
            deviceUid: r5Uid(i + 1),
            key: "face",
          })),
        );
        for (const c of ROUND5_EDGE_CASES) {
          const group = doc.querySelector(
            `[data-circuit-group="${c.name}"] [data-function-key="face"]`,
          );
          const marks = [...group!.querySelectorAll("[data-circuit-mark]")].map(
            (el) => el.getAttribute("data-circuit-mark"),
          );
          expect(marks, `${flow} ${c.name}`).toEqual([c.expected]);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
