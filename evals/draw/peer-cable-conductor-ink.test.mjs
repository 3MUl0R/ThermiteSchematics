import { afterAll, beforeAll, expect, it } from "vitest";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { peerReferenceFindings } from "./issued-reference-audit.mjs";
import { fixture } from "./m3-fixture.mjs";
import { nativeRows } from "./m3-native.mjs";
import { conductorInk } from "./peer-owner-ink.mjs";
import { terminalPeerObligations } from "./terminal-peer-oracle.mjs";

let browser, context, page;
beforeAll(async () => {
  browser = await launch([
    "--enable-blink-features=CanvasTextMetricsPreciseBounds",
  ]);
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
const zoneGrid = () =>
  Array.from({ length: 6 }, (_, i) =>
    text(30 + i * 30, 12, String(i + 1)),
  ).join("") + [..."ABCD"].map((t, i) => text(10, 42 + i * 40, t)).join("");

const marker = (dev, key, x, y) =>
  `<g data-device-uid="${dev}"><g data-terminal-id='${JSON.stringify([dev, key])}' data-terminal-key="${key}"><circle class="terminal-marker" data-terminal-marker="true" data-terminal-key="${key}" cx="${x}" cy="${y}" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/></g></g>`;

const card = (dev, key, x, y, conductors, heading, rows) =>
  `<g class="off-view-annotation" data-off-view-terminal-id='${JSON.stringify({ deviceUid: dev, terminalKey: key })}' data-off-view-conductors='${JSON.stringify(conductors)}'>` +
  `<rect x="${x}" y="${y}" width="72" height="${10 + rows.length * 6}" fill="white" stroke="#101828"/>` +
  `<text class="off-view-heading" x="${x + 2}" y="${y + 5}" font-size="2.5">${heading}</text>` +
  rows
    .map(
      (r, i) =>
        `<text class="off-view-row" x="${x + 2}" y="${y + 11 + i * 6}" font-size="2.5">${r}</text>`,
    )
    .join("") +
  `</g>`;

function cableCoreIr() {
  const ir = fixture().ir;
  ir.devices = [
    { uid: "b1", designation: "B1", typeId: "t" },
    { uid: "jb1", designation: "JB1", typeId: "t" },
    { uid: "tb1", designation: "TB1", typeId: "t" },
  ];
  ir.deviceTypes[0].terminals = [
    { key: "4", description: "OUT" },
    { key: "X1.3", description: "SIG" },
    { key: "3", description: "SIG" },
  ];
  ir.terminals = [
    { id: { deviceUid: "b1", terminalKey: "4" } },
    { id: { deviceUid: "jb1", terminalKey: "X1.3" } },
    { id: { deviceUid: "tb1", terminalKey: "3" } },
  ];
  ir.functions = [];
  ir.internalRelations = [];
  ir.wires = [];
  ir.jumpers = [];
  ir.cables = [
    { uid: "cbl1", designation: "CBL1" },
    { uid: "cbl2", designation: "CBL2" },
  ];
  ir.cableConductors = [
    {
      id: { cableUid: "cbl1", conductorId: "4" },
      endpoints: [
        { terminal: { deviceUid: "b1", terminalKey: "4" } },
        { terminal: { deviceUid: "jb1", terminalKey: "X1.3" } },
      ],
    },
    {
      id: { cableUid: "cbl2", conductorId: "4" },
      endpoints: [
        { terminal: { deviceUid: "jb1", terminalKey: "X1.3" } },
        { terminal: { deviceUid: "tb1", terminalKey: "3" } },
      ],
    },
  ];
  return ir;
}

const CBL1_4 = { kind: "cable_conductor", cableUid: "cbl1", conductorId: "4" };
const CBL2_4 = { kind: "cable_conductor", cableUid: "cbl2", conductorId: "4" };

function cardSheetSvg() {
  return svg(
    zoneGrid() +
      marker("b1", "4", 45, 50) +
      marker("jb1", "X1.3", 45, 90) +
      marker("tb1", "3", 45, 130) +
      card("b1", "4", 110, 35, [CBL1_4], "Off-view at B1.4", [
        "CBL1.4 → JB1.X1.3 02.B3",
      ]) +
      card("jb1", "X1.3", 110, 75, [CBL1_4, CBL2_4], "Off-view at JB1.X1.3", [
        "CBL1.4 → B1.4 02.B1",
        "CBL2.4 → TB1.3 02.B5",
      ]) +
      card("tb1", "3", 110, 125, [CBL2_4], "Off-view at TB1.3", [
        "CBL2.4 → JB1.X1.3 02.B3",
      ]),
  );
}

function circuitSheetSvg(cbl1Attr, cbl2Attr) {
  return svg(
    zoneGrid() +
      marker("b1", "4", 40, 82) +
      marker("jb1", "X1.3", 100, 82) +
      marker("tb1", "3", 160, 82) +
      `<g data-circuit-conductor='${cbl1Attr}'><path d="M 40 82 H 100" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `<g data-circuit-conductor='${cbl2Attr}'><path d="M 100 82 H 160" fill="none" stroke="#17212b" stroke-width="0.35"/></g>`,
  );
}

it("#628 4A recognizes painted circuit cable cores end to end and rejects mismatched identities", async () => {
  const ir = cableCoreIr();
  const sources = nativeRows(ir);
  const pkt = {
    sheets: [
      { number: 1, view: { kind: "wiring", format: "documentation-view/0.1" } },
      {
        number: 2,
        view: { kind: "circuit", format: "documentation-view/0.1" },
      },
    ],
  };
  const g1 = await openSheet(page, cardSheetSvg());
  const g2 = await openSheet(
    page,
    circuitSheetSvg(
      '{"cableUid":"cbl1","conductorId":"4"}',
      '{"cableUid":"cbl2","conductorId":"4"}',
    ),
  );
  const obls = terminalPeerObligations(pkt, [g1, g2], ir, sources);
  expect(obls.filter((o) => o.sheet === 2)).toEqual([]);
  expect(
    peerReferenceFindings(
      2,
      g2,
      obls.filter((o) => o.sheet === 2),
    ),
  ).toEqual([]);

  // Negative controls: wrong cable UID and wrong core ID must not match CBL1.4.
  const g2WrongCable = await openSheet(
    page,
    circuitSheetSvg(
      '{"cableUid":"cbl2","conductorId":"4"}',
      '{"cableUid":"cbl2","conductorId":"4"}',
    ),
  );
  expect(conductorInk(g2WrongCable, CBL1_4).runs).toEqual([]);
  const g2WrongCore = await openSheet(
    page,
    circuitSheetSvg(
      '{"cableUid":"cbl1","conductorId":"5"}',
      '{"cableUid":"cbl2","conductorId":"4"}',
    ),
  );
  expect(conductorInk(g2WrongCore, CBL1_4).runs).toEqual([]);

  // Conflict check preserved: conflicting edgeOwnerKey vs wire declaration must not match.
  const conflictGeom = {
    ...g2,
    shapes: g2.shapes.map((s) =>
      s.wire === '{"cableUid":"cbl1","conductorId":"4"}'
        ? {
            ...s,
            edgeOwnerKey: ["wire", '{"cableUid":"cbl1","conductorId":"5"}'],
          }
        : s,
    ),
  };
  expect(conductorInk(conflictGeom, CBL1_4).runs).toEqual([]);
}, 60_000);

it("#628 4A still fails when an actually owed off-sheet cable-core peer note is erased", async () => {
  const ir = cableCoreIr();
  const sources = nativeRows(ir);
  const pkt = {
    sheets: [
      { number: 1, view: { kind: "wiring", format: "documentation-view/0.1" } },
      {
        number: 2,
        view: { kind: "circuit", format: "documentation-view/0.1" },
      },
    ],
  };
  const s1 = svg(
    zoneGrid() +
      marker("jb1", "X1.3", 45, 90) +
      card("jb1", "X1.3", 110, 75, [CBL2_4], "Off-view at JB1.X1.3", [
        "CBL2.4 → TB1.3 02.B5",
      ]),
  );
  const peerSource = JSON.stringify([
    { deviceUid: "tb1", terminalKey: "3" },
    CBL2_4,
    { deviceUid: "jb1", terminalKey: "X1.3" },
  ]);
  const makeS2 = (noteMarkup) =>
    svg(zoneGrid() + marker("tb1", "3", 160, 82) + noteMarkup);
  const noteMarkup = `<text data-peer-reference="conductor-peer" data-peer-source='${peerSource}' x="162" y="81" font-size="2.5">CBL2.4 · TB1.3 → JB1.X1.3 01.B2</text>`;

  const g1 = await openSheet(page, s1);
  const g2Present = await openSheet(page, makeS2(noteMarkup));
  const oblsPresent = terminalPeerObligations(
    pkt,
    [g1, g2Present],
    ir,
    sources,
  );
  expect(
    peerReferenceFindings(
      2,
      g2Present,
      oblsPresent.filter((o) => o.sheet === 2),
    ),
  ).toEqual([]);

  const g2Erased = await openSheet(page, makeS2(""));
  const oblsErased = terminalPeerObligations(pkt, [g1, g2Erased], ir, sources);
  expect(
    peerReferenceFindings(
      2,
      g2Erased,
      oblsErased.filter((o) => o.sheet === 2),
    ).map((f) => f.kind),
  ).toContain("issued-peer-reference-missing");
}, 60_000);
