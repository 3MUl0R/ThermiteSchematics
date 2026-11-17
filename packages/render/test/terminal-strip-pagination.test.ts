import { expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { compileProject } from "@thermite/compiler";
import { renderSchematicPacket } from "../src/sheets.js";
import { longStrip } from "./terminal-strip-pagination-fixture.js";

function checkMarkerTargets(
  markers: ReturnType<typeof parseHTML>["document"]["documentElement"][],
  documents: { sheet: number; doc: ReturnType<typeof parseHTML>["document"] }[],
) {
  for (const marker of markers) {
    const target = marker.getAttribute("data-strip-target");
    const owner = documents.find(({ doc }) =>
      [...doc.querySelectorAll("[data-strip-terminal]")].some(
        (t) => t.getAttribute("data-strip-terminal") === target,
      ),
    );
    expect(owner).toBeDefined();
    expect(marker.textContent).toContain("XT-LONG continued");
    expect(marker.textContent).toMatch(
      new RegExp(`sheet ${String(owner!.sheet).padStart(2, "0")}\\.[A-D][1-6]`),
    );
    expect(marker.textContent).toContain(`terminal ${JSON.parse(target!)[1]}`);
  }
}
it("paginates a native device between terminals and resolves reciprocal final sheet destinations", async () => {
  const { ir, keys } = longStrip(),
    original = JSON.stringify(ir);
  const r = await renderSchematicPacket(ir, {
    format: "schematic-packet-request/0.1",
    page: { size: "letter", orientation: "landscape" },
    index: true,
    references: false,
    views: [
      { format: "documentation-view-request/0.1", kind: "bom" },
      {
        format: "documentation-view-request/0.1",
        kind: "terminals",
        device: "XT-LONG",
      },
    ],
  });
  if (!r.ok) throw Error(JSON.stringify(r.error));
  expect(JSON.stringify(ir)).toBe(original);
  const strips = r.value.sheets.filter(
    (s) =>
      s.view.format === "documentation-view/0.1" &&
      s.view.kind === "terminal-strip",
  );
  expect(strips.length).toBeGreaterThan(1);
  const documents = strips.map((s) => ({
    sheet: s.number,
    doc: parseHTML(s.svg).document,
  }));
  expect(
    documents.flatMap(({ doc }) =>
      [...doc.querySelectorAll("[data-strip-terminal]")].map(
        (t) => JSON.parse(t.getAttribute("data-strip-terminal")!)[1],
      ),
    ),
  ).toEqual(keys);
  const chunks = documents.flatMap(({ doc }) => [
    ...doc.querySelectorAll("[data-terminal-strip]"),
  ]);
  const markers = documents.flatMap(({ doc }) => [
    ...doc.querySelectorAll("[data-strip-continuation]"),
  ]);
  expect(markers.length).toBe(2 * (chunks.length - 1));
  checkMarkerTargets(markers, documents);
  const bridges = documents.flatMap(({ doc }) => [
    ...doc.querySelectorAll("[data-strip-jumper]"),
  ]);
  expect(bridges.length).toBe(2);
  expect(
    bridges.map((b) => b.getAttribute("data-strip-jumper-end")).sort(),
  ).toEqual(["0", "1"]);
  expect(
    bridges.every(
      (b) =>
        b.getAttribute("data-strip-jumper") === "native-cross-sheet-jumper" &&
        b.textContent!.replace(/\s+/gu, " ").includes("continued on sheet"),
    ),
  ).toBe(true);
  for (const { doc } of documents)
    for (const t of doc.querySelectorAll("text"))
      expect(Number(t.getAttribute("font-size"))).toBeGreaterThanOrEqual(2.5);
});
it("keeps generated supplementary inventories as tables without strip growth", async () => {
  const c = await compileProject("examples/operator-console");
  if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
  const r = await renderSchematicPacket(
    c.ir,
    {
      format: "schematic-packet-request/0.1",
      index: false,
      views: [
        {
          format: "wiring-view-request/0.1",
          title: "Console feeder",
          conductors: ["W-C01"],
        },
      ],
    },
    c.presentation,
  );
  if (!r.ok) throw Error(JSON.stringify(r.error));
  expect(
    r.value.sheets.some(
      (s) =>
        s.view.format === "documentation-view/0.1" &&
        s.view.kind === "terminal-strip",
    ),
  ).toBe(false);
  expect(
    r.value.sheets.some((s) =>
      parseHTML(s.svg).document.querySelector("[data-report-row]"),
    ),
  ).toBe(true);
});
