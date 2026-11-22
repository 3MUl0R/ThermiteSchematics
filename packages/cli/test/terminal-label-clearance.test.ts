import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import {
  displaySheet,
  drawingContextOptions,
  evaluateSheetGeometry,
  launch,
  openSheet,
  sheetMeasurementSource,
} from "../../../evals/draw/browser.mjs";
import { terminalLabelFindings } from "../../../evals/draw/caption-mark-clearance.mjs";
import * as clearance from "../../../evals/draw/measurement/terminal-label-clearance.mjs";
import { embedPrintableFont } from "../src/printable-font.js";

let browser: Browser, page: Page;
beforeAll(async () => {
  browser = await launch();
  page = await (await browser.newContext(drawingContextOptions)).newPage();
});
afterAll(async () => browser?.close());

function drawing(x: number, sameOwner: boolean) {
  const winding = `<g data-circuit-mark="winding" stroke="black" stroke-width=".65" fill="none">
    <polyline points="10,12 ${x},15 10,18"/>
  </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="30mm" viewBox="0 0 80 30">
    <g data-device-uid="device" data-circuit-functions="[]">
      ${sameOwner ? winding : ""}
      <g data-terminal-key="X2"><text x="21" y="16" font-family="sans-serif" font-size="2.5">X2 [+1]</text></g>
    </g>
    ${sameOwner ? "" : `<g data-device-uid="other">${winding}</g>`}
  </svg>`;
}

it.each([
  { x: 20, sameOwner: true, fails: true },
  { x: 18, sameOwner: true, fails: false },
  { x: 20, sameOwner: false, fails: false },
])(
  "measures the painted winding join beside a suffixed terminal ($x, $sameOwner)",
  async ({ x, sameOwner, fails }) => {
    const findings = terminalLabelFindings(
      await openSheet(page, drawing(x, sameOwner)),
    );
    expect(findings).toEqual(
      fails
        ? [
            expect.objectContaining({
              kind: "terminal-label-body-clearance",
              terminalKey: "X2",
              text: "X2 [+1]",
              minimumMm: 0.5,
            }),
          ]
        : [],
    );
  },
);

