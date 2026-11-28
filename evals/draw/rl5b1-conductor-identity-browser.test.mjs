import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import {
  netLabelRepetition,
  terminalText,
  wirePlacement,
  wirePlacementCoverage,
} from "./checks.mjs";
import { netOwnershipGaps } from "./net-label-oracle.mjs";
import { wireLabelSupportAudit } from "./wire-label-support.mjs";
import { evaluateSheet } from "./evaluate.mjs";
import { EVALS_VERSION } from "./version.mjs";
import { readReportSummary } from "./report-summary.mjs";

let browser, context, page, conveyorIr;
beforeAll(async () => {
  browser = await launch();
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
  const compiled = await compileProject(
    join(process.cwd(), "examples/conveyor-line"),
  );
  expect(compiled.ok).toBe(true);
  conveyorIr = compiled.ir;
}, 60_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

const hex = (s) =>
  Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
const edgeKeyAttr = (tuple) => `edge-${hex(JSON.stringify(tuple))}`;
const portKeyAttr = (tuple) => `port-${hex(JSON.stringify(tuple))}`;
const clipIdFor = (edgeTuple, role) =>
  `clip-${hex(JSON.stringify(["label", "edge", JSON.stringify(edgeTuple), role]))}`;

function renderConveyorPacket(views) {
  return renderSchematicPacket(conveyorIr, {
    format: "schematic-packet-request/0.1",
    index: false,
    views,
  });
}

function trunkPortKeys() {
  const j1Id = JSON.stringify(["junction", "net-pos", "ps1", "+"]);
  const j2Id = JSON.stringify(["junction", "net-neg", "ps1", "-"]);
  const fnPort = (fn, p) => portKeyAttr(["port", fn, p]);
  const jPort = (j, k, a, b) =>
    portKeyAttr(b ? ["port", j, k, a, b] : ["port", j, k, a]);
  return {
    j1Id,
    j2Id,
    j1DomId: `junction-${hex(j1Id)}`,
    j2DomId: `junction-${hex(j2Id)}`,
    ps1PosPort: fnPort('["function","ps1","dc_output"]', "pos"),
    ps1NegPort: fnPort('["function","ps1","dc_output"]', "neg"),
    plcPosPort: fnPort('["function","plc1","supply"]', "pos"),
    plcNegPort: fnPort('["function","plc1","supply"]', "neg"),
    hmiPosPort: fnPort('["function","hmi1","supply"]', "pos"),
    hmiNegPort: fnPort('["function","hmi1","supply"]', "neg"),
    j1Attach: jPort(j1Id, "attachment", '["function","ps1","dc_output"]'),
    j2Attach: jPort(j2Id, "attachment", '["function","ps1","dc_output"]'),
    j1W1: jPort(j1Id, "conductor", '["wire","w1"]', "source"),
    j1W3: jPort(j1Id, "conductor", '["wire","w3"]', "source"),
    j2W2: jPort(j2Id, "conductor", '["wire","w2"]', "source"),
    j2W4: jPort(j2Id, "conductor", '["wire","w4"]', "source"),
  };
}

function syntheticTrunkSvg({
  labelX = 82,
  labelY = 38,
  labelConductor = "w1",
  labelEdge = ["wire", "w1"],
  trunk1Conductors = '["w1","w3"]',
  trunk2Conductors = '["w2","w4"]',
  includeTrunkAttr = true,
  foreignStroke = "",
  foreignFrame = "",
  labelText = "+24VDC",
} = {}) {
  const k = trunkPortKeys();
  const t1Attr =
    includeTrunkAttr && trunk1Conductors
      ? ` data-trunk-conductors='${trunk1Conductors}'`
      : "";
  const t2Attr =
    includeTrunkAttr && trunk2Conductors
      ? ` data-trunk-conductors='${trunk2Conductors}'`
      : "";
  const clipId = clipIdFor(labelEdge, "net");
  const condAttr = labelConductor ? ` data-conductor="${labelConductor}"` : "";
  const term = (uid, key, portId, cx, cy, net) =>
    `<circle id="terminal-${[uid, key, portId].map(hex).join("--")}" class="terminal-marker" cx="${cx}" cy="${cy}" r="1" fill="#fff" stroke="#101828" stroke-width="0.35" data-device-uid="${uid}" data-terminal-key="${key}" data-net-id="${net}"/>`;
  return embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240mm" height="140mm" viewBox="0 0 240 140" font-family="Thermite Sans, sans-serif">` +
      `<defs><clipPath id="${clipId}"><rect x="0" y="0" width="240" height="140"/></clipPath></defs>` +
      `<g class="device-group" data-device-uid="ps1" data-designation="PS1"><rect class="device-frame" x="10" y="20" width="24" height="50" fill="#fff" stroke="#98a2b3" stroke-width="0.4"/></g>` +
      foreignFrame +
      `<g class="symbol function-symbol" data-symbol-id="ais:dc-output" data-device-uid="ps1" data-function-key="dc_output">${term("ps1", "+", "pos", 34, 40, "net-pos")}${term("ps1", "-", "neg", 34, 65, "net-neg")}</g>` +
      `<g class="symbol function-symbol" data-symbol-id="ais:supply" data-device-uid="plc1" data-function-key="supply">${term("plc1", "L+", "pos", 190, 40, "net-pos")}${term("plc1", "M", "neg", 190, 65, "net-neg")}</g>` +
      `<g class="symbol function-symbol" data-symbol-id="ais:supply" data-device-uid="hmi1" data-function-key="supply">${term("hmi1", "L+", "pos", 190, 15, "net-pos")}${term("hmi1", "M", "neg", 190, 95, "net-neg")}</g>` +
      `<path class="boundary-path" data-net-id="net-pos" data-presentation-only="true" data-edge-key="${edgeKeyAttr(["boundary-segment", k.j1Id, '["function","ps1","dc_output"]'])}" data-route-source-port-key="${k.ps1PosPort}" data-route-target-port-key="${k.j1Attach}" data-source-device-uid="ps1" data-source-terminal-key="+" data-target-device-uid="ps1" data-target-terminal-key="+"${t1Attr} d="M 34 40 H 75" fill="none" stroke="#475467" stroke-width="0.35"/>` +
      `<path class="boundary-path" data-net-id="net-neg" data-presentation-only="true" data-edge-key="${edgeKeyAttr(["boundary-segment", k.j2Id, '["function","ps1","dc_output"]'])}" data-route-source-port-key="${k.ps1NegPort}" data-route-target-port-key="${k.j2Attach}" data-source-device-uid="ps1" data-source-terminal-key="-" data-target-device-uid="ps1" data-target-terminal-key="-"${t2Attr} d="M 34 65 H 75" fill="none" stroke="#475467" stroke-width="0.35"/>` +
      `<path class="net-path wire-path" data-wire-uid="w1" data-designation="W1" data-net-id="net-pos" data-potential-name="+24VDC" data-edge-key="${edgeKeyAttr(["wire", "w1"])}" data-route-source-port-key="${k.j1W1}" data-route-target-port-key="${k.plcPosPort}" data-source-device-uid="plc1" data-source-terminal-key="L+" data-target-device-uid="ps1" data-target-terminal-key="+" d="M 75 40 H 190" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<path class="net-path wire-path" data-wire-uid="w3" data-designation="W3" data-net-id="net-pos" data-edge-key="${edgeKeyAttr(["wire", "w3"])}" data-route-source-port-key="${k.j1W3}" data-route-target-port-key="${k.hmiPosPort}" data-source-device-uid="ps1" data-source-terminal-key="+" data-target-device-uid="hmi1" data-target-terminal-key="L+" d="M 75 40 V 15 H 190" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<path class="net-path wire-path" data-wire-uid="w2" data-designation="W2" data-net-id="net-neg" data-potential-name="0VDC" data-edge-key="${edgeKeyAttr(["wire", "w2"])}" data-route-source-port-key="${k.j2W2}" data-route-target-port-key="${k.plcNegPort}" data-source-device-uid="plc1" data-source-terminal-key="M" data-target-device-uid="ps1" data-target-terminal-key="-" d="M 75 65 H 190" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<path class="net-path wire-path" data-wire-uid="w4" data-designation="W4" data-net-id="net-neg" data-edge-key="${edgeKeyAttr(["wire", "w4"])}" data-route-source-port-key="${k.j2W4}" data-route-target-port-key="${k.hmiNegPort}" data-source-device-uid="ps1" data-source-terminal-key="-" data-target-device-uid="hmi1" data-target-terminal-key="M" d="M 75 65 V 95 H 190" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      foreignStroke +
      `<circle id="${k.j1DomId}" class="junction-dot" cx="75" cy="40" r="0.8" fill="#101828" data-device-uid="ps1" data-terminal-key="+" data-net-id="net-pos"/>` +
      `<circle id="${k.j2DomId}" class="junction-dot" cx="75" cy="65" r="0.8" fill="#101828" data-device-uid="ps1" data-terminal-key="-" data-net-id="net-neg"/>` +
      `<text class="label-text label-net" data-text-role="body"${condAttr} clip-path="url(#${clipId})" x="${labelX}" y="${labelY}" font-size="2.7" fill="#101828">${labelText}</text>` +
      `</svg>`,
  );
}

const TRUNK_IR = {
  devices: [
    { uid: "ps1", designation: "PS1" },
    { uid: "plc1", designation: "PLC1" },
    { uid: "hmi1", designation: "HMI1" },
  ],
  functions: [],
  nets: [
    { id: "net-pos", terminalIds: [] },
    { id: "net-neg", terminalIds: [] },
  ],
  wires: [
    {
      uid: "w1",
      designation: "W1",
      endpoints: [
        { terminal: { deviceUid: "ps1", terminalKey: "+" } },
        { terminal: { deviceUid: "plc1", terminalKey: "L+" } },
      ],
    },
    {
      uid: "w3",
      designation: "W3",
      endpoints: [
        { terminal: { deviceUid: "ps1", terminalKey: "+" } },
        { terminal: { deviceUid: "hmi1", terminalKey: "L+" } },
      ],
    },
    {
      uid: "w2",
      designation: "W2",
      endpoints: [
        { terminal: { deviceUid: "ps1", terminalKey: "-" } },
        { terminal: { deviceUid: "plc1", terminalKey: "M" } },
      ],
    },
    {
      uid: "w4",
      designation: "W4",
      endpoints: [
        { terminal: { deviceUid: "ps1", terminalKey: "-" } },
        { terminal: { deviceUid: "hmi1", terminalKey: "M" } },
      ],
    },
  ],
  jumpers: [],
  cableConductors: [],
  cables: [],
};

function syntheticCableSheetSvg({
  includeConductorAttr = true,
  swapOwner = false,
  displaceLabel = false,
  occludeApproach = false,
  nonexistentOwner = false,
} = {}) {
  const c1Key = JSON.stringify(["cbl1", "1"]);
  const c2Key = JSON.stringify(["cbl1", "2"]);
  const lbl1Owner = nonexistentOwner
    ? JSON.stringify(["missing", "1"])
    : swapOwner
      ? c2Key
      : c1Key;
  const clip1 = clipIdFor(["cable-conductor", "cbl1", "1"], "conductor");
  const clip2 = clipIdFor(["cable-conductor", "cbl1", "2"], "conductor");
  const attr1 = includeConductorAttr ? ` data-conductor='${lbl1Owner}'` : "";
  const attr2 = includeConductorAttr ? ` data-conductor='${c2Key}'` : "";
  const lbl1Y = displaceLabel ? 58 : 30;
  const plate1Y = displaceLabel ? 54.5 : 26.5;
  const occluder = occludeApproach
    ? `<rect x="20" y="28" width="10" height="4" fill="#ffffff" stroke="none"/>`
    : "";
  return embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 200 100" font-family="Thermite Sans, sans-serif">` +
      `<defs><clipPath id="${clip1}"><rect x="0" y="0" width="200" height="100"/></clipPath><clipPath id="${clip2}"><rect x="0" y="0" width="200" height="100"/></clipPath></defs>` +
      `<path class="net-path cable-conductor-path" data-designation="CBL1" data-net-id="n1" data-cable-uid="cbl1" data-conductor-id="1" data-edge-key="${edgeKeyAttr(["cable-conductor", "cbl1", "1"])}" data-source-device-uid="d1" data-source-terminal-key="1" data-target-device-uid="d2" data-target-terminal-key="1" d="M 20 30 H 120" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<path class="net-path cable-conductor-path" data-designation="CBL1" data-net-id="n2" data-cable-uid="cbl1" data-conductor-id="2" data-edge-key="${edgeKeyAttr(["cable-conductor", "cbl1", "2"])}" data-source-device-uid="d1" data-source-terminal-key="2" data-target-device-uid="d2" data-target-terminal-key="2" d="M 20 60 H 120" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<g class="symbol" data-device-uid="d1"><circle class="terminal-marker" cx="20" cy="30" r="1" fill="#fff" stroke="#101828" stroke-width="0.35" data-device-uid="d1" data-terminal-key="1"/><text data-text-role="designation" x="10" y="20" font-size="2.7" fill="#101828">JB1</text></g>` +
      `<g class="symbol" data-device-uid="d2"><circle class="terminal-marker" cx="120" cy="30" r="1" fill="#fff" stroke="#101828" stroke-width="0.35" data-device-uid="d2" data-terminal-key="1"/><text data-text-role="designation" x="125" y="20" font-size="2.7" fill="#101828">M1</text></g>` +
      `<rect class="label-background label-conductor" x="30" y="${plate1Y}" width="14" height="5" fill="#fff" stroke="none"/>` +
      `<text class="label-text label-conductor" data-text-role="body"${attr1} clip-path="url(#${clip1})" x="31" y="${lbl1Y}" font-size="2.7" fill="#101828">CBL1.1</text>` +
      `<rect class="label-background label-conductor" x="60" y="56.5" width="14" height="5" fill="#fff" stroke="none"/>` +
      `<text class="label-text label-conductor" data-text-role="body"${attr2} clip-path="url(#${clip2})" x="61" y="60" font-size="2.7" fill="#101828">CBL1.2</text>` +
      occluder +
      `</svg>`,
  );
}

