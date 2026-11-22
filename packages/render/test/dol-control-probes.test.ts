// Replays shared authored-source patches and packet requests in both flows.
// Exact semantic inventories/disclosures are gates; pagination and route shape are not.
import { beforeAll, expect, it } from "vitest";
import { renderSchematic } from "../src/renderer.js";
import { renderSchematicPacket } from "../src/sheets.js";
import { navigationGeometry } from "../src/packet/navigation-walk.js";
import { project } from "../src/device-legend/geometry.js";
import { boxDistance } from "../src/packet/navigation-symbols.js";
import type { SchematicViewRequest } from "../src/types.js";
import {
  dolControlInventory,
  dolPackets,
  dolProbeFixture,
  type DrawingProbe,
} from "./dol-control-probes-fixture.js";
import {
  assertPacketAudit,
  assertRootedInventory,
  rejectMutation,
  selectedInventory,
} from "./dol-control-probes-contract.js";
import { cards, flows, parseSvg, required } from "./off-view-fixtures.js";
import expected from "./fixtures/dol-control-probes/expected.json";
import full from "./fixtures/dol-control-probes/inventory.json";

it.each(
  (Object.keys(expected) as DrawingProbe[]).flatMap((name) =>
    flows.map((flow) => ({ name, flow })),
  ),
)("replays $name source-selected packets in $flow", async ({ name, flow }) => {
  const fixture = await dolProbeFixture(name);
  try {
    const { ir, source } = fixture,
      before = JSON.stringify(ir);
    const inventory = dolControlInventory(source, ir);
    expect(inventory.wires.map((e) => e.name).sort()).toEqual(
      full.wires.filter((w) => name === "saved" || w !== "W31"),
    );
    expect(inventory.functions.map((e) => e.name).sort()).toEqual(
      full.functions,
    );
    expect(inventory.wires).toHaveLength(name === "saved" ? 17 : 16);
    expect(inventory.functions).toHaveLength(14);
    const requests = dolPackets(name, flow);
    for (const root of ["K1", "R1"] as const) {
      const request = requests[root].views[0] as SchematicViewRequest;
      const raw = await renderSchematic(ir, request);
      if (!raw.ok) throw Error(JSON.stringify(raw));
      assertRootedInventory(
        selectedInventory(ir, raw.value.summary),
        inventory,
        expected[name][root],
      );
      expect(
        cards(raw.value.svg).sort((a, b) =>
          String(a.terminal).localeCompare(String(b.terminal)),
        ),
      ).toEqual(expected[name][root].disclosures);
      const rooted = await renderSchematicPacket(ir, requests[root]);
      if (!rooted.ok) throw Error(JSON.stringify(rooted));
      assertPacketAudit(rooted.value, inventory, false);
      const printedCards = [
        ...new Set(
          rooted.value.sheets.flatMap((s) =>
            cards(s.svg).map((c) => JSON.stringify(c)),
          ),
        ),
      ]
        .map((c) => JSON.parse(c))
        .sort((a, b) => a.terminal.localeCompare(b.terminal));
      expect(printedCards).toEqual(expected[name][root].disclosures);
      expect(rooted.value.coverage.counts.conductors.total).toBe(
        name === "saved" ? 31 : 30,
      );
      expect(rooted.value.coverage.counts.functions.total).toBe(31);
      // Marker text does not create an audited wire/function appearance.
      for (const omitted of expected[name][root].omittedWires)
        expect(
          required(
            rooted.value.coverage.conductors.find(
              (c) => c.designation === omitted,
            ),
          ).appearances,
        ).toEqual([]);
    }
    for (const kind of ["circuit", "combined"] as const) {
      const packet = await renderSchematicPacket(ir, requests[kind]);
      if (!packet.ok) throw Error(JSON.stringify(packet));
      assertPacketAudit(packet.value, inventory, true);
      expect(packet.value.coverage.counts.conductors.outsideAuditedViews).toBe(
        14,
      );
      expect(packet.value.coverage.counts.functions.outsideAuditedViews).toBe(
        17,
      );
      // Complete control still omits the project's source, motor and PE symbol.
      expect(packet.value.coverage.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "W906",
          devices: ["M1", "PE1", "SRC1"].map((designation) =>
            expect.objectContaining({ designation }),
          ),
        }),
      );
    }
    expect(JSON.stringify(ir)).toBe(before);
  } finally {
    await fixture.dispose();
  }
});

it("fits the named W35 peer beside its grouped circuit route", async () => {
  const fixture = await dolProbeFixture("p6");
  try {
    const w35 = required(
      fixture.ir.wires.find((wire) => wire.designation === "W35"),
    );
    const outcome = await renderSchematicPacket(
      fixture.ir,
      dolPackets("p6", "left-to-right").combined,
    );
    if (!outcome.ok) throw Error(outcome.error.message);
    const { svg } = required(outcome.value.sheets[3]);
    const drawing = parseSvg(svg);
    expect(
      drawing.querySelector(
        `[data-circuit-conductor="${w35.uid}"] path[stroke="#17212b"]`,
      ),
    ).not.toBeNull();
    const note = [
      ...drawing.querySelectorAll('[data-peer-reference="conductor-peer"]'),
    ].find((note) => note.getAttribute("data-peer-source")?.includes(w35.uid));
    expect(note?.textContent).toMatch(
      /^W35 · R1\.11 → OL1\.96 01\.[A-D][1-6](?: \(also shown 02\.[A-D][1-6]\))?$/u,
    );
  } finally {
    await fixture.dispose();
  }
});

