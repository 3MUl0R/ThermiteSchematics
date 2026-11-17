import { beforeAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import { renderSchematicPacket } from "../src/sheets.js";
import type { SchematicPacketRequest } from "../src/packet/types.js";
import { parseHTML } from "linkedom";

let ir: ElectricalIr, request: SchematicPacketRequest;
beforeAll(async () => {
  const compiled = await compileProject("examples/cap-pagination");
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  ir = compiled.ir;
  request = JSON.parse(
    await readFile("examples/cap-pagination/packet.json", "utf8"),
  );
});
it("fills Letter companions with all eight atomic native cap rows at the existing em", async () => {
  const before = JSON.stringify(ir);
  const result = await renderSchematicPacket(ir, {
    ...request,
    page: { size: "letter", orientation: "landscape" },
    layout: "compact",
    views: request.views.slice(0, 1),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.sheets).toHaveLength(10);
  expect(
    result.value.sheets.filter((s) => s.view.kind === "connector-assembly"),
  ).toHaveLength(6);
  const schedules = result.value.sheets.filter(
    (s) => s.view.kind === "assemblies",
  );
  expect(schedules).toHaveLength(2);
  const rows = result.value.navigation?.documents.flatMap((d) => d.rows) ?? [];
  expect(rows.map((r) => r.displayName)).toEqual(
    Array.from({ length: 8 }, (_, i) => `CAP-X0${i + 1}`),
  );
  expect(new Set(rows.map((r) => r.nativeKey)).size).toBe(8);
  for (const sheet of schedules) {
    const doc = parseHTML(sheet.svg).document;
    for (const row of doc.querySelectorAll("[data-report-row]")) {
      expect(row.querySelectorAll("[data-report-column]")).toHaveLength(5);
      expect(
        [...row.querySelectorAll("text")].map((t) => t.textContent).join(" "),
      ).toContain(
        "Protective cover reserves a named connector; no electrical pin mapping applies.",
      );
      for (const text of row.querySelectorAll("text"))
        expect(Number(text.getAttribute("font-size"))).toBe(2.6);
    }
  }
  expect(JSON.stringify(ir)).toBe(before);
});

it("does not buy density by splitting an ordinary native port state word", async () => {
  const result = await renderSchematicPacket(ir, {
    format: "schematic-packet-request/0.1",
    page: { size: "letter", orientation: "landscape" },
    views: [
      {
        format: "connector-assembly-view-request/0.1",
        assemblies: ["CAP-X01"],
      },
    ],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const rows = result.value.navigation?.documents.flatMap((d) => d.rows) ?? [];
  const unoccupied = rows.filter((r) => r.nativeKey.startsWith("["));
  expect(unoccupied).toHaveLength(3);
  for (const row of unoccupied) {
    const doc = parseHTML(
      result.value.sheets[row.sheet - 1]?.svg ?? "",
    ).document;
    const printed = doc.getElementById(row.primitiveId);
    expect(
      [...(printed?.querySelectorAll("text") ?? [])].map((t) => t.textContent),
    ).toContain("Unoccupied");
  }
});
