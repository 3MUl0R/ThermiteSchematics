import { expect, it } from "vitest";
import { terminalPeerReferences } from "../src/packet/terminal-peer-references.js";
import type { Draft, PaperPage, RenderedSheet } from "../src/packet/types.js";
import { createTerminalIr } from "../../query/test/fixtures.js";
import { parseSvg } from "./off-view-fixtures.js";

const TABLOID: PaperPage = {
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
  const end = (deviceUid: string, terminalKey: string) => ({
    terminal: { deviceUid, terminalKey },
  });
  const source = ir.devices[0]!.source;
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

const wrapSvg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" font-family="Thermite Sans, sans-serif" width="431.8mm" height="279.4mm" viewBox="0 0 431.8 279.4">${gridSvg()}${body}</svg>`;

const markerSvg = (dev: string, key: string, x: number, y: number) =>
  `<g data-device-uid="${dev}"><g data-terminal-id="[&quot;${dev}&quot;,&quot;${key}&quot;]" data-terminal-key="${key}"><circle class="terminal-marker" data-terminal-marker="true" data-terminal-key="${key}" cx="${x}" cy="${y}" r="0.65" fill="white" stroke="#17212b" stroke-width="0.3"/></g></g>`;

function splitSheetFixture() {
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
    { format: "documentation-view/0.1" as const, kind: "circuit" as const },
    { format: "documentation-view/0.1" as const, kind: "circuit" as const },
    { format: "documentation-view/0.1" as const, kind: "wiring" as const },
  ];
  const svgs = [part1, part2, cardSheet];
  const sheets: RenderedSheet[] = svgs.map((svg, i) => ({
    number: i + 1,
    title: `Sheet ${i + 1}`,
    svg,
    view: views[i]!,
    continuations: [],
  }));
  const drafts: Draft[] = svgs.map((svg, i) => ({
    title: `Sheet ${i + 1}`,
    svg,
    view: views[i]!,
    drawingBounds: FIELD,
  }));
  return { ir: splitSheetIr(), drafts, sheets };
}

function peerTexts(svg: string) {
  const doc = parseSvg(svg);
  return [
    ...doc.querySelectorAll('[data-peer-reference="conductor-peer"]'),
  ].map((el) => el.textContent?.replace(/\s+/gu, " ").trim() ?? "");
}

it("#628 4B emits owed CBL2.4 peer note on split Part 2 sheet without duplicating on card or end-to-end sheets", () => {
  const { ir, drafts, sheets } = splitSheetFixture();
  const issued = terminalPeerReferences(ir, drafts, sheets, TABLOID);

  // Control 1: Part 1 paints CBL2.4 end-to-end -> no redundant peer note (#571).
  expect(peerTexts(issued[0]!.svg)).toEqual([]);

  // Target fix (reproduces s10): Part 2 draws CBL1.4 and owes CBL2.4 -> TB1.3 01.B1.
  expect(peerTexts(issued[1]!.svg)).toEqual([
    "CBL2.4 · JB1.X1.3 → TB1.3 01.B1",
  ]);

  // Control 2: Sheet 3 already has the off-view card -> card carries 01.B1, no duplicate free note.
  expect(peerTexts(issued[2]!.svg)).toEqual([]);
  const cardText =
    parseSvg(issued[2]!.svg)
      .querySelector("g.off-view-annotation")
      ?.textContent?.replace(/\s+/gu, " ")
      .trim() ?? "";
  expect(cardText).toContain("CBL2.4 → TB1.3 01.B1");
});

it("#628 4B does not emit a split-sheet peer note on an unconnected passive terminal", () => {
  const { ir, drafts, sheets } = splitSheetFixture();
  // Remove CBL1.4 stroke on Part 2 so JB1.X1.3 has no drawn incident conductor there.
  const passivePart2 = sheets[1]!.svg.replace(
    /<g data-circuit-conductor="[^"]+">[\s\S]*?<\/g>/u,
    "",
  );
  const nextSheets = [
    sheets[0]!,
    { ...sheets[1]!, svg: passivePart2 },
    sheets[2]!,
  ];
  const nextDrafts = [
    drafts[0]!,
    { ...drafts[1]!, svg: passivePart2 },
    drafts[2]!,
  ];
  const issued = terminalPeerReferences(ir, nextDrafts, nextSheets, TABLOID);
  expect(peerTexts(issued[1]!.svg)).toEqual([]);
});
