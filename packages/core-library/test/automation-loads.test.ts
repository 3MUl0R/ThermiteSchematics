import { expect, it } from "vitest";
import { compileProject } from "@thermite/compiler";
import { coreTypes, machineProbe } from "./machine-fixtures.js";
import { renderSchematic } from "../../render/src/renderer.js";

it.each(["left-to-right", "top-to-bottom"] as const)(
  "renders RM1's core-only power, actuation and PS1 loads deliverables in %s",
  async (flow) => {
    const compiled = await compileProject(
      "packages/core-library/test/fixtures/rm1",
    );
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    expect(compiled.diagnostics.filter((d) => d.severity !== "info")).toEqual(
      [],
    );
    expect(compiled.ir.devices.every((d) => d.typeId.startsWith("core:"))).toBe(
      true,
    );
    for (const [root, family] of [
      ["M1", "power"],
      ["K1", "control"],
    ] as const) {
      const result = await renderSchematic(compiled.ir, {
        format: "schematic-view-request/0.1",
        root: { by: "designation", value: root },
        family,
        flow,
      });
      expect(result.ok, JSON.stringify(result.ok ? {} : result)).toBe(true);
    }
    const result = await renderSchematic(compiled.ir, {
      format: "schematic-view-request/0.2",
      root: { by: "designation", value: "PS1" },
      intent: { kind: "loads" },
      flow,
    });
    expect(result.ok, JSON.stringify(result.ok ? {} : result)).toBe(true);
    if (!result.ok) throw Error(result.error.message);
    expect(result.value.summary.deviceUids).toContain(
      compiled.ir.devices.find((d) => d.designation === "PLC1")?.uid,
    );
  },
);

it.each(["left-to-right", "top-to-bottom"] as const)(
  "pins RM3's combined-load layout gap and each supply binding in %s",
  async (flow) => {
    const compiled = await compileProject(
      "packages/core-library/test/fixtures/rm3",
    );
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    const result = await renderSchematic(compiled.ir, {
      format: "schematic-view-request/0.2",
      root: { by: "designation", value: "PS1" },
      intent: { kind: "loads" },
      flow,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "R004",
        details: {
          conductors: [{ designation: "W1012" }, { designation: "W1014" }],
          loads: [
            { designation: "B1" },
            { designation: "HMI1" },
            { designation: "PLC1" },
          ],
        },
      },
    });
    // The combined-view routing defect is independent of these supply bindings.
    // Probe each exact RM3 type alone without changing the committed topology.
    const types = await coreTypes();
    for (const name of ["HMI1", "PLC1"]) {
      const typeId = compiled.ir.devices.find(
        (d) => d.designation === name,
      )?.typeId;
      const fixture = await machineProbe(
        types.find((t) => t.id === typeId),
        "loads",
        "supply",
      );
      try {
        const single = await renderSchematic(fixture.ir, {
          ...fixture.request,
          flow,
        });
        expect(single.ok, JSON.stringify(single.ok ? {} : single)).toBe(true);
        if (!single.ok) throw Error(single.error.message);
        expect(single.value.summary.functionIds).toContainEqual({
          deviceUid: fixture.ir.devices.find((d) => d.designation === "DUT")
            ?.uid,
          functionKey: "supply",
        });
      } finally {
        await fixture.dispose();
      }
    }
  },
);
