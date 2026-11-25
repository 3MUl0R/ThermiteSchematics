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
import {
  displaySheet,
  drawingContextOptions,
  evaluateSheetGeometry,
  launch,
  openSheet,
  sheetMeasurementSource,
} from "./browser.mjs";
import {
  circuitCaptionFindings,
  terminalLabelFindings,
} from "./caption-mark-clearance.mjs";
import { INTERIOR_LEGEND_NEAR_CONTACT_MM } from "./measurement/terminal-label-clearance.mjs";

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

const rawSvg = (body, width = 80, height = 60) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">${body}</svg>`;

const wrapSvg = (body, width = 80, height = 60) =>
  embedPrintableFont(rawSvg(body, width, height));

const DEFAULT_FONT = "Thermite Sans, Thermite Math, sans-serif";

function coilWitnessBody({
  text,
  y,
  vertical = false,
  rotateDeg = 0,
  fontFamily = DEFAULT_FONT,
}) {
  const rotateAttr = rotateDeg ? ` transform="rotate(${rotateDeg} 15 15)"` : "";
  return `
    <g data-device-uid="k1" data-circuit-functions='[{"deviceUid":"k1","functionKey":"coil"}]' transform="translate(10 10)">
      <g data-function-key="coil"${rotateAttr}>
        ${composedCircuitMark("coil", 15, 15, vertical)}
        <text x="15" y="${y}" text-anchor="middle" font-family="${fontFamily}" font-size="2.5" fill="#17212b">${text}</text>
      </g>
    </g>
  `;
}

// Executed inside Chromium via sheetMeasurementSource to read the checker's own
// tight painted glyph box, interior containment classification, and (when
// requested) ink gap beyond the checker's 0.50 mm reporting cutoff.
function measureCoilCaptionDiagnostics(options, h) {
  const c = { options: {}, h };
  h.prepareGeometry(c);
  h.prepareTerminals(c);
  h.prepareText(c);
  h.preparePaint(c);
  const text = c.texts.find((t) => t.text === options.text);
  if (!text) return null;
  const e = c.elementsById.get(text.element);
  const local = h.paintedGlyphLocalBox(c, e, text);
  const paintedBbox = local ? c.bounds(e, local) : null;
  const interiorMark = h.circuitInteriorLegendMark(c, e, text);
  let measuredGapMm = null;
  if (options.measureGap) {
    const owner = e?.closest("[data-circuit-functions]");
    const body = owner ? h.terminalLabelBody(c, owner) : [];
    const label = {
      e,
      text,
      bbox: text.bbox,
      inverse: e.getScreenCTM().inverse(),
    };
    let gapMm = options.maxGapMm ?? 0.8;
    for (const shape of body) {
      const gap = h.terminalLabelStrokeGap(c, label, shape, gapMm);
      if (gap < gapMm) gapMm = gap;
    }
    measuredGapMm = Math.floor((gapMm + 1e-12) * 1000) / 1000;
  }
  return {
    paintedBbox,
    measureTextBbox: text.bbox,
    interiorContained: Boolean(interiorMark),
    cutoffMm: interiorMark ? h.INTERIOR_LEGEND_NEAR_CONTACT_MM : 0.5,
    measuredGapMm,
  };
}

