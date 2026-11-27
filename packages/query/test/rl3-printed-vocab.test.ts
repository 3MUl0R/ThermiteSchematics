import { describe, expect, it } from "vitest";
import { compileProject } from "@thermite/compiler";
import { buildDocumentation, documentationCsv } from "../src/index.js";

describe("RL3 printed vocabulary — query reports", () => {
  it("KEY-03: prints human connector-port endpoints in assemblies and io-ports while preserving CSV and terminal incidences", async () => {
    const cap = await compileProject("examples/cap-pagination");
    if (!cap.ok) throw Error(JSON.stringify(cap.diagnostics));
    const assemblies = buildDocumentation(cap.ir, {
      format: "documentation-view-request/0.1",
      kind: "assemblies",
    });
    const endA = assemblies.rows.map((r) => r.cells[2]);
    const endB = assemblies.rows.map((r) => r.cells[3]);
    expect(endA).toContain("R1: X01");
    expect(endA).toContain("D1: A");
    expect(endB).toContain("CAP1: P");
    expect(
      [...endA, ...endB].some((c) =>
        /\bR1\.X01\b|\bCAP1\.P\b|\bD1\.A\b/u.test(c),
      ),
    ).toBe(false);

    const assembliesCsv = documentationCsv(
      buildDocumentation(
        cap.ir,
        { format: "documentation-view-request/0.1", kind: "assemblies" },
        undefined,
        { output: "csv" },
      ),
    );
    expect(assembliesCsv).toContain("R1.X01");
    expect(assembliesCsv).toContain("CAP1.P");

    const connIo = await compileProject("examples/connector-io");
    if (!connIo.ok) throw Error(JSON.stringify(connIo.diagnostics));
    const ioPorts = buildDocumentation(connIo.ir, {
      format: "documentation-view-request/0.1",
      kind: "io-ports",
    });
    const peers = ioPorts.rows.map((r) => r.cells[5]);
    expect(peers.some((c) => c.includes("S1: M12"))).toBe(true);
    expect(peers.some((c) => c.includes("CAP1: P"))).toBe(true);
    expect(peers.some((c) => c.includes("Y1: IN"))).toBe(true);
    expect(peers.some((c) => /\b(?:S1\.M12|CAP1\.P|Y1\.IN)\b/u.test(c))).toBe(
      false,
    );
    // Negative control: sentence prose in pin-mapping column stays unchanged.
    expect(
      ioPorts.rows.some(
        (r) => r.cells[6] === "No assembly; mapping unspecified",
      ),
    ).toBe(true);

    // Negative control: physical terminal incidence W2 -> S1.P stays dotted.
    const filtering = await compileProject("examples/report-filtering");
    if (!filtering.ok) throw Error(JSON.stringify(filtering.diagnostics));
    const terminals = buildDocumentation(filtering.ir, {
      format: "documentation-view-request/0.1",
      kind: "terminals",
    });
    expect(terminals.rows.some((r) => r.cells[5].includes("W2 -> S1.P"))).toBe(
      true,
    );
  });

  it("KEY-03: formats undesignated assembly identity with human port separator in print mode", async () => {
    const bounds = await compileProject("examples/assembly-note-bounds");
    if (!bounds.ok) throw Error(JSON.stringify(bounds.diagnostics));
    const ir = structuredClone(bounds.ir);
    const rel = ir.relations.find((r) => r.assembly)!;
    delete rel.designation;
    const printed = buildDocumentation(ir, {
      format: "documentation-view-request/0.1",
      kind: "assemblies",
    });
    const row = printed.rows.find((r) => r.key === rel.uid)!;
    expect(row.cells[0]).toBe("R1: X1 ↔ S1: P");
    expect(row.cells[2]).toContain("R1: X1");
    expect(row.cells[3]).toContain("S1: P");
    const csv = buildDocumentation(
      ir,
      { format: "documentation-view-request/0.1", kind: "assemblies" },
      undefined,
      { output: "csv" },
    );
    expect(csv.rows.find((r) => r.key === rel.uid)!.cells[0]).toBe(
      "R1.X1 ↔ S1.P",
    );
  });
});
