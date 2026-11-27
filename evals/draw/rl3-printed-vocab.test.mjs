import { describe, expect, it } from "vitest";
import { compileProject } from "@thermite/compiler";
import { buildDocumentation } from "@thermite/query";
import { EVALS_VERSION } from "./version.mjs";
import { readReportSummary } from "./report-summary.mjs";
import { nativeRows } from "./m3-native.mjs";
import { sufficient } from "./document-dependencies.mjs";
import { expectedIdentifierCells } from "./identifier-policy.mjs";
import { reports } from "./report-checks.mjs";
import {
  isExplicitEmptyState,
  matchesNativeEmptyState,
  nativeEmptyState,
} from "./native-empty-state.mjs";

describe("checker protocol 5.51 — RL3 printed vocabulary parser alignment", () => {
  it("bumps protocol to 5.51 and keeps 5.49 and 5.50 summaries readable", () => {
    expect(EVALS_VERSION).toBe("5.51");
    for (const evalsVersion of ["5.49", "5.50"]) {
      const sample = { evalsVersion, summary: { "DQ-19": { pass: 1 } } };
      expect(readReportSummary(sample)).toEqual(sample.summary);
    }
  });

  it("matches human connector-port endpoints in assemblies and io-ports while keeping physical terminals dotted", async () => {
    const cap = await compileProject("examples/cap-pagination");
    if (!cap.ok) throw Error(JSON.stringify(cap.diagnostics));
    const table = buildDocumentation(cap.ir, {
      format: "documentation-view-request/0.1",
      kind: "assemblies",
    });
    const catalog = nativeRows(cap.ir).filter((r) => r.kind === "assemblies");
    for (const row of table.rows) {
      const native = catalog.find((n) => n.key === row.key);
      expect(native).toBeDefined();
      const printed = {
        kind: "assemblies",
        key: row.key,
        cells: Object.fromEntries(row.cells.map((c, i) => [i, c])),
      };
      expect(sufficient(printed, native)).toBe(true);
      // Old dotted spelling fails exact native check for assemblies.
      const dotted = {
        ...printed,
        cells: { ...printed.cells, 2: printed.cells[2].replace(": ", ".") },
      };
      expect(sufficient(dotted, native)).toBe(false);
    }

    const cells = expectedIdentifierCells(cap.ir, table);
    expect(cells.some((c) => c.identifiers.includes("R1: X01"))).toBe(true);
    expect(cells.some((c) => c.identifiers.includes("CAP1: P"))).toBe(true);

    // Physical terminal incidences in terminals report stay dotted.
    const filtering = await compileProject("examples/report-filtering");
    if (!filtering.ok) throw Error(JSON.stringify(filtering.diagnostics));
    const terminals = buildDocumentation(filtering.ir, {
      format: "documentation-view-request/0.1",
      kind: "terminals",
    });
    const termCells = expectedIdentifierCells(filtering.ir, terminals);
    expect(termCells.some((c) => c.identifiers.includes("S1.P"))).toBe(true);
  });

  it("accepts explicit unspecified-protocol text in M3 native sufficiency", async () => {
    expect(isExplicitEmptyState("Protocol not specified in source")).toBe(true);
    expect(
      matchesNativeEmptyState(
        "Protocol not specified in source",
        nativeEmptyState("unspecified-protocol"),
      ),
    ).toBe(true);
    expect(
      matchesNativeEmptyState(
        "Protocol not specified in source\nCat6",
        nativeEmptyState("unspecified-protocol", "\nCat6"),
      ),
    ).toBe(true);
    expect(
      matchesNativeEmptyState(
        "EtherNet/IP",
        nativeEmptyState("unspecified-protocol"),
      ),
    ).toBe(false);

    const rm3 = await compileProject("packages/core-library/test/fixtures/rm3");
    if (!rm3.ok) throw Error(JSON.stringify(rm3.diagnostics));
    const table = buildDocumentation(rm3.ir, {
      format: "documentation-view-request/0.1",
      kind: "network",
    });
    const linkRow = table.rows.find((r) => r.cells[0] === "NET1");
    const native = nativeRows(rm3.ir).find(
      (r) => r.kind === "network" && r.key === linkRow.key,
    );
    expect(
      sufficient(
        {
          kind: "network",
          key: linkRow.key,
          cells: Object.fromEntries(linkRow.cells.map((c, i) => [i, c])),
        },
        native,
      ),
    ).toBe(true);
  });

  it("passes DQ-19 on explicit protocol text while still rejecting bare null placeholders", async () => {
    const rm3 = await compileProject("packages/core-library/test/fixtures/rm3");
    if (!rm3.ok) throw Error(JSON.stringify(rm3.diagnostics));
    const table = buildDocumentation(rm3.ir, {
      format: "documentation-view-request/0.1",
      kind: "network",
    });
    const linkRow = table.rows.find((r) => r.cells[0] === "NET1");
    const bbox = { x: 10, y: 10, w: 20, h: 3 };
    const cleanG = {
      reportRows: [linkRow.key],
      texts: [
        {
          element: "t1",
          row: linkRow.key,
          columnIndex: 1,
          cell: "c1",
          text: "Protocol not specified in source",
          bbox,
        },
      ],
    };
    expect(
      reports(cleanG, { view: { kind: "network" } }, {}, table, false),
    ).toEqual([]);

    const bareNullG = {
      reportRows: [linkRow.key],
      texts: [
        {
          element: "t1",
          row: linkRow.key,
          columnIndex: 1,
          cell: "c1",
          text: "unspecified",
          bbox,
        },
      ],
    };
    expect(
      reports(bareNullG, { view: { kind: "network" } }, {}, undefined, false),
    ).toEqual([
      expect.objectContaining({
        kind: "report-null-placeholder",
        placeholder: "unspecified",
      }),
    ]);
  });
});