// Executed inside Chromium via sheetMeasurementSource to compute the displaced
// baseline y once per font from painted glyph ink and refine against
// terminalLabelStrokeGap with a bounded bisection (<= 8 steps) on one sheet.
function measureDisplacedCoilY(options, h) {
  const measure = (measureGap) => {
    const c = { options: {}, h };
    h.prepareGeometry(c);
    h.prepareTerminals(c);
    h.prepareText(c);
    h.preparePaint(c);
    const text = c.texts.find((t) => t.text === options.text);
    const e = text ? c.elementsById.get(text.element) : null;
    if (!e) return { hasRect: false, hasPaintedBbox: false };
    if (measureGap) {
      const owner = e.closest("[data-circuit-functions]");
      const label = {
        e,
        text,
        bbox: text.bbox,
        inverse: e.getScreenCTM().inverse(),
      };
      let gap = options.maxGapMm;
      for (const s of owner ? h.terminalLabelBody(c, owner) : [])
        gap = Math.min(gap, h.terminalLabelStrokeGap(c, label, s, gap));
      return { gapMm: Math.floor((gap + 1e-12) * 1000) / 1000 };
    }
    const local = h.paintedGlyphLocalBox(c, e, text);
    const rect = c.root.querySelector('[data-circuit-mark="coil"] rect');
    if (!local || !rect)
      return { hasRect: Boolean(rect), hasPaintedBbox: Boolean(local) };
    const rb = c.bounds(rect),
      m = rect.getScreenCTM();
    const stroke =
      parseFloat(getComputedStyle(rect).strokeWidth) *
      Math.max(
        Math.hypot(m.a * c.sx, m.b * c.sy),
        Math.hypot(m.c * c.sx, m.d * c.sy),
      );
    const ascent = options.probeY + 10 - c.bounds(e, local).y;
    return {
      e,
      hasRect: true,
      hasPaintedBbox: true,
      y0: rb.y + rb.h + stroke / 2 - 10 + ascent + options.targetGapMm,
    };
  };
  const probe = measure(false);
  if (!probe.hasRect || !probe.hasPaintedBbox) return { y: null, ...probe };
  const target = options.targetGapMm;
  let y = Number(probe.y0.toFixed(3)),
    lo = y - 0.5,
    hi = y + 0.5;
  for (let step = 0; step < 8; step++) {
    probe.e.setAttribute("y", String(y));
    const { gapMm } = measure(true);
    if (gapMm === null || Math.abs(gapMm - target) <= 0.02) break;
    if (gapMm < target) lo = y;
    else hi = y;
    const next =
      step === 0 && gapMm > 0 && gapMm < options.maxGapMm
        ? y + (target - gapMm)
        : (lo + hi) / 2;
    y = Number(Math.min(hi, Math.max(lo, next)).toFixed(3));
  }
  return { y, hasRect: true, hasPaintedBbox: true };
}

const COIL_DIAG_SOURCE = sheetMeasurementSource(measureCoilCaptionDiagnostics);
const DISPLACED_COIL_Y_SOURCE = sheetMeasurementSource(measureDisplacedCoilY);
const displacedCoilYCache = new Map();

async function withQuantizedMeasureText(activePage, quantize, run) {
  if (!quantize) return run();
  await activePage.evaluate((extraAscent) => {
    const original = CanvasRenderingContext2D.prototype.measureText;
    window.__thermiteOrigMeasureText ??= original;
    CanvasRenderingContext2D.prototype.measureText = function (value) {
      const metrics = original.call(this, value);
      return {
        width: metrics.width,
        actualBoundingBoxLeft: 1,
        actualBoundingBoxRight: Math.ceil(metrics.actualBoundingBoxRight),
        actualBoundingBoxAscent:
          Math.ceil(metrics.actualBoundingBoxAscent) + extraAscent,
        actualBoundingBoxDescent: 0,
      };
    };
  }, quantize.extraAscent ?? 0);
  try {
    return await run();
  } finally {
    await activePage.evaluate(() => {
      if (window.__thermiteOrigMeasureText) {
        CanvasRenderingContext2D.prototype.measureText =
          window.__thermiteOrigMeasureText;
        delete window.__thermiteOrigMeasureText;
      }
    });
  }
}

async function ensureCoilWitnessSheet(activePage, embedFont) {
  const mode = embedFont ? "embedded" : "raw";
  const ready = await activePage.evaluate(
    (sheetMode) =>
      document
        .querySelector("body > svg")
        ?.getAttribute("data-coil-witness-mode") === sheetMode,
    mode,
  );
  if (ready) return;
  const shell = (embedFont ? wrapSvg("") : rawSvg("")).replace(
    "<svg ",
    `<svg data-coil-witness-mode="${mode}" `,
  );
  await displaySheet(activePage, shell);
}

async function loadCoilWitness(activePage, options) {
  await ensureCoilWitnessSheet(activePage, options.embedFont !== false);
  await activePage.evaluate(async (bodyHtml) => {
    const svg = document.querySelector("body > svg");
    svg.querySelector('g[data-device-uid="k1"]')?.remove();
    svg.insertAdjacentHTML("beforeend", bodyHtml);
    await document.fonts.ready;
  }, coilWitnessBody(options));
}

async function evaluateCoilSheet(
  activePage,
  { text, measureGap = false, maxGapMm = 0.8 } = {},
) {
  const geometry = await evaluateSheetGeometry(activePage);
  const findings = circuitCaptionFindings(geometry);
  const needGap = measureGap && findings.length === 0;
  const diag = text
    ? await activePage.evaluate(
        ({ source, options }) => (0, eval)(source)(options),
        {
          source: COIL_DIAG_SOURCE,
          options: { text, measureGap: needGap, maxGapMm },
        },
      )
    : null;
  if (diag && diag.measuredGapMm === null && findings[0]) {
    diag.measuredGapMm = findings[0].gapMm;
  }
  return { geometry, findings, diag };
}

