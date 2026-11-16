import { expect, it } from "vitest";
import type { DocumentDependency } from "../src/packet/document-types.js";
import type { RenderedSheet } from "../src/packet/types.js";
import { placeDocumentCaption } from "../src/packet/document-caption-place.js";
import { documentCaptionInk } from "../src/packet/document-caption-ink.js";
import { createTerminalIr } from "../../query/test/fixtures.js";
import { renderSchematicPacket } from "../src/sheets.js";
import { offViewFixture, parseSvg } from "./off-view-fixtures.js";

const ir = createTerminalIr([
  { uid: "caption-owner", designation: "X1", terminalKeys: ["1"] },
]);
const field = { x: 0, y: 0, w: 200, h: 200 };
const need = (): DocumentDependency => ({
  id: "native-need",
  noteId: "terminal-incidence",
  need: "conductor-incidence",
  requiredFacts: [
    {
      kind: "conductor-incidence",
      element: { kind: "wire", uid: "wire-1" },
      end: 0,
      terminal: { deviceUid: "caption-owner", terminalKey: "1" },
    },
  ],
  requiredColumns: ["identity", "endpoints", "status"],
  subject: "X1.1",
  count: 1,
  owner: { viewKey: "view-1", noteId: "terminal-incidence", sheet: 1 },
  snapshotDigest: "source",
  presentationDigest: "presentation",
  revision: "A",
  resolution: [],
});
function sheet(obstacles = ""): RenderedSheet {
  return {
    number: 1,
    view: { format: "documentation-view/0.1", kind: "wiring", title: "Owner" },
    references: [],
    continuations: [],
    svg: `<svg width="200mm" height="200mm" viewBox="0 0 200 200">${obstacles}<g data-navigation-view="view-1" data-device-uid="caption-owner"><rect x="150" y="150" width="20" height="20" fill="white" stroke="black"/><circle data-terminal-key="1" cx="160" cy="150" r=".7" fill="white" stroke="black"/></g></svg>`,
  };
}

it("chooses a fitting local slot instead of a remote margin and retains the need", () => {
  const dependency = need();
  const placed = placeDocumentCaption(
    ir,
    dependency,
    [],
    field,
    sheet(
      '<g data-device-uid="foreign"><rect x="20" y="20" width="20" height="20" fill="white" stroke="black"/><text x="20" y="30" font-size="2.5">X1.1</text></g>',
    ),
    [],
    true,
  );
  const box = placed.slot.allocatedMm?.rect;
  if (!box) throw Error("Missing caption slot");
  expect(
    Math.hypot(
      Math.max(box.x - 160, 160 - box.x - box.w, 0),
      Math.max(box.y - 150, 150 - box.y - box.h, 0),
    ),
  ).toBeLessThanOrEqual(60);
  const ink = documentCaptionInk(dependency, placed.slot, {
    form: placed.form,
  });
  expect(ink).toContain('data-document-dependency="native-need"');
  expect(ink).toContain("X1.1");
  expect(dependency.requiredFacts).toHaveLength(1);
  expect(dependency.caption?.locality).toMatchObject({
    deviceUid: "caption-owner",
    terminalKey: "1",
    mode: "local",
    anchorMm: { x: 160, y: 150 },
  });
  expect(dependency.caption?.locality?.distanceMm).toBeLessThanOrEqual(60);
});

it("supports a remote caption with a clear nonconductive leader", () => {
  const dependency = need();
  const obstacles =
    '<rect x="0" y="25" width="159" height="175" fill="black"/><rect x="161" y="25" width="39" height="175" fill="black"/><rect x="0" y="171" width="200" height="29" fill="black"/>';
  const placed = placeDocumentCaption(
    ir,
    dependency,
    [],
    field,
    sheet(obstacles),
    [],
    true,
  );
  const ink = documentCaptionInk(dependency, placed.slot, {
    form: placed.form,
  });
  expect(ink).toContain('data-document-caption-leader="native-need"');
  expect(ink).toContain("X1.1");
  expect(placed.slot.leader?.to.x).toBeCloseTo(160, 6);
  expect(placed.slot.leader?.to.y).toBeCloseTo(148, 6);
});

it("prints a caption for every native need after locality placement", async () => {
  const source = await offViewFixture();
  try {
    const result = await renderSchematicPacket(source.ir, {
      format: "schematic-packet-request/0.1",
      views: [
        {
          format: "wiring-view-request/0.1",
          title: "Local captions",
          conductors: ["W1"],
        },
      ],
    });
    if (!result.ok) throw Error(JSON.stringify(result.error));
    const dependencies = result.value.navigation.dependencies ?? [];
    expect(dependencies.map((d) => d.need).sort()).toEqual([
      "conductor-incidence",
      "terminal-inventory",
      "terminal-inventory",
    ]);
    for (const dependency of dependencies) {
      const owner = result.value.sheets.find(
        (s) => s.number === dependency.owner.sheet,
      );
      const captions = [
        ...parseSvg(owner?.svg ?? "").querySelectorAll(
          "[data-document-dependency]",
        ),
      ];
      expect(
        captions.filter(
          (c) => c.getAttribute("data-document-dependency") === dependency.id,
        ),
      ).toHaveLength(1);
      expect(dependency.requiredFacts.length).toBeGreaterThan(0);
      expect(dependency.resolution.length).toBeGreaterThan(0);
      if (dependency.need === "conductor-incidence") {
        const fact = dependency.requiredFacts[0];
        if (fact?.kind !== "conductor-incidence")
          throw Error("Missing native incidence");
        expect(dependency.caption?.locality).toMatchObject({
          deviceUid: fact.terminal.deviceUid,
          terminalKey: fact.terminal.terminalKey,
        });
      }
    }
  } finally {
    await source.dispose();
  }
});
