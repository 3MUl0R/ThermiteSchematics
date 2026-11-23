import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { prepareCircuitView } from "../src/circuit.js";
import { circuitMark } from "../src/symbols/circuit.js";
import { printableTextMetrics } from "../src/text-metrics.js";
import { paintedShape } from "./circuit-fidelity-oracle.js";
import {
  cloneSupplyWithTerminalEdits,
  corePsuFixture,
  makeSupplyFace,
  renderCircuitGroupsHtml,
  type SupplyTerminalSpec,
} from "./dc-supply-mark-helpers.js";

const AC = { rating: { voltage_type: "AC" as const } };

const REVIEW_EARTH_ROLES = [
  "protective_earth",
  "pe",
  "PE",
  "pE",
  "functional_earth",
  "fe",
  "earth",
  "chassis_ground",
  "chassis-earth",
] as const;

const REVIEW_RATING_CASES: ReadonlyArray<{
  readonly label: string;
  readonly symbol: "thermite:dc-supply" | "iec:dc-power-supply";
  readonly terminals: SupplyTerminalSpec[];
  readonly expected: "load" | "ac-input";
}> = [
  {
    label: "one AC-rated phase input + two unspecified pins",
    symbol: "thermite:dc-supply",
    terminals: [
      { key: "1", role: "phase_1_input", ...AC },
      { key: "2" },
      { key: "3" },
    ],
    expected: "load",
  },
  {
    label: "partial 2-terminal rating",
    symbol: "thermite:dc-supply",
    terminals: [{ key: "1", ...AC }, { key: "2" }],
    expected: "load",
  },
  {
    label: "partial 3-terminal rating without earth role",
    symbol: "thermite:dc-supply",
    terminals: [{ key: "1", ...AC }, { key: "2", ...AC }, { key: "3" }],
    expected: "load",
  },
  {
    label: "one AC-rated line + AC-rated PE",
    symbol: "thermite:dc-supply",
    terminals: [
      { key: "1", ...AC },
      { key: "2", role: "protective_earth", ...AC },
    ],
    expected: "load",
  },
  {
    label: "one AC-rated line + two AC-rated earth terminals",
    symbol: "thermite:dc-supply",
    terminals: [
      { key: "1", ...AC },
      { key: "2", role: "protective_earth", ...AC },
      { key: "3", role: "functional_earth", ...AC },
    ],
    expected: "load",
  },
  {
    label: "AC-rated line + AC-rated aux",
    symbol: "thermite:dc-supply",
    terminals: [
      { key: "1", role: "ac_line_input", ...AC },
      { key: "2", role: "aux", ...AC },
    ],
    expected: "load",
  },
  {
    label: "two AC-rated pins + AC-rated auxiliary",
    symbol: "thermite:dc-supply",
    terminals: [
      { key: "1", ...AC },
      { key: "2", ...AC },
      { key: "3", role: "auxiliary", ...AC },
    ],
    expected: "load",
  },
  {
    label: "AC-rated pin + AC-rated shield",
    symbol: "thermite:dc-supply",
    terminals: [
      { key: "1", ...AC },
      { key: "2", role: "shield", ...AC },
    ],
    expected: "load",
  },
  {
    label: "two AC-rated inputs + unrated PE",
    symbol: "iec:dc-power-supply",
    terminals: [
      { key: "1", ...AC },
      { key: "2", ...AC },
      { key: "3", role: "protective_earth" },
    ],
    expected: "ac-input",
  },
  {
    label: "two AC-rated inputs + AC-rated PE",
    symbol: "iec:dc-power-supply",
    terminals: [
      { key: "1", ...AC },
      { key: "2", ...AC },
      { key: "3", role: "pe", ...AC },
    ],
    expected: "ac-input",
  },
];

const UNROLED_DESCRIPTION = "480 VAC to 24 VDC power supply";

