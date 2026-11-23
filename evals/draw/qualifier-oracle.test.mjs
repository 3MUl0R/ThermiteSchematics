import { expect, it } from "vitest";
import { conversionQualifierAudit } from "./qualifier-oracle.mjs";
import { expectUnowned, kinds, psuCase } from "./qualifier-oracle-fixtures.mjs";

it.each(["thermite:dc-supply", "iec:dc-power-supply"])(
  "DQ-10 5.42: stock PSU (%s) with native AC roles and upright ac-input mark passes",
  (symbol) => {
    const { g, ir, sheet } = psuCase({ symbol, renderedMarks: ["ac-input"] });
    const audit = conversionQualifierAudit(g, ir, sheet);
    expect(audit.findings).toEqual([]);
    expect(audit.eligible).toBe(1);
  },
);

it.each([
  [
    "ac_line_input + ac_neutral",
    [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_neutral" },
    ],
  ],
  [
    "line-to-line ac_line_input",
    [
      { key: "L1", role: "ac_line_input" },
      { key: "L2", role: "ac_line_input" },
    ],
  ],
  [
    "AC voltage_type rating without roles",
    [
      { key: "1", rating: { voltage_type: "AC", nominal_voltage: 120 } },
      { key: "2", rating: { voltage_type: "AC", nominal_voltage: 120 } },
    ],
  ],
])(
  "DQ-10 5.42: 2-terminal dc-supply load with %s passes with ac-input mark",
  (_label, inputTerminals) => {
    const { g, ir, sheet } = psuCase({
      inputTerminals,
      renderedMarks: ["ac-input"],
    });
    const audit = conversionQualifierAudit(g, ir, sheet);
    expect(audit.findings).toEqual([]);
    expect(audit.eligible).toBe(1);
  },
);

it("DQ-10 5.42: stock PSU with dc-output mark on its AC-input face still fails as unowned", () => {
  const { g, ir, sheet } = psuCase({ renderedMarks: ["dc-output"] });
  const audit = conversionQualifierAudit(g, ir, sheet);
  expect(kinds(audit)).toContain(
    "conversion-qualifier-native-owner-unavailable",
  );
  expect(kinds(audit)).toContain("conversion-qualifier-geometry-unavailable");

  const both = psuCase({ renderedMarks: ["ac-input", "dc-output"] });
  expect(
    kinds(conversionQualifierAudit(both.g, both.ir, both.sheet)),
  ).toContain("conversion-qualifier-native-owner-unavailable");
});

it("DQ-10 5.42: load with no AC facts and an ac-input mark fails as unowned", () => {
  const { g, ir, sheet } = psuCase({
    inputTerminals: [{ key: "L" }, { key: "N" }],
    description: "480 VAC to 24 VDC power supply",
    renderedMarks: ["ac-input"],
  });
  expectUnowned(conversionQualifierAudit(g, ir, sheet));

  const partial = psuCase({
    inputTerminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "unknown" },
    ],
    renderedMarks: ["ac-input"],
  });
  expect(
    kinds(conversionQualifierAudit(partial.g, partial.ir, partial.sheet)),
  ).toEqual(["conversion-qualifier-native-owner-unavailable"]);

  const unmarked = psuCase({
    inputTerminals: [{ key: "L" }, { key: "N" }],
    renderedMarks: [],
  });
  expect(
    conversionQualifierAudit(unmarked.g, unmarked.ir, unmarked.sheet),
  ).toEqual({ findings: [], eligible: 0 });
});

it.each([
  [
    "AC roles + conflicting DC rating",
    [
      {
        key: "L",
        role: "ac_line_input",
        rating: { voltage_type: "DC", nominal_voltage: 24 },
      },
      { key: "N", role: "ac_input_return" },
    ],
  ],
  [
    "AC rating + conflicting DC rating",
    [
      { key: "L", rating: { voltage_type: "AC", nominal_voltage: 120 } },
      { key: "N", rating: { voltage_type: "DC", nominal_voltage: 24 } },
    ],
  ],
  [
    "AC rating + conflicting DC role",
    [
      {
        key: "L",
        role: "dc_positive_input",
        rating: { voltage_type: "AC", nominal_voltage: 120 },
      },
      {
        key: "N",
        role: "dc_return_input",
        rating: { voltage_type: "AC", nominal_voltage: 120 },
      },
    ],
  ],
])("DQ-10 5.42: %s suppresses AC expectation", (_label, inputTerminals) => {
  const unmarked = psuCase({ inputTerminals, renderedMarks: [] });
  expect(
    conversionQualifierAudit(unmarked.g, unmarked.ir, unmarked.sheet),
  ).toEqual({ findings: [], eligible: 0 });

  const marked = psuCase({ inputTerminals, renderedMarks: ["ac-input"] });
  expectUnowned(conversionQualifierAudit(marked.g, marked.ir, marked.sheet));
});

