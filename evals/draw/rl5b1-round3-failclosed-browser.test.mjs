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
import { printedConductor } from "./continuation-labels.mjs";
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
const termRef = (deviceUid, terminalKey) => ({ deviceUid, terminalKey });

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

function syntheticTrunkSvg() {
  const k = trunkPortKeys();
  const clipId = clipIdFor(["wire", "w1"], "net");
  const term = (uid, key, portId, cx, cy, net) =>
    `<circle id="terminal-${[uid, key, portId].map(hex).join("--")}" class="terminal-marker" cx="${cx}" cy="${cy}" r="1" fill="#fff" stroke="#101828" stroke-width="0.35" data-device-uid="${uid}" data-terminal-key="${key}" data-net-id="${net}"/>`;
  return embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240mm" height="140mm" viewBox="0 0 240 140" font-family="Thermite Sans, sans-serif">` +
      `<defs><clipPath id="${clipId}"><rect x="0" y="0" width="240" height="140"/></clipPath></defs>` +
      `<g class="device-group" data-device-uid="ps1" data-designation="PS1"><rect class="device-frame" x="10" y="20" width="24" height="50" fill="#fff" stroke="#98a2b3" stroke-width="0.4"/></g>` +
      `<g class="symbol function-symbol" data-symbol-id="ais:dc-output" data-device-uid="ps1" data-function-key="dc_output">${term("ps1", "+", "pos", 34, 40, "net-pos")}${term("ps1", "-", "neg", 34, 65, "net-neg")}</g>` +
      `<g class="symbol function-symbol" data-symbol-id="ais:supply" data-device-uid="plc1" data-function-key="supply">${term("plc1", "L+", "pos", 190, 40, "net-pos")}${term("plc1", "M", "neg", 190, 65, "net-neg")}</g>` +
      `<g class="symbol function-symbol" data-symbol-id="ais:supply" data-device-uid="hmi1" data-function-key="supply">${term("hmi1", "L+", "pos", 190, 15, "net-pos")}${term("hmi1", "M", "neg", 190, 95, "net-neg")}</g>` +
      `<path class="boundary-path" data-net-id="net-pos" data-presentation-only="true" data-edge-key="${edgeKeyAttr(["boundary-segment", k.j1Id, '["function","ps1","dc_output"]'])}" data-route-source-port-key="${k.ps1PosPort}" data-route-target-port-key="${k.j1Attach}" data-source-device-uid="ps1" data-source-terminal-key="+" data-target-device-uid="ps1" data-target-terminal-key="+" data-trunk-conductors='["w1","w3"]' d="M 34 40 H 75" fill="none" stroke="#475467" stroke-width="0.35"/>` +
      `<path class="boundary-path" data-net-id="net-neg" data-presentation-only="true" data-edge-key="${edgeKeyAttr(["boundary-segment", k.j2Id, '["function","ps1","dc_output"]'])}" data-route-source-port-key="${k.ps1NegPort}" data-route-target-port-key="${k.j2Attach}" data-source-device-uid="ps1" data-source-terminal-key="-" data-target-device-uid="ps1" data-target-terminal-key="-" data-trunk-conductors='["w2","w4"]' d="M 34 65 H 75" fill="none" stroke="#475467" stroke-width="0.35"/>` +
      `<path class="net-path wire-path" data-wire-uid="w1" data-designation="W1" data-net-id="net-pos" data-potential-name="+24VDC" data-edge-key="${edgeKeyAttr(["wire", "w1"])}" data-route-source-port-key="${k.j1W1}" data-route-target-port-key="${k.plcPosPort}" data-source-device-uid="plc1" data-source-terminal-key="L+" data-target-device-uid="ps1" data-target-terminal-key="+" d="M 75 40 H 190" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<path class="net-path wire-path" data-wire-uid="w3" data-designation="W3" data-net-id="net-pos" data-edge-key="${edgeKeyAttr(["wire", "w3"])}" data-route-source-port-key="${k.j1W3}" data-route-target-port-key="${k.hmiPosPort}" data-source-device-uid="ps1" data-source-terminal-key="+" data-target-device-uid="hmi1" data-target-terminal-key="L+" d="M 75 40 V 15 H 190" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<path class="net-path wire-path" data-wire-uid="w2" data-designation="W2" data-net-id="net-neg" data-potential-name="0VDC" data-edge-key="${edgeKeyAttr(["wire", "w2"])}" data-route-source-port-key="${k.j2W2}" data-route-target-port-key="${k.plcNegPort}" data-source-device-uid="plc1" data-source-terminal-key="M" data-target-device-uid="ps1" data-target-terminal-key="-" d="M 75 65 H 190" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<path class="net-path wire-path" data-wire-uid="w4" data-designation="W4" data-net-id="net-neg" data-edge-key="${edgeKeyAttr(["wire", "w4"])}" data-route-source-port-key="${k.j2W4}" data-route-target-port-key="${k.hmiNegPort}" data-source-device-uid="ps1" data-source-terminal-key="-" data-target-device-uid="hmi1" data-target-terminal-key="M" d="M 75 65 V 95 H 190" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<circle id="${k.j1DomId}" class="junction-dot" cx="75" cy="40" r="0.8" fill="#101828" data-device-uid="ps1" data-terminal-key="+" data-net-id="net-pos"/>` +
      `<circle id="${k.j2DomId}" class="junction-dot" cx="75" cy="65" r="0.8" fill="#101828" data-device-uid="ps1" data-terminal-key="-" data-net-id="net-neg"/>` +
      `<text class="label-text label-net" data-text-role="body" data-conductor="w1" clip-path="url(#${clipId})" x="82" y="38" font-size="2.7" fill="#101828">+24VDC</text>` +
      `</svg>`,
  );
}

