import { afterAll, beforeAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { NavigationSlotFailure } from "../../packages/render/dist/packet/navigation-slots.js";
import { navigationGeometry } from "../../packages/render/dist/packet/navigation-walk.js";
import { emitPeerReferences } from "../../packages/render/dist/packet/peer-reference-ink.js";
import { peerRouteIndex } from "../../packages/render/dist/packet/peer-route-ink.js";
import { printableTextMetrics } from "../../packages/render/dist/text-metrics.js";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { peerReferenceFindings } from "./issued-reference-audit.mjs";
import { nativeRows } from "./m3-native.mjs";
import { boxGap, foreignConductorBoxes } from "./peer-owner-ink.mjs";
import { terminalPeerObligations } from "./terminal-peer-oracle.mjs";

let browser, page;
beforeAll(async () => {
  browser = await launch();
  page = await browser.newPage(drawingContextOptions);
});
afterAll(async () => browser?.close());

it("#573 measures foreign conductor stroke edge in Chromium DQ-08 and renderer", async () => {
  const value = "W1 · A.1 → B.1 02.B2";
  const compact = "→ B.1 02.B2";
  const metric = printableTextMetrics(value, 2.5);
  const field = {
    x: 50,
    y: 50,
    w: metric.right - metric.left + 0.041,
    h: metric.top - metric.bottom + 0.041,
  };
  const owner = { x: 50, y: 46.7, w: 1.3, h: 1.3 };
  const source = ["A.1", "w1", "B.1"];
  const ownWire = { kind: "wire", uid: "w1" };
  const strokeWidth = 0.4;
  const y = +(field.y + field.h + boxGap(field, owner) + 0.52).toFixed(4);
  const baseSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200" font-family="Thermite Sans, sans-serif">` +
    `<g data-device-uid="A"><circle class="terminal-marker" data-terminal-marker="true" data-terminal-key="1" cx="50.65" cy="47.35" r=".65" fill="white" stroke="#17212b" stroke-width=".3"/></g>` +
    `<g data-circuit-conductor="w2"><path d="M40 ${y} H100" fill="none" stroke="#17212b" stroke-width="${strokeWidth}"/></g></svg>`;
  const runs = peerRouteIndex(navigationGeometry(baseSvg)).foreignRuns(ownWire);
  const sheet = {
    number: 1,
    svg: baseSvg,
    title: "Stroke edge probe",
    view: { format: "documentation-view/0.1", kind: "wiring" },
    continuations: [],
  };
  const entry = {
    kind: "conductor-peer",
    identity: source,
    owner,
    foreignOwners: runs,
    value,
    compact,
    destination: "02.B2",
    ownerLabel: "A.1",
  };
  // Renderer rejects the 0.32 mm stroke-edge margin slot.
  expect(() => emitPeerReferences(sheet, field, [entry])).toThrow(
    NavigationSlotFailure,
  );

  // Manually placing the note at the old centerline-passing slot must now be flagged by DQ-08.
  const oldNote = `<text data-peer-reference="conductor-peer" data-peer-source='${JSON.stringify(source)}' x="${field.x + 0.02 - metric.left}" y="${field.y + 0.02 + metric.top}" font-size="2.5">${value}</text>`;
  const svgWithOldNote = baseSvg.replace("</svg>", `${oldNote}</svg>`);
  const g = await openSheet(page, embedPrintableFont(svgWithOldNote));
  const observedOwner = g.tranche4.markers.find(
    (m) => m.deviceUid === "A",
  ).bbox;
  const observedForeign = foreignConductorBoxes(g, ownWire);
  expect(observedForeign).toHaveLength(1);
  expect(observedForeign[0].h).toBeCloseTo(strokeWidth, 2);
  const obligation = {
    kind: "conductor-peer",
    source,
    owners: [observedOwner],
    foreignConductors: observedForeign,
    values: [value],
    compactValues: [compact],
    ownerLabel: "A.1",
  };
  const findings = peerReferenceFindings(1, g, [obligation]);
  expect(findings.map((f) => f.kind)).toContain(
    "issued-peer-reference-foreign-owner",
  );
}, 60_000);

it("#573 operator-console issues all 18 sheets and DQ-08 flags moving K-Y A1 note 0.5 mm toward sibling A2", async () => {
  const compiled = await compileProject("examples/operator-console");
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const req = JSON.parse(
    await readFile("examples/operator-console/packet.request.json", "utf8"),
  );
  const pkt = await renderSchematicPacket(
    compiled.ir,
    req,
    compiled.presentation,
  );
  if (!pkt.ok) throw Error(pkt.error.message);
  expect(pkt.value.sheets).toHaveLength(18);
  const geoms = [];
  for (const s of pkt.value.sheets)
    geoms.push(await openSheet(page, embedPrintableFont(s.svg)));
  const obls = terminalPeerObligations(
    pkt.value,
    geoms,
    compiled.ir,
    nativeRows(compiled.ir),
  );
  for (const [i, s] of pkt.value.sheets.entries())
    expect(
      peerReferenceFindings(
        s.number,
        geoms[i],
        obls.filter((o) => o.sheet === s.number),
      ),
    ).toEqual([]);

  // Moving sheet-5 K-Y A1 note 0.50 mm toward sibling A2 must be flagged with minimumMarginMm 0.
  const s5 = geoms[4];
  const s5Obls = obls.filter((o) => o.sheet === 5);
  const note = s5.texts.find(
    (t) =>
      t.peerReference === "terminal-interface" &&
      t.text.startsWith("K-Y · coil terminal A1"),
  );
  expect(note).toBeDefined();
  const shifted = { ...note, bbox: { ...note.bbox, y: note.bbox.y + 0.5 } };
  const mutated = {
    ...s5,
    texts: s5.texts.map((t) => (t === note ? shifted : t)),
  };
  const findings = peerReferenceFindings(5, mutated, s5Obls);
  expect(findings).toContainEqual(
    expect.objectContaining({
      kind: "issued-peer-reference-foreign-owner",
      minimumMarginMm: 0,
    }),
  );
}, 120_000);