const NATIVE_FACT_CASES: ReadonlyArray<{
  readonly label: string;
  readonly description?: string;
  readonly terminals: SupplyTerminalSpec[];
  readonly circuitSymbols?: Record<string, string>;
  readonly expected: "load" | "ac-input";
}> = [
  {
    label: "names/keys/description alone never establish AC",
    description: UNROLED_DESCRIPTION,
    terminals: [{ key: "L" }, { key: "N" }],
    expected: "load",
  },
  {
    label: "DC-DC converter input roles stay unqualified",
    description: UNROLED_DESCRIPTION,
    terminals: [
      { key: "L", role: "dc_positive_input" },
      { key: "N", role: "dc_return_input" },
    ],
    expected: "load",
  },
  {
    label: "DC-DC converter input ratings stay unqualified",
    description: UNROLED_DESCRIPTION,
    terminals: [
      { key: "L", rating: { voltage_type: "DC", nominal_voltage: 48 } },
      { key: "N", rating: { voltage_type: "DC", nominal_voltage: 48 } },
    ],
    expected: "load",
  },
  {
    label: "partial AC roles do not establish AC",
    terminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "unknown" },
    ],
    expected: "load",
  },
  {
    label: "contradictory AC roles + DC rating do not establish AC",
    terminals: [
      {
        key: "L",
        role: "ac_line_input",
        rating: { voltage_type: "DC", nominal_voltage: 24 },
      },
      { key: "N", role: "ac_input_return" },
    ],
    expected: "load",
  },
  {
    label: "explicit AC rating establishes ac-input",
    description: UNROLED_DESCRIPTION,
    terminals: [
      { key: "L", rating: { voltage_type: "AC", nominal_voltage: 120 } },
      { key: "N", rating: { voltage_type: "AC", nominal_voltage: 120 } },
    ],
    expected: "ac-input",
  },
  {
    label: "line-to-line AC roles establish ac-input",
    description: UNROLED_DESCRIPTION,
    terminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_line_input" },
    ],
    expected: "ac-input",
  },
  {
    label: "explicit circuitSymbols load overrides native AC roles",
    terminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
    ],
    circuitSymbols: { ac_input: "load" },
    expected: "load",
  },
  {
    label: "explicit circuitSymbols ac-input overrides unroled terminals",
    description: UNROLED_DESCRIPTION,
    terminals: [{ key: "L" }, { key: "N" }],
    circuitSymbols: { ac_input: "ac-input" },
    expected: "ac-input",
  },
];

