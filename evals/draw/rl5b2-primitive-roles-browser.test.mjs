import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { launch, openSheet } from "./browser.mjs";
import { evaluateSheet, symbolsFromGeometry } from "./evaluate.mjs";
import { EVALS_VERSION } from "./version.mjs";
import { readReportSummary } from "./report-summary.mjs";
import {
  createPageRunner,
  obsDiagnostic,
  singleGroupReq,
} from "./test-support/rl5b2-browser.mjs";

let browser, functionalIr, motorIr, functionalPackets, motorSheetSvg;
const { withPage, closeActiveContexts } = createPageRunner(() => browser);

const MOTOR_CONTROL_FUNCTIONS = [
  ["K1", "coil"],
  ["K1", "aux13"],
  ["PB1", "contact11"],
  ["OL1", "aux95"],
  ["CB1", "pole1"],
  ["M1", "motor_load"],
].map(([value, key]) => ({ device: { by: "designation", value }, key }));

beforeAll(async () => {
  browser = await launch();
  const [fRes, mRes, ltrRaw, ttbRaw] = await Promise.all([
    compileProject(join(process.cwd(), "examples/functional-symbols")),
    compileProject(join(process.cwd(), "examples/motor-starter")),
    readFile(
      join(
        process.cwd(),
        "examples/functional-symbols/packet-left-to-right.request.json",
      ),
      "utf8",
    ),
    readFile(
      join(
        process.cwd(),
        "examples/functional-symbols/packet-top-to-bottom.request.json",
      ),
      "utf8",
    ),
  ]);
  expect(fRes.ok).toBe(true);
  expect(mRes.ok).toBe(true);
  functionalIr = fRes.ir;
  motorIr = mRes.ir;
  const [ltrPkt, ttbPkt, mPkt] = await Promise.all([
    renderSchematicPacket(functionalIr, JSON.parse(ltrRaw)),
    renderSchematicPacket(functionalIr, JSON.parse(ttbRaw)),
    renderSchematicPacket(
      motorIr,
      singleGroupReq(
        "Motor control circuit",
        "ctrl",
        "Control",
        MOTOR_CONTROL_FUNCTIONS,
      ),
    ),
  ]);
  expect(ltrPkt.ok && ttbPkt.ok && mPkt.ok).toBe(true);
  functionalPackets = {
    "left-to-right": ltrPkt.value,
    "top-to-bottom": ttbPkt.value,
  };
  motorSheetSvg = embedPrintableFont(mPkt.value.sheets[0].svg);
});

afterEach(closeActiveContexts);

