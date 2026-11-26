import { afterAll, beforeAll, expect, it } from "vitest";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { netLabelRepetition } from "./checks.mjs";
import { netOwnershipGaps } from "./net-label-oracle.mjs";

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

const hex = (s) =>
  Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
const portKey = (uid, key = "1") =>
  `port-${hex(JSON.stringify(["port", JSON.stringify(["function", uid, "feed"]), key]))}`;
const edgeKey = (wire) => `edge-${hex(JSON.stringify(["wire", wire]))}`;
const netClipId = (wire, prefix = "") =>
  `${prefix}clip-${hex(JSON.stringify(["label", "edge", JSON.stringify(["wire", wire]), "net"]))}`;

function symbolGroup(uid, key, x, y, extra = "") {
  const id = `terminal-${[uid, key, key].map(hex).join("--")}`;
  return (
    `<g class="symbol function-symbol" data-symbol-id="test" data-device-uid="${uid}" data-function-key="feed"${extra}>` +
    `<circle class="terminal-marker" id="${id}" data-terminal-key="${key}" cx="${x}" cy="${y}" r="0.5" fill="white" stroke="black"/>` +
    `</g>`
  );
}

function deviceFrame(uid, des, x, y, w, h, extra = "", rectExtra = "") {
  return (
    `<g class="device-group" data-device-uid="${uid}" data-designation="${des}"${extra}>` +
    `<rect class="device-frame" x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ry="3" fill="#fff" stroke="#98a2b3" stroke-width="0.4"${rectExtra}/>` +
    `</g>`
  );
}

function routePath(wire, srcUid, tgtUid, d, { keyless = false } = {}) {
  const portAttrs = keyless
    ? ""
    : ` data-route-source-port-key="${portKey(srcUid)}" data-route-target-port-key="${portKey(tgtUid)}"`;
  return (
    `<path class="net-path" data-wire-uid="${wire}" data-source-device-uid="${srcUid}" data-source-terminal-key="1"` +
    ` data-target-device-uid="${tgtUid}" data-target-terminal-key="1"${portAttrs}` +
    ` data-edge-key="${edgeKey(wire)}" d="${d}" stroke="#101828" stroke-width="0.35" fill="none"/>`
  );
}

function netLabel(
  wire,
  text,
  x,
  y,
  { clipRect, extra = "", prefix = "" } = {},
) {
  const id = netClipId(wire, prefix);
  const cr = clipRect ?? { x: 0, y: 0, w: 300, h: 200 };
  return (
    `<defs><clipPath id="${id}"><rect x="${cr.x}" y="${cr.y}" width="${cr.w}" height="${cr.h}"/></clipPath></defs>` +
    `<text class="label-text label-net" clip-path="url(#${id})" x="${x}" y="${y}" font-size="2.7" fill="#101828"${extra}>${text}</text>`
  );
}

const wrap = (body) =>
  embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200" font-family="Thermite Sans, sans-serif">${body}</svg>`,
  );

// Folded TTB mutant: SUP1 in col 1 (x=20..70, y=15..45), route drops vertically
// from SUP1 (45,40) through y=180 to M1 (45,180), so y=62 is in the source half
// (coherent route-source metadata, passes tailPosition). Q1 sits at y=55..85 in
// col 1 (or a folded col 2 view overlapping the painted label).
function foldedColumnSvg({
  labelX = 35,
  labelY = 66,
  q1Extra = "",
  q1RectExtra = "",
  labelExtra = "",
  labelClipRect,
  keyless = false,
  crossColumn = false,
} = {}) {
  const col1 =
    `<svg x="0" y="0" width="300" height="200" viewBox="0 0 300 200" overflow="hidden">` +
    deviceFrame("sup1", "SUP1", 20, 15, 50, 30) +
    (crossColumn
      ? ""
      : deviceFrame("q1", "Q1", 25, 55, 45, 30, q1Extra, q1RectExtra)) +
    deviceFrame("m1", "M1", 25, 165, 45, 25) +
    symbolGroup("sup1", "1", 45, 40) +
    symbolGroup("m1", "1", 45, 175) +
    routePath("w1", "sup1", "m1", "M 45 40 V 175", { keyless }) +
    netLabel("w1", "480VAC-L1", labelX, labelY, {
      clipRect: labelClipRect,
      extra: labelExtra,
    }) +
    `</svg>`;
  const col2 = crossColumn
    ? `<svg x="0" y="0" width="300" height="200" viewBox="0 0 300 200" overflow="hidden">` +
      deviceFrame("q1", "Q1", 25, 55, 45, 30, q1Extra, q1RectExtra) +
      `</svg>`
    : "";
  return wrap(col2 + col1);
}