const wireSpec = (uid, designation, a, b) => ({
  uid,
  designation,
  endpoints: [{ terminal: a }, { terminal: b }],
});

const trunkRole = ({ deviceUid, terminalKey }) =>
  deviceUid === "ps1"
    ? terminalKey === "+"
      ? "dc_positive_output"
      : "dc_return_output"
    : terminalKey === "L+"
      ? "supply_positive"
      : "supply_return";

function buildNativeTrunkIr() {
  const nets = [
    {
      id: "net-pos",
      terminalIds: [
        termRef("ps1", "+"),
        termRef("plc1", "L+"),
        termRef("hmi1", "L+"),
      ],
      conductiveElementIds: [
        { kind: "wire", uid: "w1" },
        { kind: "wire", uid: "w3" },
      ],
    },
    {
      id: "net-neg",
      terminalIds: [
        termRef("ps1", "-"),
        termRef("plc1", "M"),
        termRef("hmi1", "M"),
      ],
      conductiveElementIds: [
        { kind: "wire", uid: "w2" },
        { kind: "wire", uid: "w4" },
      ],
    },
  ];
  return {
    devices: [
      { uid: "ps1", designation: "PS1" },
      { uid: "plc1", designation: "PLC1" },
      { uid: "hmi1", designation: "HMI1" },
    ],
    nets,
    terminals: nets.flatMap((n) =>
      n.terminalIds.map((id) => ({ id, role: trunkRole(id) })),
    ),
    functions: [
      {
        id: { deviceUid: "ps1", functionKey: "dc_output" },
        kind: "source",
        terminals: [termRef("ps1", "+"), termRef("ps1", "-")],
      },
      ...["plc1", "hmi1"].map((deviceUid) => ({
        id: { deviceUid, functionKey: "supply" },
        kind: "load",
        terminals: [termRef(deviceUid, "L+"), termRef(deviceUid, "M")],
      })),
    ],
    potentials: [
      { name: "+24VDC", netId: "net-pos", terminal: termRef("ps1", "+") },
      { name: "0VDC", netId: "net-neg", terminal: termRef("ps1", "-") },
    ],
    wires: [
      wireSpec("w1", "W1", termRef("ps1", "+"), termRef("plc1", "L+")),
      wireSpec("w3", "W3", termRef("ps1", "+"), termRef("hmi1", "L+")),
      wireSpec("w2", "W2", termRef("ps1", "-"), termRef("plc1", "M")),
      wireSpec("w4", "W4", termRef("ps1", "-"), termRef("hmi1", "M")),
    ],
    jumpers: [],
    cableConductors: [],
    cables: [],
  };
}

