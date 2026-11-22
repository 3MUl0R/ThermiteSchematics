import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { compileProject } from "@thermite/compiler";
import { renderSchematicPacket } from "../src/sheets.js";

it("places Murr 28501 FIXED1 and FIXED2 captions unambiguously on their own jumpers away from W6/W4", async () => {
  const compiled = await compileProject("libraries/murr-pilot/examples/28501");
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const request = JSON.parse(
    await readFile(
      "libraries/murr-pilot/examples/28501/packet.request.json",
      "utf8",
    ),
  );
  const packet = await renderSchematicPacket(
    compiled.ir,
    request,
    compiled.presentation,
  );
  if (!packet.ok) throw Error(packet.error.message);
  const doc = parseHTML(packet.value.sheets[0]!.svg).document;
  for (const [jumperName, wireName] of [
    ["FIXED1", "W6"],
    ["FIXED2", "W4"],
  ] as const) {
    const jumper = compiled.ir.jumpers.find((j) => j.designation === jumperName)!;
    const wire = compiled.ir.wires.find((w) => w.designation === wireName)!;
    const labelRect = doc
      .querySelector(`[data-wire-label="${jumper.uid}"] > rect`)!;
    const labelTop = Number(labelRect.getAttribute("y"));
    const wirePath = doc
      .querySelector(`[data-circuit-conductor="${wire.uid}"] > path`)!
      .getAttribute("d")!;
    const wireY = Number(wirePath.match(/^M [\d.]+ ([\d.]+)/u)![1]);
    // Must sit well below the horizontal incoming wire (W6/W4), never tucked
    // 0.6 mm underneath its junction.
    expect(labelTop - wireY).toBeGreaterThanOrEqual(2.0);
  }
});
