import { describe, expect, it } from "vitest";
import { contactCaptionAudit } from "./contact-role-oracle.mjs";
import { contactCaptionMediaAudit } from "./contact-role-media.mjs";
import { conversionQualifierAudit } from "./qualifier-oracle.mjs";
import { elementNavigationAudit } from "./element-navigation-oracle.mjs";
import { functionKeys } from "./checks.mjs";
import { EVALS_VERSION } from "./version.mjs";
import { readReportSummary } from "./report-summary.mjs";
import { segments } from "./tranche3-geometry.mjs";
import { end, nativeIr } from "./tranche3-fixtures.mjs";
import { elementFixture } from "./check5-navigation-fixture.mjs";

const kinds = (a) => a.findings.map((f) => f.kind);

function channelIr(signal = "Conveyor stop (NC healthy)") {
  const ir = nativeIr();
  ir.devices = [
    {
      uid: "plc",
      designation: "PLC1",
      typeId: "core:plc",
      io: {
        channels: {
          di1: { address: "%I0.1", signal, usage: "in-use" },
        },
      },
    },
    {
      uid: "k1",
      designation: "K1",
      typeId: "core:contactor",
    },
  ];
  ir.deviceTypes = [
    {
      id: "core:plc",
      terminals: [{ key: "DI1", role: "signal" }],
    },
    {
      id: "core:contactor",
      terminals: [
        { key: "13", role: "control_switch" },
        { key: "14", role: "control_switch" },
      ],
    },
  ];
  ir.functions = [
    {
      id: { deviceUid: "plc", functionKey: "di1" },
      kind: "channel",
      direction: "input",
      terminals: [end("plc", "DI1")],
    },
    {
      id: { deviceUid: "k1", functionKey: "aux13" },
      kind: "contact",
      normal_state: "open",
      terminals: [end("k1", "13"), end("k1", "14")],
    },
  ];
  return ir;
}

function makeDcMarkShapes({ scope, mx, my, mark, reversed, rotated }) {
  const base = {
    deviceUid: "ps1",
    functionKey: "dc_output",
    nativeFunctionScope: scope,
    circuitFunctions: [{ deviceUid: "ps1", functionKey: "dc_output" }],
    mark,
    markGroup: `${scope}-mark`,
  };
  const mk = (tag, suffix, pts) => ({
    ...base,
    element: `${scope}-${suffix}`,
    shapeTag: tag,
    points: pts,
    inkSegments: segments(pts),
    bbox: { x: mx, y: my, w: 6.7, h: 10 },
  });
  const out = [
    mk("rect", "rect", [
      { x: mx, y: my },
      { x: mx + 6.7, y: my + 10 },
    ]),
  ];
  if (mark === "ac-input") {
    out.push(
      mk("polyline", "wave", [
        { x: mx + 1, y: my + 5 },
        { x: mx + 2, y: my + 3 },
        { x: mx + 4, y: my + 7 },
        { x: mx + 5, y: my + 5 },
      ]),
    );
    return out;
  }
  const bars = rotated
    ? [
        [mx + 2, my + 2, mx + 2, my + 8],
        [mx + 5, my + 2, mx + 5, my + 3],
        [mx + 5, my + 4, mx + 5, my + 6],
        [mx + 5, my + 7, mx + 5, my + 8],
      ]
    : (() => {
        const solidY = reversed ? my + 7 : my + 4;
        const dashY = reversed ? my + 4 : my + 7;
        return [
          [mx + 1, solidY, mx + 5, solidY],
          [mx + 1, dashY, mx + 1.8, dashY],
          [mx + 2.3, dashY, mx + 3.7, dashY],
          [mx + 4.2, dashY, mx + 5, dashY],
        ];
      })();
  bars.forEach(([x1, y1, x2, y2], i) =>
    out.push(
      mk("line", `bar-${i}`, [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ]),
    ),
  );
  return out;
}

