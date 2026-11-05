import { beforeAll, describe, expect, it } from "vitest";
import { SYMBOL_PROFILES } from "@thermite/schema";
import {
  symbolFunctionMatchesShape,
  type ElectricalIr,
} from "@thermite/compiler";
import { prepareCircuitView } from "../../render/src/circuit.js";
import { renderSchematic } from "../../render/src/renderer.js";
import { renderSchematicPacket } from "../../render/src/sheets.js";
import {
  circuitMark,
  emitCircuitMark,
} from "../../render/src/symbols/circuit.js";
import {
  coreTypes,
  isolatedMachine,
  machineProbe,
} from "./machine-fixtures.js";
import matrix from "./fixtures/machine-render-matrix.json";

let types: any[];
beforeAll(async () => {
  types = await coreTypes();
});
// P4's clone method: preserve physical identities and replace only the type ID.
// Kept here because L1 must not edit the render package, including its helpers.
function clone(ir: ElectricalIr, id: string) {
  const next = structuredClone(ir),
    type = next.deviceTypes.find((t) => t.id === id)!;
  type.id = id.replace("core:", "local:");
  for (const d of next.devices) if (d.typeId === id) d.typeId = type.id;
  next.indexes.instanceRefsByTypeId.find((e) => e.key === id)!.key = type.id;
  return next;
}

it("inventories every 0.2.0 type exactly once in the reviewed matrix", () => {
  expect(types.map((t) => t.id.slice(5)).sort()).toEqual(
    matrix.map((t) => t.type).sort(),
  );
  expect(types).toHaveLength(26);
});

