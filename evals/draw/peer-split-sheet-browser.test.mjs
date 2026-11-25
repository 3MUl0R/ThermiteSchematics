import { afterAll, beforeAll, expect, it } from "vitest";
import { DOMParser } from "linkedom";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { terminalPeerReferences } from "../../packages/render/dist/packet/terminal-peer-references.js";
import { createTerminalIr } from "../../packages/query/test/fixtures.ts";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { peerReferenceFindings } from "./issued-reference-audit.mjs";
import { nativeRows } from "./m3-native.mjs";
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

const TABLOID = {
  size: "tabloid",
  orientation: "landscape",
  widthMm: 431.8,
  heightMm: 279.4,
  marginMm: 10,
};
const FIELD = { x: 28, y: 24, w: 360, h: 240 };

function splitSheetIr() {
  const ir = createTerminalIr([
    { uid: "b1", designation: "B1", terminalKeys: ["4"] },
    { uid: "jb1", designation: "JB1", terminalKeys: ["X1.3"] },
    { uid: "tb1", designation: "TB1", terminalKeys: ["3"] },
  ]);
  ir.functions = [];
  ir.internalRelations = [];
  ir.wires = [];
  ir.jumpers = [];
  const end = (deviceUid, terminalKey) => ({
    terminal: { deviceUid, terminalKey },
  });
  const source = ir.devices[0].source;
  ir.cables = [
    { uid: "cbl1", designation: "CBL1", typeId: "t", source },
    { uid: "cbl2", designation: "CBL2", typeId: "t", source },
  ];
  ir.cableConductors = [
    {
      cableUid: "cbl1",
      id: { cableUid: "cbl1", conductorId: "4" },
      endpoints: [end("b1", "4"), end("jb1", "X1.3")],
      source,
    },
    {
      cableUid: "cbl2",
      id: { cableUid: "cbl2", conductorId: "4" },
      endpoints: [end("jb1", "X1.3"), end("tb1", "3")],
      source,
    },
  ];
  return ir;
}

const gridSvg = () =>
  Array.from(
    { length: 6 },
    (_, i) => `<text x="${58 + i * 60}" y="12" font-size="2.5">${i + 1}</text>`,
  ).join("") +
  Array.from(
    "ABCD",
    (t, i) => `<text x="10" y="${54 + i * 60}" font-size="2.5">${t}</text>`,
  ).join("");

const wrapSvg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" font-family="Thermite Sans, sans-serif" width="431.8mm" height="279.4mm" viewBox="0 0 431.8 279.4">${gridSvg()}${body}</svg>`;

const markerSvg = (dev, key, x, y) =>
  `<g data-device-uid="${dev}"><g data-terminal-id="[&quot;${dev}&quot;,&quot;${key}&quot;]" data-terminal-key="${key}"><circle class="terminal-marker" data-terminal-marker="true" data-terminal-key="${key}" cx="${x}" cy="${y}" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/></g></g>`;

