import { DOMParser } from "linkedom";
import { afterAll, beforeAll, expect, it } from "vitest";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { terminalText } from "./checks.mjs";
import { boxGap, conductorInk } from "./peer-owner-ink.mjs";

const JB_UID = "10000000-0000-4000-8000-000000000001";
const TB_UID = "10000000-0000-4000-8000-000000000002";
const CBL_UID = "10000000-0000-4000-8000-000000000003";
const CBL_PATH =
  "M 104.615 67.787 L 117.615 67.787 L 117.615 84.987 L 159.443 84.987 L 159.443 76.387 L 172.443 76.387";

const SPARE_ELEMENT = {
  kind: "cable-conductor",
  cableUid: CBL_UID,
  conductorId: "2+",
};

const SPARE_IR = {
  devices: [
    { uid: JB_UID, designation: "JB1" },
    { uid: TB_UID, designation: "TB1" },
  ],
  wires: [],
  jumpers: [],
  cableConductors: [
    {
      id: { cableUid: CBL_UID, conductorId: "2+" },
      endpoints: [
        { terminal: { deviceUid: JB_UID, terminalKey: "X1.3" } },
        { terminal: { deviceUid: TB_UID, terminalKey: "3" } },
      ],
    },
  ],
};

function buildDashedSpareSvg() {
  const conductorAttr = JSON.stringify({
    cableUid: CBL_UID,
    conductorId: "2+",
  }).replace(/"/gu, "&quot;");
  const endsAttr = JSON.stringify([
    { deviceUid: JB_UID, terminalKey: "X1.3" },
    { deviceUid: TB_UID, terminalKey: "3" },
  ]).replace(/"/gu, "&quot;");
  const jbTermAttr = JSON.stringify([JB_UID, "X1.3"]).replace(/"/gu, "&quot;");
  const tbTermAttr = JSON.stringify([TB_UID, "3"]).replace(/"/gu, "&quot;");
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="431.8mm" height="279.4mm" viewBox="0 0 431.8 279.4">',
    '<g data-navigation-view="loop:dash-probe" transform="translate(46.064 40)">',
    `<g data-loop-conductor="${conductorAttr}" data-terminal-ends="${endsAttr}">`,
    `<path d="${CBL_PATH}" fill="none" stroke="#697586" stroke-width="0.4" stroke-linecap="round" stroke-dasharray="2 1"/>`,
    "</g>",
    `<g data-device-uid="${JB_UID}" data-designation="JB1" data-terminal-body="b_jb1">`,
    '<rect x="74.615" y="55" width="30" height="30" fill="white" stroke="#18212b" stroke-width="0.35"/>',
    `<circle cx="104.615" cy="67.787" r="0.8" fill="white" stroke="#18212b" stroke-width="0.3" data-loop-terminal="${jbTermAttr}"/>`,
    '<text x="102.5" y="66.3" font-family="Thermite Sans, sans-serif" font-size="2.7" text-anchor="end" fill="#18212b" data-terminal-caption-body="b_jb1" data-terminal-key="X1.3">X1.3</text>',
    "</g>",
    `<g data-device-uid="${TB_UID}" data-designation="TB1" data-terminal-body="b_tb1">`,
    '<rect x="172.443" y="62" width="30" height="30" fill="white" stroke="#18212b" stroke-width="0.35"/>',
    `<circle cx="172.443" cy="76.387" r="0.8" fill="white" stroke="#18212b" stroke-width="0.3" data-loop-terminal="${tbTermAttr}"/>`,
    '<text x="174.5" y="74.9" font-family="Thermite Sans, sans-serif" font-size="2.7" text-anchor="start" fill="#18212b" data-terminal-caption-body="b_tb1" data-terminal-key="3">3</text>',
    "</g>",
    "</g></svg>",
  ].join("");
}

let browser, context, page;
beforeAll(async () => {
  browser = await launch([
    "--enable-blink-features=CanvasTextMetricsPreciseBounds",
  ]);
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
});
afterAll(async () => {
  await context?.close();
  await browser?.close();
});

const measure = (svg) => openSheet(page, embedPrintableFont(svg));
const parseSvg = (svg) => new DOMParser().parseFromString(svg, "image/svg+xml");

function measureEndGaps(g) {
  const ink = conductorInk(g, SPARE_ELEMENT);
  const gapFor = (deviceUid, terminal) => {
    const body = g.terminalOutsideBodies.find(
      (b) => b.deviceUid === deviceUid && b.terminal === terminal,
    );
    const tipGap = Math.min(
      ...body.markerBoxes.flatMap((m) =>
        ink.tips.map((p) => boxGap({ ...p, w: 0, h: 0 }, m)),
      ),
    );
    const inkGap = Math.min(
      ...body.markerBoxes.flatMap((m) => ink.boxes.map((b) => boxGap(b, m))),
    );
    return { tipGap, inkGap };
  };
  return {
    source: gapFor(JB_UID, "X1.3"),
    target: gapFor(TB_UID, "3"),
  };
}

function expectBothMissing(findings) {
  expect(findings).toHaveLength(2);
  expect(findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "missing-outside-connection-count",
        deviceUid: JB_UID,
        terminal: "X1.3",
        expectedOutside: 1,
        printedOutside: 0,
      }),
      expect.objectContaining({
        kind: "missing-outside-connection-count",
        deviceUid: TB_UID,
        terminal: "3",
        expectedOutside: 1,
        printedOutside: 0,
      }),
    ]),
  );
}