const CABLE_IR = {
  devices: [
    { uid: "d1", designation: "JB1" },
    { uid: "d2", designation: "M1" },
  ],
  functions: [],
  nets: [],
  wires: [],
  jumpers: [],
  cables: [{ uid: "cbl1", designation: "CBL1" }],
  cableConductors: [
    {
      id: { cableUid: "cbl1", conductorId: "1" },
      endpoints: [
        { terminal: { deviceUid: "d1", terminalKey: "1" } },
        { terminal: { deviceUid: "d2", terminalKey: "1" } },
      ],
    },
    {
      id: { cableUid: "cbl1", conductorId: "2" },
      endpoints: [
        { terminal: { deviceUid: "d1", terminalKey: "2" } },
        { terminal: { deviceUid: "d2", terminalKey: "2" } },
      ],
    },
  ],
};

describe("V5-01: DQ-17 TAIL net-label source ownership on shared source trunks", () => {
  it("measures shared source trunk net labels as PASS on positive control and real rendered PS1 loads views", async () => {
    const g = await openSheet(page, syntheticTrunkSvg());
    expect(netOwnershipGaps(g, TRUNK_IR)).toEqual([]);
    expect(netLabelRepetition(g, TRUNK_IR)).toEqual([]);

    for (const flow of ["left-to-right", "top-to-bottom"]) {
      const rendered = await renderConveyorPacket([
        {
          format: "schematic-view-request/0.2",
          intent: { kind: "loads" },
          root: { by: "designation", value: "PS1" },
          flow,
        },
      ]);
      expect(rendered.ok).toBe(true);
      const sheet = rendered.value.sheets.find((s) =>
        s.svg.includes("data-trunk-conductors="),
      );
      expect(sheet).toBeDefined();
      expect(sheet.svg).toContain("data-conductor=");
      const rg = await openSheet(page, embedPrintableFont(sheet.svg));
      expect(netOwnershipGaps(rg, conveyorIr)).toEqual([]);
      expect(netLabelRepetition(rg, conveyorIr)).toEqual([]);
    }
  }, 60_000);

  it("rejects wrong-owner labels, sibling-branch labels, sibling-trunk labels, foreign ink, and missing trunk identity", async () => {
    // 1. Label on sibling wire W3's branch (same net, different branch).
    const gSiblingBranch = await openSheet(
      page,
      syntheticTrunkSvg({ labelX: 110, labelY: 13 }),
    );
    expect(netOwnershipGaps(gSiblingBranch, TRUNK_IR)).toEqual([]);
    expect(
      netLabelRepetition(gSiblingBranch, TRUNK_IR).map((f) => f.kind),
    ).toContain("net-label-nearer-foreign-route");

    // 2. Label on sibling trunk (PS1.- trunk belonging to W2/W4, not W1).
    const gSiblingTrunk = await openSheet(
      page,
      syntheticTrunkSvg({ labelX: 45, labelY: 63 }),
    );
    expect(netOwnershipGaps(gSiblingTrunk, TRUNK_IR)).toEqual([]);
    expect(
      netLabelRepetition(gSiblingTrunk, TRUNK_IR).map((f) => f.kind),
    ).toContain("net-label-nearer-foreign-route");

    // 3. Planted wrong-owner data-conductor conflicting with clip-path labelOwnerKey.
    const gWrongOwner = await openSheet(
      page,
      syntheticTrunkSvg({ labelConductor: "w2" }),
    );
    expect(
      netLabelRepetition(gWrongOwner, TRUNK_IR).map((f) => f.kind),
    ).toContain("net-label-owner-mismatch");
  }, 60_000);

  it("rejects foreign ink, foreign device frame, target-half placement, and missing trunk identity", async () => {
    // 4. Label with foreign conductor stroke passing across its ink.
    const gForeignInk = await openSheet(
      page,
      syntheticTrunkSvg({
        foreignStroke: `<path class="net-path wire-path" data-wire-uid="w9" data-designation="W9" data-net-id="net-other" data-edge-key="${edgeKeyAttr(["wire", "w9"])}" data-source-device-uid="x1" data-source-terminal-key="1" data-target-device-uid="x2" data-target-terminal-key="1" d="M 86 20 V 50" fill="none" stroke="#101828" stroke-width="0.35"/>`,
      }),
    );
    expect(netOwnershipGaps(gForeignInk, TRUNK_IR)).toEqual([]);
    expect(
      netLabelRepetition(gForeignInk, TRUNK_IR).map((f) => f.kind),
    ).toContain("net-label-foreign-ink");

    // 5. Label overlapping a foreign device frame while anchored on a shared trunk.
    const gForeignFrame = await openSheet(
      page,
      syntheticTrunkSvg({
        foreignFrame: `<g class="device-group" data-device-uid="q1" data-designation="Q1"><rect class="device-frame" x="78" y="30" width="30" height="16" fill="#fff" stroke="#98a2b3" stroke-width="0.4"/></g>`,
      }),
    );
    expect(netOwnershipGaps(gForeignFrame, TRUNK_IR)).toEqual([]);
    expect(
      netLabelRepetition(gForeignFrame, TRUNK_IR).map((f) => f.kind),
    ).toContain("net-label-in-foreign-device-frame");

    // 6. Label in target half of trunk+branch route.
    const gTargetHalf = await openSheet(
      page,
      syntheticTrunkSvg({ labelX: 165, labelY: 38 }),
    );
    expect(netOwnershipGaps(gTargetHalf, TRUNK_IR)).toEqual([]);
    expect(
      netLabelRepetition(gTargetHalf, TRUNK_IR).map((f) => f.kind),
    ).toContain("net-label-not-at-route-source");

    // 7. Missing data-trunk-conductors stays explicitly unmeasured (fail closed).
    const gNoTrunkAttr = await openSheet(
      page,
      syntheticTrunkSvg({ includeTrunkAttr: false }),
    );
    expect(netOwnershipGaps(gNoTrunkAttr, TRUNK_IR).length).toBeGreaterThan(0);
  }, 60_000);
});

