import { afterAll, beforeAll, expect, it } from "vitest";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { fixture } from "./m3-fixture.mjs";
import { nativeRows } from "./m3-native.mjs";
import { peerReferenceFindings } from "./issued-reference-audit.mjs";
import { boxGap, foreignConductorBoxes } from "./peer-owner-ink.mjs";
import { terminalPeerObligations } from "./terminal-peer-oracle.mjs";
import { wireLocatorAudit } from "./wire-locators.mjs";

let browser, context, page;
beforeAll(async () => {
  browser = await launch();
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
});
afterAll(async () => {
  await context?.close();
  await browser?.close();
});

const svg = (body) =>
  embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200" font-family="Thermite Sans, sans-serif">${body}</svg>`,
  );
const text = (x, y, value, extra = "") =>
  `<text x="${x}" y="${y}" font-size="2.5"${extra}>${value}</text>`;

function zoneGrid() {
  // 6 columns of 30 mm starting at x=15 (col 1: 15..45, col 2: 45..75, col 3: 75..105, ...),
  // 4 rows of 40 mm starting at y=22 (row A: 22..62, row B: 62..102, ...).
  return (
    Array.from({ length: 6 }, (_, i) =>
      text(30 + i * 30, 12, String(i + 1)),
    ).join("") + [..."ABCD"].map((t, i) => text(10, 42 + i * 40, t)).join("")
  );
}

function twoDeviceIr() {
  const ir = fixture().ir;
  ir.devices = [
    { uid: "ps1", designation: "PS1", typeId: "t" },
    { uid: "s1", designation: "S1", typeId: "t" },
  ];
  ir.deviceTypes[0].terminals = [
    { key: "+", description: "24V+" },
    { key: "13", description: "NO" },
  ];
  ir.terminals = [
    { id: { deviceUid: "ps1", terminalKey: "+" } },
    { id: { deviceUid: "s1", terminalKey: "13" } },
  ];
  ir.functions = [];
  ir.internalRelations = [];
  ir.wires = [
    {
      uid: "w1",
      designation: "W-CTL-010",
      endpoints: [
        { terminal: { deviceUid: "ps1", terminalKey: "+" } },
        { terminal: { deviceUid: "s1", terminalKey: "13" } },
      ],
    },
  ];
  return ir;
}

function wireScheduleSvg(fromLoc, toLoc) {
  const headers = [
    "Conductor / label",
    "End A / first endpoint",
    "End B / second endpoint",
    "Color / size",
    "Assignment",
    "From sheet.zone",
    "To sheet.zone",
  ];
  const makeRow = (header) => {
    const vals = header
      ? headers
      : ["W-CTL-010", "PS1.+", "S1.13", "Blue", "Connected", fromLoc, toLoc];
    const y = header ? 20 : 50;
    return (
      `<g ${header ? "" : 'data-report-row="w1"'}>` +
      vals
        .map(
          (v, i) =>
            `<rect x="${20 + i * 35}" y="${y}" width="35" height="20" fill="white" stroke="#9ba6b4"/>` +
            `<g data-report-column="${i + 1}">${text(22 + i * 35, y + 8, v)}</g>`,
        )
        .join("") +
      `</g>`
    );
  };
  return svg(`<g data-document-id="doc">${makeRow(true)}${makeRow(false)}</g>`);
}

function sourceWithBranchSvg(branchMarkup, cardLoc) {
  const card =
    `<g class="off-view-annotation" data-off-view-terminal-id='{"deviceUid":"ps1","terminalKey":"+"}' data-off-view-conductors='[{"kind":"wire","uid":"w1"}]'>` +
    `<rect x="130" y="30" width="60" height="16" fill="white" stroke="#101828"/>` +
    `<text class="off-view-heading" x="132" y="35" font-size="2.5">Off-view at PS1.+</text>` +
    `<text class="off-view-row" x="132" y="42" font-size="2.5">W-CTL-010 → S1.13 ${cardLoc}</text>` +
    `</g>`;
  // Branch dot is in zone B3 (x=90, y=82); physical PS1.+ terminal-marker is in zone B2 (x=60, y=82).
  const physical = `<circle class="terminal-marker" data-device-uid="ps1" data-terminal-key="+" cx="60" cy="82" r="1.2" fill="white" stroke="#101828"/>`;
  return svg(zoneGrid() + branchMarkup + physical + card);
}