describe("thermite:dc-supply circuit mark selection (#553)", () => {
  it("marks stock core:psu-24vdc AC input as ac-input and keeps DC output as dc-output", async () => {
    const { type, acInput, dcOutput } = await corePsuFixture();
    type.symbol = "thermite:dc-supply";
    delete type.circuitSymbols;

    expect(circuitMark(type, acInput)).toBe("ac-input");
    expect(circuitMark(type, dcOutput)).toBe("dc-output");
  });

  it.each(["left-to-right", "top-to-bottom"] as const)(
    "renders upright ac-input on PS1 L/N face and upright dc-output on +/- face in %s",
    async (flow) => {
      const { ir, ps1, type } = await corePsuFixture();
      type.symbol = "thermite:dc-supply";
      delete type.circuitSymbols;

      const doc = await renderCircuitGroupsHtml(
        ir,
        "PS1 AC input and DC output",
        flow,
        [
          {
            id: "ps1-ac",
            label: "PS1 AC input",
            deviceUid: ps1.uid,
            key: "ac_input",
          },
          {
            id: "ps1-dc",
            label: "PS1 DC output",
            deviceUid: ps1.uid,
            key: "dc_output",
          },
        ],
      );

      const acGroup = doc.querySelector(
        '[data-circuit-group="ps1-ac"] [data-function-key="ac_input"]',
      )!;
      expect(
        acGroup.querySelector('[data-circuit-mark="ac-input"]'),
      ).not.toBeNull();
      expect(
        acGroup.querySelector('[data-circuit-mark="dc-output"]'),
      ).toBeNull();
      expect(
        acGroup.querySelectorAll('[data-function-interface="ac-input"] line'),
      ).toHaveLength(2);
      const acOwner = acGroup.closest("[data-device-uid]")!;
      const wave = paintedShape(
        acOwner,
        acGroup.querySelector('[data-circuit-mark="ac-input"] polyline')!,
      ).points;
      expect(wave[0]!.y).toBeCloseTo(wave.at(-1)!.y, 3);
      expect(Math.abs(wave.at(-1)!.x - wave[0]!.x)).toBeGreaterThan(5);

      const dcGroup = doc.querySelector(
        '[data-circuit-group="ps1-dc"] [data-function-key="dc_output"]',
      )!;
      expect(
        dcGroup.querySelector('[data-circuit-mark="dc-output"]'),
      ).not.toBeNull();
      expect(
        dcGroup.querySelector('[data-circuit-mark="ac-input"]'),
      ).toBeNull();
      const dcOwner = dcGroup.closest("[data-device-uid]")!;
      const dcLines = [
        ...dcGroup.querySelectorAll('[data-circuit-mark="dc-output"] line'),
      ].map((e) => paintedShape(dcOwner, e).points);
      expect(dcLines).toHaveLength(4);
      for (const [a, b] of dcLines) expect(a!.y).toBeCloseTo(b!.y, 3);
    },
  );

  it("leaves a dc-supply load unqualified when native port facts do not establish AC", async () => {
    const { type, acInput } = await corePsuFixture();
    for (const row of NATIVE_FACT_CASES) {
      const t = cloneSupplyWithTerminalEdits(type, row.terminals, {
        description: row.description,
        circuitSymbols: row.circuitSymbols,
      });
      expect(circuitMark(t, acInput), row.label).toBe(row.expected);
    }
  });

  it("handles 3-port dc-supply loads and AC-declared dc-supply sources honestly", async () => {
    const { type, ps1, dcOutput } = await corePsuFixture();
    type.symbol = "thermite:dc-supply";
    delete type.circuitSymbols;

    const threePort = structuredClone(type);
    threePort.terminals.push({ key: "L1" }, { key: "L2" }, { key: "L3" });
    const load3 = {
      id: { deviceUid: ps1.uid, functionKey: "ac_in_3p" },
      kind: "load" as const,
      terminals: ["L1", "L2", "L3"].map((terminalKey) => ({
        deviceUid: ps1.uid,
        terminalKey,
      })),
    };
    expect(circuitMark(threePort, load3)).toBe("load");

    threePort.terminals.find((t) => t.key === "L1")!.role = "phase_1_input";
    threePort.terminals.find((t) => t.key === "L2")!.role = "phase_2_input";
    threePort.terminals.find((t) => t.key === "L3")!.role = "phase_3_input";
    expect(circuitMark(threePort, load3)).toBe("ac-input");

    const sourceCases: ReadonlyArray<
      [string, SupplyTerminalSpec[], "dc-output" | "source"]
    > = [
      ["unroled 2-port source", [{ key: "+" }, { key: "-" }], "dc-output"],
      [
        "AC-rated 2-port source",
        [
          { key: "+", rating: { voltage_type: "AC", nominal_voltage: 24 } },
          { key: "-" },
        ],
        "source",
      ],
      [
        "PE 2-port source",
        [
          { key: "+", role: "dc_positive_output" },
          { key: "-", role: "protective_earth" },
        ],
        "source",
      ],
      [
        "aux 2-port source",
        [
          { key: "+", role: "aux" },
          { key: "-", role: "aux" },
        ],
        "source",
      ],
    ];
    for (const [label, terminals, expected] of sourceCases) {
      const copy = cloneSupplyWithTerminalEdits(type, terminals);
      expect(circuitMark(copy, dcOutput), label).toBe(expected);
    }
  });

  it("never derives AC input from earth/ground, auxiliary, or partial terminal ratings (#553 review)", async () => {
    const { ir, type, ps1, acInput } = await corePsuFixture();
    delete type.circuitSymbols;

    for (const earthRole of REVIEW_EARTH_ROLES) {
      const { t, fn } = makeSupplyFace(
        type,
        ps1.uid,
        "load",
        [{ key: "1" }, { key: "2" }, { key: "3", role: earthRole, ...AC }],
        { symbol: "iec:dc-power-supply" },
      );
      expect(circuitMark(t, fn), earthRole).toBe("load");
    }

    for (const row of REVIEW_RATING_CASES) {
      const { t, fn } = makeSupplyFace(type, ps1.uid, "load", row.terminals, {
        symbol: row.symbol,
      });
      expect(circuitMark(t, fn), row.label).toBe(row.expected);
    }

    const probeIr = structuredClone(ir);
    const probeType = probeIr.deviceTypes.find((t) => t.id === type.id)!;
    probeType.symbol = "iec:dc-power-supply";
    delete probeType.circuitSymbols;
    probeType.terminals = [
      { key: "1" },
      { key: "2" },
      { key: "3", role: "protective_earth", ...AC },
    ];
    const probeFn = probeIr.functions.find(
      (f) =>
        f.id.deviceUid === ps1.uid &&
        f.id.functionKey === acInput.id.functionKey,
    )!;
    probeFn.terminals = ["1", "2", "3"].map((terminalKey) => ({
      deviceUid: ps1.uid,
      terminalKey,
    }));
    for (const flow of ["left-to-right", "top-to-bottom"] as const) {
      const doc = await renderCircuitGroupsHtml(
        probeIr,
        "Rated-earth probe",
        flow,
        [
          {
            id: "rated-earth",
            label: "Rated earth",
            deviceUid: ps1.uid,
            key: "ac_input",
          },
        ],
      );
      expect(doc.querySelector('[data-circuit-mark="ac-input"]')).toBeNull();
      expect(doc.querySelector('[data-circuit-mark="load"]')).not.toBeNull();
    }
  });

  it("keeps wrapped related-function footer lines in top-to-bottom reading order inside framed LTR blocks", async () => {
    const { ir, ps1, type } = await corePsuFixture();
    type.symbol = "thermite:dc-supply";
    delete type.circuitSymbols;

    const appearances = new Map<string, string[]>([
      [
        JSON.stringify([ps1.uid, "dc_output"]),
        [
          "PS1 DC output and PLC supply",
          "Start NO pushbutton input",
          "Stop NC pushbutton input",
          "Discharge PNP sensor via CBL1, JB1 and TB1",
          "PLC DO0 through OL1 NC to K1 coil",
          "PLC DO1 status indicator",
        ],
      ],
    ]);

    const view = await prepareCircuitView(
      ir,
      {
        format: "circuit-view-request/0.1",
        title: "PS1 input feed",
        flow: "left-to-right",
        groups: [
          {
            id: "ps1-ac",
            label: "PS1 AC input",
            functions: [
              { device: { by: "uid", value: ps1.uid }, key: "ac_input" },
            ],
            conductors: [],
          },
        ],
      },
      appearances,
    );

    const doc = parseHTML(`<svg>${view.groups[0]!.content}</svg>`).document;
    const body = doc.querySelector(
      `[data-device-uid="${ps1.uid}"] [data-layout-height]`,
    )!;
    const height = Number(body.getAttribute("data-layout-height"));
    const footerTexts = [...body.children]
      .filter((el) => el.tagName.toLowerCase() === "text")
      .map((el) => ({
        text: el.textContent ?? "",
        y: Number(el.getAttribute("y")),
      }));

    expect(footerTexts.length).toBeGreaterThanOrEqual(3);
    expect(footerTexts[0]!.text).toMatch(/^\+ \/ -:/u);
    for (let i = 1; i < footerTexts.length; i++) {
      expect(footerTexts[i]!.y).toBeGreaterThan(footerTexts[i - 1]!.y);
    }
    const last = footerTexts.at(-1)!;
    const m = printableTextMetrics(last.text, 2.5);
    expect(last.y - m.bottom).toBeLessThanOrEqual(height - 1.2);
  });
});
