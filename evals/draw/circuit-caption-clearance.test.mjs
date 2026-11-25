import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileProject, lockProject } from "@thermite/compiler";
import {
  circuitMotor,
  circuitMotorVertical,
  composedCircuitMark,
} from "../../packages/render/dist/symbols/circuit.js";
import { renderSchematicPacket } from "../../packages/render/dist/sheets.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import {
  circuitCaptionFindings,
  terminalLabelFindings,
} from "./caption-mark-clearance.mjs";

let browser, page;
const temporary = [];
beforeAll(async () => {
  browser = await launch();
  page = await (await browser.newContext(drawingContextOptions)).newPage();
});
afterAll(async () => {
  await browser?.close();
  await Promise.all(
    temporary.map((p) => rm(p, { recursive: true, force: true })),
  );
});

const wrapSvg = (body, width = 80, height = 60) =>
  embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">${body}</svg>`,
  );

function sensorSupplySvg(footerY, sameOwner = true) {
  const iface = `<g data-function-interface="sensor-3wire" fill="none" stroke="#17212b" stroke-width=".35">
    <rect x="8" y="7" width="10" height="11"/>
    <line x1="0" y1="9" x2="7" y2="9"/>
    <line x1="0" y1="16" x2="7" y2="16"/>
  </g>`;
  return wrapSvg(`
    <g data-device-uid="b1" data-circuit-functions='[{"deviceUid":"b1","functionKey":"supply"}]' transform="translate(10 10)">
      <rect class="circuit-device-frame" width="26" height="28.1" fill="white" stroke="#667085" stroke-width="0.25"/>
      <g data-function-key="supply">
        ${sameOwner ? iface : ""}
        <text x="13" y="21" text-anchor="middle" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5" fill="#17212b">PNP</text>
      </g>
      <text x="13" y="${footerY}" text-anchor="middle" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5" fill="#17212b">4: 221</text>
    </g>
    ${sameOwner ? "" : `<g data-device-uid="other" data-circuit-functions="[]" transform="translate(10 10)">${iface}</g>`}
  `);
}

async function stockSensorIr() {
  const root = await mkdtemp(join(tmpdir(), "thermite-dq02-sensor-"));
  temporary.push(root);
  await writeFile(
    join(root, "system.json"),
    JSON.stringify({
      format: "electrical-system/0.1",
      project: { name: "Stock sensor DQ-02 control" },
      sources: ["source.json"],
      libraries: [{ name: "core", version: "0.1.0" }],
    }),
  );
  const device = (n, designation, type) => ({
    uid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind: "device",
    designation,
    type,
  });
  const wire = (n, from, to) => ({
    uid: `00000000-0000-4000-8001-${String(n).padStart(12, "0")}`,
    kind: "wire",
    designation: `W${n}`,
    endpoints: [from, to].map((s) => {
      const i = s.indexOf(".");
      return { device: s.slice(0, i), terminal: s.slice(i + 1) };
    }),
  });
  await writeFile(
    join(root, "source.json"),
    JSON.stringify({
      objects: [
        device(1, "PS1", "core:psu-24vdc"),
        device(2, "B1", "core:prox-pnp-3wire"),
        device(3, "PLC1", "core:plc-compact"),
        wire(1, "PS1.+", "B1.1"),
        wire(2, "PS1.-", "B1.3"),
        wire(3, "B1.4", "PLC1.X1.0"),
      ],
    }),
  );
  expect((await lockProject(root)).ok).toBe(true);
  const compiled = await compileProject(root);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.ir;
}

async function renderStockSensorTtb() {
  const ir = await stockSensorIr();
  const packet = await renderSchematicPacket(ir, {
    format: "schematic-packet-request/0.1",
    views: [
      {
        format: "circuit-view-request/0.1",
        title: "Stock sensor TTB",
        flow: "top-to-bottom",
        groups: [
          {
            id: "sensor-supply",
            label: "Sensor supply",
            lineReference: "220",
            functions: [
              { device: { by: "designation", value: "B1" }, key: "supply" },
            ],
            conductors: ["W1", "W2"],
          },
          {
            id: "sensor-output",
            label: "Sensor output",
            lineReference: "221",
            functions: [
              { device: { by: "designation", value: "B1" }, key: "output" },
            ],
            conductors: ["W3"],
          },
        ],
      },
    ],
  });
  expect(packet.ok, JSON.stringify(packet)).toBe(true);
  if (!packet.ok) throw new Error(packet.error.message);
  return packet.value;
}

