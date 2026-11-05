import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { renderSchematicPacket } from "../../render/src/sheets.js";
import { renderSchematic } from "../../render/src/renderer.js";
import { prepareCircuitView } from "../../render/src/circuit.js";
import {
  disconnectCircuit,
  signalPacket,
  writeGapProject,
} from "./automation-gap-fixtures.js";

it.each(["left-to-right", "top-to-bottom"] as const)(
  "pins R006 for a series-powered passive-input loop, with and without an auxiliary pair, in %s",
  async (flow) => {
    const root = await mkdtemp(join(tmpdir(), "thermite-loop-gap-"));
    try {
      const compiled = await writeGapProject(root, "loop");
      expect(compiled.diagnostics.filter((d) => d.severity !== "info")).toEqual(
        [],
      );
      for (const auxiliary of [false, true]) {
        const request = signalPacket(auxiliary);
        const result = await renderSchematicPacket(compiled.ir, {
          ...request,
          views: request.views.map((v) => ({ ...v, flow })),
        });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "R006",
            reason: "unprintable-layout",
            message:
              'Packet view[0] "Untitled view": No complete conductive path from TX1.+ to the selected destination function.',
          },
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["left-to-right", "top-to-bottom"] as const)(
  "pins the disconnect's plain NO circuit marks and missing power binding in %s",
  async (flow) => {
    const root = await mkdtemp(join(tmpdir(), "thermite-disconnect-gap-"));
    try {
      const compiled = await writeGapProject(root, "disconnect");
      expect(compiled.diagnostics.filter((d) => d.severity !== "info")).toEqual(
        [],
      );
      const circuit = await prepareCircuitView(compiled.ir, {
        ...disconnectCircuit,
        flow,
      });
      expect(
        circuit.groups.flatMap((g) =>
          [...g.content.matchAll(/data-circuit-mark="([^"]+)"/g)].map(
            (m) => m[1],
          ),
        ),
      ).toEqual(["switch-no", "switch-no", "switch-no"]);
      const power = await renderSchematic(compiled.ir, {
        format: "schematic-view-request/0.1",
        root: { by: "designation", value: "M1" },
        family: "power",
        flow,
      });
      expect(power).toMatchObject({
        ok: false,
        error: {
          code: "R002",
          reason: "unsupported-symbol-profile",
          unsupported: {
            designation: "DS1",
            typeId: "core:disconnect-3p",
            profile: "thermite:switch",
            functionKey: "pole1",
            family: "power",
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
