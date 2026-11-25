import { afterAll, beforeAll, expect, it } from "vitest";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import { doubleLandings } from "./checks.mjs";
import { readReportSummary } from "./report-summary.mjs";
import { EVALS_VERSION } from "./version.mjs";

let browser, page;
beforeAll(async () => {
  browser = await launch();
  page = await (await browser.newContext(drawingContextOptions)).newPage();
});
afterAll(async () => {
  await browser?.close();
});

const svg = (body, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="70mm" viewBox="0 0 100 70"><g data-circuit-group="g">${body}</g>${extra}</svg>`;

const terminal = (d, p, x, y, key = "T") =>
  `<g data-device-uid="${d}"><g data-layout-port="${p}" data-terminal-id='["${d}","${key}"]'><circle data-terminal-marker="true" cx="${x}" cy="${y}" r=".65" fill="white" stroke="#17212b" stroke-width=".3"/></g></g>`;

const alias = (x, y, port = "a-circuit-landing-positive", d = "d", key = "T") =>
  `<g data-device-uid="${d}"><circle data-layout-port="${port}" data-circuit-landing-for="a" data-terminal-key="${key}" cx="${x}" cy="${y}" r=".001" fill="none" stroke="none"/></g>`;

const route = (
  d,
  src = "a-circuit-landing-positive",
  extra = "",
  uid = "w",
  ends = [
    { deviceUid: "d", terminalKey: "T" },
    { deviceUid: "e", terminalKey: "T" },
  ],
) =>
  `<g data-circuit-conductor="${uid}" data-layout-source-port="${src}" data-layout-target-port="b" data-endpoints='${JSON.stringify(ends)}'><path d="${d}" fill="none" stroke="#17212b" stroke-width=".32" ${extra}/></g>`;

const stem = (
  x,
  extra = "",
  d = `M34 20 H${x}`,
  port = "a-circuit-landing-positive",
  dev = "d",
  key = "T",
) =>
  `<g data-device-uid="${dev}"><g data-layout-port="${port}" data-terminal-attachment='["${dev}","${key}"]' data-attachment-to='{"x":${x},"y":20}'><path d="${d}" fill="none" stroke="#17212b" stroke-width=".32" ${extra}/></g></g>`;

const base = terminal("d", "a", 34, 20) + terminal("e", "b", 80, 20);
const baseIr = {
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

const physicalFindings = (g, ir = baseIr) =>
  doubleLandings(g, ir).filter(
    (f) => f.kind === "endpoint-unpainted-to-physical-terminal",
  );

it("protocol 5.49 retains 5.48 summary readability", () => {
  expect(EVALS_VERSION).toBe("5.49");
  const sample = { evalsVersion: "5.48", summary: { "DQ-14": { pass: 1 } } };
  expect(readReportSummary(sample)).toEqual(sample.summary);
});

it.each([
  [
    "valid ±0.625 mm offset landing",
    route("M34 20.625 H50 V20 H80") + base + alias(34, 20.625),
  ],
  ["continuous attachment lead", route("M50 20 H80") + base + stem(50)],
  [
    "legitimate phase-dependent dashed conductor",
    route(
      "M34 20 H80",
      "a-circuit-landing-positive",
      'stroke-dasharray="1 2" stroke-dashoffset="1"',
    ) +
      base +
      alias(34, 20),
  ],
])("passes valid physical landing: %s", async (_name, body) => {
  const g = await openSheet(page, svg(body));
  expect(doubleLandings(g, baseIr)).toEqual([]);
});

it.each([
  [
    "alias near bounding-box corner outside circle",
    route("M34.65 20.69 H50 V20 H80") + base + alias(34.65, 20.69),
  ],
  [
    "corner well outside circle",
    route("M34.79 20.79 H50 V20 H80") + base + alias(34.79, 20.79),
  ],
  [
    "attachment lead approaching non-contacting corner",
    route("M50 20.69 H60 V20 H80") +
      base +
      stem(50, "", "M34.65 20.69 H50", "lead") +
      alias(50, 20.69),
  ],
  [
    "alias at short stem (0.02 mm route-to-stem gap)",
    route("M50 20 H80") +
      base +
      stem(49.98, "", "M34 20 H49.98", "lead") +
      alias(50, 20),
  ],
  [
    "route with 0.15 mm white space after valid attachment lead",
    route("M50 20 H80") +
      base +
      stem(50) +
      '<rect x="50" y="19" width=".15" height="2" fill="white"/>',
  ],
  [
    "completely overpainted physical marker before route",
    base +
      '<rect x="33" y="19" width="2" height="2" fill="white"/>' +
      route("M34 20 H80") +
      alias(34, 20),
  ],
  [
    "gap 0.2 mm before marker ink",
    route("M34 20 H80") +
      base +
      alias(34, 20) +
      '<rect x="34.7" y="19" width=".3" height="2" fill="white"/>',
  ],
  [
    "gap >0.25 mm before marker ink",
    route("M34 20 H80") +
      base +
      alias(34, 20) +
      '<rect x="34.7" y="19" width=".9" height="2" fill="white"/>',
  ],
  [
    "stem starts 0.2 mm short of marker",
    route("M50 20 H80") + base + stem(50, "", "M34.85 20 H50"),
  ],
  [
    "dashed attachment lead",
    route("M50 20 H80") + base + stem(50, 'stroke-dasharray="1 1"'),
  ],
  [
    "solid attachment lead erased before marker",
    route("M50 20 H80") +
      base +
      stem(50) +
      '<rect x="34.7" y="19" width=".3" height="2" fill="white"/>',
  ],
  [
    "orphan stem without physical terminal marker",
    route("M50 20 H80") + terminal("e", "b", 80, 20) + stem(50),
  ],
])("rejects disconnected landing mutant: %s", async (_name, body) => {
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

const wireIr = (wires) => ({
  devices: [...new Set(wires.flatMap((w) => [w[1][0], w[2][0]]))].map(
    (uid) => ({ uid, designation: uid }),
  ),
  terminals: [
    ...new Map(
      wires
        .flatMap((w) => [w[1], w[2]])
        .map(([d, t]) => [
          `${d}:${t}`,
          { id: { deviceUid: d, terminalKey: t } },
        ]),
    ).values(),
  ],
  wires: wires.map(([uid, a, b]) => ({
    uid,
    designation: uid,
    endpoints: [
      { terminal: { deviceUid: a[0], terminalKey: a[1] } },
      { terminal: { deviceUid: b[0], terminalKey: b[1] } },
    ],
  })),
  jumpers: [],
  cables: [],
  cableConductors: [],
});

const taggedRoute = (d, src, tgt, uid, toDev, toKey) =>
  route(d, src, "", uid, [
    { deviceUid: "PS1", terminalKey: "+" },
    { deviceUid: toDev, terminalKey: toKey },
  ]).replace('data-layout-target-port="b"', `data-layout-target-port="${tgt}"`);

it("catches rejected cc0efffc P07 18 mm tag-lane displaced-alias witnesses", async () => {
  const ir = wireIr([
    ["W101", ["PS1", "+"], ["S1", "13"]],
    ["W103", ["PS1", "+"], ["S2", "11"]],
    ["W105", ["PS1", "+"], ["LS1", "13"]],
  ]);
  const body =
    terminal("PS1", "p0", 54, 40, "+") +
    stem(72, "", "M54 40 H72", "p0", "PS1", "+") +
    terminal("S1", "s1", 92, 20, "13") +
    terminal("S2", "s2", 92, 40, "11") +
    terminal("LS1", "ls1", 92, 60, "13") +
    alias(72, 39.375, "p0-circuit-landing-negative", "PS1", "+") +
    alias(72, 40.625, "p0-circuit-landing-positive", "PS1", "+") +
    taggedRoute(
      "M72 39.375 H76 V20 H92",
      "p0-circuit-landing-negative",
      "s1",
      "W101",
      "S1",
      "13",
    ) +
    taggedRoute("M72 40 H92", "p0", "s2", "W103", "S2", "11") +
    taggedRoute(
      "M72 40.625 H76 V60 H92",
      "p0-circuit-landing-positive",
      "ls1",
      "W105",
      "LS1",
      "13",
    );
  const g = await openSheet(page, svg(body));
  expect(
    physicalFindings(g, ir)
      .map((f) => f.designation)
      .sort(),
  ).toEqual(["W101", "W105"]);
});

it("catches rejected cc0efffc Conveyor 18 mm tag-lane displaced-alias witnesses", async () => {
  const ir = wireIr([
    ["W-CTL-010", ["PS1", "+"], ["S1", "13"]],
    ["W-CTL-012", ["PS1", "+"], ["S2", "11"]],
  ]);
  const body =
    terminal("PS1", "p0", 54, 40, "+") +
    stem(72, "", "M54 40 H72", "p0", "PS1", "+") +
    terminal("S1", "s1", 92, 20, "13") +
    terminal("S2", "s2", 92, 40, "11") +
    alias(72, 39.375, "p0-circuit-landing-negative", "PS1", "+") +
    alias(72, 40.625, "p0-circuit-landing-positive", "PS1", "+") +
    taggedRoute(
      "M72 39.375 H76 V20 H92",
      "p0-circuit-landing-negative",
      "s1",
      "W-CTL-010",
      "S1",
      "13",
    ) +
    taggedRoute(
      "M72 40.625 H76 V40 H92",
      "p0-circuit-landing-positive",
      "s2",
      "W-CTL-012",
      "S2",
      "11",
    );
  const g = await openSheet(page, svg(body));
  expect(
    physicalFindings(g, ir)
      .map((f) => f.designation)
      .sort(),
  ).toEqual(["W-CTL-010", "W-CTL-012"]);
});

it("rejects forged native IR ownership even when painted ink touches a real marker", async () => {
  const forgedTerminalIr = {
    ...baseIr,
    wires: [
      {
        uid: "w",
        designation: "W1",
        endpoints: [
          { terminal: { deviceUid: "d", terminalKey: "REAL" } },
          { terminal: { deviceUid: "e", terminalKey: "T" } },
        ],
      },
    ],
  };
  const g = await openSheet(page, svg(route("M34 20 H80", "a") + base));
  expect(physicalFindings(g, forgedTerminalIr)).toContainEqual(
    expect.objectContaining({
      kind: "endpoint-unpainted-to-physical-terminal",
      end: "source",
      deviceUid: "d",
      terminal: "T",
    }),
  );

  const unknownConductorIr = { ...baseIr, wires: [] };
  expect(physicalFindings(g, unknownConductorIr).length).toBeGreaterThanOrEqual(
    1,
  );
});

it("enforces appearance-scope and circuit-group isolation for markers and leads", async () => {
  // Foreign circuit group holds the painted marker at the exact same coordinates
  const crossGroupSvg = svg(
    base +
      '<rect x="33" y="19" width="2" height="2" fill="white"/>' +
      route("M34 20 H80") +
      alias(34, 20),
    `<g data-circuit-group="other">${terminal("d", "a", 34, 20)}</g>`,
  );
  const gGroup = await openSheet(page, crossGroupSvg);
  expect(physicalFindings(gGroup)).toContainEqual(
    expect.objectContaining({
      kind: "endpoint-unpainted-to-physical-terminal",
      end: "source",
    }),
  );

  // Foreign nested <svg> holds the painted marker at the exact same coordinates
  const crossSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="70mm" viewBox="0 0 100 70"><svg width="100" height="70" viewBox="0 0 100 70"><g data-circuit-group="g">${base}<rect x="33" y="19" width="2" height="2" fill="white"/>${route("M34 20 H80")}${alias(34, 20)}</g></svg><svg width="100" height="70" viewBox="0 0 100 70"><g data-circuit-group="g">${terminal("d", "a", 34, 20)}</g></svg></svg>`;
  const gScope = await openSheet(page, crossSvg);
  expect(physicalFindings(gScope)).toContainEqual(
    expect.objectContaining({
      kind: "endpoint-unpainted-to-physical-terminal",
      end: "source",
    }),
  );
});

it("rejects occluded predicted dash and does not borrow from another appearance of the same conductor", async () => {
  // First predicted dash after exiting circle (r=0.65) for dasharray="1 2" dashoffset="1" is x in [36, 37].
  const occludedDashSvg = svg(
    route(
      "M34 20 H80",
      "a-circuit-landing-positive",
      'stroke-dasharray="1 2" stroke-dashoffset="1"',
    ) +
      base +
      alias(34, 20) +
      '<rect x="35.8" y="19" width="1.4" height="2" fill="white"/>',
    // Unrelated valid appearance of the exact same conductor in another circuit group must NOT rescue it
    `<g data-circuit-group="other" transform="translate(0 25)">${route(
      "M34 20 H80",
      "a-circuit-landing-positive",
      'stroke-dasharray="1 2" stroke-dashoffset="1"',
    )}${base}${alias(34, 20)}</g>`,
  );
  const g = await openSheet(page, occludedDashSvg);
  const findings = physicalFindings(g);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    kind: "endpoint-unpainted-to-physical-terminal",
    end: "source",
    deviceUid: "d",
    terminal: "T",
  });
});