for (const row of matrix)
  describe(`core:${row.type} / ${row.profile ?? "physical cable cores"}`, () => {
    it("conforms to the exact catalog function × family contract", () => {
      const type = types.find((t) => t.id === `core:${row.type}`)!;
      if (type.kind === "cable_type") {
        expect(row.reason).toContain(
          "cable_type has no profile/coverage fields",
        );
        expect(type.symbol).toBeUndefined();
        expect(type.connectionCoverage).toBeUndefined();
        return;
      }
      expect(type.symbol).toBe(row.profile);
      const profile = SYMBOL_PROFILES.find((p) => p.id === type.symbol)!;
      expect(profile).toBeDefined();
      if ("functionShapes" in row)
        expect(
          Object.fromEntries(
            Object.entries(type.functions).map(([key, f]: [string, any]) => [
              key,
              `${f.kind}/${f.terminals.length}`,
            ]),
          ),
        ).toEqual(row.functionShapes);
      for (const family of ["circuit", "power", "control", "loads"] as const) {
        const actual = Object.entries(type.functions)
          .filter(
            ([, f]: any) =>
              f.kind !== "mechanism" &&
              profile.support.some(
                (s) =>
                  s.family === family &&
                  s.functions.some((shape) =>
                    symbolFunctionMatchesShape(type, f, shape),
                  ),
              ),
          )
          .map(([key]) => key)
          .sort();
        expect(actual, `${type.id}/${family}`).toEqual(row.bindings![family]);
      }
    });
    it.each(["left-to-right", "top-to-bottom"] as const)(
      "renders all circuit functions and a packet in %s, including a new-ID clone",
      async (flow) => {
        const type = types.find((t) => t.id === `core:${row.type}`)!;
        const fixture = await isolatedMachine(type);
        try {
          expect(fixture.diagnostics.filter((d) => d.code === "W111")).toEqual(
            [],
          );
          const cable = type.kind === "cable_type";
          const functions = cable
            ? ["TB1", "TB2"].map((value) => ({
                device: { by: "designation" as const, value },
                key: "terminal1",
              }))
            : Object.entries(type.functions)
                .filter(([, f]: any) => f.kind !== "mechanism")
                .map(([key]) => ({
                  device: { by: "designation" as const, value: "DUT" },
                  key,
                }));
          const request = {
            format: "circuit-view-request/0.1" as const,
            title: row.type,
            flow,
            groups: [
              {
                id: "interface",
                label: "Generic interface",
                functions,
                conductors: cable
                  ? type.conductors.map((c: any) => `CBL1/${c.id}`)
                  : [],
              },
            ],
          };
          const circuit = await prepareCircuitView(fixture.ir, request);
          const expectedFunctionIds = fixture.ir.functions
            .filter((f) =>
              cable
                ? f.id.functionKey === "terminal1"
                : f.id.deviceUid ===
                    fixture.ir.devices.find((d) => d.designation === "DUT")!
                      .uid && f.kind !== "mechanism",
            )
            .map((f) => JSON.stringify([f.id.deviceUid, f.id.functionKey]))
            .sort();
          expect(
            circuit.groups.flatMap((g) => g.coverage.functionIds).sort(),
          ).toEqual(expectedFunctionIds);
          if (!cable) {
            const irType = fixture.ir.deviceTypes.find(
              (t) => t.id === type.id,
            )!;
            for (const f of fixture.ir.functions.filter(
              (f) =>
                f.id.deviceUid === fixture.ir.devices[0]!.uid &&
                f.kind !== "mechanism",
            )) {
              const mark = circuitMark(irType, f);
              expect(emitCircuitMark(mark, flow === "top-to-bottom")).toContain(
                `data-circuit-mark="${mark}"`,
              );
            }
            const cloned = await prepareCircuitView(
              clone(fixture.ir, type.id),
              request,
            );
            expect(
              JSON.stringify(cloned).replaceAll(
                type.id.replace("core:", "local:"),
                type.id,
              ) === JSON.stringify(circuit),
            ).toBe(true);
          } else {
            const conductors = await renderSchematic(fixture.ir, {
              format: "schematic-view-request/0.2",
              root: { by: "designation", value: "CBL1" },
              intent: { kind: "conductors" },
              flow,
            });
            expect(
              conductors.ok,
              JSON.stringify(conductors.ok ? {} : conductors),
            ).toBe(true);
          }
          const packet = await renderSchematicPacket(fixture.ir, {
            format: "schematic-packet-request/0.1",
            views: [request],
          });
          expect(packet.ok, JSON.stringify(packet.ok ? {} : packet)).toBe(true);
        } finally {
          await fixture.dispose();
        }
      },
      30000,
    );
    if (row.probes)
      for (const family of ["power", "control", "loads"] as const) {
        const expected = row.probes[family];
        it.each(["left-to-right", "top-to-bottom"] as const)(
          `${family}: ${expected.outcome} in %s`,
          async (flow) => {
            const type = types.find((t) => t.id === `core:${row.type}`)!;
            const fixture = await machineProbe(type, family, expected.key);
            try {
              const result = await renderSchematic(fixture.ir, {
                ...fixture.request,
                flow,
              });
              expect(
                result.ok,
                `${type.id}/${family}: ${JSON.stringify(result.ok ? {} : result)}`,
              ).toBe(expected.outcome === "renders");
              if (result.ok) {
                if (type.kind === "cable_type")
                  expect(result.value.svg).toContain(fixture.ir.cables[0]!.uid);
                else
                  expect(result.value.summary.deviceUids).toContain(
                    fixture.ir.devices.find((d) => d.designation === "DUT")!
                      .uid,
                  );
              } else {
                expect(result.error.code).toBe(expected.code);
                expect(
                  "reason" in result.error ? result.error.reason : null,
                ).toBe(expected.reason);
                if (expected.reason === "unsupported-symbol-profile")
                  expect(result.error).toMatchObject({
                    unsupported: {
                      designation: "DUT",
                      typeId: type.id,
                      profile: type.symbol,
                      functionKey: expected.functionKey,
                      family: family === "loads" ? "control" : family,
                    },
                  });
                else expect(result.error.message).toBe(expected.message);
              }
            } finally {
              await fixture.dispose();
            }
          },
          30000,
        );
      }
  });