function makeDcFragment({
  scope,
  x = 30,
  y = 60,
  mark = "dc-output",
  outline = true,
  reversed = false,
  rotated = false,
  displaced = false,
  omitMark = false,
  omitPort = false,
  omitOwnerRect = false,
}) {
  const fnId = { deviceUid: "ps1", functionKey: "dc_output" };
  const shapes = [];
  if (!omitOwnerRect) {
    shapes.push({
      element: `${scope}-owner`,
      shapeTag: "rect",
      deviceUid: "ps1",
      nativeFunctionScope: scope,
      circuitFunctions: [fnId],
      outline,
      stroke: 0,
      fill: "rgb(255, 255, 255)",
      bbox: { x, y, w: 26, h: 18 },
    });
  }
  if (!omitMark) {
    shapes.push(
      ...makeDcMarkShapes({
        scope,
        mx: x + 9 + (displaced ? 120 : 0),
        my: y + 4,
        mark,
        reversed,
        rotated,
      }),
    );
  }
  const terminals = [
    {
      deviceUid: "ps1",
      terminal: "+",
      nativeFunctionScope: scope,
      point: { x: x + 26, y: y + 5.5 },
    },
    ...(omitPort
      ? []
      : [
          {
            deviceUid: "ps1",
            terminal: "-",
            nativeFunctionScope: scope,
            point: { x: x + 26, y: y + 12.5 },
          },
        ]),
  ];
  return { shapes, terminals };
}

function dcSupplyIr() {
  const ir = nativeIr();
  ir.devices = [{ uid: "ps1", designation: "PS1", typeId: "core:psu-24vdc" }];
  ir.deviceTypes = [
    {
      id: "core:psu-24vdc",
      symbol: "thermite:dc-supply",
      terminals: [
        {
          key: "+",
          role: "dc_positive_output",
          rating: { voltage_type: "DC" },
        },
        { key: "-", role: "dc_return_output", rating: { voltage_type: "DC" } },
      ],
    },
  ];
  ir.functions = [
    {
      id: { deviceUid: "ps1", functionKey: "dc_output" },
      kind: "source",
      terminals: [end("ps1", "+"), end("ps1", "-")],
    },
  ];
  return ir;
}