describe("V5-03: DQ-16 exported label-to-conductor identity for placement and connected approach", () => {
  it("measures cable-conductor labels with exported data-conductor as PASS and rejects negative controls", async () => {
    const gPass = await openSheet(page, syntheticCableSheetSvg());
    expect(wirePlacementCoverage(gPass)).toEqual({});
    expect(wirePlacement(gPass)).toEqual([]);
    const supPass = wireLabelSupportAudit(gPass, CABLE_IR);
    expect(supPass.eligible).toBe(2);
    expect(supPass.findings).toEqual([]);

    // 1. Missing data-conductor on visible cable-conductor labels stays unmeasured.
    const gMissing = await openSheet(
      page,
      syntheticCableSheetSvg({ includeConductorAttr: false }),
    );
    expect(wirePlacementCoverage(gMissing)).toMatchObject({
      status: "not-implemented",
      reasonCode: "label-identity-unavailable",
    });

    // 2. Swapped/wrong-owner data-conductor fails placement and support audit.
    const gSwapped = await openSheet(
      page,
      syntheticCableSheetSvg({ swapOwner: true }),
    );
    expect(wirePlacement(gSwapped).map((f) => f.kind)).toContain(
      "ambiguous-wire-label",
    );
    expect(
      wireLabelSupportAudit(gSwapped, CABLE_IR).findings.length,
    ).toBeGreaterThan(0);

    // 3. Nonexistent data-conductor fails placement (never silently skipped).
    const gMissingRoute = await openSheet(
      page,
      syntheticCableSheetSvg({ nonexistentOwner: true }),
    );
    expect(wirePlacement(gMissingRoute).map((f) => f.kind)).toContain(
      "ambiguous-wire-label",
    );

    // 4. Displaced label nearer foreign cable core fails placement.
    const gDisplaced = await openSheet(
      page,
      syntheticCableSheetSvg({ displaceLabel: true }),
    );
    expect(wirePlacement(gDisplaced).map((f) => f.kind)).toContain(
      "ambiguous-wire-label",
    );

    // 5. Occluded connected approach on cable-conductor label fails DQ-16 mask/approach check.
    const gOccluded = await openSheet(
      page,
      syntheticCableSheetSvg({ occludeApproach: true }),
    );
    expect(
      wireLabelSupportAudit(gOccluded, CABLE_IR).findings.map((f) => f.kind),
    ).toContain("wire-label-plate-masks-conductor");
  }, 60_000);

  it("exports data-conductor on real rendered rooted views with cable conductors and wires", async () => {
    const rendered = await renderConveyorPacket([
      {
        format: "schematic-view-request/0.1",
        root: { by: "designation", value: "M1" },
        family: "power",
        flow: "left-to-right",
      },
    ]);
    expect(rendered.ok).toBe(true);
    const sheet = rendered.value.sheets[0];
    expect(sheet.svg).toContain("data-conductor=");
    const g = await openSheet(page, embedPrintableFont(sheet.svg));
    expect(wirePlacementCoverage(g)).toEqual({});
    expect(wirePlacement(g)).toEqual([]);
  }, 60_000);
});

describe("checker protocol 5.58 version and summary compatibility", () => {
  it("bumps EVALS_VERSION to 5.58 while keeping 5.49, 5.51, 5.53, 5.54, 5.55, 5.56, and 5.57 readable", () => {
    expect(EVALS_VERSION).toBe("5.58");
    for (const evalsVersion of [
      "5.49",
      "5.51",
      "5.53",
      "5.54",
      "5.55",
      "5.56",
      "5.57",
      "5.58",
    ]) {
      const s = readReportSummary({
        evalsVersion,
        summary: { "DQ-16": { pass: 1 } },
      });
      expect(s["DQ-16"].pass).toBe(1);
    }
    expect(() =>
      readReportSummary({ evalsVersion: "5.50", summary: {} }),
    ).toThrow();
    expect(() =>
      readReportSummary({ evalsVersion: "5.52", summary: {} }),
    ).toThrow();
  });
});
