import { describe, expect, it } from "vitest";
import { contactCaptionAudit } from "./contact-role-oracle.mjs";
import { contactCaptionMediaAudit } from "./contact-role-media.mjs";
import { conversionQualifierAudit } from "./qualifier-oracle.mjs";
import { functionKeys } from "./checks.mjs";
import { segments } from "./tranche3-geometry.mjs";
import { end, nativeIr } from "./tranche3-fixtures.mjs";

const kinds = (a) => a.findings.map((f) => f.kind);

function channelIr(signal = "NC") {
  const ir = nativeIr();
  ir.devices = [
    {
      uid: "plc",
      designation: "PLC1",
      typeId: "core:plc",
      io: { channels: { di1: { address: "%I0.1", signal, usage: "in-use" } } },
    },
    { uid: "k1", designation: "K1", typeId: "core:contactor" },
  ];
  ir.deviceTypes = [
    { id: "core:plc", terminals: [{ key: "DI1", role: "signal" }] },
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

const channelText = (text, extra = {}) => ({
  element: "signal",
  deviceUid: "plc",
  functionKey: "di1",
  functionScope: "channel-scope",
  appearanceScope: "svg-1",
  channelLine: "signal",
  text,
  bbox: { x: 10, y: 10, w: 25, h: 3 },
  ...extra,
});

const contactText = (text, extra = {}) =>
  channelText(text, {
    deviceUid: "k1",
    functionKey: "aux13",
    functionScope: "contact-scope",
    ...extra,
  });

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

function makeDcMark(scope, mx, my, rotated) {
  const base = {
    deviceUid: "ps1",
    functionKey: "dc_output",
    nativeFunctionScope: scope,
    circuitFunctions: [{ deviceUid: "ps1", functionKey: "dc_output" }],
    mark: "dc-output",
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
  const bars = rotated
    ? [
        [mx + 2, my + 2, mx + 2, my + 8],
        [mx + 5, my + 2, mx + 5, my + 3],
        [mx + 5, my + 4, mx + 5, my + 6],
        [mx + 5, my + 7, mx + 5, my + 8],
      ]
    : [
        [mx + 1, my + 4, mx + 5, my + 4],
        [mx + 1, my + 7, mx + 1.8, my + 7],
        [mx + 2.3, my + 7, mx + 3.7, my + 7],
        [mx + 4.2, my + 7, mx + 5, my + 7],
      ];
  return [
    mk("rect", "rect", [
      { x: mx, y: my },
      { x: mx + 6.7, y: my + 10 },
    ]),
    ...bars.map(([x1, y1, x2, y2], i) =>
      mk("line", `bar-${i}`, [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ]),
    ),
  ];
}

function makeDcFragment({
  scope,
  x = 30,
  y = 60,
  rotated = false,
  omitOwnerRect = false,
}) {
  const fnId = { deviceUid: "ps1", functionKey: "dc_output" };
  const shapes = omitOwnerRect
    ? []
    : [
        {
          element: `${scope}-owner`,
          shapeTag: "rect",
          deviceUid: "ps1",
          nativeFunctionScope: scope,
          circuitFunctions: [fnId],
          outline: false,
          stroke: 0,
          fill: "rgb(255, 255, 255)",
          bbox: { x, y, w: 26, h: 18 },
        },
      ];
  shapes.push(...makeDcMark(scope, x + 9, y + 4, rotated));
  const terminals = [
    {
      deviceUid: "ps1",
      terminal: "+",
      nativeFunctionScope: scope,
      point: { x: x + 26, y: y + 5.5 },
    },
    {
      deviceUid: "ps1",
      terminal: "-",
      nativeFunctionScope: scope,
      point: { x: x + 26, y: y + 12.5 },
    },
  ];
  return { shapes, terminals };
}

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

describe("RL5a round-2 Finding 3 & 4 — V2-01 contact owner, wrapping, adjacency, and media independence", () => {
  it("judges a measured native contact owner against its contact role even with forged channel labelOwnerKey", () => {
    const ir = channelIr("NC");
    const forged = contactText("NC", {
      labelOwnerKey: ["function", "plc", "di1"],
    });
    expect(kinds(contactCaptionAudit({ texts: [forged] }, ir))).toContain(
      "contact-caption-contradicts-native-role",
    );
  });

  it("rejects whitespace-removal token merges and non-adjacent distant signal rows", () => {
    const splitBoundary = contactCaptionAudit(
      {
        texts: [
          channelText("Stop"),
          channelText("NC", {
            element: "suffix",
            bbox: { x: 10, y: 14, w: 4, h: 3 },
          }),
        ],
      },
      channelIr("Stop N C"),
    );
    expect(kinds(splitBoundary)).toContain(
      "contact-caption-contradicts-native-role",
    );

    const distant = contactCaptionAudit(
      {
        texts: [
          channelText("Stop"),
          channelText("NC", {
            element: "suffix",
            bbox: { x: 145, y: 143, w: 4, h: 3 },
          }),
        ],
      },
      channelIr("Stop NC"),
    );
    expect(kinds(distant)).toContain("contact-caption-contradicts-native-role");
  });

  it("audits HTML and PDF captions independently even when SVG channel signal is exempt", () => {
    const ir = channelIr("Stop NC");
    const sg = channelText("Stop NC");
    const hg = { ...sg, text: "Start NO" };
    const pGood = { text: "Stop NC", bbox: sg.bbox };
    const pBad = { text: "Start NO", bbox: sg.bbox };

    const htmlOnly = contactCaptionMediaAudit(
      { texts: [sg], htmlTexts: [hg], tranche3: { pdfTexts: [pGood] } },
      ir,
    );
    expect(
      htmlOnly.findings.some(
        (f) =>
          f.medium === "html" &&
          f.kind === "contact-caption-contradicts-native-role",
      ),
    ).toBe(true);

    const pdfOnly = contactCaptionMediaAudit(
      { texts: [sg], htmlTexts: [sg], tranche3: { pdfTexts: [pBad] } },
      ir,
    );
    expect(
      pdfOnly.findings.some(
        (f) =>
          f.medium === "pdf" &&
          f.kind === "contact-caption-contradicts-native-role",
      ),
    ).toBe(true);

    const otherContact = contactText("NO", {
      element: "actual-contact",
      bbox: { x: 60, y: 10, w: 5, h: 3 },
    });
    const pdfWithOther = contactCaptionMediaAudit(
      {
        texts: [sg, otherContact],
        htmlTexts: [sg, otherContact],
        tranche3: { pdfTexts: [pBad, { text: "NO", bbox: otherContact.bbox }] },
      },
      ir,
    );
    expect(
      pdfWithOther.findings.some(
        (f) =>
          f.medium === "pdf" &&
          f.kind === "contact-caption-contradicts-native-role",
      ),
    ).toBe(true);
  });
});

describe("RL5a round-2 Finding 1 & 5 — V4-01 unscoped qualifier ink and attachment enclosure exclusion", () => {
  const ds = {
    view: { kind: "circuit" },
    references: [{ deviceUid: "ps1", functions: ["dc_output"] }],
  };
  const pair = (a, b) => ({
    shapes: [...a.shapes, ...b.shapes],
    terminals: [...a.terminals, ...b.terminals],
  });

  it("audits unscoped qualifier ink when another scoped fragment exists", () => {
    const dc = dcSupplyIr();
    const f1 = makeDcFragment({ scope: "s1" });
    const badUnscoped = makeDcFragment({ scope: "s2", y: 105, rotated: true });
    for (const item of [...badUnscoped.shapes, ...badUnscoped.terminals]) {
      delete item.nativeFunctionScope;
      item.circuitFunctions = [];
    }
    const audit = conversionQualifierAudit(pair(f1, badUnscoped), dc, ds);
    expect(audit.findings.length).toBeGreaterThan(0);
  });

  it("excludes data-terminal-attachment rectangles from fragment enclosure selection", () => {
    const dc = dcSupplyIr();
    const f1 = makeDcFragment({ scope: "s1" });
    const badAttach = makeDcFragment({
      scope: "s2",
      y: 105,
      omitOwnerRect: true,
    });
    badAttach.shapes.unshift({
      element: "attachment-backdrop",
      shapeTag: "rect",
      deviceUid: "ps1",
      nativeFunctionScope: "s2",
      attachment: '["ps1","+"]',
      bbox: { x: 30, y: 105, w: 26, h: 18 },
    });
    const audit = conversionQualifierAudit(pair(f1, badAttach), dc, ds);
    expect(kinds(audit)).toContain("conversion-qualifier-geometry-unavailable");
  });
});

describe("RL5a round-2 Finding 6, 7 & 8 — KEY-02 owner context, FP-01 ownership, selector scan & boundaries", () => {
  it("KEY-02: exempts pin names only for the exact owning device and complete token", () => {
    const ir = key02Ir();
    const headCtx = {
      sheet: { view: { kind: "circuit", title: "Control" } },
      request: {
        views: [
          {
            title: "Control",
            groups: [
              {
                id: "g",
                label: "Human caption",
                functions: [
                  { device: { by: "uid", value: "other" }, key: "2L+" },
                  { device: { by: "uid", value: "im" }, key: "SUPPLY" },
                ],
              },
            ],
          },
        ],
      },
    };
    const cases = [
      [
        "mixed heading borrows other pin",
        "2L+",
        { circuitHeading: "g" },
        headCtx,
      ],
      [
        "mixed heading with explicit other function owner",
        "2L+",
        { circuitHeading: "g", deviceUid: "other", functionKey: "2L+" },
        headCtx,
      ],
      [
        "raw function-key prefix followed by more text",
        "2L+ raw_leak",
        { deviceUid: "im", functionKey: "2L+" },
        {},
      ],
      ["other device prints im pin name", "2M", { deviceUid: "other" }, {}],
      [
        "mismatched label-owner metadata on other device",
        "2L+",
        {
          deviceUid: "other",
          functionKey: "2L+",
          labelOwnerKey: ["function", "im", "2L+"],
        },
        {},
      ],
    ];
    for (const [label, text, extra, ctx] of cases) {
      expect(
        functionKeys({ texts: [{ element: "t", text, ...extra }] }, ir, ctx)
          .length,
        label,
      ).toBeGreaterThan(0);
    }
  });

  it("FP-01: rejects forged extra tuple components and conflicting native function ownership", () => {
    const ir = fp01Ir();
    const caption = {
      element: "t",
      text: "coil outside view",
      labelRole: "function",
      labelOwnerKind: "symbol",
      labelOwnerKey: ["terminal", "k1", "A1"],
    };
    expect(
      functionKeys(
        {
          texts: [
            { ...caption, labelOwnerKey: ["terminal", "k1", "A1", "extra"] },
          ],
        },
        ir,
      ),
    ).toMatchObject([{ kind: "printed-function-key", key: "coil" }]);
    expect(
      functionKeys(
        { texts: [{ ...caption, deviceUid: "k1", functionKey: "coil" }] },
        ir,
      ),
    ).toMatchObject([{ kind: "printed-function-key", key: "coil" }]);
  });

  it("selector scan (a): catches dotted Device.Port without assembly provenance marker", () => {
    const ci = {
      devices: [
        { uid: "s1", designation: "S1", typeId: "t:field" },
        { uid: "r1", designation: "R1", typeId: "t:rack" },
      ],
      deviceTypes: [
        {
          id: "t:field",
          terminals: [{ key: "P" }],
          connectorPorts: { P: { connector: "M12" } },
        },
        {
          id: "t:rack",
          terminals: [],
          connectorPorts: { X01: { connector: "M12" } },
        },
      ],
      functions: [],
      terminals: [{ id: end("s1", "P") }],
    };
    expect(
      functionKeys(
        { texts: [{ element: "t", text: "Port S1.P → 02.A1" }] },
        ci,
        { sheet: { view: { kind: "circuit" } } },
      ),
    ).toMatchObject([{ kind: "printed-function-key", key: "S1.P" }]);
  });

  it("selector scan (b): matches selectors on whole-token boundaries so S1.P.1 is not flagged as S1.P", () => {
    const boundaryIr = {
      devices: [{ uid: "s1", designation: "S1", typeId: "field" }],
      deviceTypes: [
        {
          id: "field",
          terminals: [{ key: "P.1" }],
          connectorPorts: {
            P: { connector: "M12", pins: { 1: { terminal: "P.1" } } },
          },
        },
      ],
      terminals: [{ id: end("s1", "P.1") }],
      functions: [],
    };
    const wireCtx = { sheet: { view: { kind: "wires" } } };
    expect(
      functionKeys(
        {
          texts: [
            { element: "t", text: "W2 → S1.P.1", row: "wire", columnIndex: 4 },
          ],
        },
        boundaryIr,
        wireCtx,
      ),
    ).toEqual([]);
    expect(
      functionKeys(
        {
          texts: [{ element: "t", text: "S1.P", row: "wire", columnIndex: 4 }],
        },
        boundaryIr,
        wireCtx,
      ),
    ).toMatchObject([{ kind: "printed-function-key", key: "S1.P" }]);
    expect(
      functionKeys(
        {
          texts: [{ element: "t", text: "S1: P", row: "wire", columnIndex: 4 }],
        },
        boundaryIr,
        wireCtx,
      ),
    ).toEqual([]);
  });
});
