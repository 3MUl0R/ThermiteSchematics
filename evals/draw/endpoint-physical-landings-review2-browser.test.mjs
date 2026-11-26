import { afterAll, beforeAll, expect, it } from "vitest";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import { doubleLandings } from "./checks.mjs";
import { junctionRayAudit } from "./junction-rays-oracle.mjs";
import { terminalPeerObligations } from "./terminal-peer-oracle.mjs";

let browser, page;
beforeAll(async () => {
  browser = await launch();
  page = await (await browser.newContext(drawingContextOptions)).newPage();
});
afterAll(async () => {
  await browser?.close();
});

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="70mm" viewBox="0 0 100 70"><g data-circuit-group="g">${body}</g></svg>`;

const terminal = (d, p, x, y, fill = "white", sw = ".3") =>
  `<g data-device-uid="${d}"><g data-layout-port="${p}" data-terminal-id='["${d}","T"]'><circle data-terminal-marker="true" cx="${x}" cy="${y}" r=".65" fill="${fill}" stroke="#17212b" stroke-width="${sw}"/></g></g>`;

const alias = (x, y) =>
  `<g data-device-uid="d"><circle data-layout-port="a-circuit-landing-positive" data-circuit-landing-for="a" data-terminal-key="T" cx="${x}" cy="${y}" r=".001" fill="none" stroke="none"/></g>`;

const route = (d, src = "a-circuit-landing-positive", extra = "") =>
  `<g data-circuit-conductor="w" data-layout-source-port="${src}" data-layout-target-port="b" data-endpoints='[{"deviceUid":"d","terminalKey":"T"},{"deviceUid":"e","terminalKey":"T"}]'><path d="${d}" fill="none" stroke="#17212b" stroke-width=".32" ${extra}/></g>`;

const stem = (x, extra = "", d = `M34 20 H${x}`) =>
  `<g data-device-uid="d"><g data-layout-port="a-circuit-landing-positive" data-terminal-attachment='["d","T"]' data-attachment-to='{"x":${x},"y":20}'><path d="${d}" fill="none" stroke="#17212b" stroke-width=".32" ${extra}/></g></g>`;

const base = terminal("d", "a", 34, 20) + terminal("e", "b", 80, 20);
const dash = 'stroke-dasharray="1 2" stroke-dashoffset="1"';
const farDash = 'stroke-dasharray="1 4" stroke-dashoffset="1"';
const dashed =
  route("M34 20 H80", "a-circuit-landing-positive", dash) +
  base +
  alias(34, 20);
const dashedLead =
  route("M50 20 H80", "a-circuit-landing-positive", dash) + base + stem(50);

const ir = {
  devices: [
    { uid: "d", designation: "D1" },
    { uid: "e", designation: "E1" },
  ],
  terminals: [
    { id: { deviceUid: "d", terminalKey: "T" } },
    { id: { deviceUid: "e", terminalKey: "T" } },
  ],
  wires: [
    {
      uid: "w",
      designation: "W1",
      endpoints: [
        { terminal: { deviceUid: "d", terminalKey: "T" } },
        { terminal: { deviceUid: "e", terminalKey: "T" } },
      ],
    },
  ],
  jumpers: [],
  cables: [],
  cableConductors: [],
};

const physicalFindings = (g) =>
  doubleLandings(g, ir).filter(
    (f) => f.kind === "endpoint-unpainted-to-physical-terminal",
  );

it.each([
  ["legitimate dashed conductor", dashed],
  ["legitimate dashed conductor on continuous attachment lead", dashedLead],
  [
    "legitimate far-dash conductor",
    route("M34 20 H80", "a-circuit-landing-positive", farDash) +
      base +
      alias(34, 20),
  ],
])("passes valid dashed conductor: %s", async (_name, body) => {
  const g = await openSheet(page, svg(body));
  expect(doubleLandings(g, ir)).toEqual([]);
});

it.each([
  [
    "first predicted dash erased by white rectangle",
    dashed + '<rect x="35.8" y="19" width="1.4" height="2" fill="white"/>',
  ],
  [
    "first predicted dash erased by white stroke",
    dashed +
      '<path d="M36.5 19 V21" fill="none" stroke="white" stroke-width="1.4"/>',
  ],
  [
    "first predicted dash erased by standard 1.1 mm knockout",
    dashed +
      '<path d="M36.5 19 V21" fill="none" stroke="white" stroke-width="1.1"/>',
  ],
  [
    "dashed conductor with attachment lead severed by white stroke",
    dashedLead +
      '<path d="M42 19 V21" fill="none" stroke="white" stroke-width="1.1"/>',
  ],
  [
    "dashed conductor with attachment lead severed by white rectangle",
    dashedLead + '<rect x="41.45" y="19" width="1.1" height="2" fill="white"/>',
  ],
  [
    "dashed conductor on attachment lead with predicted dash erased by 1.1 mm knockout",
    dashedLead +
      '<path d="M52.5 19 V21" fill="none" stroke="white" stroke-width="1.1"/>',
  ],
  [
    "far predicted dash erased by standard 1.1 mm knockout",
    route("M34 20 H80", "a-circuit-landing-positive", farDash) +
      base +
      alias(34, 20) +
      '<path d="M38.5 19 V21" fill="none" stroke="white" stroke-width="1.1"/>',
  ],
])("rejects dashed conductor mutant: %s", async (_name, body) => {
  const g = await openSheet(page, svg(body));
  const findings = physicalFindings(g);
  expect(findings.length).toBeGreaterThanOrEqual(1);
  expect(findings[0]).toMatchObject({
    kind: "endpoint-unpainted-to-physical-terminal",
    end: "source",
    deviceUid: "d",
    terminal: "T",
  });
});

it("open marker with thin white circumference stroke still passes via surviving dark rims", async () => {
  const body =
    route("M34 20 H80") +
    base +
    alias(34, 20) +
    '<circle cx="34" cy="20" r=".65" fill="none" stroke="white" stroke-width=".10"/>';
  const g = await openSheet(page, svg(body));
  const srcMarker = g.tranche4.markers.find((m) => m.deviceUid === "d");
  expect(srcMarker.painted).toBe(true);
  expect(srcMarker.filled).toBe(false);
  expect(srcMarker.stroke).toBeGreaterThan(0);
  expect(doubleLandings(g, ir)).toEqual([]);
});

it("open marker fully erased by annular white stroke is reported as missing-painted-physical-terminal", async () => {
  const body =
    route("M34 20 H80") +
    base +
    alias(34, 20) +
    '<circle cx="34" cy="20" r=".65" fill="none" stroke="white" stroke-width=".35"/>';
  const g = await openSheet(page, svg(body));
  const srcMarker = g.tranche4.markers.find((m) => m.deviceUid === "d");
  expect(srcMarker.painted).toBe(false);
  expect(physicalFindings(g)).toContainEqual(
    expect.objectContaining({
      kind: "endpoint-unpainted-to-physical-terminal",
      end: "source",
      deviceUid: "d",
      terminal: "T",
      reason: "missing-painted-physical-terminal",
    }),
  );
});

it.each([0.012, 0.02, 0.024, 0.028, 0.03])(
  "rejects full-width %s mm erasure across all 12 phases on an 18 mm lead",
  async (width) => {
    for (let i = 0; i < 12; i++) {
      const x = (42 + i * 0.0025).toFixed(4);
      const body =
        route("M52 20 H80") +
        base +
        stem(52) +
        `<rect x="${x}" y="19" width="${width}" height="2" fill="white"/>`;
      const g = await openSheet(page, svg(body));
      const findings = physicalFindings(g);
      expect(findings, `width=${width} phase=${i} x=${x}`).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        kind: "endpoint-unpainted-to-physical-terminal",
        end: "source",
        deviceUid: "d",
        terminal: "T",
      });
    }
  },
);

it("rejects 0.008 mm erasures at all 12 phases on a 40 mm lead (rect and thin stroke)", async () => {
  for (let i = 0; i < 12; i++) {
    const x = (54 + i * 0.0025).toFixed(4);
    const rectBody =
      route("M74 20 H80") +
      base +
      stem(74) +
      `<rect x="${x}" y="19" width="0.008" height="2" fill="white"/>`;
    const gRect = await openSheet(page, svg(rectBody));
    expect(physicalFindings(gRect), `40mm rect phase=${i}`).toHaveLength(1);

    const strokeBody =
      route("M74 20 H80") +
      base +
      stem(74) +
      `<path d="M${x} 19 V21" fill="none" stroke="white" stroke-width="0.008"/>`;
    const gStroke = await openSheet(page, svg(strokeBody));
    expect(physicalFindings(gStroke), `40mm stroke phase=${i}`).toHaveLength(1);
  }
});

it("passes legitimate continuous 18 mm and 40 mm attachment leads", async () => {
  for (const body of [
    route("M52 20 H80") + base + stem(52),
    route("M74 20 H80") + base + stem(74),
    `<g transform="translate(80 -20) rotate(90)">${route("M74 20 H80") + base + stem(74)}</g>`,
    route("M52 20 H80") +
      base +
      stem(52) +
      '<rect x="42" y="19.8" width="0.1" height="0.15" fill="white"/>',
  ]) {
    const g = await openSheet(page, svg(body));
    expect(doubleLandings(g, ir)).toEqual([]);
  }
});

it("uses one consistent area-based marker visibility across N14, physical-landing and peer-terminal audits", async () => {
  const peerIr = { ...ir, functions: [], internalRelations: [] };
  const sheet = (n) => ({ number: n, view: { kind: "wiring" } });
  const zoneSvg = (inner) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="70mm" viewBox="0 0 100 70"><rect class="zone-grid" x="0" y="0" width="100" height="70" fill="none"/><text class="zone-label" x="50" y="3">1</text><text class="zone-label" x="3" y="35">A</text><g data-circuit-group="g">${inner}</g></svg>`;
  const filledDot =
    route("M34 20 H80", "a") +
    terminal("d", "a", 34, 20, "#17212b", ".25") +
    terminal("e", "b", 80, 20);
  const gOver = await openSheet(
    page,
    zoneSvg(
      filledDot +
        '<circle cx="34" cy="20" r=".65" fill="none" stroke="white" stroke-width=".35"/>',
    ),
  );
  const mOver = gOver.tranche4.markers.find((m) => m.deviceUid === "d");
  expect(mOver.filled).toBe(true);
  expect(mOver.painted).toBe(true);
  expect(junctionRayAudit(gOver, peerIr).findings).toHaveLength(1);

  const gErased = await openSheet(
    page,
    zoneSvg(
      filledDot + '<rect x="33" y="19" width="2" height="2" fill="white"/>',
    ),
  );
  const mErased = gErased.tranche4.markers.find((m) => m.deviceUid === "d");
  expect(mErased.filled).toBe(false);
  expect(mErased.painted).toBe(false);
  expect(junctionRayAudit(gErased, peerIr).findings).toEqual([]);
  expect(physicalFindings(gErased)).toContainEqual(
    expect.objectContaining({ reason: "missing-painted-physical-terminal" }),
  );
  const peerObs = terminalPeerObligations(
    { sheets: [sheet(1), sheet(2)] },
    [gErased, gOver],
    peerIr,
    [],
  );
  expect(peerObs).toEqual([]);
});