describe("RL5a V2-01 — PLC channel signal captions vs contact-state captions", () => {
  it("positive: single-line and wrapped data-channel-line=signal captions matching authored io.channels[key].signal pass", () => {
    const ir1 = channelIr("Conveyor stop (NC healthy)");
    const g1 = {
      texts: [
        {
          element: "addr",
          deviceUid: "plc",
          functionKey: "di1",
          functionScope: "plc-di1",
          channelLine: "address",
          text: "%I0.1",
          bbox: { x: 10, y: 10, w: 12, h: 2.5 },
        },
        {
          element: "sig",
          deviceUid: "plc",
          functionKey: "di1",
          functionScope: "plc-di1",
          channelLine: "signal",
          text: "Conveyor stop (NC healthy)",
          bbox: { x: 10, y: 14, w: 32, h: 2.5 },
        },
      ],
    };
    expect(contactCaptionAudit(g1, ir1).findings).toEqual([]);
    expect(
      contactCaptionMediaAudit(
        {
          ...g1,
          htmlTexts: g1.texts,
          tranche3: {
            pdfTexts: [
              { text: "Conveyor stop (NC healthy)", bbox: g1.texts[1].bbox },
            ],
          },
        },
        ir1,
      ).findings,
    ).toEqual([]);

    const ir2 = channelIr("Pump contactor command - KM1 through OL1 NC");
    const g2 = {
      texts: [
        {
          element: "sig-1",
          deviceUid: "plc",
          functionKey: "di1",
          functionScope: "plc-di1",
          channelLine: "signal",
          text: "Pump contactor command -",
          anchor: { x: 10, y: 14 },
          bbox: { x: 10, y: 12, w: 30, h: 2.5 },
        },
        {
          element: "sig-2",
          deviceUid: "plc",
          functionKey: "di1",
          functionScope: "plc-di1",
          channelLine: "signal",
          text: "KM1 through OL1 NC",
          anchor: { x: 10, y: 17 },
          bbox: { x: 10, y: 15, w: 24, h: 2.5 },
        },
      ],
    };
    expect(contactCaptionAudit(g2, ir2).findings).toEqual([]);
  });

  it("negative: forged channelLine, non-matching signal, partial snippet, or contradicting contact caption still fail", () => {
    const ir = channelIr("Conveyor stop (NC healthy)");
    const cases = [
      [
        "forged channelLine on contact glyph",
        {
          element: "c",
          deviceUid: "k1",
          functionKey: "aux13",
          functionScope: "k1-aux13",
          channelLine: "signal",
          text: "NC",
          bbox: { x: 10, y: 10, w: 8, h: 2.5 },
        },
      ],
      [
        "channel signal text disagrees with authored io.channels signal",
        {
          element: "c",
          deviceUid: "plc",
          functionKey: "di1",
          functionScope: "plc-di1",
          channelLine: "signal",
          text: "NC contact",
          bbox: { x: 10, y: 10, w: 18, h: 2.5 },
        },
      ],
      [
        "partial NC snippet does not match complete authored signal",
        {
          element: "c",
          deviceUid: "plc",
          functionKey: "di1",
          functionScope: "plc-di1",
          channelLine: "signal",
          text: "NC",
          bbox: { x: 10, y: 10, w: 8, h: 2.5 },
        },
      ],
      [
        "non-signal channel line carrying NO/NC",
        {
          element: "c",
          deviceUid: "plc",
          functionKey: "di1",
          functionScope: "plc-di1",
          channelLine: "address",
          text: "%I0.1 NO",
          bbox: { x: 10, y: 10, w: 14, h: 2.5 },
        },
      ],
      [
        "contact caption without channelLine contradicting NO contact",
        {
          element: "c",
          deviceUid: "k1",
          functionKey: "aux13",
          functionScope: "k1-aux13",
          text: "NC",
          bbox: { x: 10, y: 10, w: 8, h: 2.5 },
        },
      ],
    ];
    for (const [label, t] of cases) {
      expect(kinds(contactCaptionAudit({ texts: [t] }, ir)), label).toContain(
        "contact-caption-contradicts-native-role",
      );
    }
  });
});