async function openCoilSheet(activePage, witness, options) {
  await loadCoilWitness(activePage, witness);
  return evaluateCoilSheet(activePage, options);
}

function describeCoilDiag(context, diag) {
  if (!diag) return `${context} [caption not measured]`;
  const containment = diag.interiorContained ? "interior" : "external";
  const gap = diag.measuredGapMm ?? "none";
  const paintedY = diag.paintedBbox?.y?.toFixed(3) ?? "none";
  const measureY = diag.measureTextBbox?.y?.toFixed(3) ?? "none";
  return `${context} [containment=${containment}, cutoffMm=${diag.cutoffMm}, measuredGapMm=${gap}, paintedY=${paintedY}, measureTextY=${measureY}]`;
}

// Compute a local baseline y below the LTR coil rect once per font from the
// checker's own tight painted glyph ink measurement (refined against
// terminalLabelStrokeGap with a bounded bisection of <= 8 steps) so the
// witness ink gap lands at targetGapMm regardless of measureText quantization
// or platform fallback font metrics.
async function displacedBelowCoilY(
  activePage,
  text,
  { fontFamily = DEFAULT_FONT, embedFont = true, targetGapMm = 0.2 } = {},
) {
  const key = JSON.stringify([text, fontFamily, embedFont, targetGapMm]);
  if (displacedCoilYCache.has(key)) return displacedCoilYCache.get(key);
  const probeY = 25;
  await loadCoilWitness(activePage, {
    text,
    y: probeY,
    vertical: false,
    fontFamily,
    embedFont,
  });
  const res = await activePage.evaluate(
    ({ source, options }) => (0, eval)(source)(options),
    {
      source: DISPLACED_COIL_Y_SOURCE,
      options: { text, probeY, targetGapMm, maxGapMm: 0.6 },
    },
  );
  expect(res.hasRect, "coil rect").toBe(true);
  expect(res.hasPaintedBbox, `probe painted glyph box for ${text}`).toBe(true);
  displacedCoilYCache.set(key, res.y);
  return res.y;
}

async function assertDisplacedCoilWitness(
  activePage,
  {
    text,
    y,
    rotateDeg = 0,
    fontFamily = DEFAULT_FONT,
    embedFont = true,
    quantize = null,
    quantizeLabel = quantize?.label ?? "none",
    label,
  },
) {
  const run = async () => {
    await loadCoilWitness(activePage, {
      text,
      y,
      vertical: false,
      rotateDeg,
      fontFamily,
      embedFont,
    });
    const { findings, diag } = await evaluateCoilSheet(activePage, {
      text,
      measureGap: true,
    });
    const msg = describeCoilDiag(
      `${label} (y=${y}, rotate=${rotateDeg}, quantize=${quantizeLabel})`,
      diag,
    );
    expect(findings, msg).toEqual([
      expect.objectContaining({
        kind: "circuit-caption-body-clearance",
        text,
        minimumMm: 0.5,
      }),
    ]);
    expect(diag?.interiorContained, msg).toBe(false);
    expect(findings[0].gapMm, msg).toBeGreaterThan(
      INTERIOR_LEGEND_NEAR_CONTACT_MM,
    );
    expect(findings[0].gapMm, msg).toBeLessThan(0.5);
  };
  if (!quantize) return run();
  await ensureCoilWitnessSheet(activePage, embedFont);
  return withQuantizedMeasureText(activePage, quantize, run);
}