function circuitTerminalBox(svg: string, deviceUid: string, key: string) {
  const geom = navigationGeometry(svg);
  const byNode = new Map(geom.map((g) => [g.node, g]));
  const id = JSON.stringify([deviceUid, key]);
  const port = required(
    geom.find((g) => g.visible && g.node.attrs["data-terminal-id"] === id),
  );
  const circle = required(port.node.children.find((n) => n.name === "circle"));
  const mark = required(byNode.get(circle));
  const r = Number(circle.attrs.r);
  return project(
    {
      x: Number(circle.attrs.cx ?? 0) - r,
      y: Number(circle.attrs.cy ?? 0) - r,
      w: 2 * r,
      h: 2 * r,
    },
    mark.matrix,
  );
}

it("places W37 at both R1.14 and S2.14 nearest their own terminals in DOL P6 TTB (#507)", async () => {
  const fixture = await dolProbeFixture("p6");
  try {
    const w37 = required(
      fixture.ir.wires.find((wire) => wire.designation === "W37"),
    );
    const r1 = required(
      fixture.ir.devices.find((device) => device.designation === "R1"),
    );
    const s2 = required(
      fixture.ir.devices.find((device) => device.designation === "S2"),
    );
    const outcome = await renderSchematicPacket(
      fixture.ir,
      dolPackets("p6", "top-to-bottom").combined,
    );
    if (!outcome.ok) throw Error(outcome.error.message);
    const { svg } = required(outcome.value.sheets[4]);
    const drawing = parseSvg(svg);
    const notes = [
      ...drawing.querySelectorAll('[data-peer-reference="conductor-peer"]'),
    ].filter((el) => el.getAttribute("data-peer-source")?.includes(w37.uid));
    expect(notes).toHaveLength(2);
    const r1Note = required(
      notes.find((el) => el.textContent?.includes("R1.14 → S2.14")),
    );
    const s2Note = required(
      notes.find((el) => el.textContent?.includes("S2.14 → R1.14")),
    );
    expect(r1Note.textContent).toMatch(
      /^W37 · R1\.14 → S2\.14 01\.[A-D][1-6] \(also shown 02\.[A-D][1-6]\)$/u,
    );
    expect(s2Note.textContent).toMatch(
      /^W37 · S2\.14 → R1\.14 06\.[A-D][1-6]$/u,
    );
    const r1Box = {
      x: Number(r1Note.getAttribute("x")),
      y: Number(r1Note.getAttribute("y")) - 2,
      w: 50,
      h: 2.5,
    };
    expect(
      boxDistance(r1Box, circuitTerminalBox(svg, r1.uid, "14")),
    ).toBeLessThan(boxDistance(r1Box, circuitTerminalBox(svg, r1.uid, "12")));
    const s2Box = {
      x: Number(s2Note.getAttribute("x")),
      y: Number(s2Note.getAttribute("y")) - 2,
      w: 34,
      h: 2.5,
    };
    expect(
      boxDistance(s2Box, circuitTerminalBox(svg, s2.uid, "14")),
    ).toBeLessThan(boxDistance(s2Box, circuitTerminalBox(svg, s2.uid, "13")));
  } finally {
    await fixture.dispose();
  }
});

it.each(flows)("rejects circuit coil ink mutant in %s", async (flow) => {
  const f = await dolProbeFixture("saved");
  try {
    const packet = await renderSchematicPacket(
      f.ir,
      dolPackets("saved", flow).circuit,
    );
    if (!packet.ok) throw Error(JSON.stringify(packet));
    const coilId = JSON.stringify([
      required(f.ir.devices.find((d) => d.designation === "R1")).uid,
      "coil",
    ]);
    const mutant = {
      ...packet.value,
      sheets: packet.value.sheets.map((sheet) => {
        const doc = parseSvg(sheet.svg);
        for (const mark of doc.querySelectorAll("[data-function-id]"))
          if (mark.getAttribute("data-function-id") === coilId) mark.remove();
        return { ...sheet, svg: doc.toString() };
      }),
    };
    // Device references and the claimed coverage survive; the actual coil does not.
    expect(
      mutant.sheets
        .flatMap((s) => s.references)
        .some((r) => r.designation === "R1"),
    ).toBe(true);
    expect(
      required(mutant.coverage.functions.find((e) => e.id === coilId))
        .appearances.length,
    ).toBeGreaterThan(0);
    rejectMutation(() =>
      assertPacketAudit(mutant, dolControlInventory(f.source, f.ir), true),
    );
  } finally {
    await f.dispose();
  }
});

const p6 = new Map<
  (typeof flows)[number],
  {
    inventory: ReturnType<typeof dolControlInventory>;
    selected: ReturnType<typeof selectedInventory>;
  }
>();
beforeAll(async () => {
  const f = await dolProbeFixture("p6");
  try {
    for (const flow of flows) {
      const raw = await renderSchematic(
        f.ir,
        dolPackets("p6", flow).K1.views[0] as SchematicViewRequest,
      );
      if (!raw.ok) throw Error(JSON.stringify(raw));
      p6.set(flow, {
        inventory: dolControlInventory(f.source, f.ir),
        selected: selectedInventory(f.ir, raw.value.summary),
      });
    }
  } finally {
    await f.dispose();
  }
});

it.each(
  ["W35", "W37", "W38", "W39", "R1.coil", "R1.contact14"].flatMap((identity) =>
    flows.map((flow) => ({ identity, flow })),
  ),
)("rejects P6 selection mutant $identity in $flow", ({ identity, flow }) => {
  const observed = required(p6.get(flow));
  const mutant = structuredClone(expected.p6.K1);
  if (identity.startsWith("W"))
    mutant.omittedWires = mutant.omittedWires.filter((w) => w !== identity);
  else
    mutant.omittedFunctions = mutant.omittedFunctions.filter(
      (f) => f !== identity,
    );
  rejectMutation(() =>
    assertRootedInventory(observed.selected, observed.inventory, mutant),
  );
});