describe("RL5a V4-01 — DC-output-only fragments in conversion qualifier oracle", () => {
  const sheet = {
    view: { kind: "circuit" },
    references: [{ deviceUid: "ps1", functions: ["dc_output"] }],
  };

  it("positive: repeated DC-output-only fragments and white stroke-none owner rect pass", () => {
    const ir = dcSupplyIr();
    const f1 = makeDcFragment({ scope: "g-32", x: 30, y: 60 });
    const f2 = makeDcFragment({ scope: "g-138", x: 30, y: 105 });
    const multi = {
      shapes: [
        ...f1.shapes,
        ...f2.shapes,
        {
          element: "attach-1",
          shapeTag: "path",
          deviceUid: "ps1",
          attachment: '["ps1","+"]',
          nativeFunctionScope: "g-outer",
          circuitFunctions: [{ deviceUid: "ps1", functionKey: "dc_output" }],
          bbox: { x: 56, y: 65.5, w: 16, h: 0 },
        },
      ],
      terminals: [...f1.terminals, ...f2.terminals],
    };
    expect(conversionQualifierAudit(multi, ir, sheet).findings).toEqual([]);

    const strokeNoneOnly = makeDcFragment({
      scope: "g-50",
      x: 30,
      y: 60,
      outline: false,
    });
    expect(
      conversionQualifierAudit(strokeNoneOnly, ir, sheet).findings,
    ).toEqual([]);
  });

  it("negative: AC mark, reversed DC bars, rotated DC bars, displaced mark, or missing fragment mark/port fail", () => {
    const ir = dcSupplyIr();
    const valid = makeDcFragment({ scope: "g-32", x: 30, y: 60 });

    const plantedAc = makeDcFragment({
      scope: "g-138",
      x: 30,
      y: 105,
      mark: "ac-input",
    });
    expect(
      kinds(
        conversionQualifierAudit(
          {
            shapes: [...valid.shapes, ...plantedAc.shapes],
            terminals: [...valid.terminals, ...plantedAc.terminals],
          },
          ir,
          sheet,
        ),
      ),
    ).toContain("conversion-qualifier-native-owner-unavailable");

    for (const [label, opts, expectedKind] of [
      [
        "reversed DC bars",
        { reversed: true },
        "conversion-qualifier-not-upright",
      ],
      [
        "rotated DC bars",
        { rotated: true },
        "conversion-qualifier-not-upright",
      ],
      [
        "displaced outside own fragment",
        { displaced: true },
        "conversion-qualifier-outside-own-body",
      ],
      [
        "omitted mark on second fragment",
        { omitMark: true },
        "conversion-qualifier-geometry-unavailable",
      ],
      [
        "omitted port on second fragment",
        { omitPort: true },
        "conversion-qualifier-geometry-unavailable",
      ],
      [
        "missing owner enclosure rect",
        { omitOwnerRect: true },
        "conversion-qualifier-geometry-unavailable",
      ],
    ]) {
      const bad = makeDcFragment({ scope: "g-138", x: 30, y: 105, ...opts });
      const audit = conversionQualifierAudit(
        {
          shapes: [...valid.shapes, ...bad.shapes],
          terminals: [...valid.terminals, ...bad.terminals],
        },
        ir,
        sheet,
      );
      expect(kinds(audit), label).toContain(expectedKind);
    }
  });
});

describe("RL5a V5-07 — wrapped detached-element pointer clauses", () => {
  function multiTargetFixture(lines) {
    const x = elementFixture("top-to-bottom");
    x.packet.sheets.push({ ...structuredClone(x.packet.sheets[1]), number: 5 });
    x.geometries.push(structuredClone(x.geometries[1]));
    const base = x.geometries[0].texts.find((t) => t.element === "nav-aux");
    x.geometries[0].texts = x.geometries[0].texts.filter(
      (t) => t.element !== "nav-aux",
    );
    lines.forEach((line, i) => {
      x.geometries[0].texts.push({
        ...structuredClone(base),
        element: `nav-aux-${i}`,
        navigationAnnotation: "el-loc-ol1",
        navigationRole: "element-location",
        text: line,
        anchor: { x: base.bbox.x, y: base.bbox.y + i * 4.8 },
        bbox: { ...base.bbox, y: base.bbox.y + i * 4.8 },
      });
    });
    return x;
  }

  it("positive: reads wrapped sibling lines across trailing commas as one clause", () => {
    const x = multiTargetFixture([
      "OL1: NC contact",
      "95–96 → 02.A1,",
      "05.A1",
    ]);
    const audit = elementNavigationAudit(
      x.packet,
      x.geometries,
      x.ir,
      x.request,
    );
    expect([...audit.findings, ...audit.failures]).toEqual([]);
    expect(audit.obligations).toHaveLength(12);
  });

  it("negative: omitted destination, wrong wrapped zone, or separate trailing subject still fail", () => {
    for (const [label, lines] of [
      ["omits 05.A1", ["OL1: NC contact", "95–96 → 02.A1"]],
      [
        "wrong zone on wrapped line",
        ["OL1: NC contact", "95–96 → 02.A1,", "05.D6"],
      ],
      [
        "new subject after trailing comma does not donate target",
        ["OL1: NC contact", "95–96 → 02.A1,", "NO contact 13–14 → 05.A1"],
      ],
    ]) {
      const x = multiTargetFixture(lines);
      const audit = elementNavigationAudit(
        x.packet,
        x.geometries,
        x.ir,
        x.request,
      );
      expect(kinds(audit), label).toContain(
        "detached-element-reference-missing-or-wrong",
      );
    }
  });
});