describe("DQ-02 owned circuit caption vs own-body stroke clearance (#625)", () => {
  it("flags a footer caption crossing or under 0.50 mm from its own interface <rect>, and passes when clear", async () => {
    const crossed = circuitCaptionFindings(
      await openSheet(page, sensorSupplySvg(19.012, true)),
    );
    expect(crossed).toEqual([
      expect.objectContaining({
        kind: "circuit-caption-body-clearance",
        text: "4: 221",
        gapMm: 0,
        minimumMm: 0.5,
      }),
    ]);

    // 0.30 mm below rect bottom stroke (y = 18.175 + 0.30 + ~1.82 cap height).
    const tooClose = circuitCaptionFindings(
      await openSheet(page, sensorSupplySvg(20.3, true)),
    );
    expect(tooClose).toEqual([
      expect.objectContaining({
        kind: "circuit-caption-body-clearance",
        text: "4: 221",
        minimumMm: 0.5,
      }),
    ]);
    expect(tooClose[0].gapMm).toBeGreaterThan(0);
    expect(tooClose[0].gapMm).toBeLessThan(0.5);

    // Clear footer at y = 26.863 passes, and foreign-body strokes do not trigger.
    expect(
      circuitCaptionFindings(
        await openSheet(page, sensorSupplySvg(26.863, true)),
      ),
    ).toEqual([]);
    expect(
      circuitCaptionFindings(
        await openSheet(page, sensorSupplySvg(19.012, false)),
      ),
    ).toEqual([]);
  });

  it("flags a channel caption crossing its own interface lead stroke", async () => {
    const svg = wrapSvg(`
      <g data-device-uid="b1" data-circuit-functions='[{"deviceUid":"b1","functionKey":"output"}]' transform="translate(10 10)">
        <g data-function-key="output">
          <g data-function-interface="sensor-3wire" fill="none" stroke="#17212b" stroke-width=".35">
            <line x1="42" y1="9" x2="24.333" y2="9"/>
          </g>
          <g data-channel-line="address">
            <text x="30" y="9.8" text-anchor="middle" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5" fill="#17212b">OUT</text>
          </g>
        </g>
      </g>
    `);
    const findings = circuitCaptionFindings(await openSheet(page, svg));
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "circuit-caption-body-clearance",
        text: "OUT",
        functionKey: "output",
        gapMm: 0,
        minimumMm: 0.5,
      }),
    ]);
  });

  it("passes coil AC/DC interior text in both LTR and TTB, and fails if moved onto the coil stroke", async () => {
    for (const vertical of [false, true]) {
      for (const qualifier of ["AC", "DC"]) {
        const cleanSvg = wrapSvg(`
          <g data-device-uid="k1" data-circuit-functions='[{"deviceUid":"k1","functionKey":"coil"}]' transform="translate(10 10)">
            <g data-function-key="coil">
              ${composedCircuitMark("coil", 15, 15, vertical)}
              <text x="15" y="15.8" text-anchor="middle" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5" fill="#17212b">${qualifier}</text>
            </g>
          </g>
        `);
        expect(
          circuitCaptionFindings(await openSheet(page, cleanSvg)),
          `coil ${qualifier} vertical=${vertical}`,
        ).toEqual([]);
      }
    }

    const mutantSvg = wrapSvg(`
      <g data-device-uid="k1" data-circuit-functions='[{"deviceUid":"k1","functionKey":"coil"}]' transform="translate(10 10)">
        <g data-function-key="coil">
          ${composedCircuitMark("coil", 15, 15, false)}
          <text x="15" y="13.4" text-anchor="middle" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5" fill="#17212b">DC</text>
        </g>
      </g>
    `);
    const mutantFindings = circuitCaptionFindings(
      await openSheet(page, mutantSvg),
    );
    expect(mutantFindings).toEqual([
      expect.objectContaining({
        kind: "circuit-caption-body-clearance",
        text: "DC",
        gapMm: 0,
      }),
    ]);
  });

  it("enforces the 0.50 mm cutoff for a displaced DC qualifier (0.165 mm) and an external coil footer (0.16 mm)", async () => {
    const displacedDcSvg = wrapSvg(`
      <g data-device-uid="k1" data-circuit-functions='[{"deviceUid":"k1","functionKey":"coil"}]' transform="translate(10 10)">
        <g data-function-key="coil">
          ${composedCircuitMark("coil", 15, 15, false)}
          <text x="15" y="19.3" text-anchor="middle" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5" fill="#17212b">DC</text>
        </g>
      </g>
    `);
    const displacedDcFindings = circuitCaptionFindings(
      await openSheet(page, displacedDcSvg),
    );
    expect(displacedDcFindings).toEqual([
      expect.objectContaining({
        kind: "circuit-caption-body-clearance",
        text: "DC",
        minimumMm: 0.5,
      }),
    ]);
    expect(displacedDcFindings[0].gapMm).toBeCloseTo(0.165, 2);

    const coilFooterSvg = wrapSvg(`
      <g data-device-uid="k1" data-circuit-functions='[{"deviceUid":"k1","functionKey":"coil"}]' transform="translate(10 10)">
        <g data-function-key="coil">
          ${composedCircuitMark("coil", 15, 15, false)}
          <text x="15" y="19.295" text-anchor="middle" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5" fill="#17212b">4: 221</text>
        </g>
      </g>
    `);
    const coilFooterFindings = circuitCaptionFindings(
      await openSheet(page, coilFooterSvg),
    );
    expect(coilFooterFindings).toEqual([
      expect.objectContaining({
        kind: "circuit-caption-body-clearance",
        text: "4: 221",
        minimumMm: 0.5,
      }),
    ]);
    expect(coilFooterFindings[0].gapMm).toBeCloseTo(0.16, 2);
  });

  it("preserves interior containment under rigid rotation (30°/45° pass) while rejecting a rotated displaced DC qualifier", async () => {
    for (const angle of [30, 45]) {
      const rotatedValidSvg = wrapSvg(`
        <g data-device-uid="k1" data-circuit-functions='[{"deviceUid":"k1","functionKey":"coil"}]' transform="translate(10 10)">
          <g data-function-key="coil" transform="rotate(${angle} 15 15)">
            ${composedCircuitMark("coil", 15, 15, true)}
            <text x="15" y="15.8" text-anchor="middle" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5" fill="#17212b">AC</text>
          </g>
        </g>
      `);
      expect(
        circuitCaptionFindings(await openSheet(page, rotatedValidSvg)),
        `TTB AC coil rotated ${angle} deg`,
      ).toEqual([]);
    }

    const rotatedDisplacedDcSvg = wrapSvg(`
      <g data-device-uid="k1" data-circuit-functions='[{"deviceUid":"k1","functionKey":"coil"}]' transform="translate(10 10)">
        <g data-function-key="coil" transform="rotate(30 15 15)">
          ${composedCircuitMark("coil", 15, 15, false)}
          <text x="15" y="19.3" text-anchor="middle" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5" fill="#17212b">DC</text>
        </g>
      </g>
    `);
    const rotatedDisplacedFindings = circuitCaptionFindings(
      await openSheet(page, rotatedDisplacedDcSvg),
    );
    expect(rotatedDisplacedFindings).toEqual([
      expect.objectContaining({
        kind: "circuit-caption-body-clearance",
        text: "DC",
        minimumMm: 0.5,
      }),
    ]);
    expect(rotatedDisplacedFindings[0].gapMm).toBeGreaterThan(0.1);
    expect(rotatedDisplacedFindings[0].gapMm).toBeLessThan(0.25);
  });

  it("passes SUP, PWR, and I/F interior marks in both LTR and TTB, and rejects displaced or unrecognized text", async () => {
    for (const vertical of [false, true]) {
      for (const mark of ["source", "load", "interface"]) {
        const cleanSvg = wrapSvg(`
          <g data-device-uid="u1" data-circuit-functions='[{"deviceUid":"u1","functionKey":"f1"}]' transform="translate(10 10)">
            <g data-function-key="f1">
              ${composedCircuitMark(mark, 15, 15, vertical)}
            </g>
          </g>
        `);
        expect(
          circuitCaptionFindings(await openSheet(page, cleanSvg)),
          `${mark} vertical=${vertical}`,
        ).toEqual([]);
      }
    }

    // Displaced SUP outside its source rectangle fails at the 0.50 mm external cutoff.
    const displacedSupSvg = wrapSvg(`
      <g data-device-uid="u1" data-circuit-functions='[{"deviceUid":"u1","functionKey":"f1"}]' transform="translate(10 10)">
        <g data-function-key="f1">
          ${composedCircuitMark("source", 15, 15, false).replace(
            'y="7"',
            'y="14.2"',
          )}
        </g>
      </g>
    `);
    const displacedSupFindings = circuitCaptionFindings(
      await openSheet(page, displacedSupSvg),
    );
    expect(displacedSupFindings).toEqual([
      expect.objectContaining({
        kind: "circuit-caption-body-clearance",
        text: "SUP",
        minimumMm: 0.5,
      }),
    ]);
    expect(displacedSupFindings[0].gapMm).toBeGreaterThan(0);
    expect(displacedSupFindings[0].gapMm).toBeLessThan(0.5);
  });

  it("passes motor M / 3~ inside the circle in both LTR and TTB, and fails if moved onto the circle stroke", async () => {
    const ltrSvg = wrapSvg(`
      <g data-device-uid="m1" data-circuit-functions='[{"deviceUid":"m1","functionKey":"motor"}]' transform="translate(10 10)">
        <g data-function-key="motor">
          ${circuitMotor(26, 2, 24, [6, 14, 22], true)}
        </g>
      </g>
    `);
    const ttbSvg = wrapSvg(`
      <g data-device-uid="m1" data-circuit-functions='[{"deviceUid":"m1","functionKey":"motor"}]' transform="translate(10 10)">
        <g data-function-key="motor">
          ${circuitMotorVertical(20, 20, 24, [12, 20, 28], true)}
        </g>
      </g>
    `);
    expect(circuitCaptionFindings(await openSheet(page, ltrSvg))).toEqual([]);
    expect(circuitCaptionFindings(await openSheet(page, ttbSvg))).toEqual([]);

    const mutantSvg = ltrSvg.replace(/>3~<\/text>/u, ' dy="6">3~</text>');
    const mutantFindings = circuitCaptionFindings(
      await openSheet(page, mutantSvg),
    );
    expect(mutantFindings).toEqual([
      expect.objectContaining({
        kind: "circuit-caption-body-clearance",
        text: "3~",
        gapMm: 0,
      }),
    ]);
  });

  it("passes stock sensor-3wire in TTB and fails a mutated footer moved onto its outline", async () => {
    const packet = await renderStockSensorTtb();
    for (const sheet of packet.sheets) {
      expect(circuitCaptionFindings(await openSheet(page, sheet.svg))).toEqual(
        [],
      );
    }

    // Mutant: move the "4: 221" footer onto the sensor-3wire interface <rect> lower edge.
    const supplySheet = packet.sheets.find((s) =>
      s.svg.includes(">4: 221</text>"),
    );
    expect(supplySheet).toBeTruthy();
    const rectMatch = supplySheet.svg.match(
      /<g data-function-interface="sensor-3wire"[^>]*><rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/,
    );
    expect(rectMatch).toBeTruthy();
    const rectBottom = Number(rectMatch[2]) + Number(rectMatch[4]);
    const mutatedSvg = supplySheet.svg.replace(
      /(<text[^>]*\by=")[^"]+("[^>]*>4: 221<\/text>)/u,
      `$1${(rectBottom + 0.9).toFixed(3)}$2`,
    );
    expect(mutatedSvg).not.toBe(supplySheet.svg);
    const mutantFindings = circuitCaptionFindings(
      await openSheet(page, mutatedSvg),
    );
    expect(mutantFindings).toEqual([
      expect.objectContaining({
        kind: "circuit-caption-body-clearance",
        text: "4: 221",
        gapMm: 0,
        minimumMm: 0.5,
      }),
    ]);
  });

  it("does not double-report terminal labels already checked by terminalLabelFindings", async () => {
    const svg = wrapSvg(`
      <g data-device-uid="t1" data-circuit-functions="[]">
        <g data-circuit-mark="winding" stroke="#17212b" stroke-width=".65" fill="none">
          <polyline points="10,12 20,15 10,18"/>
        </g>
        <g data-terminal-key="X2">
          <text x="21" y="16" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5">X2 [+1]</text>
        </g>
      </g>
    `);
    const g = await openSheet(page, svg);
    expect(terminalLabelFindings(g)).toHaveLength(1);
    expect(circuitCaptionFindings(g)).toEqual([]);
  });
});