it("#627 fails folded-column TTB mutant when painted edge net label sits inside Q1 frame with coherent source metadata", async () => {
  // Same-view foreign Q1 frame with coherent source metadata (at <= total/2).
  const gSame = await openSheet(
    page,
    foldedColumnSvg({ labelX: 35, labelY: 68 }),
  );
  expect(netOwnershipGaps(gSame)).toEqual([]);
  expect(netLabelRepetition(gSame).map((f) => f.kind)).toEqual([
    "net-label-in-foreign-device-frame",
  ]);
  expect(netLabelRepetition(gSame)[0].foreignDeviceUid).toBe("q1");

  // Cross-column folded view: label painted in col 1 overlapping col 2 Q1 frame.
  const gFold = await openSheet(
    page,
    foldedColumnSvg({ labelX: 35, labelY: 68, crossColumn: true }),
  );
  expect(netOwnershipGaps(gFold)).toEqual([]);
  expect(netLabelRepetition(gFold).map((f) => f.kind)).toEqual([
    "net-label-in-foreign-device-frame",
  ]);

  // Passing wire inside Q1 does not exempt a label genuinely inside Q1's frame.
  const gWireInside = await openSheet(
    page,
    foldedColumnSvg({ labelX: 46, labelY: 68 }),
  );
  expect(netLabelRepetition(gWireInside).map((f) => f.kind)).toEqual([
    "net-label-in-foreign-device-frame",
  ]);
}, 60_000);

it("#627 passes controls: own source frame, open space, wire crossing frame edge, enclosure/location frames, hidden/clipped geometry", async () => {
  // 1. Inside its own source frame (SUP1).
  const gOwn = await openSheet(
    page,
    foldedColumnSvg({ labelX: 35, labelY: 36 }),
  );
  expect(netLabelRepetition(gOwn)).toEqual([]);

  // 2. Open space outside all device frames.
  const gOpen = await openSheet(
    page,
    foldedColumnSvg({ labelX: 80, labelY: 96 }),
  );
  expect(netLabelRepetition(gOpen)).toEqual([]);

  // 3. Beside a wire crossing a frame edge (just above Q1 top edge y=55, outside interior).
  const gEdge = await openSheet(
    page,
    foldedColumnSvg({ labelX: 46, labelY: 54.4 }),
  );
  expect(netLabelRepetition(gEdge)).toEqual([]);

  // 4. Rounded-corner boundary case: label bbox overlaps Q1's top-left corner bbox
  // [25..25.6, 55..55.5] while painted glyphs stay strictly outside the rx=3 rounded interior.
  const gCorner = await openSheet(
    page,
    foldedColumnSvg({ labelX: 12.7, labelY: 55.4 }),
  );
  expect(netLabelRepetition(gCorner)).toEqual([]);

  // 5. Location frame and source enclosure are not device frames.
  const gNonDevice = await openSheet(
    page,
    wrap(
      `<g class="location-group" data-location="MAIN-PANEL">` +
        `<rect class="location-frame" x="10" y="10" width="180" height="180" fill="#f7f8fa" stroke="#667085" stroke-width="0.4"/>` +
        `</g>` +
        `<g data-source-enclosure="true" data-device-uid="enc1"><rect x="30" y="55" width="50" height="30" fill="white" stroke="#17212b" stroke-width="0.4"/></g>` +
        deviceFrame("sup1", "SUP1", 20, 15, 50, 30) +
        deviceFrame("m1", "M1", 25, 165, 45, 25) +
        symbolGroup("sup1", "1", 45, 40) +
        symbolGroup("m1", "1", 45, 175) +
        routePath("w1", "sup1", "m1", "M 45 40 V 175") +
        netLabel("w1", "480VAC-L1", 35, 68),
    ),
  );
  expect(netLabelRepetition(gNonDevice)).toEqual([]);
}, 60_000);