function key02Ir() {
  const fn = (deviceUid, functionKey, kind, keys) => ({
    id: { deviceUid, functionKey },
    kind,
    terminals: keys.map((k) => end(deviceUid, k)),
  });
  const imKeys = ["1L+", "1M", "2L+", "2M", "X1.P1.1"];
  const otherKeys = ["1", "2"];
  return {
    devices: [
      { uid: "im", designation: "D1", typeId: "siemens:im" },
      { uid: "other", designation: "D2", typeId: "other:dev" },
    ],
    deviceTypes: [
      {
        id: "siemens:im",
        terminals: imKeys.map((key) => ({ key })),
        connectorPorts: {
          "X1.P1.CONTACTS": { pins: { SHIELD: { terminal: "X1.P1.1" } } },
        },
      },
      { id: "other:dev", terminals: otherKeys.map((key) => ({ key })) },
    ],
    functions: [
      fn("im", "SUPPLY", "load", ["1L+", "1M"]),
      fn("im", "2L+", "bus", ["2L+"]),
      fn("im", "2M", "bus", ["2M"]),
      fn("im", "X1.P1.1", "bus", ["X1.P1.1"]),
      fn("im", "SHIELD", "bus", ["X1.P1.1"]),
      fn("other", "2L+", "load", ["1", "2"]),
    ],
    terminals: [
      ...imKeys.map((k) => ({ id: end("im", k) })),
      ...otherKeys.map((k) => ({ id: end("other", k) })),
    ],
  };
}

function fp01Ir() {
  return {
    devices: [{ uid: "k1", designation: "K1", typeId: "core:contactor" }],
    deviceTypes: [
      {
        id: "core:contactor",
        terminals: [{ key: "A1" }, { key: "A2" }, { key: "13" }],
      },
    ],
    functions: [
      {
        id: { deviceUid: "k1", functionKey: "coil" },
        kind: "coil",
        terminals: [end("k1", "A1"), end("k1", "A2")],
      },
      {
        id: { deviceUid: "k1", functionKey: "aux13" },
        kind: "contact",
        normal_state: "open",
        terminals: [end("k1", "13")],
      },
    ],
    terminals: [
      { id: end("k1", "A1") },
      { id: end("k1", "A2") },
      { id: end("k1", "13") },
    ],
  };
}

