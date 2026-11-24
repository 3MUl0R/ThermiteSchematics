import { afterAll, beforeAll, expect, it } from "vitest";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { fixture } from "./m3-fixture.mjs";
import { nativeRows } from "./m3-native.mjs";
import { terminalPeerObligations } from "./terminal-peer-oracle.mjs";

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
  return (
    Array.from({ length: 6 }, (_, i) =>
      text(30 + i * 30, 12, String(i + 1)),
    ).join("") + [..."ABCD"].map((t, i) => text(10, 42 + i * 40, t)).join("")
  );
}

function attachmentOracleFixture() {
  const ir = fixture().ir;
  ir.devices = [
    { uid: "ps1", designation: "PS1", typeId: "t" },
    { uid: "s2", designation: "S2", typeId: "t" },
  ];
  ir.deviceTypes[0].terminals = [
    { key: "+", description: "24V+" },
    { key: "11", description: "NC" },
    { key: "12", description: "NC" },
  ];
  ir.terminals = [
    { id: { deviceUid: "ps1", terminalKey: "+" } },
    { id: { deviceUid: "s2", terminalKey: "11" } },
    { id: { deviceUid: "s2", terminalKey: "12" } },
  ];
  ir.functions = [];
  ir.internalRelations = [];
  ir.wires = [
    {
      uid: "w2",
      designation: "W-CTL-012",
      endpoints: [
        { terminal: { deviceUid: "ps1", terminalKey: "+" } },
        { terminal: { deviceUid: "s2", terminalKey: "11" } },
      ],
    },
  ];
  const s1Card = svg(
    zoneGrid() +
      `<circle class="terminal-marker" data-device-uid="ps1" data-terminal-key="+" cx="60" cy="82" r="1.2" fill="white" stroke="#101828"/>` +
      `<g class="off-view-annotation" data-off-view-terminal-id='{"deviceUid":"ps1","terminalKey":"+"}' data-off-view-conductors='[{"kind":"wire","uid":"w2"}]'>` +
      `<rect x="130" y="30" width="60" height="16" fill="white" stroke="#101828"/>` +
      `<text class="off-view-heading" x="132" y="35" font-size="2.5">Off-view at PS1.+</text>` +
      `<text class="off-view-row" x="132" y="42" font-size="2.5">W-CTL-012 → S2.11 02.B3</text>` +
      `</g>`,
  );
  const makeS2 = (attachmentMarkup) =>
    svg(
      zoneGrid() +
        `<g data-device-uid="ps1"><g data-layout-port="p0" data-terminal-id='["ps1","+"]' data-terminal-key="+"><circle data-terminal-marker="true" cx="54" cy="96" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/></g>${attachmentMarkup}</g>` +
        `<g data-device-uid="s2"><g data-layout-port="p2" data-terminal-id='["s2","11"]' data-terminal-key="11"><circle data-terminal-marker="true" cx="103" cy="96" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/></g><g data-layout-port="p3" data-terminal-id='["s2","12"]' data-terminal-key="12"><circle data-terminal-marker="true" cx="129" cy="96" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/></g></g>` +
        `<g data-circuit-conductor="w2"><path d="M 72 96 H 103" fill="none" stroke="#17212b" stroke-width="0.35"/></g>`,
    );
  const pkt = {
    sheets: [
      { number: 1, view: { kind: "wiring", format: "documentation-view/0.1" } },
      { number: 2, view: { kind: "circuit", format: "documentation-view/0.1" } },
    ],
  };
  return { ir, s1Card, makeS2, pkt };
}

it(
  "#571 oracle counts a drawn attachment lead as painted to that end and rejects missing/unpainted leads",
  async () => {
    const { ir, s1Card, makeS2, pkt } = attachmentOracleFixture();
    const sources = nativeRows(ir);
    const g1 = await openSheet(page, s1Card);
    const drawnLead = `<g data-terminal-attachment='["ps1","+"]' data-attachment-from='{"x":54,"y":96}' data-attachment-to='{"x":72,"y":96}'><path d="M 54 96 L 72 96" fill="none" stroke="#17212b" stroke-width="0.32"/></g>`;
    const g2Drawn = await openSheet(page, makeS2(drawnLead));
    const oblsDrawn = terminalPeerObligations(pkt, [g1, g2Drawn], ir, sources);
    expect(oblsDrawn.filter((o) => o.sheet === 1)).toHaveLength(1);
    expect(oblsDrawn.filter((o) => o.sheet === 2)).toHaveLength(0);

    for (const badMarkup of [
      "",
      `<g data-terminal-attachment='["ps1","+"]'><path d="M 54 96 L 72 96" fill="none" stroke="white" stroke-width="0.32"/></g>`,
      `<g data-terminal-attachment='["ps1","+"]'><path d="M 54 96 L 72 96" fill="none" stroke="none" stroke-width="0.32"/></g>`,
      `<g data-terminal-attachment='["ps1","+"]' opacity="0"><path d="M 54 96 L 72 96" fill="none" stroke="#17212b" stroke-width="0.32"/></g>`,
      `<g data-terminal-attachment='["ps1","+"]'><path d="M 54 96 L 72 96" fill="none" stroke="#17212b" stroke-width="0.32"/></g><rect x="61" y="92" width="4" height="8" fill="white"/>`,
      `<g data-terminal-attachment='["s2","12"]'><path d="M 54 96 L 72 96" fill="none" stroke="#17212b" stroke-width="0.32"/></g>`,
    ]) {
      const g2Bad = await openSheet(page, makeS2(badMarkup));
      const oblsBad = terminalPeerObligations(pkt, [g1, g2Bad], ir, sources);
      expect(oblsBad.filter((o) => o.sheet === 2).length).toBeGreaterThan(0);
    }
  },
  60_000,
);