it.each([
  [
    "phase_1/2/3_input",
    [
      { key: "L1", role: "phase_1_input" },
      { key: "L2", role: "phase_2_input" },
      { key: "L3", role: "phase_3_input" },
    ],
  ],
  [
    "phase_u/v/w_input",
    [
      { key: "U", role: "phase_u_input" },
      { key: "V", role: "phase_v_input" },
      { key: "W", role: "phase_w_input" },
    ],
  ],
  [
    "ac_line_input + ac_neutral + protective_earth",
    [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_neutral" },
      { key: "PE", role: "protective_earth" },
    ],
  ],
  [
    "3-terminal AC rating",
    [
      { key: "L1", rating: { voltage_type: "AC", nominal_voltage: 480 } },
      { key: "L2", rating: { voltage_type: "AC", nominal_voltage: 480 } },
      { key: "L3", rating: { voltage_type: "AC", nominal_voltage: 480 } },
    ],
  ],
])(
  "DQ-10 5.42: 3-terminal dc-supply AC input (%s) passes with ac-input mark",
  (_label, inputTerminals) => {
    const { g, ir, sheet } = psuCase({
      inputTerminals,
      renderedMarks: ["ac-input"],
    });
    const audit = conversionQualifierAudit(g, ir, sheet);
    expect(audit.findings).toEqual([]);
    expect(audit.eligible).toBe(1);
  },
);

it("DQ-10 5.42: explicit circuitSymbols overrides native profile defaults", () => {
  const explicitAc = psuCase({
    inputTerminals: [{ key: "L" }, { key: "N" }],
    circuitSymbols: { ac_input: "ac-input" },
    renderedMarks: ["ac-input"],
  });
  expect(
    conversionQualifierAudit(explicitAc.g, explicitAc.ir, explicitAc.sheet),
  ).toEqual({ findings: [], eligible: 1 });

  const explicitLoad = psuCase({
    circuitSymbols: { ac_input: "load" },
    renderedMarks: [],
  });
  expect(
    conversionQualifierAudit(
      explicitLoad.g,
      explicitLoad.ir,
      explicitLoad.sheet,
    ),
  ).toEqual({ findings: [], eligible: 0 });

  const explicitLoadWithAcMark = psuCase({
    circuitSymbols: { ac_input: "load" },
    renderedMarks: ["ac-input"],
  });
  expect(
    kinds(
      conversionQualifierAudit(
        explicitLoadWithAcMark.g,
        explicitLoadWithAcMark.ir,
        explicitLoadWithAcMark.sheet,
      ),
    ),
  ).toEqual(["conversion-qualifier-native-owner-unavailable"]);
});

it("DQ-10 5.42: non-dc-supply AC loads do not acquire an ac-input expectation", () => {
  const motor = psuCase({
    symbol: "thermite:motor-3ph",
    inputTerminals: [
      { key: "U", role: "phase_u_input" },
      { key: "V", role: "phase_v_input" },
      { key: "W", role: "phase_w_input" },
    ],
    extraTerminals: [],
    renderedMarks: [],
  });
  expect(conversionQualifierAudit(motor.g, motor.ir, motor.sheet)).toEqual({
    findings: [],
    eligible: 0,
  });

  const heater = psuCase({
    symbol: "thermite:heater",
    inputTerminals: [
      { key: "1", rating: { voltage_type: "AC", nominal_voltage: 230 } },
      { key: "2", rating: { voltage_type: "AC", nominal_voltage: 230 } },
    ],
    extraTerminals: [],
    renderedMarks: [],
  });
  expect(conversionQualifierAudit(heater.g, heater.ir, heater.sheet)).toEqual({
    findings: [],
    eligible: 0,
  });
});

