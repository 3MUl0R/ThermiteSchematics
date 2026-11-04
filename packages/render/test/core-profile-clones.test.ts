import { beforeAll, describe, expect, it } from "vitest";
import { CORE_SYMBOL_BINDINGS } from "@thermite/schema";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import { readFile } from "node:fs/promises";
import { buildDocumentation } from "@thermite/query";
import { renderSchematicPacket } from "../src/sheets.js";
import { renderSchematic } from "../src/renderer.js";
import { prepareCircuitView } from "../src/circuit.js";
import { compileCoreFixture, pnpTraceFixture } from "./fixtures.js";
import {
  CORE_DEVICE_TYPE_SYMBOL_MAPPINGS,
  projectDeviceTypeSymbolMappings,
} from "../src/symbols/mappings.js";
let core: ElectricalIr;
beforeAll(async () => {
  core = await compileCoreFixture();
});
// Preserve instance UUIDs, designations and every electrical object. Only the type
// ID changes. Normalize that ID in serialized drawings; no geometry/labels removed.
function clone(ir: ElectricalIr, id: string, symbol?: string) {
  const v = structuredClone(ir),
    t = v.deviceTypes.find((t) => t.id === id)!;
  t.id = id.replace("core:", "local:");
  if (symbol) t.symbol = symbol;
  for (const d of v.devices) if (d.typeId === id) d.typeId = t.id;
  v.indexes.instanceRefsByTypeId.find((e) => e.key === id)!.key = t.id;
  return v;
}
const requests = [
  {
    format: "schematic-view-request/0.1",
    root: { by: "designation", value: "M1" },
    family: "power",
  },
  {
    format: "schematic-view-request/0.1",
    root: { by: "designation", value: "K1" },
    family: "control",
  },
  {
    format: "schematic-view-request/0.2",
    root: { by: "designation", value: "PS1" },
    intent: { kind: "loads" },
  },
  {
    format: "schematic-view-request/0.2",
    root: { by: "designation", value: "LS1" },
    intent: {
      kind: "trace",
      to: { by: "designation", value: "PLC1" },
      includePower: true,
    },
  },
] as const;
describe("core profile clone matrix", () => {
  for (const binding of CORE_SYMBOL_BINDINGS)
    for (const variant of ["IEC", "profile"] as const) {
      it(`${binding.typeId} / ${variant} matches every supported family and flow`, async () => {
        const symbol =
          variant === "profile"
            ? (binding.equivalent ?? "thermite:sensor-3wire")
            : undefined;
        const originalIr =
          binding.typeId === "core:prox-pnp-3wire"
            ? pnpTraceFixture(core)
            : core;
        const changed = clone(originalIr, binding.typeId, symbol);
        for (const flow of ["left-to-right", "top-to-bottom"] as const) {
          for (const request of requests) {
            const original = await renderSchematic(originalIr, {
              ...request,
              flow,
            });
            expect(original.ok, JSON.stringify(original)).toBe(true);
            const actual = await renderSchematic(changed, { ...request, flow });
            expect(actual.ok, JSON.stringify(actual)).toBe(true);
            if (original.ok && actual.ok)
              expect(
                JSON.stringify(actual.value).replaceAll(
                  binding.typeId.replace("core:", "local:"),
                  binding.typeId,
                ),
              ).toBe(JSON.stringify(original.value));
          }
          const instances = originalIr.devices.filter(
            (d) => d.typeId === binding.typeId,
          );
          for (const device of instances) {
            const type = originalIr.deviceTypes.find(
              (t) => t.id === binding.typeId,
            )!;
            const request = {
              format: "circuit-view-request/0.1" as const,
              title: "Clone matrix",
              flow,
              groups: [
                {
                  id: "g",
                  label: "Device",
                  functions: type.functions
                    .filter((f) => f.kind !== "mechanism")
                    .map((f) => ({
                      device: {
                        by: "designation" as const,
                        value: device.designation!,
                      },
                      key: f.key,
                    })),
                  conductors: [],
                },
              ],
            };
            const original = await prepareCircuitView(originalIr, request);
            const actual = await prepareCircuitView(changed, request);
            expect(
              JSON.stringify(actual).replaceAll(
                binding.typeId.replace("core:", "local:"),
                binding.typeId,
              ),
            ).toBe(JSON.stringify(original));
          }
        }
      }, 30000);
    }
  it("preserves all existing rooted core bindings (PSU AC input is additive)", () => {
    const mappings = projectDeviceTypeSymbolMappings(core);
    expect(mappings).toHaveLength(12);
    for (const expected of CORE_DEVICE_TYPE_SYMBOL_MAPPINGS) {
      const actual = mappings.find((m) => m.typeId === expected.typeId)!;
      expect(
        actual.functions.filter((f) => f.functionKey !== "ac_input"),
      ).toEqual(expected.functions);
      expect(actual.aggregates).toEqual(expected.aggregates);
      expect(actual.boundaryTerminals).toEqual(expected.boundaryTerminals);
      const omissions = (m: typeof expected) =>
        m.omissions
          .filter((f) => f.functionKey !== "ac_input")
          .toSorted((a, b) =>
            a.functionKey < b.functionKey
              ? -1
              : a.functionKey > b.functionKey
                ? 1
                : 0,
          );
      expect(omissions(actual)).toEqual(omissions(expected));
    }
  });
});

describe("automatic terminal-plan profile clones", () => {
  it.each(["IEC", "profile"] as const)(
    "preserves the complete machine-demo packet and eight references per strip for %s",
    async (variant) => {
      const c = await compileProject("examples/machine-demo");
      if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
      let changed = structuredClone(c.ir);
      for (const id of CORE_SYMBOL_BINDINGS.map((b) => b.typeId))
        changed = clone(
          changed,
          id,
          variant === "profile"
            ? CORE_SYMBOL_BINDINGS.find((b) => b.typeId === id)!.equivalent
            : undefined,
        );
      const request = {
        format: "documentation-view-request/0.1" as const,
        kind: "terminals" as const,
      };
      const original = buildDocumentation(c.ir, request),
        actual = buildDocumentation(changed, request);
      for (const id of ["core:terminal-block-8", "core:junction-box-8"]) {
        const d = c.ir.devices.find((d) => d.typeId === id)!;
        expect(
          original.rows.filter((r) => JSON.parse(r.key)[0] === d.uid),
        ).toHaveLength(8);
        expect(
          actual.rows.filter((r) => JSON.parse(r.key)[0] === d.uid),
        ).toHaveLength(8);
      }
      expect(actual).toEqual(original);
      const packet = JSON.parse(
        await readFile("examples/machine-demo/packet.request.json", "utf8"),
      );
      const before = await renderSchematicPacket(c.ir, packet, c.presentation),
        after = await renderSchematicPacket(changed, packet, c.presentation);
      expect(before.ok, JSON.stringify(before)).toBe(true);
      expect(after.ok, JSON.stringify(after)).toBe(true);
      const normalized = CORE_SYMBOL_BINDINGS.reduce(
        (json, b) =>
          json.replaceAll(b.typeId.replace("core:", "local:"), b.typeId),
        JSON.stringify(after),
      );
      // A boolean comparison keeps a failure from dumping the entire packet.
      expect(normalized === JSON.stringify(before)).toBe(true);
    },
    30000,
  );
});