function syntheticCableBaseSvg() {
  const c1Key = JSON.stringify(["cbl1", "1"]);
  const c2Key = JSON.stringify(["cbl1", "2"]);
  const clip1 = clipIdFor(["cable-conductor", "cbl1", "1"], "conductor");
  const clip2 = clipIdFor(["cable-conductor", "cbl1", "2"], "conductor");
  return embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 200 100" font-family="Thermite Sans, sans-serif">` +
      `<defs><clipPath id="${clip1}"><rect x="0" y="0" width="200" height="100"/></clipPath><clipPath id="${clip2}"><rect x="0" y="0" width="200" height="100"/></clipPath></defs>` +
      `<path class="net-path cable-conductor-path" data-designation="CBL1" data-net-id="n1" data-cable-uid="cbl1" data-conductor-id="1" data-edge-key="${edgeKeyAttr(["cable-conductor", "cbl1", "1"])}" data-source-device-uid="d1" data-source-terminal-key="1" data-target-device-uid="d2" data-target-terminal-key="1" d="M 20 30 H 120" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<path class="net-path cable-conductor-path" data-designation="CBL1" data-net-id="n2" data-cable-uid="cbl1" data-conductor-id="2" data-edge-key="${edgeKeyAttr(["cable-conductor", "cbl1", "2"])}" data-source-device-uid="d1" data-source-terminal-key="2" data-target-device-uid="d2" data-target-terminal-key="2" d="M 20 60 H 120" fill="none" stroke="#101828" stroke-width="0.35"/>` +
      `<g class="symbol" data-device-uid="d1"><circle class="terminal-marker" cx="20" cy="30" r="1" fill="#fff" stroke="#101828" stroke-width="0.35" data-device-uid="d1" data-terminal-key="1"/><text data-text-role="designation" x="10" y="20" font-size="2.7" fill="#101828">JB1</text></g>` +
      `<g class="symbol" data-device-uid="d2"><circle class="terminal-marker" cx="120" cy="30" r="1" fill="#fff" stroke="#101828" stroke-width="0.35" data-device-uid="d2" data-terminal-key="1"/><text data-text-role="designation" x="125" y="20" font-size="2.7" fill="#101828">M1</text></g>` +
      `<text class="label-text label-conductor" data-text-role="body" data-conductor='${c1Key}' clip-path="url(#${clip1})" x="31" y="28" font-size="2.7" fill="#101828">CBL1.1</text>` +
      `<text class="label-text label-conductor" data-text-role="body" data-conductor='${c2Key}' clip-path="url(#${clip2})" x="61" y="58" font-size="2.7" fill="#101828">CBL1.2</text>` +
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
        { terminal: termRef("d1", "1") },
        { terminal: termRef("d2", "1") },
      ],
    },
    {
      id: { cableUid: "cbl1", conductorId: "2" },
      endpoints: [
        { terminal: termRef("d1", "2") },
        { terminal: termRef("d2", "2") },
      ],
    },
  ],
};

function continuationSheet(n, cfg, includeLabel, includeLink = true) {
  const other = n === 1 ? 2 : 1;
  const anchor = n === 1 ? 120 : 20;
  const labelX = n === 1 ? 41 : 51;
  const labelText = cfg.kind === "jumper" ? "Jumper" : cfg.text;
  const svg = embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 200 100" font-family="Thermite Sans,sans-serif">` +
      `<defs><clipPath id="${clipIdFor(cfg.tuple, "conductor")}"><rect x="0" y="0" width="200" height="100"/></clipPath><clipPath id="${clipIdFor(["wire", "w"], "conductor")}"><rect x="0" y="0" width="200" height="100"/></clipPath></defs>` +
      `<path class="net-path ${cfg.cls}" ${cfg.attrs} data-edge-key="${edgeKeyAttr(cfg.tuple)}" data-net-id="n2" data-source-device-uid="d1" data-source-terminal-key="${cfg.term}" data-target-device-uid="d2" data-target-terminal-key="${cfg.term}" d="M 20 30 H 120" fill="none" stroke="#101828" stroke-width=".35"/>` +
      (includeLabel
        ? `<text class="label-text label-conductor" data-conductor='${cfg.identity}' clip-path="url(#${clipIdFor(cfg.tuple, "conductor")})" x="${labelX}" y="28" font-size="2.7" fill="#101828">${labelText}</text>`
        : "") +
      `<path class="net-path wire-path" data-wire-uid="w" data-edge-key="${edgeKeyAttr(["wire", "w"])}" d="M 20 70 H 120" fill="none" stroke="#101828" stroke-width=".35"/>` +
      `<text class="label-text label-conductor" data-wire-label="w" data-conductor="w" clip-path="url(#${clipIdFor(["wire", "w"], "conductor")})" x="40" y="68" font-size="2.7" fill="#101828">W1</text>` +
      (includeLink
        ? `<a href="#sheet-${other}" data-continuation-id="C001" data-continuation-end="${n - 1}" data-conductor-id="${cfg.text}"><path d="M ${anchor} 30 L ${anchor + (n === 1 ? 2 : -2)} 30" fill="none" stroke="#344054" stroke-width=".3"/><text data-text-role="secondary" x="${n === 1 ? 125 : 1}" y="25" font-size="2.5" fill="#101828">C001 / 0${other}.B1</text><text data-text-role="secondary" x="${n === 1 ? 125 : 1}" y="30" font-size="2.5" fill="#101828">${cfg.text}</text></a>`
        : "") +
      `</svg>`,
  );
  return {
    number: n,
    view: { kind: "rooted", root: "D1" },
    continuations: includeLink
      ? [
          {
            id: "C001",
            toSheet: other,
            toZone: "B1",
            conductor: cfg.text,
            netId: "n2",
            end: n - 1,
            provenance: cfg.provenance,
          },
        ]
      : [],
    svg,
  };
}

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

