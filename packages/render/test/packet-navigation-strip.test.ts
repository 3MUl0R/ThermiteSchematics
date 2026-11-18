import { expect, it } from "vitest";
import { renderSchematicPacket } from "../src/sheets.js";
import { parseSvg } from "./off-view-fixtures.js";
import { compileProject } from "@thermite/compiler";
import { buildDocumentation } from "@thermite/query";
import { tableDrafts } from "../src/packet/reports.js";
import { appendTerminalStrips } from "../src/packet/terminal-strip.js";
import { assembleSheets } from "../src/packet/assembly.js";
import { normalizePaperPage } from "../src/packet/page.js";
import { locateStripSheets } from "../src/packet/terminal-strip-landings.js";
import { wireScheduleLocations } from "../src/packet/wire-schedule-locations.js";
import type { RenderedSheet } from "../src/packet/types.js";

const tb1Plan = {
  format: "documentation-view-request/0.1" as const,
  kind: "terminals" as const,
  device: "TB1",
};
const wires = {
  format: "documentation-view-request/0.1" as const,
  kind: "wires" as const,
};
function indexDeviceCell(sheet: RenderedSheet, number: number) {
  return [...parseSvg(sheet.svg).querySelectorAll("[data-report-row]")]
    .find((r) => r.getAttribute("data-report-row") === String(number))
    ?.querySelector('[data-report-column="3"]')
    ?.textContent?.trim();
}
it("indexes filtered strip devices and distinguishes repeated strip fragments from inventories", async () => {
  const c = await compileProject("examples/motor-starter");
  if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
  const r = await renderSchematicPacket(
    c.ir,
    {
      format: "schematic-packet-request/0.1",
      index: true,
      references: { appearances: "drawings" },
      views: [tb1Plan, tb1Plan, wires],
    },
    c.presentation,
  );
  if (!r.ok) throw Error(JSON.stringify(r.error));
  const strips = r.value.sheets.filter((s) => s.view.kind === "terminal-strip");
  const indexes = r.value.sheets.filter((s) => s.view.kind === "index");
  expect(strips).toHaveLength(2);
  for (const sheet of strips) {
    const indexCells = indexes
      .map((s) => indexDeviceCell(s, sheet.number))
      .filter((v) => v !== undefined);
    expect(indexCells).toEqual(["TB1"]);
    expect(sheet.references).toEqual([
      expect.objectContaining({
        deviceUid: c.ir.devices.find((d) => d.designation === "TB1")!.uid,
        designation: "TB1",
        representation: "terminal-strip",
        zone: expect.stringMatching(/^[A-D][1-6]$/u),
      }),
    ]);
  }
  const references = r.value.sheets
    .filter((s) => s.view.kind === "references")
    .flatMap((s) =>
      [...parseSvg(s.svg).querySelectorAll("text")].map((t) => t.textContent),
    );
  const printed = references.join(" ");
  expect(printed).toContain("Terminal strip");
  for (const s of strips)
    expect(printed).toContain(`${s.number} / ${s.references[0]!.zone}`);
  expect(printed).not.toContain("Terminal / schedule");
  const cable = c.ir.cables.find((x) => x.designation === "CBL1")!;
  const row = r.value.sheets
    .filter((s) => s.view.kind === "wires")
    .flatMap((s) => [...parseSvg(s.svg).querySelectorAll("[data-report-row]")])
    .find(
      (el) =>
        el.getAttribute("data-report-row") ===
        JSON.stringify([cable.uid, "2-"]),
    );
  expect(row?.querySelector('[data-report-column="6"]')?.textContent).toContain(
    String(strips[0]!.number).padStart(2, "0") + ".",
  );
  expect(row?.querySelector('[data-report-column="7"]')?.textContent).toContain(
    "not drawn",
  );
});

it("requires a painted native strip body and the exact conductor path before crediting an endpoint", async () => {
  const c = await compileProject("examples/motor-starter");
  if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
  const page = normalizePaperPage();
  const report =
    page.ok &&
    tableDrafts(
      c.ir,
      buildDocumentation(c.ir, tb1Plan),
      c.presentation,
      page.value,
      true,
    );
  if (!page.ok || !report || !report.ok)
    throw Error("Unable to prepare strip fixture");
  const drafts = appendTerminalStrips(report.value);
  const baseline = assembleSheets(c.ir, drafts, page.value);
  const cable = c.ir.cables.find((k) => k.designation === "CBL1")!;
  const key = JSON.stringify([cable.uid, "2-"]);
  const measure = (alter: (svg: string) => string) => {
    const sheets = baseline.map((s) =>
      s.view.kind === "terminal-strip" ? { ...s, svg: alter(s.svg) } : s,
    );
    const stripLocations = locateStripSheets(c.ir, drafts, sheets, page.value);
    return {
      locations: wireScheduleLocations(
        c.ir,
        drafts,
        sheets,
        page.value,
        stripLocations,
      ),
      references: sheets.find((s) => s.view.kind === "terminal-strip")!
        .references,
    };
  };
  expect(measure((s) => s).locations.get(key)).toEqual([
    expect.stringMatching(/^\d+\.[A-D][1-6]$/u),
  ]);
  const removeCore = (svg: string, hide: boolean) =>
    svg.replace(
      /(<g data-strip-incidence="[^"]*2-[^"]*"[^>]*>\s*)(<path[^>]*\/>)/gu,
      (_, group: string, path: string) =>
        group + (hide ? path.replace("<path ", '<path opacity="0" ') : ""),
    );
  for (const hide of [false, true])
    expect(measure((s) => removeCore(s, hide)).locations.has(key)).toBe(false);
  const empty = measure((s) =>
    s.replace("data-terminal-strip=", 'display="none" data-terminal-strip='),
  );
  expect(empty.locations.size).toBe(0);
  expect(empty.references).toEqual([]);
});