async function assertQuantizedCoilCase(
  activePage,
  { fontFamily = DEFAULT_FONT, embedFont = true, quantize, acPrefix, dcLabel },
) {
  const displacedY = await displacedBelowCoilY(activePage, "DC", {
    fontFamily,
    embedFont,
  });
  await ensureCoilWitnessSheet(activePage, embedFont);
  await withQuantizedMeasureText(activePage, quantize, async () => {
    for (const rotateDeg of [0, 30]) {
      await loadCoilWitness(activePage, {
        text: "AC",
        y: 15.8,
        vertical: true,
        rotateDeg,
        fontFamily,
        embedFont,
      });
      const { geometry, diag } = await evaluateCoilSheet(activePage, {
        text: "AC",
      });
      const acText = geometry.texts.find((t) => t.text === "AC");
      const msg = describeCoilDiag(`${acPrefix} rotate=${rotateDeg}`, diag);
      expect(acText.bbox.w, msg).toBeGreaterThan(4.4);
      expect(circuitCaptionFindings(geometry), msg).toEqual([]);
      expect(diag?.interiorContained, msg).toBe(true);
    }

    await assertDisplacedCoilWitness(activePage, {
      text: "DC",
      y: displacedY,
      fontFamily,
      embedFont,
      quantizeLabel: quantize.label,
      label: dcLabel,
    });
  });
}

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

  it("enforces the 0.50 mm cutoff for a displaced DC qualifier and an external coil footer", async () => {
    const displacedDcY = await displacedBelowCoilY(page, "DC");
    await assertDisplacedCoilWitness(page, {
      text: "DC",
      y: displacedDcY,
      label: "displaced DC qualifier",
    });

    const coilFooterY = await displacedBelowCoilY(page, "4: 221");
    await assertDisplacedCoilWitness(page, {
      text: "4: 221",
      y: coilFooterY,
      label: "external coil footer",
    });
  });

  it("preserves interior containment under rigid rotation (30°/45° pass) while rejecting a rotated displaced DC qualifier", async () => {
    for (const angle of [30, 45]) {
      const { geometry, diag } = await openCoilSheet(
        page,
        { text: "AC", y: 15.8, vertical: true, rotateDeg: angle },
        { text: "AC" },
      );
      const msg = describeCoilDiag(`TTB AC coil rotated ${angle} deg`, diag);
      expect(circuitCaptionFindings(geometry), msg).toEqual([]);
      expect(diag?.interiorContained, msg).toBe(true);
    }

    const displacedDcY = await displacedBelowCoilY(page, "DC");
    await assertDisplacedCoilWitness(page, {
      text: "DC",
      y: displacedDcY,
      rotateDeg: 30,
      label: "rotated displaced DC qualifier",
    });
  });

  const fallbackFontStacks = [
    {
      fontLabel: "Arial fallback",
      fontFamily: "Arial, Liberation Sans, DejaVu Sans, sans-serif",
    },
    {
      fontLabel: "Verdana fallback",
      fontFamily: "Verdana, DejaVu Sans, sans-serif",
    },
  ];

  it("keeps interior coil containment robust across fallback fonts", async () => {
    for (const { fontFamily } of fallbackFontStacks) {
      for (const rotateDeg of [0, 30]) {
        const { geometry, diag } = await openCoilSheet(
          page,
          {
            text: "AC",
            y: 15.8,
            vertical: true,
            rotateDeg,
            fontFamily,
            embedFont: false,
          },
          { text: "AC" },
        );
        const msg = describeCoilDiag(
          `fallback ${fontFamily} rotate=${rotateDeg}`,
          diag,
        );
        expect(circuitCaptionFindings(geometry), msg).toEqual([]);
        expect(diag?.interiorContained, msg).toBe(true);
      }

      const fallbackDisplacedY = await displacedBelowCoilY(page, "DC", {
        fontFamily,
        embedFont: false,
      });
      await assertDisplacedCoilWitness(page, {
        text: "DC",
        y: fallbackDisplacedY,
        fontFamily,
        embedFont: false,
        label: `fallback ${fontFamily} displaced DC`,
      });
    }
  });

  it("uses tight painted glyph ink when measureText returns integer-quantized bounds", async () => {
    // Reproduce Windows DirectWrite integer-rounded measureText bounds at
    // 2.5px, where raw measureText bbox overhangs the 4.4 mm TTB coil rect
    // while painted glyph ink remains strictly inside the coil body.
    await assertQuantizedCoilCase(page, {
      quantize: { label: "ceil", extraAscent: 0 },
      acPrefix: "quantized measureText TTB AC",
      dcLabel: "quantized measureText displaced DC",
    });
  });

  const quantizedFallbackCases = fallbackFontStacks.flatMap(
    ({ fontLabel, fontFamily }) =>
      [
        { label: "ceil", extraAscent: 0 },
        { label: "ceil+1", extraAscent: 1 },
      ].map((quantize) => ({
        fontLabel,
        fontFamily,
        quantize,
        quantizeLabel: quantize.label,
      })),
  );

  it.each(quantizedFallbackCases)(
    "keeps $fontLabel interior containment and displaced cutoff robust under $quantizeLabel quantized measureText",
    async ({ fontFamily, quantize }) => {
      await assertQuantizedCoilCase(page, {
        fontFamily,
        embedFont: false,
        quantize,
        acPrefix: `quantized(${quantize.label}) fallback ${fontFamily} TTB AC`,
        dcLabel: `quantized(${quantize.label}) fallback ${fontFamily} displaced DC`,
      });
    },
  );

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
