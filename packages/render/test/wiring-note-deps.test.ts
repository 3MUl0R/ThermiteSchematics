import { expect, it } from "vitest";
import { renderSchematicPacket } from "../src/sheets.js";
import { prepareWiringDrawing } from "../src/wiring.js";
import { offViewFixture, parseSvg } from "./off-view-fixtures.js";
import { compileProject } from "@thermite/compiler";
import { resolve } from "node:path";

const textsOf = (svg: string) =>
  [...parseSvg(svg).querySelectorAll("text")].map((t) => t.textContent ?? "");

it("omits the [+N] wiring legend when every drawn terminal has zero hidden physical connections", async () => {
  // Positive control: wiring view with zero [+N] markers on sheet (e.g. operator-console s4).
  const compiled = await compileProject(resolve("examples/operator-console"));
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const bonding = {
    format: "wiring-view-request/0.1" as const,
    title: "Console protective bonding",
    conductors: ["W-PE01", "W-PE02", "W-PE03"],
    deviceOrder: ["PE-MC", "PE-HMI", "FRAME-HMI", "HMI1"],
  };
  const drawing = await prepareWiringDrawing(compiled.ir, bonding);
  expect(drawing.note).toBe("Terminal wiring: device internals are not shown.");
  expect(drawing.note).not.toContain("[ +N ]");
  expect(drawing.note).not.toContain("see wire schedule");

  const packet = await renderSchematicPacket(compiled.ir, {
    format: "schematic-packet-request/0.1",
    views: [bonding],
  });
  if (!packet.ok) throw Error(JSON.stringify(packet.error));
  const texts = textsOf(packet.value.sheets[0]!.svg);
  expect(texts).toContain("Terminal wiring: device internals are not shown.");
  expect(texts.some((t) => t.includes("[ +N ]"))).toBe(false);
  expect(texts.some((t) => /see wire schedule/i.test(t))).toBe(false);
  // Neighbouring omitted-terminal caption must remain intact.
  expect(texts.some((t) => /4 other terminals:/.test(t))).toBe(true);
});

it("keeps the [+N] wiring legend and wire-inventory captions when hidden physical connections exist", async () => {
  // Negative control: wiring view with hidden physical connections at drawn terminals.
  const source = await offViewFixture();
  try {
    const req = {
      format: "wiring-view-request/0.1" as const,
      title: "One wire",
      conductors: ["W1"],
    };
    const drawing = await prepareWiringDrawing(source.ir, req);
    expect(drawing.note).toBe(
      "Terminal wiring: device internals are not shown. [ +N ] = other physical connections at that terminal; see wire schedule.",
    );

    const packet = await renderSchematicPacket(source.ir, {
      format: "schematic-packet-request/0.1",
      views: [req],
    });
    if (!packet.ok) throw Error(JSON.stringify(packet.error));
    const texts = textsOf(packet.value.sheets[0]!.svg);
    expect(texts).toContain(
      "Terminal wiring: device internals are not shown. [ +N ] = other physical connections at that terminal.",
    );
    expect(
      texts.some((t) => /\[\+\d+\] other physical connections:/.test(t)),
    ).toBe(true);
    expect(texts.some((t) => /see wire schedule/i.test(t))).toBe(false);
  } finally {
    await source.dispose();
  }
});

it("omits [+N] legend on a wiring view drawing cable conductors with zero hidden incidences", async () => {
  // Positive control: wiring view drawing cable conductors with zero hidden incidences at their endpoints.
  const source = await offViewFixture();
  try {
    const cable = source.ir.cables[0]!;
    const req = {
      format: "wiring-view-request/0.1" as const,
      title: "Complete cable core wiring",
      conductors: [`${cable.designation}/1`],
    };
    const ir = structuredClone(source.ir);
    // Keep only CBL1/1 in IR so both endpoints have zero hidden incidences.
    const core = ir.cableConductors.find((c) => c.cableUid === cable.uid)!;
    ir.wires = [];
    ir.jumpers = [];
    ir.cables = [
      {
        ...cable,
        assignments: (cable.assignments ?? []).filter(
          (a) => a.id === core.id.conductorId,
        ),
      },
    ];
    ir.cableConductors = [core];
    const drawing = await prepareWiringDrawing(ir, req);
    expect(drawing.note).toBe(
      "Terminal wiring: device internals are not shown.",
    );
    expect(
      drawing.documentNeeds.filter((n) => n.need === "conductor-incidence"),
    ).toEqual([]);
  } finally {
    await source.dispose();
  }
});