function peerSheetSvg(printedLoc) {
  const peerSource = JSON.stringify([
    { deviceUid: "s1", terminalKey: "13" },
    { kind: "wire", uid: "w1" },
    { deviceUid: "ps1", terminalKey: "+" },
  ]).replaceAll('"', "&quot;");
  // S1.13 is at B2 (x=60, y=82).
  return svg(
    zoneGrid() +
      `<circle class="terminal-marker" data-device-uid="s1" data-terminal-key="13" cx="60" cy="82" r="1.2" fill="white" stroke="#101828"/>` +
      text(
        64,
        82,
        `W-CTL-010 · S1.13 → PS1.+ ${printedLoc}`,
        ` data-peer-reference="conductor-peer" data-peer-source="${peerSource}"`,
      ),
  );
}

const PACKET = {
  sheets: [
    {
      number: 1,
      view: { kind: "wiring", format: "documentation-view/0.1" },
    },
    {
      number: 2,
      view: { kind: "circuit", format: "documentation-view/0.1" },
    },
    {
      number: 3,
      view: { kind: "wires", format: "documentation-view/0.1" },
    },
  ],
};

function assertPeerAndWireAudits(ir, g1, g2Wrong, g2Right, g3Wrong, g3Right) {
  const sources = nativeRows(ir);
  const wrongObls = terminalPeerObligations(
    PACKET,
    [g1, g2Wrong, g3Wrong],
    ir,
    sources,
  );
  expect(
    peerReferenceFindings(
      2,
      g2Wrong,
      wrongObls.filter((o) => o.sheet === 2),
    ).map((f) => f.kind),
  ).toContain("issued-peer-reference-unbound");

  const rightObls = terminalPeerObligations(
    PACKET,
    [g1, g2Right, g3Right],
    ir,
    sources,
  );
  expect(
    peerReferenceFindings(
      2,
      g2Right,
      rightObls.filter((o) => o.sheet === 2),
    ),
  ).toEqual([]);

  expect(
    wireLocatorAudit(PACKET, [g1, g2Wrong, g3Wrong], ir).findings.map(
      (f) => f.kind,
    ),
  ).toContain("wire-locator-mismatch");
  expect(wireLocatorAudit(PACKET, [g1, g2Right, g3Right], ir).findings).toEqual(
    [],
  );
}

it.each([
  [
    "filled junction-dot",
    '<circle class="junction-dot" data-device-uid="ps1" data-terminal-key="+" cx="90" cy="82" r="1.5" fill="#101828" stroke="none"/>',
  ],
  [
    "stroked junction-dot",
    '<circle class="junction-dot" data-device-uid="ps1" data-terminal-key="+" cx="90" cy="82" r="1.5" fill="#101828" stroke="#101828"/>',
  ],
  [
    "circuit junction",
    '<circle data-circuit-junction="true" data-device-uid="ps1" data-terminal-key="+" cx="90" cy="82" r="1.2" fill="#17212b" stroke="#17212b"/>',
  ],
])(
  "DQ-08 peer audit and DQ-19 wire locator audit reject %s zone (01.B3) and accept physical terminal zone (01.B2)",
  async (_kind, branchMarkup) => {
    const ir = twoDeviceIr();
    const g1 = await openSheet(
      page,
      sourceWithBranchSvg(branchMarkup, "02.B2"),
    );
    const g2Wrong = await openSheet(page, peerSheetSvg("01.B3"));
    const g2Right = await openSheet(page, peerSheetSvg("01.B2"));
    const g3Wrong = await openSheet(page, wireScheduleSvg("01.B3", "02.B2"));
    const g3Right = await openSheet(page, wireScheduleSvg("01.B2", "02.B2"));

    // Junction circles stay visible to DQ-13 (marked junction: true) but are excluded from wireTerminals.
    const branchMarker = g1.tranche4.markers.find(
      (m) => Math.abs(m.point.x - 90) < 2,
    );
    expect(branchMarker?.junction).toBe(true);
    expect(g1.wireTerminals.some((m) => Math.abs(m.point.x - 90) < 2)).toBe(
      false,
    );
    assertPeerAndWireAudits(ir, g1, g2Wrong, g2Right, g3Wrong, g3Right);
  },
  60_000,
);