function splitSheetPacket() {
  const ir = splitSheetIr();
  const part1 = wrapSvg(
    `<g data-navigation-view="view/circuit/sensor" data-circuit-group="sensor-signal">` +
      markerSvg("jb1", "X1.3", 58, 60) +
      markerSvg("tb1", "3", 58, 100) +
      `<g data-circuit-conductor="{&quot;cableUid&quot;:&quot;cbl2&quot;,&quot;conductorId&quot;:&quot;4&quot;}"><path d="M58 60 V100" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `</g>`,
  );
  const part2 = wrapSvg(
    `<g data-navigation-view="view/circuit/sensor" data-circuit-group="sensor-signal">` +
      markerSvg("b1", "4", 58, 120) +
      markerSvg("jb1", "X1.3", 58, 160) +
      `<g data-circuit-conductor="{&quot;cableUid&quot;:&quot;cbl1&quot;,&quot;conductorId&quot;:&quot;4&quot;}"><path d="M58 120 V160" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `</g>`,
  );
  const cardSheet = wrapSvg(
    `<g data-navigation-view="view/cable/cbl1">` +
      markerSvg("b1", "4", 58, 60) +
      markerSvg("jb1", "X1.3", 58, 110) +
      `<g data-circuit-conductor="{&quot;cableUid&quot;:&quot;cbl1&quot;,&quot;conductorId&quot;:&quot;4&quot;}"><path d="M58 60 V110" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `<g class="off-view-annotation" data-off-view-terminal-id="{&quot;deviceUid&quot;:&quot;jb1&quot;,&quot;terminalKey&quot;:&quot;X1.3&quot;}" data-off-view-conductors="[{&quot;kind&quot;:&quot;cable_conductor&quot;,&quot;cableUid&quot;:&quot;cbl2&quot;,&quot;conductorId&quot;:&quot;4&quot;}]">` +
      `<rect class="off-view-card" x="120" y="95" width="76" height="18" fill="white" stroke="#101828"/>` +
      `<text class="off-view-heading" x="122" y="101" font-size="2.6">Off-view at JB1.X1.3</text>` +
      `<text class="off-view-row" x="122" y="109" font-size="2.6">CBL2.4 → TB1.3</text>` +
      `</g>` +
      `</g>`,
  );
  const views = [
    { format: "documentation-view/0.1", kind: "circuit" },
    { format: "documentation-view/0.1", kind: "circuit" },
    { format: "documentation-view/0.1", kind: "wiring" },
  ];
  const svgs = [part1, part2, cardSheet];
  const sheets = svgs.map((svg, i) => ({
    number: i + 1,
    title: `Sheet ${i + 1}`,
    svg,
    view: views[i],
    continuations: [],
  }));
  const drafts = svgs.map((svg, i) => ({
    title: `Sheet ${i + 1}`,
    svg,
    view: views[i],
    drawingBounds: FIELD,
  }));
  return { ir, issued: terminalPeerReferences(ir, drafts, sheets, TABLOID) };
}

it("#628 4B renderer and independent Chromium checker agree on split-sheet CBL2.4 peer note and fail when erased", async () => {
  const { ir, issued } = splitSheetPacket();
  const geoms = [];
  for (const s of issued)
    geoms.push(await openSheet(page, embedPrintableFont(s.svg)));
  const obls = terminalPeerObligations(
    { sheets: issued },
    geoms,
    ir,
    nativeRows(ir),
  );

  // Part 1 paints CBL2.4 end-to-end: 0 obligations and 0 free notes.
  expect(obls.filter((o) => o.sheet === 1)).toEqual([]);
  expect(geoms[0].texts.filter((t) => t.peerReference)).toEqual([]);

  // Part 2 (reproduces s10): 1 obligation and printed note CBL2.4 · JB1.X1.3 → TB1.3 01.B1.
  const s2Obls = obls.filter((o) => o.sheet === 2);
  expect(s2Obls).toHaveLength(1);
  expect(s2Obls[0].values).toEqual(["CBL2.4 · JB1.X1.3 → TB1.3 01.B1"]);
  expect(peerReferenceFindings(2, geoms[1], s2Obls)).toEqual([]);

  // Sheet 3 (card sheet): card-backed obligation only, no duplicate free note.
  const s3Obls = obls.filter((o) => o.sheet === 3);
  expect(s3Obls).toHaveLength(1);
  expect(s3Obls[0].card).toBeDefined();
  expect(geoms[2].texts.filter((t) => t.peerReference)).toEqual([]);
  expect(peerReferenceFindings(3, geoms[2], s3Obls)).toEqual([]);

  // Witness: erasing the owed CBL2.4 note on Part 2 fails the independent checker.
  const doc = new DOMParser().parseFromString(issued[1].svg, "image/svg+xml");
  for (const el of doc.querySelectorAll(
    '[data-peer-reference="conductor-peer"]',
  ))
    el.remove();
  const erasedG2 = await openSheet(page, embedPrintableFont(doc.toString()));
  const erasedObls = terminalPeerObligations(
    { sheets: issued },
    [geoms[0], erasedG2, geoms[2]],
    ir,
    nativeRows(ir),
  ).filter((o) => o.sheet === 2);
  expect(
    peerReferenceFindings(2, erasedG2, erasedObls).map((f) => f.kind),
  ).toContain("issued-peer-reference-missing");
}, 60_000);

async function renderAndMeasureVariant(part1Svg, part2Svg) {
  const ir = splitSheetIr();
  const cardSheet = wrapSvg(
    `<g data-navigation-view="view/cable/cbl1">` +
      markerSvg("b1", "4", 58, 60) +
      markerSvg("jb1", "X1.3", 58, 110) +
      `<g data-circuit-conductor="{&quot;cableUid&quot;:&quot;cbl1&quot;,&quot;conductorId&quot;:&quot;4&quot;}"><path d="M58 60 V110" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `<g class="off-view-annotation" data-off-view-terminal-id="{&quot;deviceUid&quot;:&quot;jb1&quot;,&quot;terminalKey&quot;:&quot;X1.3&quot;}" data-off-view-conductors="[{&quot;kind&quot;:&quot;cable_conductor&quot;,&quot;cableUid&quot;:&quot;cbl2&quot;,&quot;conductorId&quot;:&quot;4&quot;}]">` +
      `<rect class="off-view-card" x="120" y="95" width="76" height="18" fill="white" stroke="#101828"/>` +
      `<text class="off-view-heading" x="122" y="101" font-size="2.6">Off-view at JB1.X1.3</text>` +
      `<text class="off-view-row" x="122" y="109" font-size="2.6">CBL2.4 → TB1.3</text>` +
      `</g>` +
      `</g>`,
  );
  const views = [
    { format: "documentation-view/0.1", kind: "circuit" },
    { format: "documentation-view/0.1", kind: "circuit" },
    { format: "documentation-view/0.1", kind: "wiring" },
  ];
  const svgs = [part1Svg, part2Svg, cardSheet];
  const sheets = svgs.map((svg, i) => ({
    number: i + 1,
    title: `Sheet ${i + 1}`,
    svg,
    view: views[i],
    continuations: [],
  }));
  const drafts = svgs.map((svg, i) => ({
    title: `Sheet ${i + 1}`,
    svg,
    view: views[i],
    drawingBounds: FIELD,
  }));
  const issued = terminalPeerReferences(ir, drafts, sheets, TABLOID);
  const geoms = [];
  for (const s of issued)
    geoms.push(await openSheet(page, embedPrintableFont(s.svg)));
  const obls = terminalPeerObligations(
    { sheets: issued },
    geoms,
    ir,
    nativeRows(ir),
  );
  return { issued, geoms, obls };
}

