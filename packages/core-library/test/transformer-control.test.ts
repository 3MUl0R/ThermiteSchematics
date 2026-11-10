import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { compileProject, analyzeCompleteness } from "@thermite/compiler";
import { prepareCircuitView } from "../../render/src/circuit.js";
import { renderSchematic } from "../../render/src/renderer.js";
import {
  transformerRoot,
  transformerFlows,
  transformerRequest,
} from "../../render/test/transformer-control-fixture.js";
import p7 from "./fixtures/transformer-control/p7-diagnostics.json";

it.each(transformerFlows)(
  "uses shipped unrated facts and preserves the complete circuit in %s",
  async (flow) => {
    const c = await compileProject(transformerRoot);
    if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
    expect(c.diagnostics).toEqual([]);
    expect(c.ir.devices.some((d) => d.designation === "K1")).toBe(false);
    const source = JSON.parse(
      await readFile(join(transformerRoot, "source.json"), "utf8"),
    );
    expect(JSON.stringify(source)).not.toMatch(/"rating"/);
    for (const id of [
      "core:control-transformer",
      "core:relay-1co",
      "core:pilot-light",
    ]) {
      const t = c.ir.deviceTypes.find((t) => t.id === id)!;
      expect(t.terminals.every((t) => t.rating === undefined)).toBe(true);
    }
    expect(
      analyzeCompleteness(c.ir).findings.filter((f) =>
        ["W903", "W904"].includes(f.code),
      ),
    ).toEqual([]);
    const functions = [
      ["XT1", "terminal1"],
      ["XT1", "terminal2"],
      ["T1", "primary"],
      ["T1", "secondary"],
      ["R1", "coil"],
      ["H1", "lamp"],
    ].map(([value, key]) => ({
      device: { by: "designation" as const, value: value! },
      key: key!,
    }));
    const view = await prepareCircuitView(c.ir, {
      format: "circuit-view-request/0.1",
      title: "Unrated transformer control",
      flow,
      groups: [
        {
          id: "unrated-control",
          label: "Unrated secondary, coil and indication",
          functions,
          conductors: ["W1", "W2", "W3", "W4", "W5", "W6"],
        },
      ],
    });
    expect(view.groups[0]!.coverage.conductorIds).toHaveLength(6);
    expect(view.groups[0]!.coverage.functionIds).toHaveLength(6);
    expect(
      createHash("sha256").update(view.groups[0]!.content).digest("hex"),
    ).toBe(
      flow === "left-to-right"
        ? "ec455e7070ab8ae79b60b8a9e573d42c9646269305da3a3201b1d41609f24284"
        : "425becd9675ab313708f67a8b3832c5455a1b0f4734dfedc1aa38ab40ad85e67",
    );
    const r = await renderSchematic(c.ir, transformerRequest(flow));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  },
);
it("keeps P7 validate-only with its exact current I305 diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "thermite-p7-"));
  try {
    await cp("packages/core-library/test/fixtures/dol-starter", root, {
      recursive: true,
    });
    const file = join(root, "source.json"),
      s = JSON.parse(await readFile(file, "utf8"));
    for (const o of s.objects) {
      if (o.designation === "W30")
        o.endpoints[0] = { device: "T1", terminal: "X1" };
      if (["W40", "W41", "W42"].includes(o.designation))
        o.endpoints[0] = { device: "T1", terminal: "X2" };
    }
    await writeFile(file, JSON.stringify(s));
    const c = await compileProject(root);
    expect(c.ok).toBe(true);
    expect(c.diagnostics).toEqual(p7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
