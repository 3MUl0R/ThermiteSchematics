import { reviewedTransformerInk } from "../../render/test/helpers/transformer-endpoint-ink.js";
import { assertRayWeights } from "../../render/test/helpers/attachment-weights.js";
import { readFile } from "node:fs/promises";
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
import { dolProbeFixture } from "../../render/test/dol-control-probes-fixture.js";

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
    // Preserve the reviewed geometry/complete-ink hash across the intentional
    // frame and attachment style changes. Physical ink is asserted separately.
    const reviewedContent = reviewedTransformerInk(view.groups[0]!.content);
    expect(view.groups[0]!.content).toContain('data-layout-source-port="');
    // Catalog attachment ink follows selected ports now; retain the original
    // reviewed geometry hash while independently requiring incident wire ink.
    assertRayWeights(view.groups[0]!.content);
    const originalOutlineInk = reviewedContent
      .replace(
        /(<g data-terminal-attachment="[^"]*" data-attachment-from="[^"]*" data-attachment-to="[^"]*"><path [^>]+stroke="white"[^>]*\/><path [^>]+stroke="#17212b" stroke-width=")[^"]+(?=")/gu,
        "$1.35",
      )
      .replace(
        /(<rect class="circuit-device-frame"[^>]*?)stroke="#667085" stroke-width="0.25"/gu,
        '$1stroke="#17212b" stroke-width="0.4"',
      )
      .replace(
        /(<g data-terminal-attachment="[^"]*" data-attachment-from="[^"]*" data-attachment-to="[^"]*"><path [^>]*fill="none") stroke="#17212b" stroke-width="0.32"/gu,
        '$1 stroke="#344054" stroke-width="0.3"',
      );
    expect(originalOutlineInk).not.toBe(reviewedContent);
    expect(createHash("sha256").update(originalOutlineInk).digest("hex")).toBe(
      flow === "left-to-right"
        ? "e9d8fc41133ff295005f7a83877e09c16326e6f21a9eba84e593b7b1d94ac00c"
        : "ffdb1a46186da48a93d745be679841eced74a2589027d6f38fa5dd30df974141",
    );
    const r = await renderSchematic(c.ir, transformerRequest(flow));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  },
);
it("keeps P7 validate-only with its exact current I305 diagnostic", async () => {
  const fixture = await dolProbeFixture("p7");
  try {
    expect(fixture.diagnostics).toEqual(p7);
  } finally {
    await fixture.dispose();
  }
});
