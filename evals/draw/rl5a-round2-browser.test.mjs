import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { launch, openSheet, drawingContextOptions } from "./browser.mjs";
import { contactCaptionAudit } from "./contact-role-oracle.mjs";
import { contactCaptionMediaAudit } from "./contact-role-media.mjs";
import { conversionQualifierAudit } from "./qualifier-oracle.mjs";
import { elementNavigationAudit } from "./element-navigation-oracle.mjs";
import { functionKeys } from "./checks.mjs";
import { end, nativeIr } from "./tranche3-fixtures.mjs";

const svgDoc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="160mm" viewBox="0 0 200 160">${body}</svg>`;

const encodeSemanticHex = (tuple) =>
  Array.from(JSON.stringify(tuple))
    .map((ch) => ch.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");

function channelIr(signal = "NC") {
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

const dcFragSvg = (y, markTransform = "") =>
  `<g data-device-uid="ps1" data-circuit-functions='[{"deviceUid":"ps1","functionKey":"dc_output"}]' transform="translate(30 ${y})">` +
  `<g data-source-enclosure="true" fill="none"><rect width="26" height="18" fill="white" stroke="none"/><line x1="0" y1="0" x2="26" y2="0" stroke="#17212b" stroke-width="0.18" stroke-dasharray="0.6 0.6"/></g>` +
  `<g data-function-key="dc_output" data-function-id='["ps1","dc_output"]'><g transform="translate(9 5) scale(.666667) ${markTransform}"><g data-circuit-mark="dc-output" stroke="#17212b" stroke-width="0.4" fill="none"><rect x="1" y="-1.5" width="10" height="15"/><line x1="3" y1="4" x2="9" y2="4"/><line x1="3" y1="7" x2="4" y2="7"/><line x1="5" y1="7" x2="7" y2="7"/><line x1="8" y1="7" x2="9" y2="7"/></g></g></g>` +
  `<g data-terminal-key="+"><circle data-terminal-marker="true" cx="26" cy="5.5" r=".65" fill="white" stroke="#17212b" stroke-width=".3" data-terminal-key="+" data-device-uid="ps1"/></g>` +
  `<g data-terminal-key="-"><circle data-terminal-marker="true" cx="26" cy="12.5" r=".65" fill="white" stroke="#17212b" stroke-width=".3" data-terminal-key="-" data-device-uid="ps1"/></g>` +
  `</g>`;

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
  const ir = v507Ir();
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
  return { ir, navSvg, auxSvg, request, packet };
}

function machineDemoCircuitRequest(ps1, plc1) {
  return {
    format: "schematic-packet-request/0.1",
    views: [
      {
        format: "circuit-view-request/0.1",
        title: "PLC I/O circuits",
        flow: "left-to-right",
        groups: [
          {
            id: "g1",
            label: "Stop input",
            functions: [
              { device: { by: "uid", value: ps1.uid }, key: "dc_output" },
              { device: { by: "uid", value: plc1.uid }, key: "di0" },
            ],
            conductors: [],
          },
          {
            id: "g2",
            label: "Second output",
            functions: [
              { device: { by: "uid", value: ps1.uid }, key: "dc_output" },
              { device: { by: "uid", value: plc1.uid }, key: "do0" },
            ],
            conductors: [],
          },
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

function fp01ConflictIr() {
  return {
    devices: [
      { uid: "k1", designation: "K1", typeId: "core:contactor" },
      { uid: "k2", designation: "K2", typeId: "t:load" },
    ],
    deviceTypes: [
      {
        id: "core:contactor",
        terminals: [{ key: "A1" }, { key: "A2" }, { key: "13" }],
      },
      { id: "t:load", terminals: [{ key: "L" }, { key: "N" }] },
    ],
    functions: [
      {
        id: { deviceUid: "k1", functionKey: "coil" },
        kind: "coil",
        terminals: [end("k1", "A1"), end("k1", "A2")],
      },
      {
        id: { deviceUid: "k2", functionKey: "coil" },
        kind: "load",
        terminals: [end("k2", "L"), end("k2", "N")],
      },
    ],
    terminals: [
      { id: end("k1", "A1") },
      { id: end("k1", "A2") },
      { id: end("k1", "13") },
      { id: end("k2", "L") },
      { id: end("k2", "N") },
    ],
  };
}

describe("RL5a round-2 browser-measured adversarial probes and repo-fixture real-site mutants", () => {
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

  it("Finding 1 & 5 browser: rotated unscoped fragment and attachment-rect enclosure fail", async () => {
    const dc = dcSupplyIr();
    const ds = {
      view: { kind: "circuit" },
      references: [{ deviceUid: "ps1", functions: ["dc_output"] }],
    };
    const unscoped = svgDoc(
      dcFragSvg(20) +
        dcFragSvg(70, "rotate(90 6 6)").replace(
          / data-circuit-functions='[^']*'/,
          "",
        ),
    );
    const gUnscoped = await openSheet(page, unscoped);
    expect(
      conversionQualifierAudit(gUnscoped, dc, ds).findings.length,
    ).toBeGreaterThan(0);

    const attachSubst = svgDoc(
      dcFragSvg(20) +
        dcFragSvg(70).replace(
          /<g data-source-enclosure="true" fill="none">.*?<\/g>/,
          '<g data-terminal-attachment=\'["ps1","+"]\'><rect width="26" height="18" fill="white" stroke="none"/></g>',
        ),
    );
    const gAttach = await openSheet(page, attachSubst);
    expect(
      conversionQualifierAudit(gAttach, dc, ds).findings.map((f) => f.kind),
    ).toContain("conversion-qualifier-geometry-unavailable");
  });

  it("Finding 2 browser: rejects non-continuation index text, split physical groups with same id, and distant rows", async () => {
    const nv = v507Fixture();
    const g2 = await openSheet(page, nv.auxSvg);
    const cases = [
      [
        "non-continuation index text",
        nv.navSvg([
          "OL1: NC contact",
          "95–96 → 02.A1,",
          "Drawing index: 05.A1",
        ]),
      ],
      [
        "distant unrelated row",
        nv
          .navSvg(["OL1: NC contact", "95–96 → 02.A1,", "05.A1"])
          .replace('y="63.6"', 'y="145"'),
      ],
      [
        "different physical groups with same annotation id",
        nv
          .navSvg(["OL1: NC contact", "95–96 → 02.A1,", "05.A1"])
          .replace(
            '<text x="30" y="63.6"',
            '</g><g data-navigation-annotation="el-ol1" data-navigation-role="element-location"><text x="30" y="63.6"',
          ),
      ],
    ];
    for (const [label, svg] of cases) {
      const g = await openSheet(page, svg);
      const audit = elementNavigationAudit(
        nv.packet,
        [g, g2, g2],
        nv.ir,
        nv.request,
      );
      expect(
        audit.findings.map((f) => f.kind),
        label,
      ).toContain("detached-element-reference-missing-or-wrong");
    }
  });

  it("Finding 3 & 4 browser: conflicting contact owner and HTML/PDF-only regressions fail", async () => {
    const ir = channelIr("NC");
    const hex = encodeSemanticHex([
      "label",
      "symbol",
      JSON.stringify(["function", "plc", "di1"]),
      "function",
    ]);
    const conflictSvg = svgDoc(
      `<defs><clipPath id="s-clip-${hex}"><rect width="180" height="140"/></clipPath></defs>` +
        `<g data-device-uid="k1" data-function-key="aux13"><g data-channel-line="signal">` +
        `<text class="label-text label-function" clip-path="url(#s-clip-${hex})" x="30" y="35" font-size="2.5">NC</text>` +
        `</g></g>`,
    );
    const gConflict = await openSheet(page, conflictSvg);
    expect(
      contactCaptionAudit(gConflict, ir).findings.map((f) => f.kind),
    ).toContain("contact-caption-contradicts-native-role");

    const ir2 = channelIr("Stop NC");
    const goodSvg = svgDoc(
      '<g data-device-uid="plc" data-function-key="di1"><g data-channel-line="signal"><text x="30" y="35" font-size="2.5">Stop NC</text></g></g>',
    );
    const sg = await openSheet(page, goodSvg);
    const hg = await openSheet(page, goodSvg);
    const hBad = await openSheet(
      page,
      goodSvg.replace(
        "</svg>",
        '<g data-device-uid="k1" data-function-key="aux13"><text x="75" y="35" font-size="2.5">NC</text></g></svg>',
      ),
    );
    const pGood = { text: "Stop NC", bbox: sg.texts[0].bbox };
    const htmlContact = contactCaptionMediaAudit(
      { ...sg, htmlTexts: hBad.texts, tranche3: { pdfTexts: [pGood] } },
      ir2,
    );
    expect(
      htmlContact.findings.some(
        (f) =>
          f.medium === "html" &&
          f.kind === "contact-caption-contradicts-native-role",
      ),
    ).toBe(true);

    const pBad = { text: "Start NO", bbox: sg.texts[0].bbox };
    const pdfBad = contactCaptionMediaAudit(
      { ...sg, htmlTexts: hg.texts, tranche3: { pdfTexts: [pBad] } },
      ir2,
    );
    expect(
      pdfBad.findings.some(
        (f) =>
          f.medium === "pdf" &&
          f.kind === "contact-caption-contradicts-native-role",
      ),
    ).toBe(true);
  });

  it("Finding 7 browser: forged terminal owner from a different device fails", async () => {
    const ir = fp01ConflictIr();
    const hex = encodeSemanticHex([
      "label",
      "symbol",
      JSON.stringify(["terminal", "k1", "A1"]),
      "function",
    ]);
    const svg = svgDoc(
      `<defs><clipPath id="s-clip-${hex}"><rect width="180" height="140"/></clipPath></defs>` +
        `<g data-device-uid="k2" data-function-key="coil">` +
        `<text class="label-text label-function" clip-path="url(#s-clip-${hex})" x="30" y="35" font-size="2.5">coil outside view</text>` +
        `</g>`,
    );
    const g = await openSheet(page, svg);
    expect(functionKeys(g, ir)).toMatchObject([
      { kind: "printed-function-key", key: "coil" },
    ]);
  });

  it("real-site mutant (repo fixture machine-demo): PS1 repeated DC scope loss + PLC1 HTML/PDF-only signal contradiction", async () => {
    const md = await compileProject("examples/machine-demo");
    expect(md.ok).toBe(true);
    const ir = structuredClone(md.ir);
    const ps1 = ir.devices.find((d) => d.designation === "PS1");
    const plc1 = ir.devices.find((d) => d.designation === "PLC1");
    plc1.io.channels.di0.signal = "Conveyor stop (NC healthy)";
    const req = machineDemoCircuitRequest(ps1, plc1);
    const rendered = await renderSchematicPacket(ir, req, md.presentation);
    expect(rendered.ok).toBe(true);
    const sheet = rendered.value.sheets[0];
    const g = await openSheet(page, embedPrintableFont(sheet.svg));
    expect(conversionQualifierAudit(g, ir, sheet).findings).toEqual([]);

    const { document } = parseHTML(sheet.svg);
    const marks = [
      ...document.querySelectorAll('[data-circuit-mark="dc-output"]'),
    ].filter(
      (e) =>
        e.closest("[data-device-uid]")?.getAttribute("data-device-uid") ===
        ps1.uid,
    );
    expect(marks.length).toBeGreaterThanOrEqual(2);
    marks[1].setAttribute("transform", "rotate(90 6 6)");
    for (let p = marks[1]; p && p.tagName !== "svg"; p = p.parentElement) {
      if (p.hasAttribute("data-circuit-functions"))
        p.removeAttribute("data-circuit-functions");
    }
    const orphanG = await openSheet(
      page,
      embedPrintableFont(document.toString()),
    );
    expect(
      conversionQualifierAudit(orphanG, ir, sheet).findings.length,
    ).toBeGreaterThan(0);

    const sig = g.texts.find((t) => t.text === "Conveyor stop (NC healthy)");
    expect(sig).toBeDefined();
    const doc2 = parseHTML(sheet.svg).document;
    const htmlSig = [...doc2.querySelectorAll("text")].find(
      (e) => e.textContent === sig.text,
    );
    htmlSig.textContent = "Conveyor stop (NO healthy)";
    const htmlG = await openSheet(page, embedPrintableFont(doc2.toString()));
    const pdfModel = g.texts.map((t) => ({ text: t.text, bbox: t.bbox }));
    expect(
      contactCaptionMediaAudit(
        { ...g, htmlTexts: htmlG.texts, tranche3: { pdfTexts: pdfModel } },
        ir,
      ).findings.some((f) => f.medium === "html"),
    ).toBe(true);

    const pdfMut = pdfModel.map((p) =>
      p.text === sig.text ? { ...p, text: "Conveyor stop (NO healthy)" } : p,
    );
    expect(
      contactCaptionMediaAudit(
        { ...g, htmlTexts: g.texts, tranche3: { pdfTexts: pdfMut } },
        ir,
      ).findings.some((f) => f.medium === "pdf"),
    ).toBe(true);
  });

  it("real-site mutant (repo fixture motor-starter): wrapped OL1 pointer rejects non-continuation index text", async () => {
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
      (gEl) =>
        gEl.textContent.includes("OL1:") && gEl.textContent.includes("03.A1"),
    );
    expect(olGroup).toBeDefined();
    const baseText = olGroup.querySelector("text");
    const x = Number(baseText.getAttribute("x")) + 25;
    const y = Number(baseText.getAttribute("y"));
    const fontAttrs = `x="${x}" font-family="${baseText.getAttribute("font-family")}" font-size="${baseText.getAttribute("font-size")}" text-anchor="start" fill="#18212b"`;
    const makeWrapped = (tail) => {
      olGroup.innerHTML =
        `<text ${fontAttrs} y="${y}">OL1: NC contact</text>` +
        `<text ${fontAttrs} y="${y + 4.8}">95–96 → 02.A1,</text>` +
        `<text ${fontAttrs} y="${y + 9.6}">${tail}</text>`;
      return document.toString();
    };
    const filter = (f) =>
      f.kind === "detached-element-reference-missing-or-wrong" &&
      f.sheet === 1 &&
      f.deviceUid === ol1.uid &&
      f.targetFunction === "aux95" &&
      f.targetSheet === 3;

    const gWrapped = await openSheet(
      page,
      embedPrintableFont(makeWrapped("03.A1")),
    );
    expect(
      elementNavigationAudit(
        packet,
        [gWrapped, ...geos.slice(1)],
        ms.ir,
        req,
      ).findings.filter(filter),
    ).toEqual([]);

    const gIndex = await openSheet(
      page,
      embedPrintableFont(makeWrapped("Drawing index: 03.A1")),
    );
    expect(
      elementNavigationAudit(
        packet,
        [gIndex, ...geos.slice(1)],
        ms.ir,
        req,
      ).findings.filter(filter),
    ).toHaveLength(3);
  });

  it("Finding 8 real-site control (repo fixture report-filtering): accepts physical S1.P on strips/wires and rejects dotted S1.P on assemblies/io-ports", async () => {
    const comp = await compileProject("examples/report-filtering");
    expect(comp.ok).toBe(true);
    const req = JSON.parse(
      await readFile("examples/report-filtering/packet.json", "utf8"),
    );
    req.views.push(
      { format: "documentation-view-request/0.1", kind: "wires" },
      { format: "documentation-view-request/0.1", kind: "assemblies" },
      { format: "documentation-view-request/0.1", kind: "io-ports" },
    );
    const rendered = await renderSchematicPacket(
      comp.ir,
      req,
      comp.presentation,
    );
    expect(rendered.ok).toBe(true);
    const packet = rendered.value;
    for (const s of packet.sheets) {
      const g = await openSheet(page, embedPrintableFont(s.svg));
      if (
        !g.texts.some(
          (t) => t.text.includes("S1.P") || t.text.includes("S1: P"),
        )
      )
        continue;
      expect(
        functionKeys(g, comp.ir, { sheet: s, packet, request: req }),
        s.view.kind,
      ).toEqual([]);
      if (!["assemblies", "io-ports"].includes(s.view.kind)) continue;
      const { document } = parseHTML(s.svg);
      const t = [...document.querySelectorAll("text")].find((el) =>
        el.textContent.includes("S1: P"),
      );
      if (!t) continue;
      t.textContent = t.textContent.replace("S1: P", "S1.P");
      const patched = await openSheet(
        page,
        embedPrintableFont(document.toString()),
      );
      expect(
        functionKeys(patched, comp.ir, { sheet: s, packet, request: req }),
        `mutated ${s.view.kind}`,
      ).toMatchObject([{ kind: "printed-function-key", key: "S1.P" }]);
    }
  });
});
