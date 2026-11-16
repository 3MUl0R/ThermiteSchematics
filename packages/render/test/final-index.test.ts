import { beforeAll, expect, it } from "vitest";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import { reserveFinalIndex } from "../src/packet/references-final.js";
import { tableDrafts } from "../src/packet/reports.js";
import { normalizePaperPage } from "../src/packet/page.js";
import { buildDocumentation } from "@thermite/query";
import { required } from "./off-view-fixtures.js";
import { parseHTML } from "linkedom";
import {
  renderSchematicPacket,
  type SchematicPacketRequest,
} from "../src/sheets.js";
let ir: ElectricalIr;
beforeAll(async () => {
  const c = await compileProject("examples/report-filtering");
  if (!c.ok) throw Error("fixture compile");
  ir = c.ir;
});
const request: SchematicPacketRequest = {
  format: "schematic-packet-request/0.1",
  index: true,
  views: [
    { format: "documentation-view-request/0.1", kind: "bom" },
    { format: "documentation-view-request/0.1", kind: "bom" },
  ],
};
const rows = (sheets: readonly { svg: string; view: { kind: string } }[]) =>
  sheets
    .filter((s) => s.view.kind === "index")
    .flatMap((s) => [
      ...parseHTML(s.svg).document.querySelectorAll("[data-report-row]"),
    ]);
it("indexes every final sheet, including all index and reference pages", async () => {
  const before = JSON.stringify(ir),
    result = await renderSchematicPacket(ir, request);
  if (!result.ok) throw Error(result.error.message);
  expect(
    rows(result.value.sheets).map((r) => r.getAttribute("data-report-row")),
  ).toEqual(result.value.sheets.map((s) => String(s.number)));
  expect(JSON.stringify(ir)).toBe(before);
});
it("disambiguates repeated titles with sheet destinations, not title identities", async () => {
  const result = await renderSchematicPacket(ir, request);
  if (!result.ok) throw Error(result.error.message);
  const names = rows(result.value.sheets)
    .slice(0, 2)
    .map((r) => r.querySelector('[data-report-column="2"]')?.textContent);
  expect(new Set(names).size).toBe(2);
  expect(names[0]).toContain("sheet 01");
  expect(names[1]).toContain("sheet 02");
});
it("keeps references:false intentional while indexing its own final page", async () => {
  const result = await renderSchematicPacket(ir, {
    ...request,
    references: false,
  });
  if (!result.ok) throw Error(result.error.message);
  expect(result.value.sheets.some((s) => s.view.kind === "references")).toBe(
    false,
  );
  expect(rows(result.value.sheets)).toHaveLength(result.value.sheets.length);
});

it("bounds an index self-pagination cycle by the reserved sheet capacity", () => {
  const page = normalizePaperPage();
  if (!page.ok) throw Error("paper");
  const prepared = tableDrafts(
    ir,
    buildDocumentation(ir, {
      format: "documentation-view-request/0.1",
      kind: "bom",
    }),
    undefined,
    page.value,
  );
  if (!prepared.ok) throw Error(prepared.error.message);
  const template = required(prepared.value[0]);
  let calls = 0;
  const result = reserveFinalIndex([template], [], template, (all) => {
    calls++;
    expect(calls).toBeLessThanOrEqual(100);
    return {
      ok: true,
      value: Array.from({ length: all.length === 2 ? 2 : 1 }, () => template),
    };
  });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toMatchObject({
      code: "R006",
      root: "packet",
      reason: "unprintable-layout",
      message:
        "A bounded final index cannot fit within the 100-sheet packet limit.",
    });
  expect(calls).toBe(99);
});