it("DQ-19 detects circuit boundary port-group terminals and rejects not drawn or junction zones", async () => {
  const ir = twoDeviceIr();
  // PS1.+ appears ONLY as a circuit boundary port group (unkeyed circle inside g[data-terminal-id])
  // at zone B2 (x=60, y=82), preceded by a circuit junction dot in zone B3 (x=90, y=82).
  const circuitSheet = svg(
    zoneGrid() +
      `<circle data-circuit-junction="true" data-device-uid="ps1" data-terminal-key="+" cx="90" cy="82" r="0.55" fill="#17212b"/>` +
      `<g data-device-uid="ps1">` +
      `<g data-layout-port="n0p0" data-terminal-id='["ps1","+"]' data-terminal-key="+">` +
      `<circle cx="60" cy="82" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/>` +
      `</g></g>` +
      `<g data-device-uid="s1">` +
      `<g data-layout-port="n1p0" data-terminal-id='["s1","13"]' data-terminal-key="13">` +
      `<circle cx="120" cy="82" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/>` +
      `</g></g>`,
  );
  const circuitPacket = {
    sheets: [
      {
        number: 1,
        view: { kind: "circuit", format: "documentation-view/0.1" },
      },
      { number: 2, view: { kind: "wires", format: "documentation-view/0.1" } },
    ],
  };
  const gCircuit = await openSheet(page, circuitSheet);
  const gNotDrawn = await openSheet(
    page,
    wireScheduleSvg("not drawn", "01.B4"),
  );
  const gJunctionZone = await openSheet(
    page,
    wireScheduleSvg("01.B3", "01.B4"),
  );
  const gPhysicalZone = await openSheet(
    page,
    wireScheduleSvg("01.B2", "01.B4"),
  );

  expect(
    wireLocatorAudit(circuitPacket, [gCircuit, gNotDrawn], ir).findings.map(
      (f) => f.kind,
    ),
  ).toContain("wire-locator-undrawn-claim");
  expect(
    wireLocatorAudit(circuitPacket, [gCircuit, gJunctionZone], ir).findings.map(
      (f) => f.kind,
    ),
  ).toContain("wire-locator-mismatch");
  expect(
    wireLocatorAudit(circuitPacket, [gCircuit, gPhysicalZone], ir).findings,
  ).toEqual([]);
}, 60_000);

function foreignConductorFixture() {
  const ir = twoDeviceIr();
  ir.devices.push({ uid: "s2", designation: "S2", typeId: "t" });
  ir.deviceTypes[0].terminals.push({ key: "11", description: "NC" });
  ir.terminals.push({ id: { deviceUid: "s2", terminalKey: "11" } });
  ir.wires.push({
    uid: "w2",
    designation: "W-CTL-012",
    endpoints: [
      { terminal: { deviceUid: "ps1", terminalKey: "+" } },
      { terminal: { deviceUid: "s2", terminalKey: "11" } },
    ],
  });
  const s1Card = svg(
    zoneGrid() +
      `<circle class="terminal-marker" data-device-uid="ps1" data-terminal-key="+" cx="60" cy="82" r="1.2" fill="white" stroke="#101828"/>` +
      `<g class="off-view-annotation" data-off-view-terminal-id='{"deviceUid":"ps1","terminalKey":"+"}' data-off-view-conductors='[{"kind":"wire","uid":"w2"}]'>` +
      `<rect x="130" y="30" width="60" height="16" fill="white" stroke="#101828"/>` +
      `<text class="off-view-heading" x="132" y="35" font-size="2.5">Off-view at PS1.+</text>` +
      `<text class="off-view-row" x="132" y="42" font-size="2.5">W-CTL-012 → S2.11 02.B3</text>` +
      `</g>`,
  );
  const peerSourceW2 = JSON.stringify([
    { deviceUid: "ps1", terminalKey: "+" },
    { kind: "wire", uid: "w2" },
    { deviceUid: "s2", terminalKey: "11" },
  ]).replaceAll('"', "&quot;");
  const peerSourceRev = JSON.stringify([
    { deviceUid: "s2", terminalKey: "11" },
    { kind: "wire", uid: "w2" },
    { deviceUid: "ps1", terminalKey: "+" },
  ]).replaceAll('"', "&quot;");
  const makeS2 = (noteMarkup) =>
    svg(
      zoneGrid() +
        `<g data-device-uid="ps1"><g data-layout-port="p0" data-terminal-id='["ps1","+"]' data-terminal-key="+"><circle cx="54" cy="96" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/></g></g>` +
        `<g data-device-uid="s1"><g data-layout-port="p1" data-terminal-id='["s1","13"]' data-terminal-key="13"><circle cx="103" cy="65" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/></g></g>` +
        `<g data-device-uid="s2"><g data-layout-port="p2" data-terminal-id='["s2","11"]' data-terminal-key="11"><circle cx="103" cy="96" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/></g></g>` +
        `<g data-circuit-conductor="w1"><path d="M 72 96 H 75 V 65 H 103" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
        `<g data-circuit-conductor="w2"><path d="M 72 96 H 103" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
        `<circle data-circuit-junction="true" data-device-uid="ps1" data-terminal-key="+" cx="75" cy="96" r="0.55" fill="#17212b"/>` +
        text(
          104,
          100,
          "W-CTL-012 · S2.11 → PS1.+ 01.B2",
          ` data-peer-reference="conductor-peer" data-peer-source="${peerSourceRev}"`,
        ) +
        noteMarkup,
    );
  return { ir, s1Card, makeS2, peerSourceW2 };
}