function transformerSecondary(points: string, labelX: number) {
  return embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="431.8mm" height="279.4mm" viewBox="0 0 431.8 279.4">
      <g data-circuit-functions="[]" transform="translate(90.063 51.928)">
        <g data-circuit-mark="winding" stroke="#17212b" stroke-width="0.4" fill="none">
          <polyline points="${points}"/>
        </g>
        <g data-terminal-key="X2">
          <text x="${labelX}" y="12.5" text-anchor="end" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.5" font-weight="400" fill="#17212b">X2 [+1]</text>
        </g>
      </g>
    </svg>`,
  );
}

// Secondary winding and suffixed terminal extracted from functional-symbols LTR sheet 1.
const roundOneWinding =
  "26,6 16,6 14.4,7 16,8 14.4,9 16,10 14.4,11 16,12 14.4,13 16,14 26,14";
const roundTwoWinding =
  "26.959,6 16.48,6 14.88,7 16.48,8 14.88,9 16.48,10 14.88,11 16.48,12 14.88,13 16.48,14 26.959,14";

it("catches the round-one T1 terminal label next to the secondary winding", async () => {
  const findings = terminalLabelFindings(
    await openSheet(page, transformerSecondary(roundOneWinding, 24.5)),
  );
  expect(findings).toEqual([
    expect.objectContaining({
      kind: "terminal-label-body-clearance",
      terminalKey: "X2",
      text: "X2 [+1]",
      minimumMm: 0.5,
    }),
  ]);
  expect(findings[0].gapMm).toBeLessThan(0.36);
});

const measureFixtureCoarseGap = sheetMeasurementSource((options, h) => {
  const c = { options, h };
  h.prepareGeometry(c);
  h.prepareTerminals(c);
  h.prepareText(c);
  h.preparePaint(c);
  const text = c.texts[0],
    e = text && c.elementsById.get(text.element),
    owner = e
      ?.closest("[data-terminal-key]")
      ?.parentElement?.closest("[data-circuit-functions],[data-device-uid]"),
    shape = owner && h.terminalLabelBody(c, owner)[0];
  if (!text?.reviewPainted || !shape) return undefined;
  const label = {
      e,
      text,
      bbox: text.bbox,
      inverse: e.getScreenCTM().inverse(),
    },
    step = 0.02,
    cutoff = 1.5,
    labelRegion = c.intersect(
      label.bbox,
      h.expandClearanceBox(shape.bbox, cutoff),
    ),
    strokeRegion = c.intersect(
      shape.bbox,
      h.expandClearanceBox(label.bbox, cutoff),
    );
  if (
    labelRegion.w <= 0 ||
    labelRegion.h <= 0 ||
    strokeRegion.w <= 0 ||
    strokeRegion.h <= 0
  )
    return undefined;
  const ink = h.terminalLabelInkRows(labelRegion, step, (p) =>
      c.glyphAt(label, p),
    ),
    stroke = h.terminalLabelInkRows(
      strokeRegion,
      step,
      h.terminalLabelStrokeHit(c, shape),
    );
  if (!ink.length || !stroke.length) return undefined;
  const coarse = h.terminalLabelRunGap(ink, stroke, step, cutoff);
  return coarse.pair && coarse.gap < cutoff ? coarse.gap : undefined;
});

const measureFixtureGap = sheetMeasurementSource((options, h) => {
  const c = { options, h };
  h.prepareGeometry(c);
  h.prepareTerminals(c);
  h.prepareText(c);
  h.preparePaint(c);
  // Keep targetGapMm inside the adaptive 0.001 mm refinement band
  // (ceilingMm - 0.03 .. ceilingMm).
  return h.terminalLabelClearances(c, options.ceilingMm)[0]?.gapMm;
});

async function roundTwoFindingsAtGap(
  targetGapMm: number,
  labelX: number,
  minGapMm: number,
  maxGapMm: number,
) {
  // Start near the target in the embedded font and calibrate against the
  // measured ink to allow for native Chromium rasterization differences
  // (CoreText vs FreeType / DirectWrite).
  await displaySheet(page, transformerSecondary(roundTwoWinding, labelX));
  const label = page.locator('[data-terminal-key="X2"] text');
  const setLabelX = (x: number) =>
    label.evaluate((e, next) => e.setAttribute("x", String(next)), x);
  const readCoarseGap = (): Promise<number | undefined> =>
    page.evaluate((source) => (0, eval)(source)(), measureFixtureCoarseGap);
  const ceilingMm = targetGapMm + 0.015;
  const readFineGap = (): Promise<number | undefined> =>
    page.evaluate(({ source, ceilingMm }) => (0, eval)(source)({ ceilingMm }), {
      source: measureFixtureGap,
      ceilingMm,
    });

  // Fast coarse bracket (0.02 mm grid, 1.5 mm search window) so platforms whose
  // native glyph rasterization starts above ceilingMm move into the refinement
  // band without throwing on a narrow cutoff ceiling.
  for (let bracket = 0; bracket < 4; bracket++) {
    const coarseGap = await readCoarseGap();
    if (coarseGap === undefined)
      throw new Error("Could not measure the X2 ink gap");
    if (coarseGap >= targetGapMm - 0.005 && coarseGap <= targetGapMm + 0.012)
      break;
    labelX += (targetGapMm - coarseGap) * 0.85;
    await setLabelX(labelX);
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    const fineGap = await readFineGap();
    if (fineGap !== undefined && fineGap >= minGapMm && fineGap <= maxGapMm) {
      return {
        labelX,
        findings: terminalLabelFindings(await evaluateSheetGeometry(page)),
      };
    }
    const gapMm = fineGap ?? (await readCoarseGap());
    if (gapMm === undefined)
      throw new Error("Could not measure the X2 ink gap");
    // The winding is slanted, so damp the horizontal step near the 0.001 mm grid.
    labelX += (targetGapMm - gapMm) * 0.85;
    await setLabelX(labelX);
  }
  throw new Error(`Could not position X2 at a ${targetGapMm} mm ink gap`);
}

it.each([
  {
    targetGapMm: 0.49,
    minGapMm: 0.488,
    maxGapMm: 0.492,
    startX: 25.28,
    fails: true,
  },
  {
    targetGapMm: 0.501,
    minGapMm: 0.5,
    maxGapMm: 0.502,
    startX: 25.28,
    fails: false,
  },
  {
    targetGapMm: 0.51,
    minGapMm: 0.508,
    maxGapMm: 0.512,
    startX: 25.28,
    fails: false,
  },
])(
  "resolves the 0.50 mm X2 cutoff at $targetGapMm mm within the expected geometric band (#481)",
  async ({ targetGapMm, minGapMm, maxGapMm, startX, fails }) => {
    const { labelX, findings } = await roundTwoFindingsAtGap(
      targetGapMm,
      startX,
      minGapMm,
      maxGapMm,
    );
    // Anchor converged labelX so a uniform measurement bias cannot hide behind calibration.
    expect(labelX).toBeGreaterThan(25.15);
    expect(labelX).toBeLessThan(25.35);
    expect(findings).toEqual(
      fails
        ? [
            expect.objectContaining({
              kind: "terminal-label-body-clearance",
              terminalKey: "X2",
              minimumMm: 0.5,
            }),
          ]
        : [],
    );
    if (fails) expect(findings[0].gapMm).toBeCloseTo(targetGapMm, 2);
  },
  150_000,
);

type ProbeBox = { x: number; y: number; w: number; h: number };
const probeBox = (x: number, y: number, w: number, h: number): ProbeBox => ({
  x,
  y,
  w,
  h,
});
const probeIntersect = (a: ProbeBox, b: ProbeBox): ProbeBox => {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  return probeBox(
    x,
    y,
    Math.min(a.x + a.w, b.x + b.w) - x,
    Math.min(a.y + a.h, b.y + b.h) - y,
  );
};
const probeInside = (b: ProbeBox, p: { x: number; y: number }) =>
  b.x <= p.x && p.x <= b.x + b.w && b.y <= p.y && p.y <= b.y + b.h;
const probeExtent = (boxes: readonly ProbeBox[]): ProbeBox => {
  const minX = Math.min(...boxes.map((b) => b.x)),
    minY = Math.min(...boxes.map((b) => b.y));
  return probeBox(
    minX,
    minY,
    Math.max(...boxes.map((b) => b.x + b.w)) - minX,
    Math.max(...boxes.map((b) => b.y + b.h)) - minY,
  );
};

class ProbeDomPoint {
  constructor(
    public x: number,
    public y: number,
  ) {}
  matrixTransform() {
    return this;
  }
}

function measureCutoffProbe(
  labels: readonly ProbeBox[],
  strokes: readonly ProbeBox[],
) {
  const label = { bbox: probeExtent(labels) },
    shape = {
      bbox: probeExtent(strokes),
      clips: [],
      covers: [],
      e: {
        isPointInStroke: (p: { x: number; y: number }) =>
          strokes.some((s) => probeInside(s, p)),
      },
    },
    c = {
      rr: { x: 0, y: 0 },
      sx: 1,
      sy: 1,
      contains: probeInside,
      intersect: probeIntersect,
      glyphAt: (_l: unknown, p: { x: number; y: number }) =>
        labels.some((b) => probeInside(b, p)),
    };
  const gap = clearance.terminalLabelStrokeGap(
    { ...c, h: clearance },
    label,
    shape,
    0.5,
  );
  const cap = { element: "label", bbox: label.bbox, reviewPainted: true },
    terminal = {
      parentElement: { closest: () => ({}) },
      getAttribute: () => "X2",
    },
    labelEl = {
      closest: () => terminal,
      getScreenCTM: () => ({ inverse: () => null }),
    };
  const findings = clearance.terminalLabelClearances(
    {
      ...c,
      texts: [cap],
      elementsById: new Map([["label", labelEl]]),
      ids: new Map([[shape.e, "shape"]]),
      h: { ...clearance, terminalLabelBody: () => [shape] },
    },
    0.5,
  );
  return { gap, findings };
}

it("never rounds a 0.499625 mm failure to pass and refines every near-cutoff approach (#481)", () => {
  const savedDomPoint = Reflect.get(globalThis, "DOMPoint");
  Reflect.set(globalThis, "DOMPoint", ProbeDomPoint);
  try {
    for (const [labels, strokes] of [
      [
        [probeBox(1 - 0.0001, 1 - 0.0001, 0.0002, 0.0002)],
        [
          probeBox(
            1 + 92 * 0.005 - 0.0001,
            1 + 39 * 0.005 - 0.0001,
            0.0002,
            0.0002,
          ),
        ],
      ],
      [
        [probeBox(0.95, 0.95, 0.05, 0.05)],
        [probeBox(1 + 92 * 0.005, 1 + 39 * 0.005, 0.05, 0.05)],
      ],
      [
        [probeBox(1.0, 1.001, 0.4, 0.003), probeBox(2.0, 1.001, 0.4, 0.003)],
        [probeBox(1.0, 1.504, 0.4, 0.003), probeBox(2.0, 1.502, 0.4, 0.003)],
      ],
      [
        [probeBox(1.0, 0.984, 0.4, 0.02), probeBox(2.0, 0.984, 0.4, 0.02)],
        [probeBox(1.0, 1.504, 0.4, 0.02), probeBox(2.0, 1.503, 0.4, 0.02)],
      ],
    ] as const) {
      const result = measureCutoffProbe(labels, strokes);
      expect(result.gap).toBeLessThan(0.5);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].gapMm).toBeLessThan(0.5);
    }
    for (const strokeY of [1.504, 1.514]) {
      const result = measureCutoffProbe(
        [probeBox(1.0, 0.984, 0.4, 0.02)],
        [probeBox(1.0, strokeY, 0.4, 0.02)],
      );
      expect(result.gap).toBe(0.5);
      expect(result.findings).toEqual([]);
    }
  } finally {
    Reflect.set(globalThis, "DOMPoint", savedDomPoint);
  }
});
