import { beforeAll, expect, it } from "vitest";
import { compileProject } from "@thermite/compiler";
import { parseHTML } from "linkedom";
import { renderSchematicPacket } from "../src/sheets.js";
import { continuationOracle } from "./continuation-oracle.js";
import { generatedSvgInk } from "../src/device-legend.js";

let compiled: Extract<Awaited<ReturnType<typeof compileProject>>, { ok: true }>;
beforeAll(async () => {
  const result = await compileProject("examples/motor-starter");
  if (!result.ok) throw result;
  compiled = result;
});
const note =
  "Equipment identification and maintenance access for the process cell. Verify the labelled terminal against the installation drawing before planned maintenance.";
const request = (flow: "left-to-right" | "top-to-bottom") => ({
  format: "schematic-packet-request/0.1" as const,
  layout: "compact" as const,
  page: { size: "letter" as const, orientation: "portrait" as const },
  views: [
    {
      format: "schematic-view-request/0.1" as const,
      root: { by: "designation" as const, value: "M1" },
      family: "power" as const,
      flow,
    },
    {
      format: "schematic-view-request/0.1" as const,
      root: { by: "designation" as const, value: "K1" },
      family: "control" as const,
      flow,
    },
  ],
});
const identity = (c: any) =>
  JSON.stringify([c.provenance, c.netId, c.conductor, c.designation]);
it.each(["left-to-right", "top-to-bottom"] as const)(
  "reserves readable same-sheet tags for about 300 and 765 authored characters in %s without new electrical identities",
  async (flow) => {
    const native = await renderSchematicPacket(
      compiled.ir,
      request(flow),
      compiled.presentation,
    );
    if (!native.ok) throw native;
    const originalContinuations = new Set(
      native.value.sheets.flatMap((s) => s.continuations.map(identity)),
    );
    for (const repetitions of [2, 5]) {
      const ir = structuredClone(compiled.ir),
        description = Array(repetitions).fill(note).join(" ");
      expect(description.length).toBeGreaterThan(repetitions === 2 ? 280 : 745);
      expect(description.length).toBeLessThan(repetitions === 2 ? 325 : 800);
      for (const device of ir.devices) device.description = description;
      const before = JSON.stringify(ir),
        nets = JSON.stringify(ir.nets);
      const rendered = await renderSchematicPacket(
        ir,
        request(flow),
        compiled.presentation,
      );
      if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
      expect(rendered.value.sheets.length).toBeLessThanOrEqual(8); // unchanged 2× native four-sheet packet cost
      expect(JSON.stringify(ir)).toBe(before);
      expect(JSON.stringify(ir.nets)).toBe(nets);
      expect(rendered.value.coverage.counts).toEqual(
        native.value.coverage.counts,
      );
      expect(rendered.value.coverage.conductors).toEqual(
        native.value.coverage.conductors,
      );
      expect(rendered.value.coverage.functions).toEqual(
        native.value.coverage.functions,
      );
      const retained = new Set(
        rendered.value.sheets.flatMap((s) => s.continuations.map(identity)),
      );
      for (const original of originalContinuations)
        expect(retained.has(original)).toBe(true);
      expect(continuationOracle(ir, rendered.value).ends).toBeGreaterThan(0);
      for (const sheet of rendered.value.sheets) {
        const doc = parseHTML(sheet.svg).document,
          bodies = generatedSvgInk(sheet.svg).bodies,
          entries = [...doc.querySelectorAll("[data-device-legend-entry]")];
        expect(entries).toHaveLength(bodies.size);
        expect(
          new Set(entries.map((e) => e.getAttribute("data-tag-owner-uid")))
            .size,
        ).toBe(entries.length);
        for (const entry of entries) {
          const uid = entry.getAttribute("data-tag-owner-uid"),
            device = ir.devices.find((d) => d.uid === uid)!,
            type = ir.deviceTypes.find((t) => t.id === device.typeId)!;
          expect(entry.getAttribute("data-tag-key")).toBe(device.designation);
          expect(
            doc.querySelector(
              `text[data-tag-kind="body"][data-tag-key="${device.designation}"]`,
            )?.textContent,
          ).toBe(device.designation);
          for (const [field, value] of Object.entries({
            designation: device.designation,
            description,
            part: type.catalog?.orderNumber,
          })) {
            const rows = [
              ...entry.querySelectorAll(`text[data-tag-field="${field}"]`),
            ];
            expect(rows.map((r) => r.textContent).join("")).toBe(value ?? "");
            for (const row of rows) {
              expect(
                Number(row.getAttribute("font-size")),
              ).toBeGreaterThanOrEqual(field === "designation" ? 2.7 : 2.5);
              expect(row.hasAttribute("textLength")).toBe(false);
            }
          }
        }
      }
    }
  },
  120000,
);
