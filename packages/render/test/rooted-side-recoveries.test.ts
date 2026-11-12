import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { compileProject } from "@thermite/compiler";
import {
  renderSchematicPacket,
  type SchematicPacketRequest,
} from "../src/sheets.js";
import { continuationOracle } from "./continuation-oracle.js";
import { dolFixture, actuation } from "./dol-control-junctions-fixture.js";

it("packs machine TB within22 including its K1/K2 and LS1 compositions", async () => {
  const c = await compileProject("examples/machine-demo");
  if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
  const request = JSON.parse(
    await readFile("examples/machine-demo/packet.request.json", "utf8"),
  );
  for (const v of request.views) if (v.flow) v.flow = "top-to-bottom";
  const r = await renderSchematicPacket(c.ir, request, c.presentation);
  if (!r.ok) throw Error(JSON.stringify(r.error));
  expect(r.value.sheets.length).toBeLessThanOrEqual(22);
  const pages = (designation: string) =>
    r.value.sheets.filter(
      (s) =>
        s.view.format.startsWith("schematic-view/") &&
        "root" in s.view &&
        s.view.root.designation === designation,
    );
  expect(pages("M1").length).toBeGreaterThan(0);
  expect(pages("M1").length).toBeLessThanOrEqual(2);
  expect(pages("M2")).toHaveLength(1);
  expect(pages("K1")).toHaveLength(1);
  expect(pages("K2")).toHaveLength(1);
  expect(pages("LS1")).toHaveLength(2);
  expect(pages("K1")[0]!.svg).toContain("translate(");
  expect(continuationOracle(c.ir, r.value).ends).toBeGreaterThan(0);
}, 30000);
it("keeps conveyor TB within13 with complete continuations", async () => {
  const c = await compileProject("examples/conveyor-line");
  if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
  const request: SchematicPacketRequest = {
    format: "schematic-packet-request/0.1",
    layout: "compact",
    index: true,
    page: { size: "tabloid", orientation: "landscape" },
    views: [
      ...(["M1", "M2", "K1", "K2"] as const).map((root) => ({
        format: "schematic-view-request/0.1" as const,
        root: { by: "designation" as const, value: root },
        family: root.startsWith("M")
          ? ("power" as const)
          : ("control" as const),
        flow: "top-to-bottom" as const,
      })),
      { format: "documentation-view-request/0.1", kind: "wires" },
      { format: "documentation-view-request/0.1", kind: "terminals" },
    ],
  };
  const r = await renderSchematicPacket(c.ir, request, c.presentation);
  if (!r.ok) throw Error(JSON.stringify(r.error));
  expect(r.value.sheets.length).toBeLessThanOrEqual(13);
  expect(continuationOracle(c.ir, r.value).ends).toBeGreaterThan(0);
}, 30000);
it.each(["K1", "R1"])(
  "packs %s TB on one tabloid sheet without claiming its short-loop goal",
  async (root) => {
    const f = await dolFixture("saved");
    try {
      for (const layout of ["standard", "compact"] as const) {
        const r = await renderSchematicPacket(f.ir, {
          format: "schematic-packet-request/0.1",
          layout,
          views: [actuation(root, "top-to-bottom")],
        });
        if (!r.ok) throw Error(JSON.stringify(r.error));
        expect(r.value.sheets).toHaveLength(1);
        expect(continuationOracle(f.ir, r.value).ends).toBeGreaterThan(0);
      }
    } finally {
      await f.dispose();
    }
  },
  30000,
);
