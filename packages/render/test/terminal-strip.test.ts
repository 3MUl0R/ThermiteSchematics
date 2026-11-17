import { expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { buildDocumentation } from "@thermite/query";
import { renderSchematicPacket } from "../src/sheets.js";
import { createTerminalIr } from "../../query/test/fixtures.js";

function fixture() {
  const keys = ["3", "1", "2"];
  const ir = createTerminalIr([
    { uid: "strip-uid", designation: "XT1", terminalKeys: keys },
    { uid: "panel-uid", designation: "P1", terminalKeys: keys },
    { uid: "field-uid", designation: "F1", terminalKeys: keys },
  ]);
  ir.deviceTypes[0]!.terminalOrder = keys;
  ir.devices[0]!.location = ir.devices[1]!.location = "Panel";
  ir.devices[2]!.location = "Field";
  const source = ir.devices[0]!.source;
  const end = (deviceUid: string, terminalKey: string) => ({
    terminal: { deviceUid, terminalKey },
    source,
  });
  ir.wires = [
    {
      uid: "wire-panel",
      designation: "W-P",
      aliases: [],
      source,
      endpoints: [end("strip-uid", "3"), end("panel-uid", "1")],
    },
    {
      uid: "wire-field",
      designation: "W-F",
      aliases: [],
      source,
      endpoints: [end("field-uid", "2"), end("strip-uid", "1")],
    },
  ];
  ir.jumpers = [
    {
      uid: "bridge-uid",
      designation: "J1",
      aliases: [],
      source,
      endpoints: [end("strip-uid", "3"), end("strip-uid", "2")],
    },
  ];
  return ir;
}
const view = {
  format: "documentation-view-request/0.1" as const,
  kind: "terminals" as const,
  device: "XT1",
};
async function drawing(ir = fixture()) {
  const before = JSON.stringify(ir);
  const result = await renderSchematicPacket(ir, {
    format: "schematic-packet-request/0.1",
    index: false,
    views: [view],
  });
  expect(JSON.stringify(ir)).toBe(before);
  if (!result.ok) throw Error(result.error.message);
  return {
    ir,
    packet: result.value,
    document: parseHTML(result.value.sheets.map((s) => s.svg).join("\n"))
      .document,
  };
}
it("draws authored terminal order and only native jumper geometry with reciprocal inventory references", async () => {
  const { ir, packet, document } = await drawing();
  const terminals = [...document.querySelectorAll("[data-strip-terminal]")];
  expect(
    terminals.map((e) => JSON.parse(e.getAttribute("data-strip-terminal")!)),
  ).toEqual(["3", "1", "2"].map((key) => ["strip-uid", key]));
  expect(terminals.every((t) => t.querySelector("rect"))).toBe(true);
  expect(terminals.map((t) => t.getAttribute("data-strip-ref"))).toEqual([
    "T1/R1",
    "T1/R2",
    "T1/R3",
  ]);
  for (const t of terminals) {
    const key = JSON.parse(t.getAttribute("data-strip-terminal")!)[1];
    expect([...t.querySelectorAll("text")].map((e) => e.textContent)).toEqual([
      key,
      t.getAttribute("data-strip-ref"),
    ]);
  }

  const bridges = [...document.querySelectorAll("[data-strip-jumper]")];
  expect(bridges.map((b) => b.getAttribute("data-strip-jumper"))).toEqual([
    "bridge-uid",
  ]);
  expect(bridges[0]!.querySelector("path")).toBeTruthy();
  for (const t of terminals) {
    const id = t.getAttribute("data-strip-terminal")!;
    const row = [...document.querySelectorAll("[data-report-row]")].find(
      (r) => r.getAttribute("data-report-row") === id,
    )!;
    expect(row.getAttribute("data-strip-ref")).toBe(
      t.getAttribute("data-strip-ref"),
    );
    expect(t.getAttribute("data-inventory-row")).toBe(id);
    expect(
      [...document.querySelectorAll("text")]
        .map((t) => t.textContent)
        .join(" "),
    ).toContain(t.getAttribute("data-strip-ref"));
  }
  expect(document.querySelectorAll("[data-report-row]").length).toBe(
    buildDocumentation(ir, view).rows.length,
  );
  expect(packet.sheets.length).toBeLessThanOrEqual(2);
  for (const label of ["W-P", "W-F", "P1.1", "F1.2", "hardware unspecified"])
    expect(
      [...document.querySelectorAll("text")]
        .map((t) => t.textContent)
        .join(" "),
    ).toContain(label);
  for (const t of document.querySelectorAll("text"))
    expect(Number(t.getAttribute("font-size"))).toBeGreaterThanOrEqual(2.5);
});
it("does not derive a bridge from a shared net or device function", async () => {
  const ir = fixture();
  ir.jumpers = [];
  const { document } = await drawing(ir);
  expect(document.querySelectorAll("[data-strip-jumper]").length).toBe(0);
  expect(document.querySelectorAll("[data-strip-terminal]").length).toBe(3);
});
it("keeps missing order and hardware visibly unspecified", async () => {
  const ir = fixture();
  delete ir.deviceTypes[0]!.terminalOrder;
  const { document } = await drawing(ir);
  expect(
    [...document.querySelectorAll("text")].map((t) => t.textContent).join(" "),
  ).toContain("order unspecified");
  expect(
    [...document.querySelectorAll("text")].map((t) => t.textContent).join(" "),
  ).toContain("hardware unspecified");
  expect(document.querySelector("[data-strip-accessory]")).toBeNull();
});
it("is deterministic and affects only terminal-plan sheets", async () => {
  const a = await drawing(),
    b = await drawing();
  expect(a.packet).toEqual(b.packet);
  const result = await renderSchematicPacket(fixture(), {
    format: "schematic-packet-request/0.1",
    index: false,
    views: [{ format: "documentation-view-request/0.1", kind: "wires" }],
  });
  if (!result.ok) throw Error(result.error.message);
  expect(
    result.value.sheets.some((s) => s.svg.includes("data-strip-terminal")),
  ).toBe(false);
});