it("#627 excludes hidden/clipped geometry and preserves unresolved route ownership gaps", async () => {
  // 6. Hidden or clipped foreign frames are excluded.
  for (const opts of [
    { q1Extra: ' display="none"' },
    { q1Extra: ' visibility="hidden"' },
    { q1Extra: ' opacity="0"' },
    { q1RectExtra: ' style="fill:none;stroke:none"' },
  ]) {
    const gHidden = await openSheet(
      page,
      foldedColumnSvg({ labelX: 35, labelY: 68, ...opts }),
    );
    expect(netLabelRepetition(gHidden)).toEqual([]);
  }

  // 7. Label clipped away before entering Q1 frame is excluded.
  const gClippedLabel = await openSheet(
    page,
    foldedColumnSvg({
      labelX: 35,
      labelY: 68,
      labelClipRect: { x: 0, y: 0, w: 300, h: 54 },
    }),
  );
  expect(netLabelRepetition(gClippedLabel)).toEqual([]);

  // 8. Unresolved route ownership keeps ownership-gap handling (never flags every frame as foreign).
  const gUnresolved = await openSheet(
    page,
    foldedColumnSvg({ labelX: 35, labelY: 68, keyless: true }),
  );
  expect(netOwnershipGaps(gUnresolved).length).toBeGreaterThan(0);
  expect(
    netLabelRepetition(gUnresolved).filter(
      (f) => f.kind === "net-label-in-foreign-device-frame",
    ),
  ).toEqual([]);
}, 60_000);

it("#627 matches actual source appearance within the correct SVG/view for repeated device appearances", async () => {
  // Repeated appearance of SUP1 in two separate nested SVGs on the same sheet:
  // each label inside its own SVG's SUP1 frame passes.
  const repeatedViewsPass = wrap(
    `<svg x="0" y="0" width="140" height="200" viewBox="0 0 140 200" overflow="hidden">` +
      deviceFrame("sup1", "SUP1", 15, 15, 60, 35) +
      deviceFrame("m1", "M1", 15, 140, 60, 30) +
      symbolGroup("sup1", "1", 45, 42) +
      symbolGroup("m1", "1", 45, 150) +
      routePath("w1", "sup1", "m1", "M 45 42 V 150") +
      netLabel("w1", "480VAC-L1", 25, 36, { prefix: "v1-" }) +
      `</svg>` +
      `<svg x="150" y="0" width="140" height="200" viewBox="0 0 140 200" overflow="hidden">` +
      deviceFrame("sup1", "SUP1", 15, 15, 60, 35) +
      deviceFrame("m2", "M2", 15, 140, 60, 30) +
      symbolGroup("sup1", "1", 45, 42) +
      symbolGroup("m2", "1", 45, 150) +
      routePath("w2", "sup1", "m2", "M 45 42 V 150") +
      netLabel("w2", "480VAC-L2", 25, 36, { prefix: "v2-" }) +
      `</svg>`,
  );
  const gRepeatedPass = await openSheet(page, repeatedViewsPass);
  expect(netLabelRepetition(gRepeatedPass)).toEqual([]);

  // Same deviceUid (SUP1) repeated in two frames in the same SVG: label for
  // appearance 1 placed inside appearance 2's frame must FAIL (not same source appearance).
  const repeatedSameUidMutant = wrap(
    `<svg x="0" y="0" width="300" height="200" viewBox="0 0 300 200" overflow="hidden">` +
      deviceFrame("sup1", "SUP1", 20, 15, 50, 30) +
      deviceFrame("sup1", "SUP1", 20, 55, 50, 30) +
      deviceFrame("m1", "M1", 20, 165, 50, 25) +
      symbolGroup("sup1", "1", 45, 40) +
      symbolGroup("m1", "1", 45, 175) +
      routePath("w1", "sup1", "m1", "M 45 40 V 175") +
      netLabel("w1", "480VAC-L1", 30, 68) +
      `</svg>`,
  );
  const gRepeatedFail = await openSheet(page, repeatedSameUidMutant);
  expect(netLabelRepetition(gRepeatedFail).map((f) => f.kind)).toEqual([
    "net-label-in-foreign-device-frame",
  ]);
}, 60_000);

