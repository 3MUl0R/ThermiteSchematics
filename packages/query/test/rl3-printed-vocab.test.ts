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

  it("TXT-01: replaces bare null protocol tokens with an explicit page-explained statement while keeping native IR unknown", async () => {
    const rm3 = await compileProject("packages/core-library/test/fixtures/rm3");
    if (!rm3.ok) throw Error(JSON.stringify(rm3.diagnostics));
    const before = JSON.stringify(rm3.ir);
    const network = buildDocumentation(rm3.ir, {
      format: "documentation-view-request/0.1",
      kind: "network",
    });
    const linkRow = network.rows.find((r) => r.cells[0] === "NET1")!;
    expect(linkRow.cells[1]).toBe("Protocol not specified in source");
    expect(linkRow.cells[1]).not.toMatch(/^(?:unspecified|none|null)$/iu);
    expect(
      network.notes.some((n) => n.includes("Protocol not specified in source")),
    ).toBe(true);
    // Native IR remains untouched.
    expect(JSON.stringify(rm3.ir)).toBe(before);
    expect(
      rm3.ir.relations.find((r) => r.connection)?.connection?.protocol,
    ).toBe("unspecified");

    // Covers bare null tokens (including alongside cable specs) and preserves real protocol prose.
    const ir = structuredClone(rm3.ir);
    const conn = ir.relations.find((r) => r.connection)!.connection!;
    for (const token of ["unspecified", "Unspecified", "None", "null", "  "]) {
      conn.protocol = token;
      const table = buildDocumentation(ir, {
        format: "documentation-view-request/0.1",
        kind: "network",
      });
      expect(table.rows.find((r) => r.cells[0] === "NET1")!.cells[1]).toBe(
        "Protocol not specified in source",
      );
    }
    conn.protocol = "unspecified";
    conn.cable = { specification: "Cat6 shielded", lengthM: 12 };
    const withCable = buildDocumentation(ir, {
      format: "documentation-view-request/0.1",
      kind: "network",
    });
    expect(withCable.rows.find((r) => r.cells[0] === "NET1")!.cells[1]).toBe(
      "Protocol not specified in source\nCat6 shielded\n12 m",
    );
    delete conn.cable;
    conn.protocol = "EtherNet/IP";
    const known = buildDocumentation(ir, {
      format: "documentation-view-request/0.1",
      kind: "network",
    });
    expect(known.rows.find((r) => r.cells[0] === "NET1")!.cells[1]).toBe(
      "EtherNet/IP",
    );
    expect(
      known.notes.some((n) => n.includes("Protocol not specified in source")),
    ).toBe(false);
    // Negative control: sentence prose containing "unspecified" is never altered.
    conn.protocol = "Vendor protocol (unspecified revision)";
    const prose = buildDocumentation(ir, {
      format: "documentation-view-request/0.1",
      kind: "network",
    });
    expect(prose.rows.find((r) => r.cells[0] === "NET1")!.cells[1]).toBe(
      "Vendor protocol (unspecified revision)",
    );
  });

  it("TXT-01 CSV: keeps the native protocol token in network CSV exports while printed output uses the explicit phrase", async () => {
    const rm3 = await compileProject("packages/core-library/test/fixtures/rm3");
    if (!rm3.ok) throw Error(JSON.stringify(rm3.diagnostics));

    const printedTable = buildDocumentation(rm3.ir, {
      format: "documentation-view-request/0.1",
      kind: "network",
    });
    expect(printedTable.rows.find((r) => r.cells[0] === "NET1")!.cells[1]).toBe(
      "Protocol not specified in source",
    );

    const csvTable = buildDocumentation(
      rm3.ir,
      { format: "documentation-view-request/0.1", kind: "network" },
      undefined,
      { output: "csv" },
    );
    expect(csvTable.rows.find((r) => r.cells[0] === "NET1")!.cells[1]).toBe(
      "unspecified",
    );
    expect(
      csvTable.notes.some((n) =>
        n.includes("Protocol not specified in source"),
      ),
    ).toBe(false);
    const csvText = documentationCsv(csvTable);
    expect(csvText).toContain('"NET1","unspecified"');
    expect(csvText).not.toContain("Protocol not specified in source");

    const ir = structuredClone(rm3.ir);
    const conn = ir.relations.find((r) => r.connection)!.connection!;
    for (const token of ["unspecified", "Unspecified", "None", "null"]) {
      conn.protocol = token;
      const exported = buildDocumentation(
        ir,
        { format: "documentation-view-request/0.1", kind: "network" },
        undefined,
        { output: "csv" },
      );
      expect(exported.rows.find((r) => r.cells[0] === "NET1")!.cells[1]).toBe(
        token,
      );
    }
    conn.protocol = "unspecified";
    conn.cable = { specification: "Cat6 shielded", lengthM: 12 };
    const withCableCsv = buildDocumentation(
      ir,
      { format: "documentation-view-request/0.1", kind: "network" },
      undefined,
      { output: "csv" },
    );
    expect(withCableCsv.rows.find((r) => r.cells[0] === "NET1")!.cells[1]).toBe(
      "unspecified\nCat6 shielded\n12 m",
    );
  });
});