describe("RL5b-1 round-3 fail-closed and continuation controls (#646)", () => {
  it("repro-08: rejects detached native sibling that fails to physically reach its junction", async () => {
    const ir = buildNativeTrunkIr();
    const base = syntheticTrunkSvg();
    expect(dq17Status(await openSheet(page, base), ir).status).toBe("pass");

    const ownDetached = base.replace("M 75 40 H 190", "M 95 40 H 190");
    expect(dq17Status(await openSheet(page, ownDetached), ir).status).not.toBe(
      "pass",
    );

    const siblingDetached = base.replace("M 75 40 V 15 H 190", "M 75 15 H 190");
    const res = dq17Status(await openSheet(page, siblingDetached), ir);
    expect(res.status).not.toBe("pass");
    expect(res.gaps.length + res.findings.length).toBeGreaterThan(0);
  }, 60_000);

  it("repro-09: rejects clipped junction, occluded junction, and severed trunk or branch approach", async () => {
    const ir = buildNativeTrunkIr();
    const base = syntheticTrunkSvg();
    expect(dq17Status(await openSheet(page, base), ir).status).toBe("pass");

    const clippedDot = base
      .replace(
        "</defs>",
        '<clipPath id="hide-dot"><rect x="0" y="0" width="10" height="10"/></clipPath></defs>',
      )
      .replace(
        'class="junction-dot" cx="75" cy="40"',
        'class="junction-dot" clip-path="url(#hide-dot)" cx="75" cy="40"',
      );
    const coveredDot = base.replace(
      "</svg>",
      '<rect x="74" y="39" width="2" height="2" fill="#fff" stroke="none"/></svg>',
    );
    const severedTrunk = base.replace(
      "</svg>",
      '<rect x="50" y="38" width="5" height="4" fill="#fff" stroke="none"/></svg>',
    );
    const severedApproach = base.replace(
      "</svg>",
      '<rect x="77" y="38" width="4" height="4" fill="#fff" stroke="none"/></svg>',
    );
    for (const svg of [clippedDot, coveredDot, severedTrunk, severedApproach]) {
      const res = dq17Status(await openSheet(page, svg), ir);
      expect(res.status).not.toBe("pass");
      expect(res.gaps.length + res.findings.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("repro-13: flags duplicate captions on the same continuous component regardless of disconnected components", async () => {
    const base = syntheticCableBaseSvg();
    const clip1 = clipIdFor(["cable-conductor", "cbl1", "1"], "conductor");
    const duplicate = base.replace(
      "</svg>",
      `<text class="label-text label-conductor" data-text-role="body" data-conductor='["cbl1","1"]' clip-path="url(#${clip1})" x="75" y="28" font-size="2.7" fill="#101828">CBL1.1</text></svg>`,
    );
    const extraPiece = duplicate.replace(
      "</svg>",
      `<path class="net-path cable-conductor-path" data-cable-uid="cbl1" data-conductor-id="1" data-edge-key="${edgeKeyAttr(["cable-conductor", "cbl1", "1"])}" data-net-id="n1" data-source-device-uid="d1" data-source-terminal-key="1" data-target-device-uid="d2" data-target-terminal-key="1" d="M 145 30 H 185" fill="none" stroke="#101828" stroke-width=".35"/></svg>`,
    );
    const onePerComponent = base.replace(
      "</svg>",
      `<path class="net-path cable-conductor-path" data-cable-uid="cbl1" data-conductor-id="1" data-edge-key="${edgeKeyAttr(["cable-conductor", "cbl1", "1"])}" data-net-id="n1" data-source-device-uid="d1" data-source-terminal-key="1" data-target-device-uid="d2" data-target-terminal-key="1" d="M 145 30 H 185" fill="none" stroke="#101828" stroke-width=".35"/>` +
        `<text class="label-text label-conductor" data-text-role="body" data-conductor='["cbl1","1"]' clip-path="url(#${clip1})" x="155" y="28" font-size="2.7" fill="#101828">CBL1.1</text></svg>`,
    );

    const rDup = dq16Status(await openSheet(page, duplicate), CABLE_IR);
    expect(rDup.status).toBe("fail");
    expect(rDup.findings.map((f) => f.kind)).toContain(
      "duplicate-conductor-label",
    );

    const rExtra = dq16Status(await openSheet(page, extraPiece), CABLE_IR);
    expect(rExtra.status).toBe("fail");
    expect(rExtra.findings.map((f) => f.kind)).toContain(
      "duplicate-conductor-label",
    );

    const rSplit = dq16Status(await openSheet(page, onePerComponent), CABLE_IR);
    expect(rSplit.status).toBe("pass");
    expect(rSplit.findings).toEqual([]);
  }, 60_000);

  const CONTINUATION_IR = {
    devices: [
      { uid: "d1", designation: "D1" },
      { uid: "d2", designation: "D2" },
    ],
    wires: [wireSpec("w", "W1", termRef("d1", "1"), termRef("d2", "1"))],
    jumpers: [
      {
        uid: "j",
        endpoints: [
          { terminal: termRef("d1", "2") },
          { terminal: termRef("d2", "2") },
        ],
      },
    ],
    cables: [{ uid: "c", designation: "CBL1" }],
    cableConductors: [
      {
        id: { cableUid: "c", conductorId: "1" },
        endpoints: [
          { terminal: termRef("d1", "3") },
          { terminal: termRef("d2", "3") },
        ],
      },
    ],
    nets: [],
    functions: [],
  };

  it("repro-12: accepts undesignated jumper continuation via provenance while preserving legacy sourceElement fallback", async () => {
    expect(
      printedConductor(
        { conductor: "JUMPER", provenance: { kind: "jumper", uid: "j" } },
        CONTINUATION_IR,
      ),
    ).toMatchObject({ kind: "jumper", uid: "j", text: "JUMPER" });
    expect(
      printedConductor(
        { conductor: "JUMPER", sourceElement: { kind: "jumper", uid: "j" } },
        CONTINUATION_IR,
      ),
    ).toMatchObject({ kind: "jumper", uid: "j", text: "JUMPER" });
    expect(
      printedConductor(
        {
          conductor: "CBL1.1",
          provenance: {
            kind: "cable_conductor",
            cableUid: "c",
            conductorId: "1",
          },
        },
        CONTINUATION_IR,
      ),
    ).toMatchObject({
      kind: "core",
      cableUid: "c",
      conductorId: "1",
      text: "CBL1.1",
    });

    const jumperCfg = {
      kind: "jumper",
      text: "JUMPER",
      identity: "j",
      tuple: ["jumper", "j"],
      attrs: 'data-jumper-uid="j"',
      provenance: { kind: "jumper", uid: "j" },
      cls: "jumper-path",
      term: "2",
    };
    const packet = {
      sheets: [
        continuationSheet(1, jumperCfg, false, true),
        continuationSheet(2, jumperCfg, false, true),
      ],
    };
    const gs = [];
    for (const s of packet.sheets) gs.push(await openSheet(page, s.svg));
    const statuses = packet.sheets.map((s, i) => {
      const cov = conductorLabelCoverage(s, packet, gs[i], gs, CONTINUATION_IR);
      return wireCaptionObservation(gs[i], cov, (dq, fs, extra) =>
        observation({ id: "probe" }, s, dq, fs, extra),
      );
    });
    expect(statuses.map((o) => o.status)).toEqual(["pass", "pass"]);
    expect(statuses.flatMap((o) => o.evidence.findings)).toEqual([]);
  }, 60_000);
});
