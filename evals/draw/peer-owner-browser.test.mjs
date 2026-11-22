import { afterAll, beforeAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { DOMParser } from "linkedom";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { conveyorRequest } from "../../packages/render/test/packet-navigation-review-fixture.ts";
import {
  dolPackets,
  dolProbeFixture,
} from "../../packages/render/test/dol-control-probes-fixture.ts";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { peerReferenceFindings } from "./issued-reference-audit.mjs";
import { terminalPeerObligations } from "./terminal-peer-oracle.mjs";
import { nativeRows } from "./m3-native.mjs";

let browser, page, input;
beforeAll(async () => {
  input = await compileProject("examples/conveyor-line");
  if (!input.ok) throw Error(JSON.stringify(input.diagnostics));
  // Accurate Canvas bounds for small-font clearance checks (crbug.com/479240778).
  browser = await launch([
    "--enable-blink-features=CanvasTextMetricsPreciseBounds",
  ]);
  page = await browser.newPage(drawingContextOptions);
});
afterAll(async () => browser?.close());

const measure = (svg) => openSheet(page, embedPrintableFont(svg));

function stripCardDestination(svg, wireUid) {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const card = [...document.querySelectorAll("g.off-view-annotation")].find(
    (e) => (e.getAttribute("data-off-view-conductors") ?? "").includes(wireUid),
  );
  if (!card) throw Error("Missing off-view card for wire");
  for (const row of card.querySelectorAll("text.off-view-row"))
    row.textContent = row.textContent.replace(/\s*\d{2,}\.[A-D][1-6].*$/u, "");
  return document.toString();
}

async function assertRemovedRouteNeedsPeer(packet, geometries, first) {
  const complete = input.ir.wires.find(
    (w) => w.designation === "W-PWR-002",
  ).uid;
  expect(
    first.texts.some(
      (t) =>
        t.peerReference === "conductor-peer" &&
        JSON.parse(t.peerSource)[1].uid === complete,
    ),
  ).toBe(false);
  const withoutRoute = packet.sheets[0].svg.replace(
    new RegExp(`<path(?=[^>]*data-wire-uid="${complete}")[^>]*\/>`, "gu"),
    "",
  );
  expect(withoutRoute).not.toBe(packet.sheets[0].svg);
  const ink = await measure(withoutRoute);
  const next = terminalPeerObligations(
    packet,
    [ink, ...geometries.slice(1)],
    input.ir,
    nativeRows(input.ir),
  );
  expect(next.some((o) => o.sheet === 1 && o.source[1]?.uid === complete)).toBe(
    true,
  );
}

it.each([
  ["letter", "standard"],
  ["a4", "standard"],
  ["a4", "compact"],
])(
  "measures card-owned destinations and owner proximity in %s portrait %s",
  async (size, layout) => {
    const packet = await renderSchematicPacket(
      input.ir,
      { ...conveyorRequest(), layout, page: { size, orientation: "portrait" } },
      input.presentation,
    );
    if (!packet.ok) throw Error(packet.error.message);
    const geometries = [];
    for (const sheet of packet.value.sheets)
      geometries.push(await measure(sheet.svg));
    const obligations = terminalPeerObligations(
      packet.value,
      geometries,
      input.ir,
      nativeRows(input.ir),
    );
    const [first] = geometries;
    const expected = obligations.filter((o) => o.sheet === 1);
    expect(peerReferenceFindings(1, first, expected)).toEqual([]);
    const uid = input.ir.wires.find((w) => w.designation === "W-PWR-009").uid;
    const owner = input.ir.devices.find((d) => d.designation === "SRC1").uid;
    expect(
      expected.find(
        (o) =>
          o.kind === "conductor-peer" &&
          o.source[0]?.deviceUid === owner &&
          o.source[1]?.uid === uid,
      )?.card,
    ).toBeDefined();
    expect(
      first.texts.some(
        (t) =>
          t.peerReference === "conductor-peer" &&
          JSON.parse(t.peerSource)[1]?.uid === uid,
      ),
    ).toBe(false);
    if (size === "letter")
      await assertRemovedRouteNeedsPeer(packet.value, geometries, first);
    const stripped = await measure(
      stripCardDestination(packet.value.sheets[0].svg, uid),
    );
    const strippedObligations = terminalPeerObligations(
      packet.value,
      [stripped, ...geometries.slice(1)],
      input.ir,
      nativeRows(input.ir),
    ).filter((o) => o.sheet === 1);
    expect(
      peerReferenceFindings(1, stripped, strippedObligations),
    ).toContainEqual(
      expect.objectContaining({ kind: "issued-peer-reference-missing" }),
    );
  },
  120_000,
);

it("audits DOL P6 TTB s05 W37 at S2.14 in Chromium", async () => {
  const dol = await dolProbeFixture("p6");
  try {
    const pkt = await renderSchematicPacket(
      dol.ir,
      dolPackets("p6", "top-to-bottom").combined,
    );
    if (!pkt.ok) throw Error(pkt.error.message);
    const geoms = [];
    for (const s of pkt.value.sheets) geoms.push(await measure(s.svg));
    const obls = terminalPeerObligations(
      pkt.value,
      geoms,
      dol.ir,
      nativeRows(dol.ir),
    );
    const s2 = dol.ir.devices.find((d) => d.designation === "S2");
    const w37 = dol.ir.wires.find((w) => w.designation === "W37");
    const s5Obls = obls.filter((o) => o.sheet === 5);
    expect(
      s5Obls.some(
        (o) =>
          o.source[0]?.deviceUid === s2.uid && o.source[1]?.uid === w37.uid,
      ),
    ).toBe(true);
    expect(peerReferenceFindings(5, geoms[4], s5Obls)).toEqual([]);
    // Every peer note on DOL P6 TTB s05 must maintain >= 1.5 mm vertical clearance from overlapping text.
    const paintedTexts = geoms[4].texts.filter(
      (t) => t.painted !== false && t.bbox?.w > 0 && t.bbox?.h > 0,
    );
    const peerTexts = paintedTexts.filter((t) => t.peerReference);
    expect(peerTexts.length).toBeGreaterThanOrEqual(2);
    for (const p of peerTexts) {
      for (const other of paintedTexts) {
        if (other === p || (other.peerGroup && other.peerGroup === p.peerGroup))
          continue;
        const a = p.bbox,
          b = other.bbox;
        if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) <= 0) continue;
        const gap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
        expect(
          gap,
          `vertical clearance between ${JSON.stringify(p.text)} (${JSON.stringify(a)}) and ${JSON.stringify(other.text)} (${JSON.stringify(b)})`,
        ).toBeGreaterThanOrEqual(1.5 - 1e-6);
      }
    }
    // Removing the S2.14 W37 peer note (leaving only the generic repeat pointer) must fail.
    const doc = new DOMParser().parseFromString(
      pkt.value.sheets[4].svg,
      "image/svg+xml",
    );
    for (const el of doc.querySelectorAll(
      '[data-peer-reference="conductor-peer"]',
    )) {
      const src = JSON.parse(el.getAttribute("data-peer-source") ?? "[]");
      if (src[0]?.deviceUid === s2.uid && src[1]?.uid === w37.uid) el.remove();
    }
    const erasedS5 = await measure(doc.toString());
    expect(
      peerReferenceFindings(5, erasedS5, s5Obls).map((f) => f.kind),
    ).toContain("issued-peer-reference-missing");
  } finally {
    await dol.dispose();
  }
}, 120_000);

it("audits repeated motor-starter CBL1 views in Chromium without destination loss", async () => {
  const ms = await compileProject("examples/motor-starter");
  if (!ms.ok) throw Error(JSON.stringify(ms.diagnostics));
  const baseReq = JSON.parse(
    await readFile("examples/alpha/motor-starter.packet.json", "utf8"),
  );
  const repPkt = await renderSchematicPacket(
    ms.ir,
    { ...baseReq, views: [...baseReq.views, baseReq.views.at(-1)] },
    ms.presentation,
  );
  if (!repPkt.ok) throw Error(repPkt.error.message);
  const repGeoms = [];
  for (const s of repPkt.value.sheets) repGeoms.push(await measure(s.svg));
  const repObls = terminalPeerObligations(
    repPkt.value,
    repGeoms,
    ms.ir,
    nativeRows(ms.ir),
  );
  for (const [i, s] of repPkt.value.sheets.entries())
    expect(
      peerReferenceFindings(
        s.number,
        repGeoms[i],
        repObls.filter((o) => o.sheet === s.number),
      ),
    ).toEqual([]);
}, 120_000);