it("DQ-10 5.42: dc-supply 2-terminal source expects dc-output unless terminals declare AC", () => {
  const dcSource = psuCase({
    functionKey: "dc_output",
    functionKind: "source",
    inputTerminals: [
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
    ],
    extraTerminals: [],
    renderedMarks: ["dc-output"],
  });
  expect(
    conversionQualifierAudit(dcSource.g, dcSource.ir, dcSource.sheet),
  ).toEqual({ findings: [], eligible: 1 });

  const acSource = psuCase({
    functionKey: "ac_out",
    functionKind: "source",
    inputTerminals: [
      { key: "X1", rating: { voltage_type: "AC", nominal_voltage: 24 } },
      { key: "X2", rating: { voltage_type: "AC", nominal_voltage: 24 } },
    ],
    extraTerminals: [],
    renderedMarks: [],
  });
  expect(
    conversionQualifierAudit(acSource.g, acSource.ir, acSource.sheet),
  ).toEqual({ findings: [], eligible: 0 });

  // Earth or auxiliary terminals on a 2-terminal source do not expect dc-output.
  for (const inputTerminals of [
    [
      { key: "+", role: "dc_positive_output" },
      { key: "PE", role: "protective_earth" },
    ],
    [
      { key: "1", role: "aux" },
      { key: "2", role: "aux" },
    ],
  ]) {
    const marked = psuCase({
      functionKey: "dc_output",
      functionKind: "source",
      inputTerminals,
      extraTerminals: [],
      renderedMarks: ["dc-output"],
    });
    expectUnowned(conversionQualifierAudit(marked.g, marked.ir, marked.sheet));
  }
});

it.each([
  [
    "two unrated pins + AC-rated protective_earth (reviewer probe)",
    "iec:dc-power-supply",
    [
      { key: "1" },
      { key: "2" },
      { key: "3", role: "protective_earth", rating: { voltage_type: "AC" } },
    ],
  ],
  [
    "two unrated pins + AC-rated pe role",
    "iec:dc-power-supply",
    [
      { key: "1" },
      { key: "2" },
      { key: "PE", role: "pe", rating: { voltage_type: "AC" } },
    ],
  ],
  [
    "two unrated pins + AC-rated functional_earth",
    "thermite:dc-supply",
    [
      { key: "1" },
      { key: "2" },
      { key: "FE", role: "functional_earth", rating: { voltage_type: "AC" } },
    ],
  ],
  [
    "two unrated pins + AC-rated ground role",
    "thermite:dc-supply",
    [
      { key: "1" },
      { key: "2" },
      { key: "GND", role: "chassis_ground", rating: { voltage_type: "AC" } },
    ],
  ],
  [
    "one AC-rated phase input + two unspecified pins (reviewer probe)",
    "thermite:dc-supply",
    [
      { key: "1", role: "phase_1_input", rating: { voltage_type: "AC" } },
      { key: "2" },
      { key: "3" },
    ],
  ],
  [
    "one AC-rated pin + one AC-rated PE (earth excluded from terminal count)",
    "thermite:dc-supply",
    [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2", role: "protective_earth", rating: { voltage_type: "AC" } },
    ],
  ],
  [
    "one AC-rated pin + one unrated pin",
    "thermite:dc-supply",
    [{ key: "1", rating: { voltage_type: "AC" } }, { key: "2" }],
  ],
  [
    "two AC-rated pins + one unrated non-earth pin",
    "thermite:dc-supply",
    [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2", rating: { voltage_type: "AC" } },
      { key: "3" },
    ],
  ],
  [
    "AC-rated line + AC-rated auxiliary terminal",
    "thermite:dc-supply",
    [
      { key: "1", role: "ac_line_input", rating: { voltage_type: "AC" } },
      { key: "2", role: "aux", rating: { voltage_type: "AC" } },
    ],
  ],
])(
  "DQ-10 5.42 (#553 review): %s treats ac-input mark as unowned",
  (_label, symbol, inputTerminals) => {
    const unmarked = psuCase({ symbol, inputTerminals, renderedMarks: [] });
    expect(
      conversionQualifierAudit(unmarked.g, unmarked.ir, unmarked.sheet),
    ).toEqual({ findings: [], eligible: 0 });

    const marked = psuCase({
      symbol,
      inputTerminals,
      renderedMarks: ["ac-input"],
    });
    expectUnowned(conversionQualifierAudit(marked.g, marked.ir, marked.sheet));
  },
);

it.each([
  [
    "two AC-rated inputs + unrated protective_earth",
    "iec:dc-power-supply",
    [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2", rating: { voltage_type: "AC" } },
      { key: "3", role: "protective_earth" },
    ],
  ],
  [
    "two AC-rated inputs + AC-rated PE",
    "thermite:dc-supply",
    [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2", rating: { voltage_type: "AC" } },
      { key: "PE", role: "pe", rating: { voltage_type: "AC" } },
    ],
  ],
])(
  "DQ-10 5.42 (#553 review): %s qualifies for ac-input",
  (_label, symbol, inputTerminals) => {
    const { g, ir, sheet } = psuCase({
      symbol,
      inputTerminals,
      renderedMarks: ["ac-input"],
    });
    expect(conversionQualifierAudit(g, ir, sheet)).toEqual({
      findings: [],
      eligible: 1,
    });
  },
);