it("#627 rejects repeated-SUP1 mutants within 0.5 mm, adjacent, and overlapping, and flags ambiguous sibling frames", async () => {
  const repeatedSvg = (frame2Y, labelY, symbolBody = "") =>
    wrap(
      `<svg x="0" y="0" width="300" height="200" viewBox="0 0 300 200" overflow="hidden">` +
        deviceFrame("sup1", "SUP1", 20, 15, 50, 30) +
        deviceFrame("sup1", "SUP1", 20, frame2Y, 50, 30) +
        deviceFrame("m1", "M1", 20, 165, 50, 25) +
        `<g class="symbol function-symbol" data-symbol-id="test" data-device-uid="sup1" data-function-key="feed">` +
        symbolBody +
        `<circle class="terminal-marker" id="terminal-${["sup1", "1", "1"].map(hex).join("--")}" data-terminal-key="1" cx="45" cy="40" r="0.5" fill="white" stroke="black"/>` +
        `</g>` +
        symbolGroup("m1", "1", 45, 175) +
        routePath("w1", "sup1", "m1", "M 45 40 V 175") +
        netLabel("w1", "480VAC-L1", 30, labelY) +
        `</svg>`,
    );

  // 1. Reviewer's exact mutant: second SUP1 frame starts at y=40.2 (0.2 mm below y=40.0 anchor),
  // label painted inside second frame at y=68 -> must FAIL as foreign device frame.
  const gNear = await openSheet(page, repeatedSvg(40.2, 68));
  expect(netOwnershipGaps(gNear)).toEqual([]);
  expect(netLabelRepetition(gNear).map((f) => f.kind)).toEqual([
    "net-label-in-foreign-device-frame",
  ]);

  // Control: label inside legitimate own source frame (y=36) still passes even with frame 2 at y=40.2.
  const gNearOwn = await openSheet(page, repeatedSvg(40.2, 36));
  expect(netOwnershipGaps(gNearOwn)).toEqual([]);
  expect(netLabelRepetition(gNearOwn)).toEqual([]);

  // 2. Adjacent touching frames (y=15..45 and y=45..75): label in frame 2 fails.
  const gAdjacent = await openSheet(page, repeatedSvg(45, 68));
  expect(netOwnershipGaps(gAdjacent)).toEqual([]);
  expect(netLabelRepetition(gAdjacent).map((f) => f.kind)).toEqual([
    "net-label-in-foreign-device-frame",
  ]);

  // 3. Overlapping frames (y=15..45 and y=35..65) with source symbol body uniquely inside frame 1:
  // frame 2 is foreign, so label inside frame 2 at y=58 fails.
  const gOverlapUnique = await openSheet(
    page,
    repeatedSvg(
      35,
      58,
      `<rect x="35" y="20" width="20" height="20" fill="none" stroke="black"/>`,
    ),
  );
  expect(netOwnershipGaps(gOverlapUnique)).toEqual([]);
  expect(netLabelRepetition(gOverlapUnique).map((f) => f.kind)).toEqual([
    "net-label-in-foreign-device-frame",
  ]);

  // 4. Overlapping sibling frames both enclosing the entire source symbol+anchor:
  // cannot establish unique geometric association -> must report an ownership gap (never silent pass).
  const gOverlapAmbiguous = await openSheet(page, repeatedSvg(35, 58));
  expect(netOwnershipGaps(gOverlapAmbiguous).length).toBeGreaterThan(0);
}, 60_000);