it("DQ-08 rejects a peer note sitting nearer a foreign conductor run than its own terminal or conductor", async () => {
  const { ir, s1Card, makeS2, peerSourceW2 } = foreignConductorFixture();
  const badNote =
    `<g data-peer-reference="conductor-peer" data-peer-source="${peerSourceW2}">` +
    text(76.7, 88.2, "W-CTL-012 · PS1.+") +
    text(76.7, 91.7, "→ S2.11 02.B3") +
    `</g>`;
  const goodNote = text(
    55.5,
    101.0,
    "W-CTL-012 · PS1.+ → S2.11 02.B3",
    ` data-peer-reference="conductor-peer" data-peer-source="${peerSourceW2}"`,
  );
  const pkt = {
    sheets: [
      { number: 1, view: { kind: "wiring", format: "documentation-view/0.1" } },
      {
        number: 2,
        view: { kind: "circuit", format: "documentation-view/0.1" },
      },
    ],
  };
  const g1 = await openSheet(page, s1Card);
  const g2Bad = await openSheet(page, makeS2(badNote));
  const g2Good = await openSheet(page, makeS2(goodNote));
  const sources = nativeRows(ir);

  const badObls = terminalPeerObligations(pkt, [g1, g2Bad], ir, sources).filter(
    (o) => o.sheet === 2,
  );
  expect(peerReferenceFindings(2, g2Bad, badObls).map((f) => f.kind)).toContain(
    "issued-peer-reference-foreign-owner",
  );
  const goodObls = terminalPeerObligations(
    pkt,
    [g1, g2Good],
    ir,
    sources,
  ).filter((o) => o.sheet === 2);
  expect(peerReferenceFindings(2, g2Good, goodObls)).toEqual([]);

  // Coincident shared stem [72, 75] at y=96 must be excluded from foreignConductorBoxes(w2),
  // leaving w1's distinct vertical run at x=75 (~4.05 mm from goodNote, strictly > own gap ~3.46 mm).
  const noteBox = g2Good.texts.find((t) =>
    t.text.includes("W-CTL-012 · PS1.+ → S2.11"),
  ).bbox;
  const w2Foreign = foreignConductorBoxes(g2Good, { kind: "wire", uid: "w2" });
  const w2OwnGap = Math.min(
    ...goodObls
      .find((o) => o.ownerLabel === "PS1.+")
      .supports.map((b) => boxGap(noteBox, b)),
  );
  const w2ForeignGap = Math.min(...w2Foreign.map((b) => boxGap(noteBox, b)));
  expect(w2OwnGap).toBeLessThan(w2ForeignGap - 0.3);

  // Relative to w1, the shared stem [72, 74.4] is excluded while w2's non-coincident [75.6, 103] remains.
  const w1Foreign = foreignConductorBoxes(g2Good, { kind: "wire", uid: "w1" });
  const stemProbe = { x: 72.0, y: 99.5, w: 1, h: 1 };
  const contProbe = { x: 85, y: 99.5, w: 2, h: 1 };
  expect(
    Math.min(...w1Foreign.map((b) => boxGap(stemProbe, b))),
  ).toBeGreaterThan(4.0);
  expect(Math.min(...w1Foreign.map((b) => boxGap(contProbe, b)))).toBeLessThan(
    3.6,
  );
}, 60_000);