afterAll(async () => {
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

function assertFunctionalSheetPasses(g, sheetNumber, label) {
  const { catalogRoles, dq03Sheet, dq03Visual } = catalogRoleObs(
    g,
    functionalIr,
    sheetNumber,
  );
  expect(catalogRoles?.status, obsDiagnostic(catalogRoles, label)).toBe("pass");
  expect(catalogRoles?.evidence?.findings ?? [], label).toEqual([]);
  expect(catalogRoles?.evidence?.notMeasured ?? [], label).toEqual([]);
  expect(dq03Sheet?.status, obsDiagnostic(dq03Sheet, label)).toBe("pass");
  expect(dq03Visual?.status, obsDiagnostic(dq03Visual, label)).toBe("manual");
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
  it.each([
    ["left-to-right", 0],
    ["left-to-right", 1],
    ["left-to-right", 2],
    ["top-to-bottom", 0],
    ["top-to-bottom", 1],
    ["top-to-bottom", 2],
  ])(
    "positive controls: functional-symbols %s circuit sheet index %i measures PASS",
    async (flow, index) => {
      const sheet = functionalPackets[flow].sheets[index];
      expect(sheet).toBeDefined();
      await withPage(async (page) => {
        const g = await openSheet(page, embedPrintableFont(sheet.svg));
        expect(g.catalogs, `${flow} s${sheet.number}`).toContain("circuit");
        assertFunctionalSheetPasses(
          g,
          sheet.number,
          `${flow} s${sheet.number}`,
        );
      });
    },
  );

  it.each(["left-to-right", "top-to-bottom"])(
    "positive controls: remaining functional-symbols %s sheets measure PASS if circuit-catalog",
    async (flow) => {
      const rest = functionalPackets[flow].sheets.slice(3);
      await withPage(async (page) => {
        for (const sheet of rest) {
          const g = await openSheet(page, embedPrintableFont(sheet.svg));
          if (!g.catalogs.includes("circuit")) continue;
          assertFunctionalSheetPasses(
            g,
            sheet.number,
            `${flow} s${sheet.number}`,
          );
        }
      });
    },
  );

  it("positive controls: real rendered motor-starter circuit view measures PASS", async () => {
    await withPage(async (page) => {
      const mg = await openSheet(page, motorSheetSvg);
      const { catalogRoles } = catalogRoleObs(mg, motorIr, 1);
      expect(
        catalogRoles?.status,
        obsDiagnostic(catalogRoles, "motor-starter"),
      ).toBe("pass");
      expect(catalogRoles?.evidence?.findings ?? []).toEqual([]);
    });
  });

  it("positive controls: clean synthetic contacts and coil pass", async () => {
    await withPage(async (page) => {
      const cleanContacts = twoContactsFixture();
      const r1 = catalogRoleObs(
        await openSheet(page, cleanContacts.svg),
        cleanContacts.ir,
      ).catalogRoles;
      expect(r1?.status, obsDiagnostic(r1, "clean-contacts")).toBe("pass");

      const cleanCoil = coilWithForeignTerminalFixture();
      const r2 = catalogRoleObs(
        await openSheet(page, cleanCoil.svg),
        cleanCoil.ir,
      ).catalogRoles;
      expect(r2?.status, obsDiagnostic(r2, "clean-coil")).toBe("pass");
    });
  });

  it.each([
    ' data-electrical-role="terminal-lead"',
    ' data-electrical-role="mechanical-operator"',
    ' data-electrical-role="functional-boundary"',
    "",
  ])(
    "negative controls: planted stroke (%s) bridging two contacts' terminals fails",
    async (roleAttr) => {
      const { svg, ir } = twoContactsFixture({
        bridgeStroke: `<line${roleAttr} x1="0" y1="10" x2="0" y2="30" stroke="#17212b" stroke-width="0.4"/>`,
      });
      await withPage(async (page) => {
        const g = await openSheet(page, svg);
        const { catalogRoles } = catalogRoleObs(g, ir);
        expect(
          catalogRoles?.status,
          obsDiagnostic(catalogRoles, `roleAttr=${roleAttr}`),
        ).toBe("fail");
        expect(
          catalogRoles?.evidence?.findings?.some(
            (f) => f.kind === "symbol-primitive-joins-independent-nets",
          ),
          obsDiagnostic(catalogRoles, `roleAttr=${roleAttr}`),
        ).toBe(true);
      });
    },
  );

  it("negative control: coil body stroke touching both coil terminals AND a third net fails", async () => {
    await withPage(async (page) => {
      // Bottom edge of coil-body at y = 6 + (2.7 + 24.3)*0.666667 = 24.0 touches foreign terminal 13 (net-13).
      const stretched = coilWithForeignTerminalFixture({
        coilBodyHeight: 24.3,
      });
      const r1 = catalogRoleObs(
        await openSheet(page, stretched.svg),
        stretched.ir,
      ).catalogRoles;
      expect(r1?.status, obsDiagnostic(r1, "stretched-coil")).toBe("fail");
      expect(
        r1?.evidence?.findings?.some(
          (f) => f.kind === "symbol-primitive-joins-independent-nets",
        ),
        obsDiagnostic(r1, "stretched-coil"),
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
      expect(r2?.status, obsDiagnostic(r2, "coil-spur")).toBe("fail");
      expect(
        r2?.evidence?.findings?.some(
          (f) => f.kind === "symbol-primitive-joins-independent-nets",
        ),
        obsDiagnostic(r2, "coil-spur"),
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
      expect(r3?.status, obsDiagnostic(r3, "contact-bypass")).toBe("fail");
      expect(
        r3?.evidence?.findings?.some(
          (f) => f.kind === "symbol-primitive-joins-independent-nets",
        ),
        obsDiagnostic(r3, "contact-bypass"),
      ).toBe(true);
    });
  });

  it.each([
    [
      "forge-contact-no",
      () =>
        twoContactsFixture({
          firstMark: "contact-no",
          firstRoleOverride: "contact-path",
        }),
      "forged-electrical-role",
    ],
    [
      "forge-open-as-nc",
      () =>
        twoContactsFixture({
          firstMark: "contact-nc",
          firstNativeState: "open",
        }),
      "forged-electrical-role",
    ],
    [
      "forge-coil-element-path",
      () => coilWithForeignTerminalFixture({ coilBodyRole: "element-path" }),
      "forged-electrical-role",
    ],
    [
      "invalid-role-token",
      () => coilWithForeignTerminalFixture({ coilBodyRole: "allow-any-short" }),
      "invalid-electrical-role",
    ],
  ])(
    "negative controls: forged/invalid role attribute (%s) fails",
    async (label, buildFixture, expectedKind) => {
      const fixture = buildFixture();
      await withPage(async (page) => {
        const res = catalogRoleObs(
          await openSheet(page, fixture.svg),
          fixture.ir,
        ).catalogRoles;
        expect(res?.status, obsDiagnostic(res, label)).toBe("fail");
        expect(
          res?.evidence?.findings?.some((f) => f.kind === expectedKind),
          obsDiagnostic(res, label),
        ).toBe(true);
      });
    },
  );

  it("negative controls: missing or explicit 'unspecified' electrical role yields not-measured, never PASS", async () => {
    await withPage(async (page) => {
      const missing = twoContactsFixture({ stripRole: true });
      const rMissing = catalogRoleObs(
        await openSheet(page, missing.svg),
        missing.ir,
      ).catalogRoles;
      expect(rMissing?.status, obsDiagnostic(rMissing, "missing-role")).toBe(
        "not-measured",
      );
      expect(rMissing?.evidence?.notMeasured?.length).toBeGreaterThan(0);

      const unspecified = twoContactsFixture({ unspecifiedRole: true });
      const rUnspecified = catalogRoleObs(
        await openSheet(page, unspecified.svg),
        unspecified.ir,
      ).catalogRoles;
      expect(
        rUnspecified?.status,
        obsDiagnostic(rUnspecified, "unspecified-role"),
      ).toBe("not-measured");
      expect(
        rUnspecified?.evidence?.notMeasured?.some(
          (m) => m.reason === "unspecified-electrical-role",
        ),
        obsDiagnostic(rUnspecified, "unspecified-role"),
      ).toBe(true);
    });
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