it("#626 dash-phase landing: legitimate dash gap at target (0.198 mm source / 0.797 mm target) passes", async () => {
  const g = await measure(buildDashedSpareSvg());
  const gaps = measureEndGaps(g);
  expect(gaps.source.tipGap).toBe(0);
  expect(gaps.target.tipGap).toBe(0);
  expect(gaps.source.inkGap).toBeCloseTo(0.198, 2);
  expect(gaps.target.inkGap).toBeCloseTo(0.797, 2);
  expect(terminalText(g, SPARE_IR)).toEqual([]);
});

it("#626 dash-phase landing: geometrically shortened dashed route (tip 1.4 mm short of marker) fails", async () => {
  const doc = parseSvg(buildDashedSpareSvg());
  const path = doc.querySelector("[data-loop-conductor] path");
  path.setAttribute(
    "d",
    path.getAttribute("d").replace("M 104.615 67.787", "M 106.815 67.787"),
  );
  const g = await measure(doc.toString());
  expect(measureEndGaps(g).source.tipGap).toBeCloseTo(1.4, 2);
  expectBothMissing(terminalText(g, SPARE_IR));
});

it("#626 dash-phase landing: clipped source landing where dash predicts ink (1.196 mm painted gap) fails", async () => {
  const doc = parseSvg(buildDashedSpareSvg());
  const svg = doc.querySelector("svg");
  const defs = doc.createElement("defs");
  const clip = doc.createElement("clipPath");
  clip.setAttribute("id", "review-tip-clip");
  const rect = doc.createElement("rect");
  rect.setAttribute("x", "106.5");
  rect.setAttribute("y", "0");
  rect.setAttribute("width", "1000");
  rect.setAttribute("height", "1000");
  clip.appendChild(rect);
  defs.appendChild(clip);
  svg.insertBefore(defs, svg.firstChild);
  const path = doc.querySelector("[data-loop-conductor] path");
  path.setAttribute("stroke-dashoffset", "0");
  path.setAttribute("clip-path", "url(#review-tip-clip)");
  const g = await measure(doc.toString());
  const gaps = measureEndGaps(g);
  expect(gaps.source.tipGap).toBe(0);
  expect(gaps.source.inkGap).toBeCloseTo(1.196, 2);
  expectBothMissing(terminalText(g, SPARE_IR));
});

it("#626 dash-phase landing: occluded landing where pattern predicts ink fails at either end", async () => {
  const docSourceOcc = parseSvg(buildDashedSpareSvg());
  const srcCover = docSourceOcc.createElement("rect");
  srcCover.setAttribute("x", "105.4");
  srcCover.setAttribute("y", "66.5");
  srcCover.setAttribute("width", "1.4");
  srcCover.setAttribute("height", "2.6");
  srcCover.setAttribute("fill", "white");
  docSourceOcc.querySelector("[data-loop-conductor]").appendChild(srcCover);
  const gSrc = await measure(docSourceOcc.toString());
  expect(measureEndGaps(gSrc).source.tipGap).toBe(0);
  expect(measureEndGaps(gSrc).source.inkGap).toBeGreaterThan(1.0);
  expectBothMissing(terminalText(gSrc, SPARE_IR));

  const docTargetOcc = parseSvg(buildDashedSpareSvg());
  const tgtCover = docTargetOcc.createElement("rect");
  tgtCover.setAttribute("x", "169.6");
  tgtCover.setAttribute("y", "75.0");
  tgtCover.setAttribute("width", "2.0");
  tgtCover.setAttribute("height", "2.6");
  tgtCover.setAttribute("fill", "white");
  docTargetOcc.querySelector("[data-loop-conductor]").appendChild(tgtCover);
  const gTgt = await measure(docTargetOcc.toString());
  expect(measureEndGaps(gTgt).target.tipGap).toBe(0);
  expectBothMissing(terminalText(gTgt, SPARE_IR));
});

it("#626 dash-phase landing: non-zero stroke-dashoffset gap passes when painted and fails when occluded or hidden", async () => {
  const doc = parseSvg(buildDashedSpareSvg());
  const group = doc.querySelector("[data-loop-conductor]");
  const path = group.querySelector("path");
  // Place a 1 mm dash gap right outside the r=0.8 mm source marker ([0.8, 1.8]).
  path.setAttribute("stroke-dashoffset", "1.2");
  expect(terminalText(await measure(doc.toString()), SPARE_IR)).toEqual([]);

  // Occluding the predicted Dash 1 start ([1.6, 2.8] from source tip) fails.
  const docOcc = parseSvg(doc.toString());
  const cover = docOcc.createElement("rect");
  cover.setAttribute("x", "106.2");
  cover.setAttribute("y", "66.5");
  cover.setAttribute("width", "1.4");
  cover.setAttribute("height", "2.6");
  cover.setAttribute("fill", "white");
  docOcc.querySelector("[data-loop-conductor]").appendChild(cover);
  expectBothMissing(terminalText(await measure(docOcc.toString()), SPARE_IR));

  // Same dashed route at opacity 0 fails.
  group.setAttribute("opacity", "0");
  expectBothMissing(terminalText(await measure(doc.toString()), SPARE_IR));
});
