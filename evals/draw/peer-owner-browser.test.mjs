import { afterAll, beforeAll, expect, it } from "vitest";
import { DOMParser } from "linkedom";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { conveyorRequest } from "../../packages/render/test/packet-navigation-review-fixture.ts";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { peerReferenceFindings } from "./issued-reference-audit.mjs";
import { terminalPeerObligations } from "./terminal-peer-oracle.mjs";
import { nativeRows } from "./m3-native.mjs";

let browser, page, input;
beforeAll(async () => {
  input = await compileProject("examples/conveyor-line");
  if (!input.ok) throw Error(JSON.stringify(input.diagnostics));
  browser = await launch();
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
