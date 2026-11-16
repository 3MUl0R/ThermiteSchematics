import { afterAll, beforeAll, expect, it } from "vitest";
import { buildDocumentation } from "@thermite/query";
import { offViewFixture } from "./off-view-fixtures.js";
import {
  wireNeed,
  dependencyDraft,
  documentPaper,
} from "./document-fixture.js";
import { factTable } from "../src/packet/document-facts.js";
import { appendDocumentCompanions } from "../src/packet/document-companions.js";

let source: Awaited<ReturnType<typeof offViewFixture>>;
beforeAll(async () => {
  source = await offViewFixture();
});
afterAll(async () => {
  await source.dispose();
});
it("counts unique conductor rows, not repeated endpoint incidences, and discloses supplementary purpose", () => {
  const need = wireNeed(source.ir);
  const table = factTable(source.ir, "wires", [
    ...need.requiredFacts,
    ...need.requiredFacts,
  ]);
  const wire = source.ir.wires.find((w) => w.designation === "W3");
  expect(table.rows.map((r) => r.key)).toEqual([wire?.uid]);
  expect(table.title).toBe("Supplementary connections");
  expect(table.notes.join(" ")).toContain(
    "1 conductor row for source-detail notes",
  );
  expect(table.notes.join(" ")).toContain("not a complete inventory");
  expect(table.selection).toBeUndefined();
});
it("names a cable-core-only companion accurately without adding or dropping cores", () => {
  const cable = source.ir.cables[0];
  if (!cable) throw new Error("missing cable");
  const table = factTable(source.ir, "wires", [
    { kind: "core-inventory", cableUid: cable.uid, conductorId: "2" },
  ]);
  expect(table.title).toBe("Supplementary cable cores");
  expect(table.rows.map((r) => r.key)).toEqual([
    JSON.stringify([cable.uid, "2"]),
  ]);
  expect(table.notes.join(" ")).toContain(
    "1 conductor row for source-detail notes",
  );
});
it("carries the truthful scope into automatically issued companion sheets", () => {
  const need = wireNeed(source.ir);
  const closed = appendDocumentCompanions(
    source.ir,
    [dependencyDraft(source.ir, [need, { ...need, noteId: "again" }])],
    documentPaper(),
  );
  if (!closed.ok) throw new Error(closed.error.message);
  const generated = closed.value.filter((d) => d.autoDocumentOrigin);
  expect(generated).toHaveLength(1);
  expect(generated[0]?.view.title).toBe("Supplementary connections");
  expect(generated[0]?.documentHeader?.labelText).toBe(
    "Supplementary connections — wire inventory",
  );
  expect(generated[0]?.content).toContain(
    "1 conductor row for source-detail notes",
  );
  expect(generated[0]?.documentRows).toHaveLength(1);
});
it("keeps full requested schedules complete and requested device filters independently verifiable", () => {
  const full = buildDocumentation(source.ir, {
    format: "documentation-view-request/0.1",
    kind: "wires",
  });
  const native = [...source.ir.wires, ...source.ir.jumpers].map((w) => w.uid);
  for (const cable of source.ir.cables) {
    const type = source.ir.cableTypes.find((t) => t.id === cable.typeId);
    if (!type) throw new Error("missing cable type");
    native.push(
      ...type.conductors.map((c) => JSON.stringify([cable.uid, c.id])),
    );
  }
  expect(full.rows.map((r) => r.key).sort()).toEqual(native.sort());
  expect(full.title).not.toContain("Supplementary");
  expect(full.selection).toBeUndefined();
  const filtered = buildDocumentation(source.ir, {
    format: "documentation-view-request/0.1",
    kind: "wires",
    filter: { devices: ["H1"] },
  });
  const h1 = source.ir.devices.find((d) => d.designation === "H1");
  expect(filtered.rows.map((r) => r.key).sort()).toEqual(
    source.ir.wires
      .filter((w) => w.endpoints.some((e) => e.terminal.deviceUid === h1?.uid))
      .map((w) => w.uid)
      .sort(),
  );
  expect(filtered.selection?.retainedRows).toBe(filtered.rows.length);
  expect(filtered.selection?.totalRows).toBe(native.length);
  expect(filtered.title).toContain("(filtered)");
});

it("does not retain an intermediate device-filter count or a full-terminal promise on a partial companion", () => {
  const device = source.ir.devices.find((d) => d.designation === "H1");
  if (!device) throw new Error("missing fixture device");
  const terminal = { deviceUid: device.uid, terminalKey: "X1" };
  const table = factTable(source.ir, "terminals", [
    { kind: "terminal-inventory", terminal },
  ]);
  expect(table.rows.map((r) => r.key)).toEqual([
    JSON.stringify([device.uid, "X1"]),
  ]);
  expect(table.notes.join(" ")).toContain(
    "1 terminal row for source-detail notes",
  );
  expect(table.notes.join(" ")).not.toMatch(
    /Filtered report:|Lists every terminal|Device-owned rows follow/,
  );
  expect(table.selection).toBeUndefined();
});
