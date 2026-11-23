import { afterAll, beforeAll, expect, it } from "vitest";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { fixture } from "./m3-fixture.mjs";
import { nativeRows } from "./m3-native.mjs";
import { peerReferenceFindings } from "./issued-reference-audit.mjs";
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