it("#628 4B negative controls: unrelated-group caption mutant, repeated terminals, and multiple groups on one sheet", async () => {
  const basePart1 = wrapSvg(
    `<g data-navigation-view="view/circuit/sensor" data-circuit-group="sensor-signal">` +
      markerSvg("jb1", "X1.3", 58, 60) +
      markerSvg("tb1", "3", 58, 100) +
      `<g data-circuit-conductor="{&quot;cableUid&quot;:&quot;cbl2&quot;,&quot;conductorId&quot;:&quot;4&quot;}"><path d="M58 60 V100" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `</g>`,
  );

  // 1. Reviewer mutant: Part 2 JB1 terminal + CBL1.4 moved to other-signal, plus an
  // unrelated visible caption in sensor-signal -> 0 renderer notes, 0 checker obligations.
  const captionMutantPart2 = wrapSvg(
    `<g data-navigation-view="view/circuit/sensor" data-circuit-group="other-signal">` +
      markerSvg("b1", "4", 58, 120) +
      markerSvg("jb1", "X1.3", 58, 160) +
      `<g data-circuit-conductor="{&quot;cableUid&quot;:&quot;cbl1&quot;,&quot;conductorId&quot;:&quot;4&quot;}"><path d="M58 120 V160" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `</g>` +
      `<g data-navigation-view="view/circuit/sensor" data-circuit-group="sensor-signal">` +
      `<text x="200" y="60" font-size="2.6" fill="#17212b">Sensor signal caption</text>` +
      `</g>`,
  );
  const rMutant = await renderAndMeasureVariant(basePart1, captionMutantPart2);
  expect(rMutant.geoms[1].texts.filter((t) => t.peerReference)).toEqual([]);
  expect(rMutant.obls.filter((o) => o.sheet === 2)).toEqual([]);

  // 2. Repeated terminal across groups on one sheet: unconnected in sensor-signal +
  // connected in other-signal -> 0 renderer notes, 0 checker obligations.
  const crossGroupPart2 = wrapSvg(
    `<g data-navigation-view="view/circuit/sensor" data-circuit-group="sensor-signal">` +
      markerSvg("jb1", "X1.3", 58, 80) +
      `</g>` +
      `<g data-navigation-view="view/circuit/sensor" data-circuit-group="other-signal">` +
      markerSvg("b1", "4", 58, 160) +
      markerSvg("jb1", "X1.3", 58, 200) +
      `<g data-circuit-conductor="{&quot;cableUid&quot;:&quot;cbl1&quot;,&quot;conductorId&quot;:&quot;4&quot;}"><path d="M58 160 V200" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `</g>`,
  );
  const rCross = await renderAndMeasureVariant(basePart1, crossGroupPart2);
  expect(rCross.geoms[1].texts.filter((t) => t.peerReference)).toEqual([]);
  expect(rCross.obls.filter((o) => o.sheet === 2)).toEqual([]);
}, 60_000);

it("#628 4B multiple groups and positive repeated-terminal anchoring in Chromium oracle", async () => {
  const basePart1 = wrapSvg(
    `<g data-navigation-view="view/circuit/sensor" data-circuit-group="sensor-signal">` +
      markerSvg("jb1", "X1.3", 58, 60) +
      markerSvg("tb1", "3", 58, 100) +
      `<g data-circuit-conductor="{&quot;cableUid&quot;:&quot;cbl2&quot;,&quot;conductorId&quot;:&quot;4&quot;}"><path d="M58 60 V100" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `</g>`,
  );
  const multiPart1 = wrapSvg(
    `<g data-navigation-view="view/circuit/sensor" data-circuit-group="sensor-signal">` +
      markerSvg("jb1", "X1.3", 58, 60) +
      markerSvg("tb1", "3", 58, 100) +
      `<g data-circuit-conductor="{&quot;cableUid&quot;:&quot;cbl2&quot;,&quot;conductorId&quot;:&quot;4&quot;}"><path d="M58 60 V100" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `</g>` +
      `<g data-navigation-view="view/circuit/sensor" data-circuit-group="other-signal">` +
      markerSvg("b1", "4", 180, 60) +
      `</g>`,
  );
  const multiPart2 = wrapSvg(
    `<g data-navigation-view="view/circuit/sensor" data-circuit-group="other-signal">` +
      markerSvg("b1", "4", 58, 120) +
      markerSvg("jb1", "X1.3", 58, 160) +
      `<g data-circuit-conductor="{&quot;cableUid&quot;:&quot;cbl1&quot;,&quot;conductorId&quot;:&quot;4&quot;}"><path d="M58 120 V160" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `</g>` +
      `<g data-navigation-view="view/circuit/sensor" data-circuit-group="sensor-signal">` +
      markerSvg("b1", "4", 180, 120) +
      `</g>`,
  );
  const rMulti = await renderAndMeasureVariant(multiPart1, multiPart2);
  expect(rMulti.geoms[1].texts.filter((t) => t.peerReference)).toEqual([]);
  expect(rMulti.obls.filter((o) => o.sheet === 2)).toEqual([]);

  // Positive repeated-terminal variant: JB1.X1.3 connected in sensor-signal (y=160)
  // plus unconnected JB1.X1.3 in other-signal (y=230) -> 1 obligation anchored ONLY to y=160.
  const repeatPosPart2 = wrapSvg(
    `<g data-navigation-view="view/circuit/sensor" data-circuit-group="sensor-signal">` +
      markerSvg("b1", "4", 58, 120) +
      markerSvg("jb1", "X1.3", 58, 160) +
      `<g data-circuit-conductor="{&quot;cableUid&quot;:&quot;cbl1&quot;,&quot;conductorId&quot;:&quot;4&quot;}"><path d="M58 120 V160" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `</g>` +
      `<g data-navigation-view="view/circuit/sensor" data-circuit-group="other-signal">` +
      markerSvg("jb1", "X1.3", 240, 230) +
      `</g>`,
  );
  const rPos = await renderAndMeasureVariant(basePart1, repeatPosPart2);
  const s2Obls = rPos.obls.filter((o) => o.sheet === 2);
  expect(s2Obls).toHaveLength(1);
  expect(s2Obls[0].owners).toHaveLength(1);
  expect(Math.abs(s2Obls[0].owners[0].y - 160)).toBeLessThan(2);
  expect(peerReferenceFindings(2, rPos.geoms[1], s2Obls)).toEqual([]);
}, 60_000);
