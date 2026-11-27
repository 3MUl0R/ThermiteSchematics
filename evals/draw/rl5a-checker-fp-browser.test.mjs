import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { launch, openSheet, drawingContextOptions } from "./browser.mjs";
import { contactCaptionAudit } from "./contact-role-oracle.mjs";
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

describe("RL5a browser-measured positive and negative controls", () => {
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

  it("V2-01 browser: data-channel-line=signal is measured and exempt only when matching native channel signal", async () => {
    const ir = nativeIr();
    ir.devices = [
      {
        uid: "plc",
        designation: "PLC1",
        typeId: "core:plc",
        io: {
          channels: {
            di1: { address: "%I0.1", signal: "Conveyor stop (NC healthy)" },
            do0: {
              address: "%Q0.0",
              signal: "Pump contactor command - KM1 through OL1 NC",
            },
          },
        },
      },
    ];
    ir.deviceTypes = [
      { id: "core:plc", terminals: [{ key: "DI1" }, { key: "DO0" }] },
    ];
    ir.functions = [
      {
        id: { deviceUid: "plc", functionKey: "di1" },
        kind: "channel",
        direction: "input",
        terminals: [end("plc", "DI1")],
      },
      {
        id: { deviceUid: "plc", functionKey: "do0" },
        kind: "channel",
        direction: "output",
        terminals: [end("plc", "DO0")],
      },
    ];
    const goodSvg = svgDoc(
      `<g data-device-uid="plc" data-circuit-functions='[{"deviceUid":"plc","functionKey":"di1"},{"deviceUid":"plc","functionKey":"do0"}]'>` +
        `<g data-function-key="di1"><g data-channel-line="address"><text x="20" y="20" font-size="2.5">%I0.1</text></g><g data-channel-line="signal"><text x="20" y="24" font-size="2.5">Conveyor stop (NC healthy)</text></g></g>` +
        `<g data-function-key="do0"><g data-channel-line="address"><text x="20" y="34" font-size="2.5">%Q0.0</text></g><g data-channel-line="signal"><text x="20" y="38" font-size="2.5">Pump contactor command -</text></g><g data-channel-line="signal"><text x="20" y="42" font-size="2.5">KM1 through OL1 NC</text></g></g>` +
        `</g>`,
    );
    const goodG = await openSheet(page, goodSvg);
    expect(goodG.texts.filter((t) => t.channelLine === "signal").length).toBe(
      3,
    );
    expect(contactCaptionAudit(goodG, ir).findings).toEqual([]);

    const badSvg = goodSvg.replace(
      "Conveyor stop (NC healthy)",
      "Spurious NC contact",
    );
    const badG = await openSheet(page, badSvg);
    expect(contactCaptionAudit(badG, ir).findings.map((f) => f.kind)).toContain(
      "contact-caption-contradicts-native-role",
    );
  });

  it("V4-01 browser: two PS1 DC-output-only fragments on one sheet pass; rotated second fragment fails", async () => {
    const ir = nativeIr();
    ir.devices = [{ uid: "ps1", designation: "PS1", typeId: "core:psu" }];
    ir.deviceTypes = [
      {
        id: "core:psu",
        symbol: "thermite:dc-supply",
        terminals: [
          {
            key: "+",
            role: "dc_positive_output",
            rating: { voltage_type: "DC" },
          },
          {
            key: "-",
            role: "dc_return_output",
            rating: { voltage_type: "DC" },
          },
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
    const frag = (y, markTransform = "") =>
      `<g data-device-uid="ps1" data-circuit-functions='[{"deviceUid":"ps1","functionKey":"dc_output"}]' transform="translate(30 ${y})">` +
      `<g data-source-enclosure="true" fill="none"><rect width="26" height="18" fill="white" stroke="none"/><line x1="0" y1="0" x2="26" y2="0" stroke="#17212b" stroke-width="0.18" stroke-dasharray="0.6 0.6"/></g>` +
      `<g data-function-key="dc_output" data-function-id='["ps1","dc_output"]'><g transform="translate(9 5) scale(.666667) ${markTransform}"><g data-circuit-mark="dc-output" stroke="#17212b" stroke-width="0.4" fill="none"><rect x="1" y="-1.5" width="10" height="15"/><line x1="3" y1="4" x2="9" y2="4"/><line x1="3" y1="7" x2="4" y2="7"/><line x1="5" y1="7" x2="7" y2="7"/><line x1="8" y1="7" x2="9" y2="7"/></g></g></g>` +
      `<g data-terminal-key="+"><circle data-terminal-marker="true" cx="26" cy="5.5" r=".65" fill="white" stroke="#17212b" stroke-width=".3" data-terminal-key="+" data-device-uid="ps1"/></g>` +
      `<g data-terminal-key="-"><circle data-terminal-marker="true" cx="26" cy="12.5" r=".65" fill="white" stroke="#17212b" stroke-width=".3" data-terminal-key="-" data-device-uid="ps1"/></g>` +
      `</g>`;
    const sheet = {
      view: { kind: "circuit" },
      references: [{ deviceUid: "ps1", functions: ["dc_output"] }],
    };
    const goodG = await openSheet(page, svgDoc(frag(20) + frag(70)));
    expect(conversionQualifierAudit(goodG, ir, sheet).findings).toEqual([]);

    const rotatedG = await openSheet(
      page,
      svgDoc(frag(20) + frag(70, "rotate(90 6 6)")),
    );
    expect(
      conversionQualifierAudit(rotatedG, ir, sheet).findings.map((f) => f.kind),
    ).toContain("conversion-qualifier-not-upright");
  });

  it("FP-01 browser: real clip-path semantic terminal label 'coil outside view' passes while raw coil key fails", async () => {
    const uid = "10000000-0000-4000-8000-000000000003";
    const ir = {
      devices: [{ uid, designation: "K1", typeId: "core:contactor" }],
      deviceTypes: [
        { id: "core:contactor", terminals: [{ key: "A1" }, { key: "A2" }] },
      ],
      functions: [
        {
          id: { deviceUid: uid, functionKey: "coil" },
          kind: "coil",
          terminals: [end(uid, "A1"), end(uid, "A2")],
        },
      ],
      terminals: [{ id: end(uid, "A1") }, { id: end(uid, "A2") }],
    };
    const hex = encodeSemanticHex([
      "label",
      "symbol",
      JSON.stringify(["terminal", uid, "A1"]),
      "function",
    ]);
    const svg = svgDoc(
      `<defs><clipPath id="s-clip-${hex}"><rect x="0" y="0" width="120" height="40"/></clipPath></defs>` +
        `<text class="label-text label-function" clip-path="url(#s-clip-${hex})" x="10" y="20" font-size="2.5">coil outside view</text>`,
    );
    const g = await openSheet(page, svg);
    expect(functionKeys(g, ir)).toEqual([]);

    const badG = await openSheet(
      page,
      svg.replace("coil outside view", "coil raw_leak"),
    );
    expect(functionKeys(badG, ir)).toMatchObject([
      { kind: "printed-function-key", key: "coil" },
    ]);
  });

  it("connectorPorts browser: RL3 cap-pagination has 0 selector hits and a planted R1.X01 selector fails", async () => {
    const compiled = await compileProject("examples/cap-pagination");
    expect(compiled.ok).toBe(true);
    const request = JSON.parse(
      await readFile("examples/cap-pagination/packet.json", "utf8"),
    );
    const rendered = await renderSchematicPacket(
      compiled.ir,
      request,
      compiled.presentation,
    );
    expect(rendered.ok).toBe(true);
    for (const sheet of rendered.value.sheets) {
      const g = await openSheet(page, embedPrintableFont(sheet.svg));
      expect(
        functionKeys(g, compiled.ir, {
          sheet,
          packet: rendered.value,
          request,
        }),
      ).toEqual([]);
    }
    const asmSheet = rendered.value.sheets.find(
      (s) => s.view.kind === "assemblies",
    );
    const { document } = parseHTML(asmSheet.svg);
    const cellText = [...document.querySelectorAll("text")].find((t) =>
      t.textContent.includes("R1: X01"),
    );
    expect(cellText).toBeDefined();
    cellText.textContent = cellText.textContent.replace("R1: X01", "R1.X01");
    const mutatedG = await openSheet(
      page,
      embedPrintableFont(document.toString()),
    );
    expect(
      functionKeys(mutatedG, compiled.ir, {
        sheet: asmSheet,
        packet: rendered.value,
        request,
      }),
    ).toMatchObject([{ kind: "printed-function-key", key: "R1.X01" }]);
  });

  it("V5-07 browser: wrapped detached-element pointer in one data-navigation-annotation group passes and omission fails", async () => {
    const { ir, navSvg, auxSvg, request, packet } = v507Fixture();
    const g2 = await openSheet(page, auxSvg);
    const gGood = await openSheet(
      page,
      navSvg(["OL1: NC contact", "95–96 → 02.A1,", "05.A1"]),
    );
    const passAudit = elementNavigationAudit(
      packet,
      [gGood, g2, g2],
      ir,
      request,
    );
    expect([...passAudit.findings, ...passAudit.failures]).toEqual([]);

    const gOmitted = await openSheet(
      page,
      navSvg(["OL1: NC contact", "95–96 → 02.A1"]),
    );
    const failAudit = elementNavigationAudit(
      packet,
      [gOmitted, g2, g2],
      ir,
      request,
    );
    expect(failAudit.findings.map((f) => f.kind)).toContain(
      "detached-element-reference-missing-or-wrong",
    );
  });
});
