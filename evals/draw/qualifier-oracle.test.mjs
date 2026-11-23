import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  compileProject,
  lockProject,
} from "../../packages/compiler/dist/index.js";
import { conversionQualifierAudit } from "./qualifier-oracle.mjs";
import { segments } from "./tranche3-geometry.mjs";
import { end, nativeIr } from "./tranche3-fixtures.mjs";

const kinds = (audit) => audit.findings.map((f) => f.kind);

function psuCase({
  symbol = "thermite:dc-supply",
  circuitSymbols,
  functionKey = "ac_input",
  functionKind = "load",
  inputTerminals = [
    { key: "L", role: "ac_line_input" },
    { key: "N", role: "ac_input_return" },
  ],
  extraTerminals = [
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
  const makeShapes = (mark) => {
    const base = {
      deviceUid: "D",
      functionKey,
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
    return [rect, ...glyph];
  };

  const g = {
    shapes: [
      {
        deviceUid: "D",
        outline: true,
        circuitFunctions: [fn.id],
        bbox: { x: 0, y: 0, w: 50, h: 30 },
      },
      ...renderedMarks.flatMap((mark) => makeShapes(mark)),
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
  const audit = conversionQualifierAudit(g, ir, sheet);
  expect(audit.eligible).toBe(0);
  expect(kinds(audit)).toEqual([
    "conversion-qualifier-native-owner-unavailable",
  ]);

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
  const audit = conversionQualifierAudit(marked.g, marked.ir, marked.sheet);
  expect(audit.eligible).toBe(0);
  expect(kinds(audit)).toEqual([
    "conversion-qualifier-native-owner-unavailable",
  ]);
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
    const audit = conversionQualifierAudit(marked.g, marked.ir, marked.sheet);
    expect(audit.eligible).toBe(0);
    expect(kinds(audit)).toEqual([
      "conversion-qualifier-native-owner-unavailable",
    ]);
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
    const audit = conversionQualifierAudit(marked.g, marked.ir, marked.sheet);
    expect(audit.eligible).toBe(0);
    expect(kinds(audit)).toEqual([
      "conversion-qualifier-native-owner-unavailable",
    ]);
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

it.each([
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
])(
  "DQ-10 5.42 (#553 round 4): closed earth role %s (%s) never supplies the second AC rating or dc-output",
  (role, symbol) => {
    const loadTerminals = [
      { key: "A", rating: { voltage_type: "AC" } },
      { key: "B", role, rating: { voltage_type: "AC" } },
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
    const audit = conversionQualifierAudit(marked.g, marked.ir, marked.sheet);
    expect(audit.eligible).toBe(0);
    expect(kinds(audit)).toEqual([
      "conversion-qualifier-native-owner-unavailable",
    ]);

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
    const srcAudit = conversionQualifierAudit(
      srcMarked.g,
      srcMarked.ir,
      srcMarked.sheet,
    );
    expect(srcAudit.eligible).toBe(0);
    expect(kinds(srcAudit)).toEqual([
      "conversion-qualifier-native-owner-unavailable",
    ]);
  },
);

it("DQ-10 5.42 (#553 round 4): only IR protective_earth potential (never drawing marks or synthetic lists) classifies unroled earth", () => {
  const loadTerminals = [
    { key: "A", rating: { voltage_type: "AC" } },
    { key: "B", rating: { voltage_type: "AC" } },
  ];

  // 1. Compiled IR protective_earth potential anchor excludes unroled earth terminal on loads and sources.
  const viaPotential = psuCase({
    inputTerminals: loadTerminals,
    renderedMarks: ["ac-input"],
  });
  viaPotential.ir.potentials = [
    {
      uid: "p-pe",
      name: "PE",
      electrical: { polarity: "protective_earth" },
      terminal: { deviceUid: "D", terminalKey: "B" },
      netId: "net:pe",
    },
  ];
  expect(
    conversionQualifierAudit(
      viaPotential.g,
      viaPotential.ir,
      viaPotential.sheet,
    ),
  ).toMatchObject({
    eligible: 0,
    findings: [
      expect.objectContaining({
        kind: "conversion-qualifier-native-owner-unavailable",
      }),
    ],
  });

  const srcViaPotential = psuCase({
    functionKey: "dc_output",
    functionKind: "source",
    inputTerminals: [{ key: "A" }, { key: "B" }],
    extraTerminals: [],
    renderedMarks: ["dc-output"],
  });
  srcViaPotential.ir.potentials = [
    {
      uid: "p-pe-src",
      name: "PE",
      electrical: { polarity: "protective_earth" },
      terminal: { deviceUid: "D", terminalKey: "B" },
      netId: "net:pe-src",
    },
  ];
  expect(
    conversionQualifierAudit(
      srcViaPotential.g,
      srcViaPotential.ir,
      srcViaPotential.sheet,
    ),
  ).toMatchObject({
    eligible: 0,
    findings: [
      expect.objectContaining({
        kind: "conversion-qualifier-native-owner-unavailable",
      }),
    ],
  });

  // 2. Drawing marks NEVER classify earth: an "earth" bus mark on a separate function
  // leaves unroled AC-rated loads, AC-return loads, and DC-return sources eligible.
  const viaBusUnroled = psuCase({
    inputTerminals: loadTerminals,
    circuitSymbols: { bond: "earth" },
    renderedMarks: ["ac-input"],
  });
  viaBusUnroled.ir.deviceTypes[0].functions = [
    { key: "bond", kind: "bus", terminalKeys: ["B"] },
  ];
  expect(
    conversionQualifierAudit(
      viaBusUnroled.g,
      viaBusUnroled.ir,
      viaBusUnroled.sheet,
    ),
  ).toEqual({ findings: [], eligible: 1 });

  const viaBusAcReturn = psuCase({
    inputTerminals: [
      { key: "A", role: "ac_line_input", rating: { voltage_type: "AC" } },
      { key: "B", role: "ac_input_return", rating: { voltage_type: "AC" } },
    ],
    circuitSymbols: { bond: "earth" },
    renderedMarks: ["ac-input"],
  });
  viaBusAcReturn.ir.deviceTypes[0].functions = [
    { key: "bond", kind: "bus", terminalKeys: ["B"] },
  ];
  expect(
    conversionQualifierAudit(
      viaBusAcReturn.g,
      viaBusAcReturn.ir,
      viaBusAcReturn.sheet,
    ),
  ).toEqual({ findings: [], eligible: 1 });

  const viaBusDcReturn = psuCase({
    functionKey: "dc_output",
    functionKind: "source",
    inputTerminals: [
      { key: "A", role: "dc_positive_output", rating: { voltage_type: "DC" } },
      { key: "B", role: "dc_return_output", rating: { voltage_type: "DC" } },
    ],
    extraTerminals: [],
    circuitSymbols: { bond: "earth" },
    renderedMarks: ["dc-output"],
  });
  viaBusDcReturn.ir.deviceTypes[0].functions = [
    { key: "bond", kind: "bus", terminalKeys: ["B"] },
  ];
  expect(
    conversionQualifierAudit(
      viaBusDcReturn.g,
      viaBusDcReturn.ir,
      viaBusDcReturn.sheet,
    ),
  ).toEqual({ findings: [], eligible: 1 });

  // 3. Oracle relies only on compiled IR facts (roles and potentials), ignoring non-IR protectiveEarthTerminals.
  const nonIrField = psuCase({
    inputTerminals: loadTerminals,
    renderedMarks: ["ac-input"],
  });
  nonIrField.ir.protectiveEarthTerminals = [
    { deviceUid: "D", terminalKey: "B" },
  ];
  expect(
    conversionQualifierAudit(nonIrField.g, nonIrField.ir, nonIrField.sheet),
  ).toEqual({ findings: [], eligible: 1 });
});

it("DQ-10 5.42 (#553 round 4): earth terminals are ignored in both directions (never veto AC)", () => {
  // Complete AC role pair + DC-rated protective_earth (reviewer's dc-rated-earth).
  const dcRatedPe = psuCase({
    inputTerminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "PE", role: "protective_earth", rating: { voltage_type: "DC" } },
    ],
    renderedMarks: ["ac-input"],
  });
  expect(
    conversionQualifierAudit(dcRatedPe.g, dcRatedPe.ir, dcRatedPe.sheet),
  ).toEqual({ findings: [], eligible: 1 });

  // AC-rated pair + DC-rated camelCase protectiveEarth.
  const dcRatedCamel = psuCase({
    inputTerminals: [
      { key: "L", rating: { voltage_type: "AC" } },
      { key: "N", rating: { voltage_type: "AC" } },
      { key: "PE", role: "protectiveEarth", rating: { voltage_type: "DC" } },
    ],
    renderedMarks: ["ac-input"],
  });
  expect(
    conversionQualifierAudit(
      dcRatedCamel.g,
      dcRatedCamel.ir,
      dcRatedCamel.sheet,
    ),
  ).toEqual({ findings: [], eligible: 1 });

  // Closed set: "dc_earth" is not in the closed earth set, so its DC role/rating vetoes AC.
  const dcEarthNotInSet = psuCase({
    inputTerminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "PE", role: "dc_earth", rating: { voltage_type: "DC" } },
    ],
    renderedMarks: ["ac-input"],
  });
  expect(
    conversionQualifierAudit(
      dcEarthNotInSet.g,
      dcEarthNotInSet.ir,
      dcEarthNotInSet.sheet,
    ),
  ).toMatchObject({
    eligible: 0,
    findings: [
      expect.objectContaining({
        kind: "conversion-qualifier-native-owner-unavailable",
      }),
    ],
  });

  // Complete AC role pair + unroled DC-rated terminal anchored to a protective_earth potential.
  const canonicalPe = psuCase({
    inputTerminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "E", rating: { voltage_type: "DC" } },
    ],
    renderedMarks: ["ac-input"],
  });
  canonicalPe.ir.potentials = [
    {
      uid: "p-pe-dc",
      name: "PE",
      electrical: { polarity: "protective_earth" },
      terminal: { deviceUid: "D", terminalKey: "E" },
      netId: "net:pe-dc",
    },
  ];
  expect(
    conversionQualifierAudit(canonicalPe.g, canonicalPe.ir, canonicalPe.sheet),
  ).toEqual({ findings: [], eligible: 1 });
});

it("DQ-10 5.42 (#553 round 4): compiled reviewer probes match the closed earth rule", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thermite-oracle-r4-"));
  try {
    const ac = { rating: { voltage_type: "AC" } };
    const dc = { rating: { voltage_type: "DC" } };
    const line = { ...ac, role: "ac_line_input" };
    const neutral = { ...ac, role: "ac_input_return" };
    const positive = { ...dc, role: "dc_positive_output" };
    const negative = { ...dc, role: "dc_return_output" };
    const earthBus = {
      extraFunctions: { bond: { kind: "bus", terminals: ["B"] } },
      circuitSymbols: { bond: "earth" },
    };

    const probes = [
      {
        id: "earth-alias-1",
        terminals: { A: ac, B: { ...ac, role: "functional_earth" } },
        expectedMark: null,
      },
      {
        id: "earth-alias-2",
        symbol: "iec:dc-power-supply",
        terminals: { A: ac, B: { ...ac, role: "PE" } },
        expectedMark: null,
      },
      {
        id: "earth-alias-3",
        terminals: { A: ac, B: { ...ac, role: "chassis-ground" } },
        expectedMark: null,
      },
      {
        id: "earth-alias-4",
        symbol: "iec:dc-power-supply",
        terminals: { A: ac, B: { ...ac, role: "Protective Earth" } },
        expectedMark: null,
      },
      {
        id: "earth-alias-5",
        terminals: { A: ac, B: { ...ac, role: "protectiveEarth" } },
        expectedMark: null,
      },
      {
        id: "neutral-only-ac-rated",
        symbol: "iec:dc-power-supply",
        terminals: {
          L: { role: "ac_line_input" },
          N: { role: "neutral", rating: { voltage_type: "AC" } },
          PE: { role: "protective_earth" },
        },
        expectedMark: null,
      },
      {
        id: "complete-ac-roles",
        terminals: {
          L: { role: "ac_line_input" },
          N: { role: "ac_neutral", rating: { voltage_type: "AC" } },
          PE: { role: "protective_earth" },
        },
        expectedMark: "ac-input",
      },
      {
        id: "all-ac-alternate-pe",
        symbol: "iec:dc-power-supply",
        terminals: { L: ac, N: ac, PE: { role: "Functional Earth" } },
        expectedMark: "ac-input",
      },
      {
        id: "dc-rated-earth",
        terminals: {
          L: { role: "ac_line_input" },
          N: { role: "ac_input_return" },
          PE: { role: "protective_earth", rating: { voltage_type: "DC" } },
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
        terminals: {
          D: { role: "dc_positive_output" },
          A: { role: "aux" },
        },
        expectedMark: null,
      },
      {
        id: "camel-functional-earth",
        terminals: { A: ac, B: { ...ac, role: "functionalEarth" } },
        expectedMark: null,
      },
      {
        id: "camel-chassis-ground",
        terminals: { A: ac, B: { ...ac, role: "chassisGround" } },
        expectedMark: null,
      },
      {
        id: "camel-supply-ground-return",
        terminals: {
          A: line,
          B: {
            ...ac,
            role: "supplyGroundReturn",
            description: "Supply ground return",
          },
        },
        expectedMark: "ac-input",
      },
      {
        id: "supply-ground-description-control",
        terminals: {
          A: line,
          B: { ...ac, role: "return", description: "Supply ground return" },
        },
        expectedMark: "ac-input",
      },
      {
        id: "ground-return-ac-rated",
        terminals: { A: line, B: { ...ac, role: "ground" } },
        expectedMark: "ac-input",
      },
      {
        id: "gnd-return-ac-rated",
        terminals: { A: line, B: { ...ac, role: "gnd" } },
        expectedMark: "ac-input",
      },
      {
        id: "earth-bus-unroled",
        terminals: { A: ac, B: ac },
        ...earthBus,
        expectedMark: "ac-input",
      },
      {
        id: "earth-bus-ac-return",
        terminals: { A: line, B: neutral },
        ...earthBus,
        expectedMark: "ac-input",
      },
      {
        id: "earth-bus-dc-return",
        kind: "source",
        terminals: { A: positive, B: negative },
        ...earthBus,
        expectedMark: "dc-output",
      },
      {
        id: "explicit-ac-binding",
        terminals: { A: line, B: neutral },
        ...earthBus,
        circuitSymbols: { bond: "earth", face: "ac-input" },
        expectedMark: "ac-input",
      },
      {
        id: "mixed-case-pe-source",
        kind: "source",
        terminals: { A: positive, B: { role: "pE" } },
        expectedMark: null,
      },
      {
        id: "mixed-case-pe-load",
        terminals: { A: ac, B: { ...ac, role: "pE" } },
        expectedMark: null,
      },
      {
        id: "ac-with-rated-aux",
        terminals: { A: line, B: neutral, C: { ...ac, role: "aux" } },
        expectedMark: null,
      },
      {
        id: "ac-with-dc-conflict",
        terminals: { A: line, B: { ...dc, role: "ac_input_return" } },
        expectedMark: null,
      },
      {
        id: "pe-potential-anchored",
        terminals: { A: ac, B: ac },
        pePotentialTerminal: "B",
        expectedMark: null,
      },
    ];

    await mkdir(join(dir, "library"), { recursive: true });
    await writeFile(
      join(dir, "system.json"),
      JSON.stringify({
        format: "electrical-system/0.1",
        project: { name: "Oracle Round 4 Probes" },
        sources: ["source.json"],
        libraries: [{ name: "r4-oracle", version: "0.1.0", path: "library" }],
      }),
    );
    await writeFile(
      join(dir, "library/library.json"),
      JSON.stringify({
        name: "r4-oracle",
        version: "0.1.0",
        sources: ["types.json"],
      }),
    );
    await writeFile(
      join(dir, "library/types.json"),
      JSON.stringify({
        types: probes.map((p) => ({
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
        })),
      }),
    );
    const objects = probes.map((p, idx) => ({
      kind: "device",
      uid: `f6000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
      designation: `Q${idx + 1}`,
      type: `r4-oracle:${p.id}`,
    }));
    for (const [idx, p] of probes.entries()) {
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
    await writeFile(join(dir, "source.json"), JSON.stringify({ objects }));
    const locked = await lockProject(dir);
    expect(locked.ok, JSON.stringify(locked)).toBe(true);
    const compiled = await compileProject(dir);
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true);

    const makeGeometry = (deviceUid, fn, mark) => {
      const shapes = [
        {
          deviceUid,
          outline: true,
          circuitFunctions: [fn.id],
          bbox: { x: 0, y: 0, w: 50, h: 30 },
        },
      ];
      if (mark) {
        const base = {
          deviceUid,
          functionKey: fn.id.functionKey,
          mark,
          markGroup: "glyph",
          circuitFunctions: [fn.id],
        };
        const shape = (tag, points, idx) => ({
          ...base,
          element: `${mark}-${tag}-${idx}`,
          shapeTag: tag,
          points,
          inkSegments: segments(points),
          bbox: { x: 8, y: 11, w: 8, h: 8 },
        });
        shapes.push(
          shape(
            "rect",
            [
              { x: 8, y: 11 },
              { x: 16, y: 19 },
            ],
            0,
          ),
        );
        if (mark === "ac-input") {
          shapes.push(
            shape(
              "polyline",
              [
                { x: 10, y: 15 },
                { x: 11, y: 14 },
                { x: 12, y: 16 },
                { x: 14, y: 15 },
              ],
              1,
            ),
          );
        } else {
          [
            [9, 15, 12],
            [9, 10, 16],
            [11, 12, 16],
            [13, 15, 16],
          ].forEach(([x1, x2, y], idx) =>
            shapes.push(
              shape(
                "line",
                [
                  { x: x1, y },
                  { x: x2, y },
                ],
                idx + 1,
              ),
            ),
          );
        }
      }
      return {
        shapes,
        terminals: fn.terminals.map((t, i) => ({
          deviceUid,
          terminal: t.terminalKey,
          point: { x: 0, y: i * 10 },
        })),
      };
    };

    for (const [idx, p] of probes.entries()) {
      const uid = `f6000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`;
      const fn = compiled.ir.functions.find(
        (f) => f.id.deviceUid === uid && f.id.functionKey === "face",
      );
      const sheet = {
        view: { kind: "circuit" },
        references: [{ deviceUid: uid, functions: ["face"] }],
      };
      if (p.expectedMark) {
        const pass = conversionQualifierAudit(
          makeGeometry(uid, fn, p.expectedMark),
          compiled.ir,
          sheet,
        );
        expect(pass, `${p.id} expected ${p.expectedMark}`).toEqual({
          findings: [],
          eligible: 1,
        });
      } else {
        const unmarked = conversionQualifierAudit(
          makeGeometry(uid, fn, null),
          compiled.ir,
          sheet,
        );
        expect(unmarked, `${p.id} unmarked`).toEqual({
          findings: [],
          eligible: 0,
        });
        const spuriousMark = p.kind === "source" ? "dc-output" : "ac-input";
        const spurious = conversionQualifierAudit(
          makeGeometry(uid, fn, spuriousMark),
          compiled.ir,
          sheet,
        );
        expect(spurious.eligible, `${p.id} spurious ${spuriousMark}`).toBe(0);
        expect(kinds(spurious), `${p.id} spurious findings`).toEqual([
          "conversion-qualifier-native-owner-unavailable",
        ]);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("DQ-10 5.42 (#553 round 5): normalizes every dc-supply role class identically across snake, camel, Pascal, kebab and spaced spellings", () => {
  const ac = { rating: { voltage_type: "AC" } };
  const check = (functionKind, inputTerminals, expectedMark) => {
    if (expectedMark) {
      const pass = psuCase({
        functionKey: "face",
        functionKind,
        inputTerminals,
        extraTerminals: [],
        renderedMarks: [expectedMark],
      });
      return {
        mark: expectedMark,
        audit: conversionQualifierAudit(pass.g, pass.ir, pass.sheet),
      };
    }
    const unmarked = psuCase({
      functionKey: "face",
      functionKind,
      inputTerminals,
      extraTerminals: [],
      renderedMarks: [],
    });
    const spuriousMark = functionKind === "source" ? "dc-output" : "ac-input";
    const spurious = psuCase({
      functionKey: "face",
      functionKind,
      inputTerminals,
      extraTerminals: [],
      renderedMarks: [spuriousMark],
    });
    return {
      unmarked: conversionQualifierAudit(
        unmarked.g,
        unmarked.ir,
        unmarked.sheet,
      ),
      spurious: conversionQualifierAudit(
        spurious.g,
        spurious.ir,
        spurious.sheet,
      ),
    };
  };

  const table = [
    {
      roleClass: "ac single-phase pair (line + input_return)",
      kind: "load",
      expected: "ac-input",
      snake: [
        { key: "L", role: "ac_line_input" },
        { key: "N", role: "ac_input_return" },
      ],
      variants: {
        camel: [
          { key: "L", role: "acLineInput" },
          { key: "N", role: "acInputReturn" },
        ],
        pascal: [
          { key: "L", role: "AcLineInput" },
          { key: "N", role: "AcInputReturn" },
        ],
        kebab: [
          { key: "L", role: "ac-line-input" },
          { key: "N", role: "ac-input-return" },
        ],
        spaced: [
          { key: "L", role: "AC Line Input" },
          { key: "N", role: "AC Input Return" },
        ],
      },
    },
    {
      roleClass: "ac single-phase pair (line + ac_neutral)",
      kind: "load",
      expected: "ac-input",
      snake: [
        { key: "L", role: "ac_line_input" },
        { key: "N", role: "ac_neutral" },
      ],
      variants: {
        camel: [
          { key: "L", role: "acLineInput" },
          { key: "N", role: "acNeutral" },
        ],
        pascal: [
          { key: "L", role: "AcLineInput" },
          { key: "N", role: "AcNeutral" },
        ],
        kebab: [
          { key: "L", role: "ac-line-input" },
          { key: "N", role: "ac-neutral" },
        ],
        spaced: [
          { key: "L", role: "AC Line Input" },
          { key: "N", role: "AC Neutral" },
        ],
      },
    },
    {
      roleClass: "three-phase numeric input (phase_1/2/3_input)",
      kind: "load",
      expected: "ac-input",
      snake: [
        { key: "L1", role: "phase_1_input" },
        { key: "L2", role: "phase_2_input" },
        { key: "L3", role: "phase_3_input" },
      ],
      variants: {
        camel: [
          { key: "L1", role: "phase1Input" },
          { key: "L2", role: "phase2Input" },
          { key: "L3", role: "phase3Input" },
        ],
        pascal: [
          { key: "L1", role: "Phase1Input" },
          { key: "L2", role: "Phase2Input" },
          { key: "L3", role: "Phase3Input" },
        ],
        kebab: [
          { key: "L1", role: "phase-1-input" },
          { key: "L2", role: "phase-2-input" },
          { key: "L3", role: "phase-3-input" },
        ],
        spaced: [
          { key: "L1", role: "Phase 1 Input" },
          { key: "L2", role: "Phase 2 Input" },
          { key: "L3", role: "Phase 3 Input" },
        ],
      },
    },
    {
      roleClass: "three-phase u/v/w input (phase_u/v/w_input)",
      kind: "load",
      expected: "ac-input",
      snake: [
        { key: "U", role: "phase_u_input" },
        { key: "V", role: "phase_v_input" },
        { key: "W", role: "phase_w_input" },
      ],
      variants: {
        camel: [
          { key: "U", role: "phaseUInput" },
          { key: "V", role: "phaseVInput" },
          { key: "W", role: "phaseWInput" },
        ],
        pascal: [
          { key: "U", role: "PhaseUInput" },
          { key: "V", role: "PhaseVInput" },
          { key: "W", role: "PhaseWInput" },
        ],
        kebab: [
          { key: "U", role: "phase-u-input" },
          { key: "V", role: "phase-v-input" },
          { key: "W", role: "phase-w-input" },
        ],
        spaced: [
          { key: "U", role: "Phase U Input" },
          { key: "V", role: "Phase V Input" },
          { key: "W", role: "Phase W Input" },
        ],
      },
    },
    {
      roleClass: "dc veto on AC-rated load (dc_return / dcReturn)",
      kind: "load",
      expected: null,
      snake: [
        { key: "L", role: "ac_line_input", ...ac },
        { key: "N", role: "dc_return", ...ac },
      ],
      variants: {
        camel: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "dcReturn", ...ac },
        ],
        pascal: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "DcReturn", ...ac },
        ],
        kebab: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "dc-return", ...ac },
        ],
        spaced: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "DC Return", ...ac },
        ],
      },
    },
    {
      roleClass: "aux veto on AC-rated load (aux_input / auxInput)",
      kind: "load",
      expected: null,
      snake: [
        { key: "L", role: "ac_line_input", ...ac },
        { key: "N", role: "ac_input_return", ...ac },
        { key: "A", role: "aux_input", ...ac },
      ],
      variants: {
        camel: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "ac_input_return", ...ac },
          { key: "A", role: "auxInput", ...ac },
        ],
        pascal: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "ac_input_return", ...ac },
          { key: "A", role: "AuxInput", ...ac },
        ],
        kebab: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "ac_input_return", ...ac },
          { key: "A", role: "aux-input", ...ac },
        ],
        spaced: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "ac_input_return", ...ac },
          { key: "A", role: "Aux Input", ...ac },
        ],
      },
    },
    {
      roleClass: "non-power no_connection veto on AC-rated load",
      kind: "load",
      expected: null,
      snake: [
        { key: "L", role: "ac_line_input", ...ac },
        { key: "N", role: "ac_input_return", ...ac },
        { key: "NC", role: "no_connection", ...ac },
      ],
      variants: {
        camel: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "ac_input_return", ...ac },
          { key: "NC", role: "noConnection", ...ac },
        ],
        pascal: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "ac_input_return", ...ac },
          { key: "NC", role: "NoConnection", ...ac },
        ],
        kebab: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "ac_input_return", ...ac },
          { key: "NC", role: "no-connection", ...ac },
        ],
        spaced: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "ac_input_return", ...ac },
          { key: "NC", role: "No Connection", ...ac },
        ],
      },
    },
    {
      roleClass: "ac role veto on 2-pin source (ac_line_input / acLineInput)",
      kind: "source",
      expected: null,
      snake: [
        { key: "A", role: "dc_positive_output" },
        { key: "B", role: "ac_line_input" },
      ],
      variants: {
        camel: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "acLineInput" },
        ],
        pascal: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "AcLineInput" },
        ],
        kebab: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "ac-line-input" },
        ],
        spaced: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "AC Line Input" },
        ],
      },
    },
    {
      roleClass: "phase role veto on 2-pin source (phase_1_source)",
      kind: "source",
      expected: null,
      snake: [
        { key: "A", role: "dc_positive_output" },
        { key: "B", role: "phase_1_source" },
      ],
      variants: {
        camel: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "phase1Source" },
        ],
        pascal: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "Phase1Source" },
        ],
        kebab: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "phase-1-source" },
        ],
        spaced: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "Phase 1 Source" },
        ],
      },
    },
    {
      roleClass: "aux role veto on 2-pin source (auxiliary_potential)",
      kind: "source",
      expected: null,
      snake: [
        { key: "A", role: "dc_positive_output" },
        { key: "B", role: "auxiliary_potential" },
      ],
      variants: {
        camel: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "auxiliaryPotential" },
        ],
        pascal: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "AuxiliaryPotential" },
        ],
        kebab: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "auxiliary-potential" },
        ],
        spaced: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "Auxiliary Potential" },
        ],
      },
    },
    {
      roleClass: "earth exclusion on 2-pin AC-rated load (protective_earth)",
      kind: "load",
      expected: null,
      snake: [
        { key: "A", ...ac },
        { key: "B", role: "protective_earth", ...ac },
      ],
      variants: {
        camel: [
          { key: "A", ...ac },
          { key: "B", role: "protectiveEarth", ...ac },
        ],
        pascal: [
          { key: "A", ...ac },
          { key: "B", role: "ProtectiveEarth", ...ac },
        ],
        kebab: [
          { key: "A", ...ac },
          { key: "B", role: "protective-earth", ...ac },
        ],
        spaced: [
          { key: "A", ...ac },
          { key: "B", role: "Protective Earth", ...ac },
        ],
      },
    },
    {
      roleClass: "earth skip on 3-pin AC load (chassis_ground)",
      kind: "load",
      expected: "ac-input",
      snake: [
        { key: "L", role: "ac_line_input" },
        { key: "N", role: "ac_input_return" },
        { key: "PE", role: "chassis_ground" },
      ],
      variants: {
        camel: [
          { key: "L", role: "acLineInput" },
          { key: "N", role: "acInputReturn" },
          { key: "PE", role: "chassisGround" },
        ],
        pascal: [
          { key: "L", role: "AcLineInput" },
          { key: "N", role: "AcInputReturn" },
          { key: "PE", role: "ChassisGround" },
        ],
        kebab: [
          { key: "L", role: "ac-line-input" },
          { key: "N", role: "ac-input-return" },
          { key: "PE", role: "chassis-ground" },
        ],
        spaced: [
          { key: "L", role: "AC Line Input" },
          { key: "N", role: "AC Input Return" },
          { key: "PE", role: "Chassis Ground" },
        ],
      },
    },
  ];

  for (const row of table) {
    const assertResult = (res, label) => {
      if (row.expected) {
        expect(res.audit, label).toEqual({ findings: [], eligible: 1 });
      } else {
        expect(res.unmarked, `${label} unmarked`).toEqual({
          findings: [],
          eligible: 0,
        });
        expect(res.spurious.eligible, `${label} spurious`).toBe(0);
        expect(kinds(res.spurious), `${label} spurious findings`).toEqual([
          "conversion-qualifier-native-owner-unavailable",
        ]);
      }
    };
    assertResult(
      check(row.kind, row.snake, row.expected),
      `${row.roleClass} snake_case`,
    );
    for (const [style, terminals] of Object.entries(row.variants)) {
      assertResult(
        check(row.kind, terminals, row.expected),
        `${row.roleClass} ${style}`,
      );
    }
  }
});

it("DQ-10 5.42 (#553 round 5): authored current-carrying roles outrank protective_earth potential anchors (PEN)", async () => {
  const ac = { rating: { voltage_type: "AC" } };
  const withPeAnchor = ({
    functionKind = "load",
    inputTerminals,
    anchorKey,
    renderedMarks,
  }) => {
    const c = psuCase({
      functionKey: "face",
      functionKind,
      inputTerminals,
      extraTerminals: [],
      renderedMarks,
    });
    c.ir.potentials = [
      {
        uid: "p-pen",
        name: "PEN",
        electrical: { polarity: "protective_earth" },
        terminal: { deviceUid: "D", terminalKey: anchorKey },
        netId: "net:pen",
      },
    ];
    return conversionQualifierAudit(c.g, c.ir, c.sheet);
  };

  // Authored current-carrying roles stay current-carrying under a direct PE potential anchor.
  for (const [label, inputTerminals] of [
    [
      "ac_input_return",
      [
        { key: "L", role: "ac_line_input", ...ac },
        { key: "N", role: "ac_input_return", ...ac },
      ],
    ],
    [
      "camelCase acInputReturn",
      [
        { key: "L", role: "acLineInput" },
        { key: "N", role: "acInputReturn" },
      ],
    ],
    [
      "neutral",
      [
        { key: "L", role: "ac_line_input", ...ac },
        { key: "N", role: "neutral", ...ac },
      ],
    ],
    [
      "return",
      [
        { key: "L", role: "ac_line_input", ...ac },
        { key: "N", role: "return", ...ac },
      ],
    ],
  ]) {
    expect(
      withPeAnchor({
        inputTerminals,
        anchorKey: "N",
        renderedMarks: ["ac-input"],
      }),
      label,
    ).toEqual({ findings: [], eligible: 1 });
  }

  expect(
    withPeAnchor({
      functionKind: "source",
      inputTerminals: [
        { key: "+", role: "dc_positive_output" },
        { key: "-", role: "dc_return_output" },
      ],
      anchorKey: "-",
      renderedMarks: ["dc-output"],
    }),
    "dc_return_output with PE anchor keeps dc-output",
  ).toEqual({ findings: [], eligible: 1 });

  // Unroled and earth-set terminals keep earth behavior under a direct PE potential anchor.
  for (const [label, inputTerminals] of [
    [
      "unroled",
      [
        { key: "L", ...ac },
        { key: "N", ...ac },
      ],
    ],
    [
      "earth-set role",
      [
        { key: "L", ...ac },
        { key: "N", role: "ProtectiveEarth", ...ac },
      ],
    ],
  ]) {
    const audit = withPeAnchor({
      inputTerminals,
      anchorKey: "N",
      renderedMarks: ["ac-input"],
    });
    expect(audit.eligible, label).toBe(0);
    expect(kinds(audit), label).toEqual([
      "conversion-qualifier-native-owner-unavailable",
    ]);
  }

  // Compiled project reproducing the reviewer's round-4 PEN direct and remote anchor cases.
  const dir = await mkdtemp(join(tmpdir(), "thermite-oracle-r5-"));
  try {
    const uid = (i) => `f9000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const line = { role: "ac_line_input", rating: { voltage_type: "AC" } };
    const ret = { role: "ac_input_return", rating: { voltage_type: "AC" } };
    await mkdir(join(dir, "library"), { recursive: true });
    await writeFile(
      join(dir, "system.json"),
      JSON.stringify({
        format: "electrical-system/0.1",
        project: { name: "Oracle Round 5 PEN Probes" },
        sources: ["source.json"],
        libraries: [{ name: "r5-pen", version: "0.1.0", path: "library" }],
      }),
    );
    await writeFile(
      join(dir, "library/library.json"),
      JSON.stringify({
        name: "r5-pen",
        version: "0.1.0",
        sources: ["types.json"],
      }),
    );
    await writeFile(
      join(dir, "library/types.json"),
      JSON.stringify({
        types: [
          {
            kind: "device_type",
            id: "r5-pen:pen-direct-anchor",
            symbol: "thermite:dc-supply",
            terminals: { L: line, N: ret },
            functions: { face: { kind: "load", terminals: ["L", "N"] } },
          },
          {
            kind: "device_type",
            id: "r5-pen:pen-remote-anchor",
            symbol: "thermite:dc-supply",
            terminals: { L: line, N: ret },
            functions: { face: { kind: "load", terminals: ["L", "N"] } },
          },
          {
            kind: "device_type",
            id: "r5-pen:bond-point",
            terminals: { PE: { role: "protective_earth" } },
            functions: { bond: { kind: "bus", terminals: ["PE"] } },
          },
        ],
      }),
    );
    const objects = [
      {
        kind: "device",
        uid: uid(1),
        designation: "P1",
        type: "r5-pen:pen-direct-anchor",
      },
      {
        kind: "device",
        uid: uid(2),
        designation: "P2",
        type: "r5-pen:pen-remote-anchor",
      },
      {
        kind: "device",
        uid: uid(11),
        designation: "PE1",
        type: "r5-pen:bond-point",
      },
      {
        kind: "device",
        uid: uid(12),
        designation: "PE2",
        type: "r5-pen:bond-point",
      },
      {
        kind: "wire",
        uid: uid(21),
        designation: "BOND1",
        endpoints: [
          { device: "P1", terminal: "N" },
          { device: "PE1", terminal: "PE" },
        ],
      },
      {
        kind: "wire",
        uid: uid(22),
        designation: "BOND2",
        endpoints: [
          { device: "P2", terminal: "N" },
          { device: "PE2", terminal: "PE" },
        ],
      },
      {
        kind: "potential",
        uid: uid(31),
        name: "PEN1",
        at: { device: "P1", terminal: "N" },
        electrical: { polarity: "protective_earth" },
      },
      {
        kind: "potential",
        uid: uid(32),
        name: "PEN2",
        at: { device: "PE2", terminal: "PE" },
        electrical: { polarity: "protective_earth" },
      },
    ];
    await writeFile(join(dir, "source.json"), JSON.stringify({ objects }));
    expect((await lockProject(dir)).ok).toBe(true);
    const compiled = await compileProject(dir);
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true);

    for (const [idx, label] of [
      [1, "pen-direct-anchor"],
      [2, "pen-remote-anchor"],
    ]) {
      const deviceUid = uid(idx);
      const fn = compiled.ir.functions.find(
        (f) => f.id.deviceUid === deviceUid && f.id.functionKey === "face",
      );
      const base = {
        deviceUid,
        functionKey: "face",
        mark: "ac-input",
        markGroup: "glyph",
        circuitFunctions: [fn.id],
      };
      const g = {
        shapes: [
          {
            deviceUid,
            outline: true,
            circuitFunctions: [fn.id],
            bbox: { x: 0, y: 0, w: 50, h: 30 },
          },
          {
            ...base,
            element: "rect-0",
            shapeTag: "rect",
            points: [
              { x: 8, y: 11 },
              { x: 16, y: 19 },
            ],
            inkSegments: segments([
              { x: 8, y: 11 },
              { x: 16, y: 19 },
            ]),
            bbox: { x: 8, y: 11, w: 8, h: 8 },
          },
          {
            ...base,
            element: "poly-1",
            shapeTag: "polyline",
            points: [
              { x: 10, y: 15 },
              { x: 11, y: 14 },
              { x: 12, y: 16 },
              { x: 14, y: 15 },
            ],
            inkSegments: segments([
              { x: 10, y: 15 },
              { x: 11, y: 14 },
              { x: 12, y: 16 },
              { x: 14, y: 15 },
            ]),
            bbox: { x: 8, y: 11, w: 8, h: 8 },
          },
        ],
        terminals: fn.terminals.map((t, i) => ({
          deviceUid,
          terminal: t.terminalKey,
          point: { x: 0, y: i * 10 },
        })),
      };
      const sheet = {
        view: { kind: "circuit" },
        references: [{ deviceUid, functions: ["face"] }],
      };
      expect(conversionQualifierAudit(g, compiled.ir, sheet), label).toEqual({
        findings: [],
        eligible: 1,
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
