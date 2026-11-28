import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileProject, lockProject } from "@thermite/compiler";
import { renderSchematicPacket } from "../../packages/render/dist/sheets.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import {
  displaySheet,
  drawingContextOptions,
  launch,
  openSheet,
  sheetMeasurementSource,
} from "./browser.mjs";
import { terminalLabelConductorFindings } from "./caption-mark-clearance.mjs";
import { evaluateSheet, symbolsFromGeometry } from "./evaluate.mjs";
import { EVALS_VERSION } from "./version.mjs";
import { readReportSummary } from "./report-summary.mjs";

let browser, page;
const tempDirs = [];

beforeAll(async () => {
  browser = await launch();
  page = await (await browser.newContext(drawingContextOptions)).newPage();
});

afterAll(async () => {
  await browser?.close();
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const wrapSvg = (body, width = 80, height = 60) =>
  embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">${body}</svg>`,
  );

function measureRunEnvelope(options, h) {
  const c = { options: {}, h };
  h.prepareGeometry(c);
  h.prepareTerminals(c);
  h.prepareText(c);
  h.preparePaint(c);
  const text = c.texts.find((t) => t.text === options.text);
  if (!text) return null;
  const e = c.elementsById.get(text.element);
  return h.terminalLabelRunEnvelope(c, text, e);
}

const RUN_ENVELOPE_SOURCE = sheetMeasurementSource(measureRunEnvelope);

async function probeRunBox(labelText) {
  const svg = wrapSvg(`
    <g data-device-uid="r1" data-circuit-functions='[{"deviceUid":"r1","functionKey":"c1"}]' transform="translate(10 10)">
      <g data-layout-port="n0p0" data-terminal-id='["r1","11"]' data-terminal-key="11">
        <circle data-terminal-marker="true" cx="10" cy="0" r=".65" fill="white" stroke="#17212b" stroke-width=".3"/>
        <text data-text-role="body" x="11" y="6" text-anchor="start" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5" fill="#17212b">${labelText}</text>
      </g>
    </g>
  `);
  await displaySheet(page, svg);
  return page.evaluate(({ source, text }) => (0, eval)(source)({ text }), {
    source: RUN_ENVELOPE_SOURCE,
    text: labelText,
  });
}

function leadFixtureSvg({ leadPath, stroke = "#17212b", role = "lead" }) {
  const leadGroup =
    role === "conductor"
      ? `<g data-circuit-conductor="W1"><path d="${leadPath}" fill="none" stroke="${stroke}" stroke-width="0.35"/></g>`
      : `<g data-terminal-attachment='["r1","11"]'><path data-electrical-role="terminal-lead" d="${leadPath}" fill="none" stroke="${stroke}" stroke-width="0.35"/></g>`;
  return wrapSvg(`
    <g data-device-uid="r1" data-circuit-functions='[{"deviceUid":"r1","functionKey":"c1"}]' transform="translate(10 10)">
      ${leadGroup}
      <g data-layout-port="n0p0" data-terminal-id='["r1","11"]' data-terminal-key="11">
        <circle data-terminal-marker="true" cx="10" cy="0" r=".65" fill="white" stroke="#17212b" stroke-width=".3"/>
        <text data-text-role="body" x="11" y="6" text-anchor="start" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5" fill="#17212b">11 [+1]</text>
      </g>
    </g>
  `);
}

function changeoverTypes(southCommon) {
  const shared = (...keys) =>
    Object.fromEntries(keys.map((k) => [k, { connection_policy: "shared" }]));
  return {
    types: [
      {
        kind: "device_type",
        id: "synth:relay",
        symbol: "thermite:relay",
        terminals: shared("A1", "A2", "11", "12", "14"),
        functions: {
          contact12: {
            kind: "contact",
            normal_state: "closed",
            terminals: southCommon ? ["12", "11"] : ["11", "12"],
          },
          contact14: {
            kind: "contact",
            normal_state: "open",
            terminals: southCommon ? ["14", "11"] : ["11", "14"],
          },
          coil: { kind: "coil", terminals: ["A1", "A2"] },
        },
        internal_relations: [
          { relation: "actuates", from: "coil", to: "contact12" },
          { relation: "actuates", from: "coil", to: "contact14" },
        ],
      },
      {
        kind: "device_type",
        id: "synth:lamp",
        symbol: "thermite:lamp",
        terminals: shared("X1", "X2"),
        functions: { lamp: { kind: "load", terminals: ["X1", "X2"] } },
      },
    ],
  };
}

function changeoverSource() {
  const dev = (n, designation, type) => ({
    kind: "device",
    uid: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    designation,
    type,
  });
  const wire = (n, designation, a, b, label) => ({
    kind: "wire",
    uid: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    designation,
    endpoints: [
      { device: a[0], terminal: a[1] },
      { device: b[0], terminal: b[1] },
    ],
    properties: { label },
  });
  return {
    objects: [
      dev(101, "R1", "synth:relay"),
      dev(102, "H1", "synth:lamp"),
      dev(103, "H2", "synth:lamp"),
      wire(201, "W1", ["R1", "11"], ["H1", "X1"], "100"),
      wire(202, "W2", ["R1", "11"], ["H2", "X1"], "100"),
      wire(203, "W3", ["R1", "14"], ["H1", "X2"], "101"),
    ],
  };
}

async function syntheticChangeoverProject(southCommon = false) {
  const dir = await mkdtemp(join(tmpdir(), "leadlabel-changeover-"));
  tempDirs.push(dir);
  const write = (rel, data) =>
    writeFile(join(dir, rel), JSON.stringify(data, null, 2));
  await mkdir(join(dir, "library"));
  await write("system.json", {
    format: "electrical-system/0.1",
    project: { name: "Synthetic changeover lead-label fixture" },
    sources: ["source.json"],
    libraries: [{ name: "synth", version: "0.1.0", path: "library" }],
  });
  await write("library/library.json", {
    name: "synth",
    version: "0.1.0",
    sources: ["types.json"],
  });
  await write("library/types.json", changeoverTypes(southCommon));
  await write("source.json", changeoverSource());
  const locked = await lockProject(dir);
  expect(locked.ok).toBe(true);
  const compiled = await compileProject(dir);
  expect(compiled.ok).toBe(true);
  return compiled.ir;
}

describe("terminal-label conductor and lead crossing measurement (#667)", () => {
  it("passes just-clear and fails just-crossing on vertical and horizontal boundaries", async () => {
    const run = await probeRunBox("11 [+1]");
    expect(run).toBeTruthy();
    const halfStroke = 0.35 / 2;
    const localRight = run.x + run.w - 10;
    const localBottom = run.y + run.h - 10;

    // Vertical boundary: 0.04 mm clear right of run vs 0.04 mm inside right edge.
    const clearX = (localRight + halfStroke + 0.04).toFixed(3);
    const crossX = (localRight + halfStroke - 0.04).toFixed(3);
    const clearVert = await openSheet(
      page,
      leadFixtureSvg({ leadPath: `M ${clearX} 0 L ${clearX} 14` }),
    );
    expect(terminalLabelConductorFindings(clearVert)).toEqual([]);

    const crossVert = await openSheet(
      page,
      leadFixtureSvg({ leadPath: `M ${crossX} 0 L ${crossX} 14` }),
    );
    expect(terminalLabelConductorFindings(crossVert)).toEqual([
      expect.objectContaining({
        kind: "terminal-label-conductor-crossing",
        terminalKey: "11",
        text: "11 [+1]",
        strokeKind: "terminal-lead",
      }),
    ]);

    // Horizontal boundary: 0.04 mm below run vs 0.04 mm inside bottom edge.
    const clearY = (localBottom + halfStroke + 0.04).toFixed(3);
    const crossY = (localBottom + halfStroke - 0.04).toFixed(3);
    const clearHoriz = await openSheet(
      page,
      leadFixtureSvg({ leadPath: `M 8 ${clearY} L 24 ${clearY}` }),
    );
    expect(terminalLabelConductorFindings(clearHoriz)).toEqual([]);

    const crossHoriz = await openSheet(
      page,
      leadFixtureSvg({ leadPath: `M 8 ${crossY} L 24 ${crossY}` }),
    );
    expect(terminalLabelConductorFindings(crossHoriz)).toEqual([
      expect.objectContaining({
        kind: "terminal-label-conductor-crossing",
        terminalKey: "11",
        text: "11 [+1]",
        strokeKind: "terminal-lead",
      }),
    ]);
  });

  it("flags a lead bisecting the space inside a multi-token run, ignores white halos, and flags routed conductors", async () => {
    const run = await probeRunBox("11 [+1]");
    const midX = (run.x + run.w * 0.35 - 10).toFixed(3);
    const bisect = await openSheet(
      page,
      leadFixtureSvg({ leadPath: `M ${midX} 0 L ${midX} 14` }),
    );
    expect(terminalLabelConductorFindings(bisect)).toHaveLength(1);

    const haloOnly = await openSheet(
      page,
      leadFixtureSvg({
        leadPath: `M ${midX} 0 L ${midX} 14`,
        stroke: "white",
      }),
    );
    expect(terminalLabelConductorFindings(haloOnly)).toEqual([]);

    const conductor = await openSheet(
      page,
      leadFixtureSvg({
        leadPath: `M ${midX} 0 L ${midX} 14`,
        role: "conductor",
      }),
    );
    expect(terminalLabelConductorFindings(conductor)).toEqual([
      expect.objectContaining({
        kind: "terminal-label-conductor-crossing",
        strokeKind: "conductor",
        conductorId: "W1",
      }),
    ]);
  });

  it("keeps top-to-bottom changeover relay common terminal labels clear of their own leads (NORTH and SOUTH commons)", async () => {
    for (const southCommon of [false, true]) {
      const ir = await syntheticChangeoverProject(southCommon);
      const rendered = await renderSchematicPacket(ir, {
        format: "schematic-packet-request/0.1",
        page: { size: "tabloid", orientation: "landscape", marginMm: 10 },
        layout: "standard",
        index: false,
        views: [
          {
            format: "circuit-view-request/0.1",
            title: "Changeover relay TTB",
            flow: "top-to-bottom",
            groups: [
              {
                id: "changeover",
                label: "Changeover relay",
                functions: [
                  {
                    device: { by: "designation", value: "R1" },
                    key: "contact12",
                  },
                  {
                    device: { by: "designation", value: "R1" },
                    key: "contact14",
                  },
                  { device: { by: "designation", value: "R1" }, key: "coil" },
                  { device: { by: "designation", value: "H1" }, key: "lamp" },
                ],
                // Omit W2 so R1.11 prints "11 [+1]".
                conductors: ["W1", "W3"],
              },
            ],
          },
        ],
      });
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) continue;
      for (const sheet of rendered.value.sheets) {
        const g = await openSheet(page, embedPrintableFont(sheet.svg));
        expect(terminalLabelConductorFindings(g)).toEqual([]);
        const dq02 = evaluateSheet(
          { id: "synth-ttb", flow: "top-to-bottom" },
          sheet,
          rendered.value,
          g,
          ir,
          [],
          [],
          symbolsFromGeometry(g, ir),
          [],
          [g],
        ).find((row) => row.dq === "DQ-02" && row.medium === "svg");
        const crossingFindings = (dq02?.evidence?.findings ?? []).filter(
          (f) => f.kind === "terminal-label-conductor-crossing",
        );
        expect(crossingFindings).toEqual([]);
      }
    }
  });

  it("bumps EVALS_VERSION to 5.58 while retaining 5.49, 5.51, and 5.53–5.57 summary readability", () => {
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
      const sample = { evalsVersion, summary: { "DQ-02": { pass: 1 } } };
      expect(readReportSummary(sample)).toEqual(sample.summary);
    }
  });
});