it.each([
  [
    "extra painted circle before marker",
    `<g data-device-uid="ps1"><g data-layout-port="n0p0" data-terminal-id='["ps1","+"]' data-terminal-key="+">` +
      `<circle class="unrelated-ring" cx="60" cy="122" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/>` +
      `<circle cx="60" cy="82" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/>` +
      `</g></g>`,
    "01.C2",
  ],
  [
    "extra painted circle after marker",
    `<g data-device-uid="ps1"><g data-layout-port="n0p0" data-terminal-id='["ps1","+"]' data-terminal-key="+">` +
      `<circle cx="60" cy="82" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/>` +
      `<circle class="unrelated-ring" cx="60" cy="122" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/>` +
      `</g></g>`,
    "01.C2",
  ],
  [
    "unpainted-only circle (fill none, stroke-width 0)",
    `<g data-device-uid="ps1"><g data-layout-port="n0p0" data-terminal-id='["ps1","+"]' data-terminal-key="+">` +
      `<circle class="unrelated-ring" cx="60" cy="122" r="0.65" fill="none" stroke="#17212b" stroke-width="0"/>` +
      `</g></g>`,
    "01.C2",
  ],
])(
  "DQ-19 rejects ambiguous or unpainted port-group fallback (%s)",
  async (_label, ps1Port, claimedLoc) => {
    const ir = twoDeviceIr();
    const circuitSheet = svg(
      zoneGrid() +
        ps1Port +
        `<g data-device-uid="s1"><g data-layout-port="n1p0" data-terminal-id='["s1","13"]' data-terminal-key="13">` +
        `<circle cx="120" cy="82" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/>` +
        `</g></g>`,
    );
    const circuitPacket = {
      sheets: [
        {
          number: 1,
          view: { kind: "circuit", format: "documentation-view/0.1" },
        },
        {
          number: 2,
          view: { kind: "wires", format: "documentation-view/0.1" },
        },
      ],
    };
    const gCircuit = await openSheet(page, circuitSheet);
    const gForged = await openSheet(page, wireScheduleSvg(claimedLoc, "01.B4"));
    const gRealZone = await openSheet(page, wireScheduleSvg("01.B2", "01.B4"));
    const gNotDrawn = await openSheet(
      page,
      wireScheduleSvg("not drawn", "01.B4"),
    );
    expect(
      gCircuit.wireTerminals.filter(
        (m) => JSON.stringify(m.terminal) === '["ps1","+"]',
      ),
    ).toEqual([]);
    expect(
      wireLocatorAudit(circuitPacket, [gCircuit, gForged], ir).findings.map(
        (f) => f.kind,
      ),
    ).toContain("wire-locator-without-appearance");
    expect(
      wireLocatorAudit(circuitPacket, [gCircuit, gRealZone], ir).findings.map(
        (f) => f.kind,
      ),
    ).toContain("wire-locator-without-appearance");
    expect(
      wireLocatorAudit(circuitPacket, [gCircuit, gNotDrawn], ir).findings,
    ).toEqual([]);
  },
  60_000,
);

it("DQ-19 keeps a conflicting explicit child identity separate from its parent port group", async () => {
  const ir = twoDeviceIr();
  const circuitSheet = svg(
    zoneGrid() +
      `<g data-device-uid="ps1"><g data-layout-port="n0p0" data-terminal-id='["ps1","+"]' data-terminal-key="+">` +
      `<circle data-device-uid="s1" data-terminal-key="13" cx="120" cy="82" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/>` +
      `</g></g>`,
  );
  const circuitPacket = {
    sheets: [
      {
        number: 1,
        view: { kind: "circuit", format: "documentation-view/0.1" },
      },
      { number: 2, view: { kind: "wires", format: "documentation-view/0.1" } },
    ],
  };
  const gCircuit = await openSheet(page, circuitSheet);
  const gSchedule = await openSheet(
    page,
    wireScheduleSvg("not drawn", "01.B4"),
  );
  expect(gCircuit.wireTerminals.map((m) => JSON.stringify(m.terminal))).toEqual(
    ['["s1","13"]'],
  );
  expect(
    wireLocatorAudit(circuitPacket, [gCircuit, gSchedule], ir).findings,
  ).toEqual([]);
}, 60_000);
