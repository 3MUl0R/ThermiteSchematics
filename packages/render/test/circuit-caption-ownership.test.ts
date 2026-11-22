import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { compileProject } from "@thermite/compiler";
import { renderSchematicPacket } from "../src/sheets.js";
import { besideCaption } from "../src/layout/beside-caption.js";

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
    const jumper = compiled.ir.jumpers.find(
      (j) => j.designation === jumperName,
    )!;
    const wire = compiled.ir.wires.find((w) => w.designation === wireName)!;
    const labelRect = doc.querySelector(
      `[data-wire-label="${jumper.uid}"] > rect`,
    )!;
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

it.each(["6ES7135-4FB01-0AB0", "6ES7135-4GB01-0AB0", "6ES7151-3AA23-0AB0"])(
  "places FIXED jumper captions inline on their own unshared horizontal bar on Siemens %s top-to-bottom",
  async (part) => {
    const dir = `libraries/siemens-pilot/examples/${part.toLowerCase()}`;
    const compiled = await compileProject(dir);
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    const request = JSON.parse(
      await readFile(`${dir}/packet.request.json`, "utf8"),
    );
    const packet = await renderSchematicPacket(
      compiled.ir,
      {
        ...request,
        views: request.views.map((v: Record<string, unknown>) => ({
          ...v,
          flow: "top-to-bottom",
        })),
      },
      compiled.presentation,
    );
    if (!packet.ok) throw Error(packet.error.message);
    const doc = parseHTML(packet.value.sheets[0]!.svg).document;
    for (const jumper of compiled.ir.jumpers) {
      const labelRect = doc.querySelector(
        `[data-wire-label="${jumper.uid}"] > rect`,
      )!;
      const lx = Number(labelRect.getAttribute("x"));
      const ly = Number(labelRect.getAttribute("y"));
      const lw = Number(labelRect.getAttribute("width"));
      const lh = Number(labelRect.getAttribute("height"));
      const pathD = doc
        .querySelector(`[data-circuit-conductor="${jumper.uid}"] > path`)!
        .getAttribute("d")!;
      // Jumper path: M x1 yBase L x1 yBar L x2 yBar L x2 yBase
      const nums = [...pathD.matchAll(/-?\d+(?:\.\d+)?/gu)].map(Number);
      const barY = nums[3]!;
      const barMinX = Math.min(nums[0]!, nums[4]!);
      const barMaxX = Math.max(nums[0]!, nums[4]!);
      // Caption must sit inline over the jumper's own horizontal bar, not beside
      // a vertical leg shared with an incoming wire.
      expect(barY).toBeGreaterThanOrEqual(ly);
      expect(barY).toBeLessThanOrEqual(ly + lh);
      expect(lx).toBeGreaterThanOrEqual(barMinX + 0.5);
      expect(lx + lw).toBeLessThanOrEqual(barMaxX - 0.5);
    }
  },
);

it("never admits an unleadering beside-caption when foreign ownership margin is below 0.5 mm", () => {
  const sharedVertical = [
    { x: 50, y: 0 },
    { x: 50, y: 40 },
  ];
  const ink = { left: 51.0, right: 59.0, top: 18, bottom: 20 };
  const reservation = { left: 40, right: 70, top: 10, bottom: 30 };
  const placement = besideCaption(
    ink,
    reservation,
    [sharedVertical],
    {
      foreign: [sharedVertical],
      foreignStrokes: [0.32],
      obstacles: [],
      bounds: { left: 0, right: 100, top: 0, bottom: 100 },
    },
    1,
    0.55,
    0.5,
  );
  // Shared vertical leg gives only (0.55 - 0.32) / 2 = 0.115 mm margin (< 0.5 mm),
  // so an unleadering placement must never be accepted.
  expect(placement?.needsLeader ?? true).toBe(true);
});
