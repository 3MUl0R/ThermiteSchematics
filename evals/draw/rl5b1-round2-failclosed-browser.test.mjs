import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import {
  netLabelRepetition,
  terminalText,
  wirePlacement,
  wirePlacementCoverage,
} from "./checks.mjs";
import { wireCaptionObservation } from "./coincident-wire-labels.mjs";
import { conductorLabelCoverage } from "./conductor-label-coverage.mjs";
import { observation } from "./evaluate.mjs";
import { measurementCoverage } from "./measurement-coverage.mjs";
import { netOwnershipGaps } from "./net-label-oracle.mjs";
import { wireLabelSupportAudit } from "./wire-label-support.mjs";

let browser, context, page;
beforeAll(async () => {
  browser = await launch();
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
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
  labelText = "+24VDC",
} = {}) {
  const k = trunkPortKeys();
  const clipId = clipIdFor(labelEdge, "net");
  const condAttr = labelConductor ? ` data-conductor="${labelConductor}"` : "";
  const term = (uid, key, portId, cx, cy, net) =>
    `<circle id="terminal-${[uid, key, portId].map(hex).join("--")}" class="terminal-marker" cx="${cx}" cy="${cy}" r="1" fill="#fff" stroke="#101828" stroke-width="0.35" data-device-uid="${uid}" data-terminal-key="${key}" data-net-id="${net}"/>`;
  return embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240mm" height="140mm" viewBox="0 0 240 140" font-family="Thermite Sans, sans-serif">` +
      `<defs><clipPath id="${clipId}"><rect x="0" y="0" width="240" height="140"/></clipPath></defs>` +
      `<g class="device-group" data-device-uid="ps1" data-designation="PS1"><rect class="device-frame" x="10" y="20" width="24" height="50" fill="#fff" stroke="#98a2b3" stroke-width="0.4"/></g>` +
      `<g class="symbol function-symbol" data-symbol-id="ais:dc-output" data-device-uid="ps1" data-function-key="dc_output">${term("ps1", "+", "pos", 34, 40, "net-pos")}${term("ps1", "-", "neg", 34, 65, "net-neg")}</g>` +
      `<g class="symbol function-symbol" data-symbol-id="ais:supply" data-device-uid="plc1" data-function-key="supply">${term("plc1", "L+", "pos", 190, 40, "net-pos")}${term("plc1", "M", "neg", 190, 65, "net-neg")}</g>` +
      `<g class="symbol function-symbol" data-symbol-id="ais:supply" data-device-uid="hmi1" data-function-key="supply">${term("hmi1", "L+", "pos", 190, 15, "net-pos")}${term("hmi1", "M", "neg", 190, 95, "net-neg")}</g>` +
      `<path class="boundary-path" data-net-id="net-pos" data-presentation-only="true" data-edge-key="${edgeKeyAttr(["boundary-segment", k.j1Id, '["function","ps1","dc_output"]'])}" data-route-source-port-key="${k.ps1PosPort}" data-route-target-port-key="${k.j1Attach}" data-source-device-uid="ps1" data-source-terminal-key="+" data-target-device-uid="ps1" data-target-terminal-key="+" data-trunk-conductors='${trunk1Conductors}' d="M 34 40 H 75" fill="none" stroke="#475467" stroke-width="0.35"/>` +
      `<path class="boundary-path" data-net-id="net-neg" data-presentation-only="true" data-edge-key="${edgeKeyAttr(["boundary-segment", k.j2Id, '["function","ps1","dc_output"]'])}" data-route-source-port-key="${k.ps1NegPort}" data-route-target-port-key="${k.j2Attach}" data-source-device-uid="ps1" data-source-terminal-key="-" data-target-device-uid="ps1" data-target-terminal-key="-" data-trunk-conductors='${trunk2Conductors}' d="M 34 65 H 75" fill="none" stroke="#475467" stroke-width="0.35"/>` +
      `<path class="net-path wire-path" data-wire-uid="w1" data-designation="W1" data-net-id="net-pos" data-potential-name="+24VDC" data-edge-key="${edgeKeyAttr(["wire", "w1"])}" data-route-source-port-key="${k.j1W1}" data-route-target-port-key="${k.plcPosPort}" data-source-device-uid="plc1" data-source-terminal-key="L+" data-target-device-uid="ps1" data-target-terminal-key="+" d="M 75 40 H 190" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<path class="net-path wire-path" data-wire-uid="w3" data-designation="W3" data-net-id="net-pos" data-edge-key="${edgeKeyAttr(["wire", "w3"])}" data-route-source-port-key="${k.j1W3}" data-route-target-port-key="${k.hmiPosPort}" data-source-device-uid="ps1" data-source-terminal-key="+" data-target-device-uid="hmi1" data-target-terminal-key="L+" d="M 75 40 V 15 H 190" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<path class="net-path wire-path" data-wire-uid="w2" data-designation="W2" data-net-id="net-neg" data-potential-name="0VDC" data-edge-key="${edgeKeyAttr(["wire", "w2"])}" data-route-source-port-key="${k.j2W2}" data-route-target-port-key="${k.plcNegPort}" data-source-device-uid="plc1" data-source-terminal-key="M" data-target-device-uid="ps1" data-target-terminal-key="-" d="M 75 65 H 190" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<path class="net-path wire-path" data-wire-uid="w4" data-designation="W4" data-net-id="net-neg" data-edge-key="${edgeKeyAttr(["wire", "w4"])}" data-route-source-port-key="${k.j2W4}" data-route-target-port-key="${k.hmiNegPort}" data-source-device-uid="ps1" data-source-terminal-key="-" data-target-device-uid="hmi1" data-target-terminal-key="M" d="M 75 65 V 95 H 190" fill="none" stroke="#101828" stroke-width="0.35"/>` +
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

const ROLE_TRUNK_IR = {
  ...TRUNK_IR,
  functions: [
    {
      id: { deviceUid: "ps1", functionKey: "dc_output" },
      kind: "source",
      terminals: [
        { deviceUid: "ps1", terminalKey: "+" },
        { deviceUid: "ps1", terminalKey: "-" },
      ],
    },
    {
      id: { deviceUid: "plc1", functionKey: "supply" },
      kind: "load",
      terminals: [
        { deviceUid: "plc1", terminalKey: "L+" },
        { deviceUid: "plc1", terminalKey: "M" },
      ],
    },
    {
      id: { deviceUid: "hmi1", functionKey: "supply" },
      kind: "load",
      terminals: [
        { deviceUid: "hmi1", terminalKey: "L+" },
        { deviceUid: "hmi1", terminalKey: "M" },
      ],
    },
  ],
  terminals: [
    { id: { deviceUid: "ps1", terminalKey: "+" }, role: "dc_positive_output" },
    { id: { deviceUid: "ps1", terminalKey: "-" }, role: "dc_return_output" },
    { id: { deviceUid: "plc1", terminalKey: "L+" }, role: "supply_positive" },
    { id: { deviceUid: "plc1", terminalKey: "M" }, role: "supply_return" },
    { id: { deviceUid: "hmi1", terminalKey: "L+" }, role: "supply_positive" },
    { id: { deviceUid: "hmi1", terminalKey: "M" }, role: "supply_return" },
  ],
  // Author W1 load-first to verify source role beats endpoints[] order.
  wires: [
    {
      uid: "w1",
      designation: "W1",
      endpoints: [
        { terminal: { deviceUid: "plc1", terminalKey: "L+" } },
        { terminal: { deviceUid: "ps1", terminalKey: "+" } },
      ],
    },
    ...TRUNK_IR.wires.slice(1),
  ],
};

function syntheticCableSheetSvg({ includeConductorAttr = true } = {}) {
  const c1Key = JSON.stringify(["cbl1", "1"]);
  const c2Key = JSON.stringify(["cbl1", "2"]);
  const clip1 = clipIdFor(["cable-conductor", "cbl1", "1"], "conductor");
  const clip2 = clipIdFor(["cable-conductor", "cbl1", "2"], "conductor");
  const attr1 = includeConductorAttr ? ` data-conductor='${c1Key}'` : "";
  const attr2 = includeConductorAttr ? ` data-conductor='${c2Key}'` : "";
  return embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 200 100" font-family="Thermite Sans, sans-serif">` +
      `<defs><clipPath id="${clip1}"><rect x="0" y="0" width="200" height="100"/></clipPath><clipPath id="${clip2}"><rect x="0" y="0" width="200" height="100"/></clipPath></defs>` +
      `<path class="net-path cable-conductor-path" data-designation="CBL1" data-net-id="n1" data-cable-uid="cbl1" data-conductor-id="1" data-edge-key="${edgeKeyAttr(["cable-conductor", "cbl1", "1"])}" data-source-device-uid="d1" data-source-terminal-key="1" data-target-device-uid="d2" data-target-terminal-key="1" d="M 20 30 H 120" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<path class="net-path cable-conductor-path" data-designation="CBL1" data-net-id="n2" data-cable-uid="cbl1" data-conductor-id="2" data-edge-key="${edgeKeyAttr(["cable-conductor", "cbl1", "2"])}" data-source-device-uid="d1" data-source-terminal-key="2" data-target-device-uid="d2" data-target-terminal-key="2" d="M 20 60 H 120" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<g class="symbol" data-device-uid="d1"><circle class="terminal-marker" cx="20" cy="30" r="1" fill="#fff" stroke="#101828" stroke-width="0.35" data-device-uid="d1" data-terminal-key="1"/><text data-text-role="designation" x="10" y="20" font-size="2.7" fill="#101828">JB1</text></g>` +
      `<g class="symbol" data-device-uid="d2"><circle class="terminal-marker" cx="120" cy="30" r="1" fill="#fff" stroke="#101828" stroke-width="0.35" data-device-uid="d2" data-terminal-key="1"/><text data-text-role="designation" x="125" y="20" font-size="2.7" fill="#101828">M1</text></g>` +
      `<rect class="label-background label-conductor" x="30" y="26.5" width="14" height="5" fill="#fff" stroke="none"/>` +
      `<text class="label-text label-conductor" data-text-role="body"${attr1} clip-path="url(#${clip1})" x="31" y="30" font-size="2.7" fill="#101828">CBL1.1</text>` +
      `<rect class="label-background label-conductor" x="60" y="56.5" width="14" height="5" fill="#fff" stroke="none"/>` +
      `<text class="label-text label-conductor" data-text-role="body"${attr2} clip-path="url(#${clip2})" x="61" y="60" font-size="2.7" fill="#101828">CBL1.2</text>` +
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

function dq17Status(g, ir) {
  const sheet = { number: 1, view: { kind: "rooted" } };
  const [obs] = measurementCoverage(
    [observation({ id: "probe" }, sheet, "DQ-17", terminalText(g, ir))],
    g,
    null,
    sheet,
    ir,
  );
  return {
    gaps: netOwnershipGaps(g, ir),
    findings: netLabelRepetition(g, ir),
    status: obs.status,
  };
}

function dq16Status(g, ir) {
  const sheet = { number: 1, view: { kind: "rooted" } };
  const obs = wireCaptionObservation(
    g,
    conductorLabelCoverage(sheet, { sheets: [sheet] }, g, [g], ir),
    (dq, fs, extra) => observation({ id: "probe" }, sheet, dq, fs, extra),
  );
  return {
    coverage: wirePlacementCoverage(g),
    findings: wirePlacement(g),
    audit: wireLabelSupportAudit(g, ir),
    status: obs.status,
    allFindings: obs.evidence.findings,
  };
}

describe("RL5b-1 round-2 fail-closed controls (findings 1-5: DQ-17)", () => {
  it("finding 1: rejects forged trunk membership (cross-net, nonexistent, missing sibling, conflicting wire UID)", async () => {
    const pos = dq17Status(
      await openSheet(page, syntheticTrunkSvg()),
      TRUNK_IR,
    );
    expect(pos.status).toBe("pass");

    const cases = [
      syntheticTrunkSvg({ trunk1Conductors: '["w1","w3","w2"]' }),
      syntheticTrunkSvg({ trunk1Conductors: '["w1","w3","fake"]' }),
      syntheticTrunkSvg({ trunk1Conductors: '["w1"]' }),
      syntheticTrunkSvg({ trunk1Conductors: '["w3"]' }).replace(
        'data-wire-uid="w1"',
        'data-wire-uid="w3"',
      ),
    ];
    for (const svg of cases) {
      const res = dq17Status(await openSheet(page, svg), TRUNK_IR);
      expect(res.status).not.toBe("pass");
      expect(res.gaps.length + res.findings.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("finding 2: rejects native destination masquerading as trunk source and enforces native source role", async () => {
    const k = trunkPortKeys();
    const wrongTerminal = syntheticTrunkSvg()
      .replace(
        'data-source-terminal-key="+" data-target-device-uid="ps1" data-target-terminal-key="+"',
        'data-source-terminal-key="-" data-target-device-uid="ps1" data-target-terminal-key="-"',
      )
      .replace("M 34 40 H 75", "M 34 65 L 75 40")
      .replace(k.ps1PosPort, k.ps1NegPort);
    expect(
      dq17Status(await openSheet(page, wrongTerminal), TRUNK_IR).status,
    ).toBe("fail");

    const targetAsSource = syntheticTrunkSvg({ labelX: 80, labelY: 38 })
      .replace(
        'data-source-device-uid="ps1" data-source-terminal-key="+" data-target-device-uid="ps1" data-target-terminal-key="+"',
        'data-source-device-uid="plc1" data-source-terminal-key="L+" data-target-device-uid="plc1" data-target-terminal-key="L+"',
      )
      .replace("M 34 40 H 75", "M 190 40 H 75")
      .replace(k.ps1PosPort, k.plcPosPort);
    const resTarget = dq17Status(
      await openSheet(page, targetAsSource),
      TRUNK_IR,
    );
    expect(resTarget.status).not.toBe("pass");
    expect(resTarget.gaps.length + resTarget.findings.length).toBeGreaterThan(
      0,
    );

    // Real native source role accepts PS1.+ even when W1 endpoints are authored load-first.
    expect(
      dq17Status(await openSheet(page, syntheticTrunkSvg()), ROLE_TRUNK_IR)
        .status,
    ).toBe("pass");
    expect(
      dq17Status(await openSheet(page, targetAsSource), ROLE_TRUNK_IR).status,
    ).not.toBe("pass");
  }, 60_000);

  it("finding 3: rejects foreign-net junction dot and cross-net coincident junctions", async () => {
    const foreignDot = syntheticTrunkSvg().replace(
      /(class="junction-dot" cx="75" cy="40"[^>]*data-net-id=")net-pos/,
      "$1net-neg",
    );
    const rForeign = dq17Status(await openSheet(page, foreignDot), TRUNK_IR);
    expect(rForeign.status).toBe("not-measured");
    expect(rForeign.gaps.length).toBeGreaterThan(0);

    const sharedPos = syntheticTrunkSvg({ labelX: 81, labelY: 38 })
      .replace("M 34 65 H 75", "M 34 65 H 65 L 75 40")
      .replace("M 75 65 H 190", "M 75 40 L 90 65 H 190")
      .replace("M 75 65 V 95 H 190", "M 75 40 V 95 H 190")
      .replace('cx="75" cy="65" r="0.8"', 'cx="75" cy="40" r="0.8"');
    const rShared = dq17Status(await openSheet(page, sharedPos), TRUNK_IR);
    expect(rShared.status).toBe("not-measured");
    expect(rShared.gaps.length).toBeGreaterThan(0);
  }, 60_000);

  it("finding 4: rejects invisible trunk stroke and invisible junction dot fill", async () => {
    const invisibleTrunk = syntheticTrunkSvg().replace(
      'd="M 34 40 H 75"',
      'stroke-opacity="0" d="M 34 40 H 75"',
    );
    const rTrunk = dq17Status(await openSheet(page, invisibleTrunk), TRUNK_IR);
    expect(rTrunk.status).toBe("not-measured");
    expect(rTrunk.gaps.length).toBeGreaterThan(0);

    const invisibleDot = syntheticTrunkSvg().replace(
      'cx="75" cy="40" r="0.8"',
      'cx="75" cy="40" r="0.8" fill-opacity="0"',
    );
    const rDot = dq17Status(await openSheet(page, invisibleDot), TRUNK_IR);
    expect(rDot.status).toBe("not-measured");
    expect(rDot.gaps.length).toBeGreaterThan(0);
  }, 60_000);

  it("finding 5: keeps visible net labels lacking clip-path owner in the population as explicit gaps", async () => {
    const targetHalf = syntheticTrunkSvg({ labelX: 165, labelY: 38 });
    expect(dq17Status(await openSheet(page, targetHalf), TRUNK_IR).status).toBe(
      "fail",
    );

    const clipRemoved = targetHalf.replace(
      / clip-path="url\(#clip-[^"]+\)"/,
      "",
    );
    const rClip = dq17Status(await openSheet(page, clipRemoved), TRUNK_IR);
    expect(rClip.status).toBe("not-measured");
    expect(rClip.gaps.length).toBeGreaterThan(0);

    const clipAndAttrRemoved = clipRemoved.replace(' data-conductor="w1"', "");
    const rBoth = dq17Status(
      await openSheet(page, clipAndAttrRemoved),
      TRUNK_IR,
    );
    expect(rBoth.status).toBe("not-measured");
    expect(rBoth.gaps.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("RL5b-1 round-2 fail-closed controls (findings 6-7: DQ-16)", () => {
  it("finding 6: flags duplicate distinct caption blocks claiming one continuous conductor and unlabelled sibling conductors", async () => {
    const pos = dq16Status(
      await openSheet(page, syntheticCableSheetSvg()),
      CABLE_IR,
    );
    expect(pos.status).toBe("pass");
    expect(pos.findings).toEqual([]);
    expect(pos.allFindings).toEqual([]);

    const dupSvg = syntheticCableSheetSvg().replace(
      "</svg>",
      `<text class="label-text label-conductor" data-text-role="body" data-conductor='["cbl1","1"]' x="75" y="28" font-size="2.7" fill="#101828">CBL1.1</text></svg>`,
    );
    const rDup = dq16Status(await openSheet(page, dupSvg), CABLE_IR);
    expect(rDup.status).toBe("fail");
    expect(rDup.findings.map((f) => f.kind)).toContain(
      "duplicate-conductor-label",
    );

    const dupReplaceSvg = syntheticCableSheetSvg()
      .replace(
        /<rect class="label-background label-conductor" x="60"[^>]*\/>/,
        "",
      )
      .replace(
        /<text class="label-text label-conductor"[^>]*>CBL1\.2<\/text>/,
        `<text class="label-text label-conductor" data-text-role="body" data-conductor='["cbl1","1"]' clip-path="url(#${clipIdFor(["cable-conductor", "cbl1", "1"], "conductor")})" x="75" y="28" font-size="2.7" fill="#101828">CBL1.1</text>`,
      );
    const rRep = dq16Status(await openSheet(page, dupReplaceSvg), CABLE_IR);
    expect(rRep.status).toBe("fail");
    expect(rRep.findings.map((f) => f.kind)).toContain(
      "duplicate-conductor-label",
    );
    expect(rRep.allFindings.map((f) => f.kind)).toContain(
      "conductor-fragment-without-visible-identity",
    );
  }, 60_000);

  it("finding 7: reports label-identity-unavailable for unowned visible conductor labels even when routes are absent", async () => {
    const withRoutes = syntheticCableSheetSvg({
      includeConductorAttr: false,
    }).replace(/ clip-path="url\(#clip-[^"]+\)"/g, "");
    const rWith = dq16Status(await openSheet(page, withRoutes), CABLE_IR);
    expect(rWith.coverage).toMatchObject({
      status: "not-implemented",
      reasonCode: "label-identity-unavailable",
    });
    expect(rWith.status).toBe("not-implemented");
    expect(rWith.audit.findings.length).toBeGreaterThan(0);

    const noRoutes = withRoutes.replace(
      /<path class="net-path cable-conductor-path"[^>]*\/>/g,
      "",
    );
    const rWithout = dq16Status(await openSheet(page, noRoutes), CABLE_IR);
    expect(rWithout.coverage).toMatchObject({
      status: "not-implemented",
      reasonCode: "label-identity-unavailable",
    });
    expect(rWithout.status).toBe("not-implemented");
    expect(rWithout.audit.findings.length).toBeGreaterThan(0);
  }, 60_000);
});
