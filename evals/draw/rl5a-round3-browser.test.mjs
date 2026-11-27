import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { packetPdf } from "../../packages/cli/dist/alpha-pdf.js";
import { launch, openSheet, drawingContextOptions } from "./browser.mjs";
import { loadPdfBytes } from "./pdf.mjs";
import { pdfIdentifierRuns } from "./identifier-pdf.mjs";
import { prepareOraclePdf } from "./tranche3-pdf.mjs";
import { contactCaptionMediaAudit } from "./contact-role-media.mjs";
import { conversionQualifierAudit } from "./qualifier-oracle.mjs";
import { elementNavigationAudit } from "./element-navigation-oracle.mjs";
import { functionKeys } from "./checks.mjs";
import { end, nativeIr } from "./tranche3-fixtures.mjs";

const svgDoc = (body, font = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg"${font ? ` font-family="${font}"` : ""} width="200mm" height="160mm" viewBox="0 0 200 160">${body}</svg>`;

const encodeSemanticHex = (tuple) =>
  Array.from(JSON.stringify(tuple))
    .map((ch) => ch.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");

const semanticLabel = (entity, role, body) => {
  const h = encodeSemanticHex([
    "label",
    "symbol",
    JSON.stringify(entity),
    role,
  ]);
  return (
    `<defs><clipPath id="s-clip-${h}"><rect width="180" height="140"/></clipPath></defs>` +
    body.replace("CLIP", `clip-path="url(#s-clip-${h})"`)
  );
};

const unscoped = (s) => s.replace(/ data-circuit-functions='[^']*'/, "");

const dcFragSvg = (y, markTransform = "") =>
  `<g data-device-uid="ps1" data-circuit-functions='[{"deviceUid":"ps1","functionKey":"dc_output"}]' transform="translate(30 ${y})">` +
  `<g data-source-enclosure="true" fill="none"><rect width="26" height="18" fill="white" stroke="none"/><line x1="0" y1="0" x2="26" y2="0" stroke="#17212b" stroke-width="0.18" stroke-dasharray="0.6 0.6"/></g>` +
  `<g data-function-key="dc_output" data-function-id='["ps1","dc_output"]'><g transform="translate(9 5) scale(.666667) ${markTransform}"><g data-circuit-mark="dc-output" stroke="#17212b" stroke-width="0.4" fill="none"><rect x="1" y="-1.5" width="10" height="15"/><line x1="3" y1="4" x2="9" y2="4"/><line x1="3" y1="7" x2="4" y2="7"/><line x1="5" y1="7" x2="7" y2="7"/><line x1="8" y1="7" x2="9" y2="7"/></g></g></g>` +
  `<g data-terminal-key="+"><circle data-terminal-marker="true" cx="26" cy="5.5" r=".65" fill="white" stroke="#17212b" stroke-width=".3" data-terminal-key="+" data-device-uid="ps1"/></g>` +
  `<g data-terminal-key="-"><circle data-terminal-marker="true" cx="26" cy="12.5" r=".65" fill="white" stroke="#17212b" stroke-width=".3" data-terminal-key="-" data-device-uid="ps1"/></g>` +
  `</g>`;

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

function channelIr(signal = "Pump ready") {
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

function v507Ir() {
  return {
    devices: [{ uid: "ol1", designation: "OL1", typeId: "t:ol" }],
    deviceTypes: [
      {
        id: "t:ol",
        symbol: "thermite:overload",
        terminals: [
          { key: "1/L1", role: "power_input" },
          { key: "2/T1", role: "power_output" },
          { key: "95", role: "control_switch" },
          { key: "96", role: "control_switch" },
        ],
      },
    ],
    functions: [
      {
        id: { deviceUid: "ol1", functionKey: "pole1" },
        kind: "contact",
        normal_state: "closed",
        terminals: [end("ol1", "1/L1"), end("ol1", "2/T1")],
      },
      {
        id: { deviceUid: "ol1", functionKey: "aux95" },
        kind: "contact",
        normal_state: "closed",
        terminals: [end("ol1", "95"), end("ol1", "96")],
      },
    ],
    internalRelations: [],
  };
}

function v507Fixture() {
  const zones =
    [1, 2, 3, 4, 5, 6]
      .map(
        (n, i) => `<text x="${35 + i * 28}" y="10" font-size="2.5">${n}</text>`,
      )
      .join("") +
    ["A", "B", "C", "D"]
      .map(
        (l, i) => `<text x="10" y="${30 + i * 35}" font-size="2.5">${l}</text>`,
      )
      .join("");
  const navSvg = (lines) =>
    svgDoc(
      zones +
        `<g data-device-uid="ol1" data-circuit-functions='[{"deviceUid":"ol1","functionKey":"pole1"}]'><g class="symbol" data-symbol-id="ais:overload" data-function-key="pole1" data-function-id='["ol1","pole1"]'><rect x="30" y="30" width="14" height="12" stroke="black" stroke-width="0.4" fill="none"/></g><circle data-terminal-marker="true" data-terminal-key="1/L1" data-device-uid="ol1" cx="30" cy="36" r=".6" stroke="black" fill="white"/><circle data-terminal-marker="true" data-terminal-key="2/T1" data-device-uid="ol1" cx="44" cy="36" r=".6" stroke="black" fill="white"/></g>` +
        `<g data-navigation-annotation="el-ol1" data-navigation-role="element-location">${lines.map((line, i) => `<text x="30" y="${54 + i * 4.8}" font-size="3.5">${line}</text>`).join("")}</g>`,
    );
  const auxSvg = svgDoc(
    zones +
      `<g data-device-uid="ol1" data-circuit-functions='[{"deviceUid":"ol1","functionKey":"aux95"}]'><g class="symbol" data-symbol-id="ais:contact-nc" data-function-key="aux95" data-function-id='["ol1","aux95"]'><rect x="30" y="30" width="14" height="12" stroke="black" stroke-width="0.4" fill="none"/></g><circle data-terminal-marker="true" data-terminal-key="95" data-device-uid="ol1" cx="30" cy="36" r=".6" stroke="black" fill="white"/><circle data-terminal-marker="true" data-terminal-key="96" data-device-uid="ol1" cx="44" cy="36" r=".6" stroke="black" fill="white"/></g>` +
      `<g data-navigation-annotation="el-ol1-back" data-navigation-role="element-location"><text x="30" y="54" font-size="3.5">OL1: Overload element 1/L1–2/T1 → 01.A1</text></g>`,
  );
  const sel = (id, key) => ({
    id,
    functions: [{ device: { by: "uid", value: "ol1" }, key }],
  });
  const request = {
    views: [
      { title: "P", groups: [sel("g1", "pole1")] },
      { title: "C1", groups: [sel("g2", "aux95")] },
      { title: "C2", groups: [sel("g3", "aux95")] },
    ],
  };
  const packet = {
    sheets: [
      { number: 1, view: { kind: "circuit", title: "P" } },
      { number: 2, view: { kind: "circuit", title: "C1" } },
      { number: 5, view: { kind: "circuit", title: "C2" } },
    ],
  };
  return { ir: v507Ir(), navSvg, auxSvg, request, packet };
}

function key02Ir() {
  const fn = (deviceUid, functionKey, kind, keys) => ({
    id: { deviceUid, functionKey },
    kind,
    terminals: keys.map((k) => end(deviceUid, k)),
  });
  const imKeys = ["1L+", "1M", "2L+", "2M", "X1.P1.1"];
  return {
    devices: [{ uid: "im", designation: "D1", typeId: "siemens:im" }],
    deviceTypes: [
      {
        id: "siemens:im",
        terminals: imKeys.map((key) => ({ key })),
        connectorPorts: {
          "X1.P1.CONTACTS": { pins: { SHIELD: { terminal: "X1.P1.1" } } },
        },
      },
    ],
    functions: [
      fn("im", "2L+", "bus", ["2L+"]),
      fn("im", "SHIELD", "bus", ["X1.P1.1"]),
    ],
    terminals: imKeys.map((k) => ({ id: end("im", k) })),
  };
}

function machineDemoCircuitRequest(ps1, plc1) {
  const dcGroup = (id, label, extra) => ({
    id,
    label,
    functions: [
      { device: { by: "uid", value: ps1.uid }, key: "dc_output" },
      ...(extra
        ? [{ device: { by: "uid", value: plc1.uid }, key: extra }]
        : []),
    ],
    conductors: [],
  });
  return {
    format: "schematic-packet-request/0.1",
    views: [
      {
        format: "circuit-view-request/0.1",
        title: "DC and PLC",
        flow: "left-to-right",
        groups: [
          dcGroup("dc-a", "24VDC A", "di0"),
          dcGroup("dc-b", "24VDC B", "do0"),
          dcGroup("dc-c", "24VDC C"),
        ],
      },
    ],
  };
}

function motorStarterNavRequest(ol1) {
  const aux = (id, label) => ({
    format: "circuit-view-request/0.1",
    title: label,
    flow: "top-to-bottom",
    groups: [
      {
        id,
        label,
        functions: [{ device: { by: "uid", value: ol1.uid }, key: "aux95" }],
        conductors: [],
      },
    ],
  });
  return {
    format: "schematic-packet-request/0.1",
    views: [
      {
        format: "schematic-view-request/0.1",
        family: "power",
        root: { by: "designation", value: "M1" },
        flow: "top-to-bottom",
      },
      aux("c1", "Control 1"),
      aux("c2", "Control 2"),
    ],
  };
}

async function renderReportFilteringWires() {
  const comp = await compileProject("examples/report-filtering");
  expect(comp.ok).toBe(true);
  const request = JSON.parse(
    await readFile("examples/report-filtering/packet.json", "utf8"),
  );
  request.views.push({
    format: "documentation-view-request/0.1",
    kind: "wires",
  });
  const rendered = await renderSchematicPacket(
    comp.ir,
    request,
    comp.presentation,
  );
  expect(rendered.ok).toBe(true);
  const packet = rendered.value;
  const wire = packet.sheets.find(
    (s) => s.view.kind === "wires" && s.svg.includes(">S1.P<"),
  );
  expect(wire).toBeDefined();
  return { ir: comp.ir, request, packet, wire };
}

async function auditPdfMutation(g, ir, sheet, pageDims, pdfSvg, title) {
  const pdfBytes = await packetPdf(
    { page: pageDims, sheets: [{ number: 1, svg: pdfSvg }] },
    title,
  );
  const doc = await loadPdfBytes(pdfBytes);
  try {
    const pdfPage = await doc.getPage(1);
    const runs = await pdfIdentifierRuns(pdfPage);
    const prepared = { ...g, htmlTexts: g.texts, tranche3: {} };
    await prepareOraclePdf(prepared, ir, sheet, pdfPage, runs);
    return { prepared, audit: contactCaptionMediaAudit(prepared, ir) };
  } finally {
    await doc.loadingTask.destroy();
  }
}

describe("RL5a round-3 adversarial variants and repo-fixture regressions (#646)", () => {
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

  it("1a V4-01: unscoped fragment missing ports cannot borrow a neighbor's ports (synthetic + machine-demo)", async () => {
    const dc = dcSupplyIr();
    const ds = {
      view: { kind: "circuit" },
      references: [{ deviceUid: "ps1", functions: ["dc_output"] }],
    };
    const intact = await openSheet(
      page,
      svgDoc(
        dcFragSvg(20) + unscoped(dcFragSvg(65)) + unscoped(dcFragSvg(110)),
      ),
    );
    expect(conversionQualifierAudit(intact, dc, ds).findings).toEqual([]);

    const noPorts = unscoped(dcFragSvg(110)).replace(
      /<g data-terminal-key="[^"]+"><circle[^>]+\/><\/g>/g,
      "",
    );
    const missing = await openSheet(
      page,
      svgDoc(dcFragSvg(20) + unscoped(dcFragSvg(65)) + noPorts),
    );
    expect(
      conversionQualifierAudit(missing, dc, ds).findings.map((f) => f.kind),
    ).toContain("conversion-qualifier-geometry-unavailable");

    const md = await compileProject("examples/machine-demo");
    expect(md.ok).toBe(true);
    const ps1 = md.ir.devices.find((d) => d.designation === "PS1");
    const plc1 = md.ir.devices.find((d) => d.designation === "PLC1");
    const rendered = await renderSchematicPacket(
      md.ir,
      machineDemoCircuitRequest(ps1, plc1),
      md.presentation,
    );
    expect(rendered.ok).toBe(true);
    const sheet = rendered.value.sheets[0];
    const { document } = parseHTML(sheet.svg);
    const frags = [
      ...document.querySelectorAll("[data-circuit-functions]"),
    ].filter(
      (el) =>
        el.getAttribute("data-device-uid") === ps1.uid &&
        el.querySelector('[data-circuit-mark="dc-output"]'),
    );
    expect(frags.length).toBeGreaterThanOrEqual(3);
    frags[1].removeAttribute("data-circuit-functions");
    frags[2].removeAttribute("data-circuit-functions");
    for (const marker of frags[2].querySelectorAll("circle[data-terminal-key]"))
      marker.remove();
    const realMissing = await openSheet(
      page,
      embedPrintableFont(document.toString()),
    );
    expect(
      conversionQualifierAudit(realMissing, md.ir, sheet).findings.map(
        (f) => f.kind,
      ),
    ).toContain("conversion-qualifier-geometry-unavailable");
  });

  it("2a V5-07: separate inner navigation container and second-column rows never join", async () => {
    const nv = v507Fixture();
    const g2 = await openSheet(page, nv.auxSvg);
    const wrap = nv.navSvg(["OL1: NC contact", "95–96 → 02.A1,", "05.A1"]);
    const splitContainer = wrap.replace(
      '<text x="30" y="63.6" font-size="3.5">05.A1</text>',
      '<g data-navigation-role="mirror" data-navigation-owner="other-pointer">' +
        '<line x1="57" x2="57" y1="49" y2="68" stroke="black" stroke-width=".2"/>' +
        '<text x="59" y="54" font-size="3.5">Drawing index:</text>' +
        '<text x="59" y="63.6" font-size="3.5">05.A1</text></g>',
    );
    const gSplit = await openSheet(page, splitContainer);
    expect(
      elementNavigationAudit(nv.packet, [gSplit, g2, g2], nv.ir, nv.request)
        .findings,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "detached-element-reference-missing-or-wrong",
          targetSheet: 5,
          targetFunction: "aux95",
        }),
      ]),
    );

    const shiftedColumn = wrap.replace(
      '<text x="30" y="63.6" font-size="3.5">05.A1</text>',
      '<text x="59" y="63.6" font-size="3.5">05.A1</text>',
    );
    const gShifted = await openSheet(page, shiftedColumn);
    expect(
      elementNavigationAudit(nv.packet, [gShifted, g2, g2], nv.ir, nv.request)
        .findings,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "detached-element-reference-missing-or-wrong",
          targetSheet: 5,
          targetFunction: "aux95",
        }),
      ]),
    );
  });

  it("2a V5-07 (motor-starter): inner drawing-index container cannot donate OL1 target", async () => {
    const ms = await compileProject("examples/motor-starter");
    expect(ms.ok).toBe(true);
    const ol1 = ms.ir.devices.find((d) => d.designation === "OL1");
    const req = motorStarterNavRequest(ol1);
    const rendered = await renderSchematicPacket(ms.ir, req, ms.presentation);
    expect(rendered.ok).toBe(true);
    const packet = rendered.value;
    const geos = [];
    for (const s of packet.sheets)
      geos.push(await openSheet(page, embedPrintableFont(s.svg)));
    const { document } = parseHTML(packet.sheets[0].svg);
    const olGroup = [
      ...document.querySelectorAll("[data-navigation-annotation]"),
    ].find(
      (el) =>
        el.textContent.includes("OL1:") && el.textContent.includes("03.A1"),
    );
    expect(olGroup).toBeDefined();
    const baseText = olGroup.querySelector("text");
    const x = Number(baseText.getAttribute("x")) + 25;
    const y = Number(baseText.getAttribute("y"));
    const fontAttrs = `font-family="${baseText.getAttribute("font-family")}" font-size="${baseText.getAttribute("font-size")}" text-anchor="start" fill="#18212b"`;
    olGroup.innerHTML =
      `<text ${fontAttrs} x="${x}" y="${y}">OL1: NC contact</text>` +
      `<text ${fontAttrs} x="${x}" y="${y + 4.8}">95–96 → 02.A1,</text>` +
      `<g data-navigation-role="mirror" data-navigation-owner="other-pointer">` +
      `<text ${fontAttrs} x="${x + 29}" y="${y}">Drawing index:</text>` +
      `<text ${fontAttrs} x="${x + 29}" y="${y + 9.6}">03.A1</text></g>`;
    const gMut = await openSheet(page, embedPrintableFont(document.toString()));
    expect(
      elementNavigationAudit(
        packet,
        [gMut, ...geos.slice(1)],
        ms.ir,
        req,
      ).findings.filter(
        (f) =>
          f.kind === "detached-element-reference-missing-or-wrong" &&
          f.targetSheet === 3 &&
          f.targetFunction === "aux95",
      ),
    ).toHaveLength(3);
  });

  it("4a V2-01 PDF: PDF-only NC on token-free channel signal is extracted by prepareOraclePdf and flagged", async () => {
    const signalMarkup = (text) =>
      `<g data-device-uid="plc" data-function-key="di1"><g data-channel-line="signal"><text x="30" y="35" font-size="3.5">${text}</text></g></g>`;
    const sheetSvg = (text) => svgDoc(signalMarkup(text), "Thermite Sans");
    const mediaIr = channelIr("Pump ready");
    const g = await openSheet(page, embedPrintableFont(sheetSvg("Pump ready")));
    const { prepared, audit } = await auditPdfMutation(
      g,
      mediaIr,
      { view: { kind: "circuit" } },
      { widthMm: 200, heightMm: 160 },
      sheetSvg("Pump NC"),
      "RL5a round-3 PDF-only mutation",
    );
    expect(prepared.tranche3.pdfTexts?.length).toBeGreaterThan(0);
    expect(audit.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "contact-caption-contradicts-native-role",
          medium: "pdf",
        }),
      ]),
    );
  });

  it("4a V2-01 PDF (machine-demo): PDF-only NC on real PLC channel signal is flagged", async () => {
    const md = await compileProject("examples/machine-demo");
    expect(md.ok).toBe(true);
    const ir = structuredClone(md.ir);
    const ps1 = ir.devices.find((d) => d.designation === "PS1");
    const plc1 = ir.devices.find((d) => d.designation === "PLC1");
    plc1.io.channels.di0.signal = "Pump ready";
    const rendered = await renderSchematicPacket(
      ir,
      machineDemoCircuitRequest(ps1, plc1),
      md.presentation,
    );
    expect(rendered.ok).toBe(true);
    const sheet = rendered.value.sheets[0];
    const realG = await openSheet(page, embedPrintableFont(sheet.svg));
    const mutatedSvg = sheet.svg.replace(">Pump ready<", ">Pump NC<");
    expect(mutatedSvg).not.toBe(sheet.svg);
    const { prepared, audit } = await auditPdfMutation(
      realG,
      ir,
      sheet,
      rendered.value.page,
      mutatedSvg,
      "RL5a round-3 machine-demo PDF mutation",
    );
    expect(prepared.tranche3.pdfTexts?.length).toBeGreaterThan(0);
    expect(audit.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "contact-caption-contradicts-native-role",
          medium: "pdf",
        }),
      ]),
    );
  });

  it("6a KEY-02: same-device pin alias SHIELD on function-caption surface fails while pin label passes", async () => {
    const ki = key02Ir();
    const fnCaptionSvg = semanticLabel(
      ["function", "im", "SHIELD"],
      "function",
      '<g data-device-uid="im" data-function-key="SHIELD">' +
        '<text class="label-text label-function" CLIP x="30" y="35" font-size="3.5">SHIELD</text></g>',
    );
    const kg = await openSheet(page, svgDoc(fnCaptionSvg));
    expect(
      functionKeys(kg, ki, { sheet: { view: { kind: "circuit" } } }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "printed-function-key",
          key: "SHIELD",
        }),
      ]),
    );

    const pinLabelSvg =
      '<g data-device-uid="im" data-terminal-key="X1.P1.1">' +
      '<text class="label-text label-terminal" x="30" y="35" font-size="3.5">SHIELD</text></g>';
    const pinG = await openSheet(page, svgDoc(pinLabelSvg));
    expect(
      functionKeys(pinG, ki, { sheet: { view: { kind: "circuit" } } }),
    ).toEqual([]);
  });

  it("7a FP-01: conflicting measured terminal on same device rejects 'coil outside view' (motor-starter K1)", async () => {
    const ms = await compileProject("examples/motor-starter");
    expect(ms.ok).toBe(true);
    const k1 = ms.ir.devices.find((d) => d.designation === "K1");
    expect(k1).toBeDefined();
    const makeSvg = (terminalKey) =>
      svgDoc(
        semanticLabel(
          ["terminal", k1.uid, "A1"],
          "function",
          `<g data-device-uid="${k1.uid}" data-terminal-key="${terminalKey}">` +
            `<text class="label-text label-function" CLIP x="30" y="35" font-size="3.5">coil outside view</text></g>`,
        ),
      );
    const mismatch = await openSheet(page, makeSvg("13"));
    expect(functionKeys(mismatch, ms.ir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "printed-function-key", key: "coil" }),
      ]),
    );
    const matched = await openSheet(page, makeSvg("A1"));
    expect(functionKeys(matched, ms.ir)).toEqual([]);
  });

  it("8b selector: physical-incidence exemption is per-element and rejects Port-prefixed, parenthesised, bracketed, and non-endpoint cells", async () => {
    const { ir, request, packet, wire } = await renderReportFilteringWires();
    const wireCtx = { sheet: wire, packet, request };
    const control = await openSheet(page, embedPrintableFont(wire.svg));
    expect(functionKeys(control, ir, wireCtx)).toEqual([]);

    for (const replacement of [
      "Port: (S1.P)",
      "Port: S1.P",
      "(S1.P)",
      "[S1.P]",
    ]) {
      const doc = parseHTML(wire.svg).document;
      const target = [...doc.querySelectorAll("text")].find(
        (t) => t.textContent === "S1.P",
      );
      expect(target).toBeDefined();
      target.textContent = replacement;
      const mut = await openSheet(page, embedPrintableFont(doc.toString()));
      expect(functionKeys(mut, ir, wireCtx), replacement).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "printed-function-key",
            key: "S1.P",
          }),
        ]),
      );
    }

    const docNonEndpoint = parseHTML(wire.svg).document;
    const assignCell = docNonEndpoint.querySelector(
      '[data-report-row] [data-report-column="5"] text',
    );
    expect(assignCell).toBeDefined();
    assignCell.textContent = "S1.P";
    const mutAssign = await openSheet(
      page,
      embedPrintableFont(docNonEndpoint.toString()),
    );
    expect(functionKeys(mutAssign, ir, wireCtx)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "printed-function-key",
          key: "S1.P",
        }),
      ]),
    );
  });
});
