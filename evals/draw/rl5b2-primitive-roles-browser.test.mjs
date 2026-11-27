import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import { evaluateSheet, symbolsFromGeometry } from "./evaluate.mjs";
import { EVALS_VERSION } from "./version.mjs";
import { readReportSummary } from "./report-summary.mjs";

let browser, context, page, functionalIr, motorIr;

beforeAll(async () => {
  browser = await launch();
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
  const [fRes, mRes] = await Promise.all([
    compileProject(join(process.cwd(), "examples/functional-symbols")),
    compileProject(join(process.cwd(), "examples/motor-starter")),
  ]);
  expect(fRes.ok).toBe(true);
  expect(mRes.ok).toBe(true);
  functionalIr = fRes.ir;
  motorIr = mRes.ir;
}, 60_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

const svgWrap = (body) =>
  embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="90mm" viewBox="0 0 120 90">${body}</svg>`,
  );

function catalogRoleObs(g, ir, sheetNumber = 1) {
  const sheet = {
    number: sheetNumber,
    view: { format: "circuit-view/0.1", kind: "circuit", title: "Circuit" },
    references: [],
    continuations: [],
  };
  const packet = { sheets: [sheet] };
  const rows = evaluateSheet(
    { id: "test-case", flow: "left-to-right" },
    sheet,
    packet,
    g,
    ir,
    [],
    [],
    symbolsFromGeometry(g, ir),
    [],
    [g],
    undefined,
    {},
  );
  return {
    rows,
    catalogRoles: rows.find((r) => r.id.includes("/DQ-03/catalog-roles-")),
    dq03Sheet: rows.find((r) => r.id.includes("/DQ-03/sheet-")),
    dq03Visual: rows.find((r) => r.id.includes("/DQ-03/visual-")),
  };
}

function twoContactsIr(firstNativeState) {
  return {
    devices: [{ uid: "k1", designation: "K1", typeId: "t-k" }],
    deviceTypes: [{ id: "t-k", symbol: "thermite:contactor", terminals: [] }],
    functions: [
      {
        id: { deviceUid: "k1", functionKey: "c1" },
        kind: "contact",
        normal_state: firstNativeState,
        terminals: [
          { deviceUid: "k1", terminalKey: "13" },
          { deviceUid: "k1", terminalKey: "14" },
        ],
      },
      {
        id: { deviceUid: "k1", functionKey: "c2" },
        kind: "contact",
        normal_state: "closed",
        terminals: [
          { deviceUid: "k1", terminalKey: "21" },
          { deviceUid: "k1", terminalKey: "22" },
        ],
      },
    ],
    terminals: ["13", "14", "21", "22"].map((terminalKey) => ({
      id: { deviceUid: "k1", terminalKey },
    })),
    nets: ["13", "14", "21", "22"].map((terminalKey) => ({
      id: `net-${terminalKey}`,
      terminalIds: [{ deviceUid: "k1", terminalKey }],
    })),
    wires: [],
    jumpers: [],
    cables: [],
  };
}

function twoContactsFixture({
  bridgeStroke = "",
  extraSecondPrim = "",
  firstMark = "contact-no",
  firstRoleOverride = null,
  secondMark = "contact-nc",
  firstNativeState = "open",
  stripRole = false,
  unspecifiedRole = false,
} = {}) {
  const leadAttr = stripRole
    ? ""
    : unspecifiedRole
      ? ' data-electrical-role="unspecified"'
      : ' data-electrical-role="terminal-lead"';
  const bladeRole = firstRoleOverride ?? "contact-blade";
  const c1Prims =
    `<line${leadAttr} x1="0" y1="6" x2="4.2" y2="6"/>` +
    `<line data-electrical-role="terminal-lead" x1="7.8" y1="6" x2="12" y2="6"/>` +
    `<line data-electrical-role="${bladeRole}" x1="4.2" y1="4.5" x2="4.2" y2="7.5"/>` +
    `<line data-electrical-role="contact-blade" x1="7.8" y1="4.5" x2="7.8" y2="7.5"/>` +
    (firstMark === "contact-nc"
      ? `<line data-electrical-role="contact-path" x1="3.3" y1="8.1" x2="8.7" y2="3.9"/>`
      : "");
  const c2Prims =
    `<line data-electrical-role="terminal-lead" x1="0" y1="6" x2="4.2" y2="6"/>` +
    `<line data-electrical-role="terminal-lead" x1="7.8" y1="6" x2="12" y2="6"/>` +
    `<line data-electrical-role="contact-blade" x1="4.2" y1="4.5" x2="4.2" y2="7.5"/>` +
    `<line data-electrical-role="contact-blade" x1="7.8" y1="4.5" x2="7.8" y2="7.5"/>` +
    `<line data-electrical-role="contact-path" x1="3.3" y1="8.1" x2="8.7" y2="3.9"/>` +
    extraSecondPrim;
  const svg = svgWrap(
    `<g data-circuit-group="g1">` +
      `<g data-device-uid="k1" data-designation="K1" data-circuit-functions='[{"deviceUid":"k1","functionKey":"c1"},{"deviceUid":"k1","functionKey":"c2"}]' transform="translate(20 15)">` +
      `<g data-function-key="c1" data-function-id='["k1","c1"]'>` +
      `<g transform="translate(10 6) scale(.666667)"><g data-circuit-mark="${firstMark}" stroke="#17212b" stroke-width="0.4" fill="none">${c1Prims}</g></g>` +
      `<g data-terminal-attachment='["k1","13"]'><path data-electrical-role="terminal-lead" d="M 0 10 L 10 10" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `<g data-terminal-attachment='["k1","14"]'><path data-electrical-role="terminal-lead" d="M 28 10 L 18 10" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `</g>` +
      `<g data-function-key="c2" data-function-id='["k1","c2"]'>` +
      `<g transform="translate(10 26) scale(.666667)"><g data-circuit-mark="${secondMark}" stroke="#17212b" stroke-width="0.4" fill="none">${c2Prims}</g></g>` +
      `<g data-terminal-attachment='["k1","21"]'><path data-electrical-role="terminal-lead" d="M 0 30 L 10 30" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `<g data-terminal-attachment='["k1","22"]'><path data-electrical-role="terminal-lead" d="M 28 30 L 18 30" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `</g>` +
      bridgeStroke +
      `<g data-terminal-id='["k1","13"]' data-terminal-key="13"><circle data-terminal-marker="true" cx="0" cy="10" r=".65" fill="white" stroke="#17212b" stroke-width=".3"/></g>` +
      `<g data-terminal-id='["k1","14"]' data-terminal-key="14"><circle data-terminal-marker="true" cx="28" cy="10" r=".65" fill="white" stroke="#17212b" stroke-width=".3"/></g>` +
      `<g data-terminal-id='["k1","21"]' data-terminal-key="21"><circle data-terminal-marker="true" cx="0" cy="30" r=".65" fill="white" stroke="#17212b" stroke-width=".3"/></g>` +
      `<g data-terminal-id='["k1","22"]' data-terminal-key="22"><circle data-terminal-marker="true" cx="28" cy="30" r=".65" fill="white" stroke="#17212b" stroke-width=".3"/></g>` +
      `</g></g>`,
  );
  return { svg, ir: twoContactsIr(firstNativeState) };
}

function coilWithForeignTerminalFixture({
  coilBodyHeight = 6.6,
  coilBodyRole = "coil-body",
  extraCoilPrimitive = "",
} = {}) {
  const svg = svgWrap(
    `<g data-circuit-group="g1">` +
      `<g data-device-uid="k1" data-designation="K1" data-circuit-functions='[{"deviceUid":"k1","functionKey":"coil"},{"deviceUid":"k1","functionKey":"aux"}]' transform="translate(20 15)">` +
      `<g data-function-key="coil" data-function-id='["k1","coil"]'>` +
      `<g transform="translate(10 6) scale(.666667)"><g data-circuit-mark="coil" stroke="#17212b" stroke-width="0.4" fill="none">` +
      `<line data-electrical-role="terminal-lead" x1="0" y1="6" x2="2.4" y2="6"/>` +
      `<rect data-electrical-role="${coilBodyRole}" x="2.4" y="2.7" width="7.2" height="${coilBodyHeight}"/>` +
      `<line data-electrical-role="terminal-lead" x1="9.6" y1="6" x2="12" y2="6"/>` +
      extraCoilPrimitive +
      `</g></g>` +
      `<g data-terminal-attachment='["k1","A1"]'><path data-electrical-role="terminal-lead" d="M 0 10 L 10 10" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `<g data-terminal-attachment='["k1","A2"]'><path data-electrical-role="terminal-lead" d="M 28 10 L 18 10" fill="none" stroke="#17212b" stroke-width="0.35"/></g>` +
      `</g>` +
      `<g data-terminal-id='["k1","A1"]' data-terminal-key="A1"><circle data-terminal-marker="true" cx="0" cy="10" r=".65" fill="white" stroke="#17212b" stroke-width=".3"/></g>` +
      `<g data-terminal-id='["k1","A2"]' data-terminal-key="A2"><circle data-terminal-marker="true" cx="28" cy="10" r=".65" fill="white" stroke="#17212b" stroke-width=".3"/></g>` +
      `<g data-terminal-id='["k1","13"]' data-terminal-key="13"><circle data-terminal-marker="true" cx="14" cy="24" r=".65" fill="white" stroke="#17212b" stroke-width=".3"/></g>` +
      `</g></g>`,
  );
  const ir = {
    devices: [{ uid: "k1", designation: "K1", typeId: "t-k" }],
    deviceTypes: [{ id: "t-k", symbol: "thermite:contactor", terminals: [] }],
    functions: [
      {
        id: { deviceUid: "k1", functionKey: "coil" },
        kind: "coil",
        terminals: [
          { deviceUid: "k1", terminalKey: "A1" },
          { deviceUid: "k1", terminalKey: "A2" },
        ],
      },
      {
        id: { deviceUid: "k1", functionKey: "aux" },
        kind: "contact",
        normal_state: "open",
        terminals: [{ deviceUid: "k1", terminalKey: "13" }],
      },
    ],
    terminals: [
      { id: { deviceUid: "k1", terminalKey: "A1" } },
      { id: { deviceUid: "k1", terminalKey: "A2" } },
      { id: { deviceUid: "k1", terminalKey: "13" } },
    ],
    nets: [
      { id: "net-a1", terminalIds: [{ deviceUid: "k1", terminalKey: "A1" }] },
      { id: "net-a2", terminalIds: [{ deviceUid: "k1", terminalKey: "A2" }] },
      { id: "net-13", terminalIds: [{ deviceUid: "k1", terminalKey: "13" }] },
    ],
    wires: [],
    jumpers: [],
    cables: [],
  };
  return { svg, ir };
}