describe("RL5a FP-01, KEY-02, and connectorPorts selector scan", () => {
  it("FP-01: accepts 'coil outside view' only with native coil-terminal symbol provenance; rejects raw coil keys", () => {
    const ir = fp01Ir();
    const valid = {
      element: "t-valid",
      text: "coil outside view",
      role: "label-text label-function",
      labelRole: "function",
      labelOwnerKind: "symbol",
      labelOwnerKey: ["terminal", "k1", "A1"],
    };
    expect(functionKeys({ texts: [valid] }, ir)).toEqual([]);

    for (const [label, t] of [
      ["unowned phrase", { element: "t", text: "coil outside view" }],
      [
        "function-owned prefix",
        {
          element: "t",
          text: "coil outside view",
          labelRole: "function",
          labelOwnerKind: "symbol",
          labelOwnerKey: ["function", "k1", "coil"],
        },
      ],
      [
        "non-coil terminal provenance",
        {
          element: "t",
          text: "coil outside view",
          labelRole: "function",
          labelOwnerKind: "symbol",
          labelOwnerKey: ["terminal", "k1", "13"],
        },
      ],
      [
        "raw function key prefix with terminal provenance",
        {
          element: "t",
          text: "coil aux",
          labelRole: "function",
          labelOwnerKind: "symbol",
          labelOwnerKey: ["terminal", "k1", "A1"],
        },
      ],
    ]) {
      expect(functionKeys({ texts: [t] }, ir), label).toMatchObject([
        { kind: "printed-function-key", key: "coil" },
      ]);
    }
  });

  it("KEY-02: classifies native physical terminal/pin names as pin names while failing non-terminal function keys", () => {
    const ir = key02Ir();
    const headingCtx = {
      sheet: { view: { kind: "circuit", title: "IM check" } },
      request: {
        views: [
          {
            title: "IM check",
            groups: [
              {
                id: "g2",
                label: "Different",
                functions: [
                  {
                    device: { by: "designation", value: "D1" },
                    key: "X1.P1.1",
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    for (const [t, ctx] of [
      [{ element: "t", text: "X1.P1.1", deviceUid: "im" }],
      [{ element: "t", text: "X1.P1.1", circuitHeading: "g2" }, headingCtx],
      [{ element: "t", text: "2L+", deviceUid: "im" }],
      [{ element: "t", text: "2M", deviceUid: "im" }],
      [{ element: "t", text: "SHIELD", deviceUid: "im" }],
    ]) {
      expect(functionKeys({ texts: [t] }, ir, ctx)).toEqual([]);
    }
    for (const [text, deviceUid] of [
      ["SUPPLY", "im"],
      ["2L+", "other"],
    ]) {
      expect(
        functionKeys({ texts: [{ element: "t", text, deviceUid }] }, ir),
      ).toMatchObject([{ kind: "printed-function-key", key: text }]);
    }
  });

  it("connectorPorts selector scan flags dotted Device.ConnectorPort while preserving physical W2 -> S1.P", () => {
    const ir = {
      devices: [
        { uid: "r1", designation: "R1", typeId: "t:rack" },
        { uid: "s1", designation: "S1", typeId: "t:field" },
      ],
      deviceTypes: [
        {
          id: "t:rack",
          terminals: [],
          connectorPorts: { X01: { connector: "M12" } },
        },
        {
          id: "t:field",
          terminals: [{ key: "P" }],
          connectorPorts: { P: { connector: "M12" } },
        },
      ],
      functions: [],
      terminals: [{ id: end("s1", "P") }],
    };
    expect(
      functionKeys(
        { texts: [{ element: "t", text: "Port R1: X01 → 02.B3" }] },
        ir,
        { sheet: { view: { kind: "connector-assembly" } } },
      ),
    ).toEqual([]);
    expect(
      functionKeys(
        { texts: [{ element: "t", text: "Port R1.X01 → 02.B3" }] },
        ir,
        { sheet: { view: { kind: "connector-assembly" } } },
      ),
    ).toMatchObject([{ kind: "printed-function-key", key: "R1.X01" }]);
    expect(
      functionKeys({ texts: [{ element: "t", text: "W2 → S1.P" }] }, ir, {
        sheet: { view: { kind: "terminal-strip" } },
      }),
    ).toEqual([]);
    expect(
      functionKeys({ texts: [{ element: "t", text: "S1.P" }] }, ir, {
        sheet: { view: { kind: "assemblies" } },
      }),
    ).toMatchObject([{ kind: "printed-function-key", key: "S1.P" }]);
    expect(
      functionKeys(
        {
          texts: [
            { element: "t", text: "S1.P", peerReference: "assembly-inventory" },
          ],
        },
        ir,
        { sheet: { view: { kind: "circuit" } } },
      ),
    ).toMatchObject([{ kind: "printed-function-key", key: "S1.P" }]);
  });
});

describe("checker protocol 5.55 version and summary compatibility", () => {
  it("bumps EVALS_VERSION to 5.55 while preserving 5.49, 5.51, 5.53, and 5.54 readability", () => {
    expect(EVALS_VERSION).toBe("5.55");
    for (const evalsVersion of ["5.49", "5.51", "5.53", "5.54", "5.55"]) {
      const sample = { evalsVersion, summary: { "DQ-05": { pass: 1 } } };
      expect(readReportSummary(sample)).toEqual(sample.summary);
    }
    for (const skipped of ["5.50", "5.52"]) {
      expect(() =>
        readReportSummary({ evalsVersion: skipped, summary: {} }),
      ).toThrow(/Unsupported report summary version/);
    }
  });
});