it("#627 catches partially clipped offending labels and reports explicit gaps on unsupported clips", async () => {
  // 1. Reviewer witness: label at x=35..47.9 clipped at x=45 (~9.9 mm still visibly inside Q1).
  const gPartial = await openSheet(
    page,
    foldedColumnSvg({
      labelX: 35,
      labelY: 68,
      labelClipRect: { x: 0, y: 0, w: 45, h: 200 },
    }),
  );
  expect(netOwnershipGaps(gPartial)).toEqual([]);
  expect(netLabelRepetition(gPartial).map((f) => f.kind)).toEqual([
    "net-label-in-foreign-device-frame",
  ]);

  // 2. Partial clip that removes only the offending part inside Q1 (x>=25), leaving x<24 visible outside Q1 -> passes.
  const gClippedOutside = await openSheet(
    page,
    foldedColumnSvg({
      labelX: 16,
      labelY: 68,
      labelClipRect: { x: 0, y: 0, w: 24, h: 200 },
    }),
  );
  expect(netOwnershipGaps(gClippedOutside)).toEqual([]);
  expect(netLabelRepetition(gClippedOutside)).toEqual([]);

  // 3. Fully clipped label control -> passes with 0 findings and 0 gaps.
  const gFullyClipped = await openSheet(
    page,
    foldedColumnSvg({
      labelX: 35,
      labelY: 68,
      labelClipRect: { x: 0, y: 0, w: 300, h: 54 },
    }),
  );
  expect(netOwnershipGaps(gFullyClipped)).toEqual([]);
  expect(netLabelRepetition(gFullyClipped)).toEqual([]);

  // 4. Hidden label paint controls (opacity=0, fill=none) -> pass cleanly.
  for (const labelExtra of [' opacity="0"', ' style="fill:none"']) {
    const gHiddenLabel = await openSheet(
      page,
      foldedColumnSvg({ labelX: 35, labelY: 68, labelExtra }),
    );
    expect(netOwnershipGaps(gHiddenLabel)).toEqual([]);
    expect(netLabelRepetition(gHiddenLabel)).toEqual([]);
  }
}, 60_000);

it("#627 reports explicit measurement gaps on unsupported circular clips", async () => {
  // 1. Unsupported circular clip on Q1 preserving the offending portion -> explicit measurement gap.
  const circularFrameSvg = wrap(
    `<defs><clipPath id="circ-q1"><circle cx="45" cy="68" r="15"/></clipPath></defs>` +
      `<svg x="0" y="0" width="300" height="200" viewBox="0 0 300 200" overflow="hidden">` +
      deviceFrame("sup1", "SUP1", 20, 15, 50, 30) +
      deviceFrame(
        "q1",
        "Q1",
        25,
        55,
        45,
        30,
        "",
        ' clip-path="url(#circ-q1)"',
      ) +
      deviceFrame("m1", "M1", 25, 165, 45, 25) +
      symbolGroup("sup1", "1", 45, 40) +
      symbolGroup("m1", "1", 45, 175) +
      routePath("w1", "sup1", "m1", "M 45 40 V 175") +
      netLabel("w1", "480VAC-L1", 35, 68) +
      `</svg>`,
  );
  const gCircFrame = await openSheet(page, circularFrameSvg);
  expect(netOwnershipGaps(gCircFrame).length).toBeGreaterThan(0);

  // 2. Unsupported circular clip on the net label preserving the offending portion -> explicit measurement gap.
  const circularLabelSvg = wrap(
    `<defs><clipPath id="circ-lbl"><circle cx="40" cy="68" r="10"/></clipPath></defs>` +
      `<svg x="0" y="0" width="300" height="200" viewBox="0 0 300 200" overflow="hidden">` +
      deviceFrame("sup1", "SUP1", 20, 15, 50, 30) +
      deviceFrame("q1", "Q1", 25, 55, 45, 30) +
      deviceFrame("m1", "M1", 25, 165, 45, 25) +
      symbolGroup("sup1", "1", 45, 40) +
      symbolGroup("m1", "1", 45, 175) +
      routePath("w1", "sup1", "m1", "M 45 40 V 175") +
      `<g clip-path="url(#circ-lbl)">` +
      netLabel("w1", "480VAC-L1", 35, 68) +
      `</g></svg>`,
  );
  const gCircLabel = await openSheet(page, circularLabelSvg);
  expect(netOwnershipGaps(gCircLabel).length).toBeGreaterThan(0);
}, 60_000);