describe("RL5b-2 V2-02 circuit catalog primitive electrical-role lint (#646)", () => {
  it("positive controls: real rendered functional-symbols packets measure PASS in both flows", async () => {
    for (const flow of ["left-to-right", "top-to-bottom"]) {
      const req = JSON.parse(
        await readFile(
          join(
            process.cwd(),
            `examples/functional-symbols/packet-${flow}.request.json`,
          ),
          "utf8",
        ),
      );
      const pkt = await renderSchematicPacket(functionalIr, req);
      expect(pkt.ok).toBe(true);
      for (const sheet of pkt.value.sheets) {
        const g = await openSheet(page, embedPrintableFont(sheet.svg));
        if (!g.catalogs.includes("circuit")) continue;
        const { catalogRoles, dq03Sheet, dq03Visual } = catalogRoleObs(
          g,
          functionalIr,
          sheet.number,
        );
        expect(catalogRoles?.status, `${flow} s${sheet.number}`).toBe("pass");
        expect(catalogRoles?.evidence?.findings ?? []).toEqual([]);
        expect(catalogRoles?.evidence?.notMeasured ?? []).toEqual([]);
        expect(dq03Sheet?.status).toBe("pass");
        expect(dq03Visual?.status).toBe("manual");
      }
    }
  }, 60_000);

  it("positive controls: real rendered motor-starter circuit view measures PASS", async () => {
    const motorReq = {
      format: "schematic-packet-request/0.1",
      index: false,
      page: { size: "tabloid", orientation: "landscape", marginMm: 10 },
      views: [
        {
          format: "circuit-view-request/0.1",
          title: "Motor control circuit",
          flow: "left-to-right",
          groups: [
            {
              id: "ctrl",
              label: "Control",
              functions: [
                { device: { by: "designation", value: "K1" }, key: "coil" },
                { device: { by: "designation", value: "K1" }, key: "aux13" },
                {
                  device: { by: "designation", value: "PB1" },
                  key: "contact11",
                },
                { device: { by: "designation", value: "OL1" }, key: "aux95" },
                { device: { by: "designation", value: "CB1" }, key: "pole1" },
                {
                  device: { by: "designation", value: "M1" },
                  key: "motor_load",
                },
              ],
              conductors: [],
            },
          ],
        },
      ],
    };
    const mPkt = await renderSchematicPacket(motorIr, motorReq);
    expect(mPkt.ok).toBe(true);
    const mg = await openSheet(
      page,
      embedPrintableFont(mPkt.value.sheets[0].svg),
    );
    const { catalogRoles } = catalogRoleObs(mg, motorIr, 1);
    expect(catalogRoles?.status).toBe("pass");
    expect(catalogRoles?.evidence?.findings ?? []).toEqual([]);
  }, 60_000);

  it("positive controls: clean synthetic contacts and coil pass", async () => {
    const cleanContacts = twoContactsFixture();
    const g1 = await openSheet(page, cleanContacts.svg);
    expect(catalogRoleObs(g1, cleanContacts.ir).catalogRoles?.status).toBe(
      "pass",
    );

    const cleanCoil = coilWithForeignTerminalFixture();
    const g2 = await openSheet(page, cleanCoil.svg);
    expect(catalogRoleObs(g2, cleanCoil.ir).catalogRoles?.status).toBe("pass");
  });

  it("negative controls: planted stroke bridging two contacts' terminals fails", async () => {
    for (const roleAttr of [
      ' data-electrical-role="terminal-lead"',
      ' data-electrical-role="mechanical-operator"',
      ' data-electrical-role="functional-boundary"',
      "",
    ]) {
      const { svg, ir } = twoContactsFixture({
        bridgeStroke: `<line${roleAttr} x1="0" y1="10" x2="0" y2="30" stroke="#17212b" stroke-width="0.4"/>`,
      });
      const g = await openSheet(page, svg);
      const { catalogRoles } = catalogRoleObs(g, ir);
      expect(catalogRoles?.status, `roleAttr=${roleAttr}`).toBe("fail");
      expect(
        catalogRoles?.evidence?.findings?.some(
          (f) => f.kind === "symbol-primitive-joins-independent-nets",
        ),
        `roleAttr=${roleAttr}`,
      ).toBe(true);
    }
  });

  it("negative control: coil body stroke touching both coil terminals AND a third net fails", async () => {
    // Bottom edge of coil-body at y = 6 + (2.7 + 24.3)*0.666667 = 24.0 touches foreign terminal 13 (net-13).
    const stretched = coilWithForeignTerminalFixture({ coilBodyHeight: 24.3 });
    const r1 = catalogRoleObs(
      await openSheet(page, stretched.svg),
      stretched.ir,
    ).catalogRoles;
    expect(r1?.status).toBe("fail");
    expect(
      r1?.evidence?.findings?.some(
        (f) => f.kind === "symbol-primitive-joins-independent-nets",
      ),
    ).toBe(true);

    // Extra lead stroke from coil body down to foreign terminal 13 (net-13) also fails.
    const spur = coilWithForeignTerminalFixture({
      extraCoilPrimitive:
        '<line data-electrical-role="terminal-lead" x1="6" y1="9.3" x2="6" y2="27"/>',
    });
    const r2 = catalogRoleObs(
      await openSheet(page, spur.svg),
      spur.ir,
    ).catalogRoles;
    expect(r2?.status).toBe("fail");
    expect(
      r2?.evidence?.findings?.some(
        (f) => f.kind === "symbol-primitive-joins-independent-nets",
      ),
    ).toBe(true);

    // Extra conductive bypass stroke on contact-nc independent of contact-path also fails.
    const bypass = twoContactsFixture({
      extraSecondPrim:
        '<line data-electrical-role="terminal-lead" x1="0" y1="6" x2="12" y2="6"/>',
    });
    const r3 = catalogRoleObs(
      await openSheet(page, bypass.svg),
      bypass.ir,
    ).catalogRoles;
    expect(r3?.status).toBe("fail");
    expect(
      r3?.evidence?.findings?.some(
        (f) => f.kind === "symbol-primitive-joins-independent-nets",
      ),
    ).toBe(true);
  });

  it("negative controls: forged role attributes contradicting the catalog fail", async () => {
    // 1. Forge contact-path on a contact-no mark.
    const f1 = twoContactsFixture({
      firstMark: "contact-no",
      firstRoleOverride: "contact-path",
    });
    const r1 = catalogRoleObs(
      await openSheet(page, f1.svg),
      f1.ir,
    ).catalogRoles;
    expect(r1?.status).toBe("fail");
    expect(
      r1?.evidence?.findings?.some((f) => f.kind === "forged-electrical-role"),
    ).toBe(true);

    // 2. Forge contact-nc mark + contact-path on a native OPEN contact.
    const f2 = twoContactsFixture({
      firstMark: "contact-nc",
      firstNativeState: "open",
    });
    const r2 = catalogRoleObs(
      await openSheet(page, f2.svg),
      f2.ir,
    ).catalogRoles;
    expect(r2?.status).toBe("fail");
    expect(
      r2?.evidence?.findings?.some((f) => f.kind === "forged-electrical-role"),
    ).toBe(true);

    // 3. Forge element-path on a coil body rect.
    const f3 = coilWithForeignTerminalFixture({
      coilBodyRole: "element-path",
    });
    const r3 = catalogRoleObs(
      await openSheet(page, f3.svg),
      f3.ir,
    ).catalogRoles;
    expect(r3?.status).toBe("fail");
    expect(
      r3?.evidence?.findings?.some((f) => f.kind === "forged-electrical-role"),
    ).toBe(true);

    // 4. Invalid unknown role token.
    const f4 = coilWithForeignTerminalFixture({
      coilBodyRole: "allow-any-short",
    });
    const r4 = catalogRoleObs(
      await openSheet(page, f4.svg),
      f4.ir,
    ).catalogRoles;
    expect(r4?.status).toBe("fail");
    expect(
      r4?.evidence?.findings?.some((f) => f.kind === "invalid-electrical-role"),
    ).toBe(true);
  });

  it("negative controls: missing or explicit 'unspecified' electrical role yields not-measured, never PASS", async () => {
    const missing = twoContactsFixture({ stripRole: true });
    const rMissing = catalogRoleObs(
      await openSheet(page, missing.svg),
      missing.ir,
    ).catalogRoles;
    expect(rMissing?.status).toBe("not-measured");
    expect(rMissing?.evidence?.notMeasured?.length).toBeGreaterThan(0);

    const unspecified = twoContactsFixture({ unspecifiedRole: true });
    const rUnspecified = catalogRoleObs(
      await openSheet(page, unspecified.svg),
      unspecified.ir,
    ).catalogRoles;
    expect(rUnspecified?.status).toBe("not-measured");
    expect(
      rUnspecified?.evidence?.notMeasured?.some(
        (m) => m.reason === "unspecified-electrical-role",
      ),
    ).toBe(true);
  });
});

describe("checker protocol 5.57 version and summary compatibility", () => {
  it("bumps EVALS_VERSION to 5.57 while keeping 5.49, 5.51, 5.53, 5.54, 5.55, and 5.56 readable", () => {
    expect(EVALS_VERSION).toBe("5.57");
    for (const evalsVersion of [
      "5.49",
      "5.51",
      "5.53",
      "5.54",
      "5.55",
      "5.56",
      "5.57",
    ]) {
      const s = readReportSummary({
        evalsVersion,
        summary: { "DQ-03": { pass: 1 } },
      });
      expect(s["DQ-03"].pass).toBe(1);
    }
    expect(() =>
      readReportSummary({ evalsVersion: "5.50", summary: {} }),
    ).toThrow();
    expect(() =>
      readReportSummary({ evalsVersion: "5.52", summary: {} }),
    ).toThrow();
  });
});
