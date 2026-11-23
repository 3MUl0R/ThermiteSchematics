import { expect, it } from "vitest";
import { compileProject } from "@thermite/compiler";
import { renderSchematicPacket } from "../src/sheets.js";
import { prepareSchematicDrawing } from "../src/renderer.js";
import { locationFragmentCaptions } from "../src/packet/location-fragment-captions.js";

it("records and marks the plain-name fallback on Tabloid compact TTB s01 FIELD", async () => {
  const compiled = await compileProject("examples/motor-starter");
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const packet = await renderSchematicPacket(
    compiled.ir,
    {
      format: "schematic-packet-request/0.1",
      layout: "compact",
      page: { size: "tabloid", orientation: "landscape" },
      views: [
        {
          format: "schematic-view-request/0.1",
          family: "power",
          root: { by: "designation", value: "M1" },
          flow: "top-to-bottom",
        },
        {
          format: "schematic-view-request/0.1",
          family: "control",
          root: { by: "designation", value: "K1" },
          flow: "top-to-bottom",
        },
      ],
    },
    compiled.presentation,
  );
  if (!packet.ok) throw Error(packet.error.message);
  const s1 = packet.value.sheets[0]!;
  expect(s1.locationFragmentFallbacks).toContainEqual(
    expect.objectContaining({
      locationName: "FIELD",
      kind: "plain-name",
      lines: ["FIELD"],
    }),
  );
  expect(s1.svg).toContain('data-location-name="FIELD"');
  expect(s1.svg).toContain('data-location-fragment-fallback="plain-name"');
});

it("reports a visible failure instead of silently skipping when no interior slot fits", async () => {
  const compiled = await compileProject("examples/motor-starter");
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const prepared = await prepareSchematicDrawing(
    compiled.ir,
    {
      format: "schematic-view-request/0.1",
      family: "power",
      root: { by: "designation", value: "M1" },
      flow: "top-to-bottom",
    },
    compiled.presentation,
  );
  if (!prepared.ok) throw Error(prepared.error.message);
  const fieldGroup = prepared.value.graph.locationGroups.find(
    (g) => g.label.text === "FIELD",
  );
  if (!fieldGroup) throw Error("Missing FIELD location group");
  const fieldBox = prepared.value.layout.nodes.find(
    (n) => n.id === fieldGroup.id,
  );
  if (!fieldBox) throw Error("Missing FIELD layout box");
  const motorNode = prepared.value.layout.nodes.find(
    (n) =>
      n.kind === "symbol" &&
      n.x >= fieldBox.x &&
      n.x + n.width <= fieldBox.x + fieldBox.width,
  );
  if (!motorNode) throw Error("Missing motor symbol in FIELD");
  // Clip tightly around the motor symbol so no clear interior caption slot exists.
  const tightViewport = {
    x: motorNode.x,
    y: motorNode.y,
    w: motorNode.width,
    h: motorNode.height,
  };
  const result = locationFragmentCaptions(
    prepared.value,
    [fieldGroup],
    tightViewport,
    { x: 28, y: 47, w: 100, h: 100 },
    0.25,
    [],
  );
  expect(result.svg).toBe("");
  expect(result.failure).toContain("FIELD");
  expect(result.failure).toContain("no clear interior slot");
});
