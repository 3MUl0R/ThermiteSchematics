import { expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { buildDocumentation } from "@thermite/query";
import { createTerminalIr } from "../../query/test/fixtures.js";
import { reportCells } from "../src/packet/report-cells.js";
import { tableDrafts } from "../src/packet/reports.js";
import { documentPaper } from "./document-fixture.js";

const fixture = () => {
  const ir = createTerminalIr([
    { uid: "word-owner", designation: "X-PROTECTED-123", terminalKeys: ["1"] },
  ]);
  const table = buildDocumentation(ir, {
    format: "documentation-view-request/0.1",
    kind: "terminals",
    device: "X-PROTECTED-123",
  });
  return { ir, table };
};

it("reserves a whole state word before surplus goes to empty columns", () => {
  const { ir, table } = fixture();
  const state = table.columns.indexOf("State");
  const measured = reportCells(ir, table, 160);
  const source = table.rows[0];
  if (!source) throw Error("Missing native terminal row");
  const cells = measured.split(source.cells, "1", source.key);
  expect(cells[state]).toEqual(["Unconnected"]);
  expect(cells.flat().join(" ")).toContain("X-PROTECTED-123");
  expect(measured.cellSize).toBe(2.6);
});

it("wraps report notes at measured word boundaries without dropping an identifier", () => {
  const { ir, table } = fixture();
  const note =
    "The protected identifier X-PROTECTED-123 remains available for lookup. "
      .repeat(7)
      .trim();
  table.notes = [note];
  const result = tableDrafts(ir, table, undefined, documentPaper());
  if (!result.ok) throw Error(JSON.stringify(result.error));
  const dom = parseHTML(`<svg>${result.value[0]?.content}</svg>`).document;
  const lines = [...dom.querySelectorAll("[data-report-note]")].map(
    (node) => node.textContent ?? "",
  );
  expect(lines.join(" ").replace(/\s+/gu, " ").trim()).toBe(note);
  for (const line of lines)
    for (const word of line.trim().split(/\s+/u))
      expect(note.split(/\s+/u)).toContain(word);
  expect(lines.join(" ").match(/X-PROTECTED-123/gu)).toHaveLength(7);
  expect(result.value).toHaveLength(1);
});
