import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileProject, lockProject } from "@thermite/compiler";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { expect, it } from "vitest";
import { renderSchematicPacket } from "../src/index.js";
import { createElkEngine } from "../src/layout/elk-runtime.js";
import { ELK_OPTIONS } from "../src/layout/options.js";
import {
  checkLabelPairOverlap,
  createNetLabelCollisionReport,
  recordNetLabelCollision,
} from "../src/layout/label-overlaps.js";
import { prepareSchematicDrawing } from "../src/renderer.js";
import type {
  NormalizedSchematicLayout,
  PresentationGraph,
} from "../src/types.js";
import { observedRecoveryEngine } from "./helpers/agent-recovery.js";

function paintedNetLabelTexts(svg: string): string[] {
  return [
    ...svg.matchAll(
      /<text\b[^>]*\bclass="label-text label-net"[^>]*>([^<]*)<\/text>/gu,
    ),
  ]
    .map((m) => m[1]!)
    .filter((text) => text.length > 0)
    .sort();
}

async function pumpVariantObjects(
  phaseNames?: readonly [string, string, string],
): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(
    await readFile(
      resolve(import.meta.dirname, "fixtures/agent-refusals/pump.json"),
      "utf8",
    ),
  );
  if (typeof raw !== "object" || raw === null || !("objects" in raw)) {
    throw new Error("Invalid pump fixture");
  }
  const { objects } = raw;
  if (!Array.isArray(objects)) throw new Error("Invalid pump fixture objects");
  if (phaseNames) {
    const byTerm = new Map([
      ["L1", phaseNames[0]],
      ["L2", phaseNames[1]],
      ["L3", phaseNames[2]],
    ]);
    for (const obj of objects) {
      if (
        typeof obj !== "object" ||
        obj === null ||
        !("kind" in obj) ||
        obj.kind !== "potential" ||
        !("at" in obj) ||
        typeof obj.at !== "object" ||
        obj.at === null ||
        !("device" in obj.at) ||
        obj.at.device !== "SUP1" ||
        !("terminal" in obj.at) ||
        typeof obj.at.terminal !== "string"
      ) {
        continue;
      }
      const next = byTerm.get(obj.at.terminal);
      if (next !== undefined && "name" in obj) obj.name = next;
    }
  }
  return { objects };
}

async function compileVariantFixture(
  tag: string,
  phaseNames?: readonly [string, string, string],
) {
  const root = await mkdtemp(join(tmpdir(), `thermite-netlabel-r3-${tag}-`));
  await writeFile(
    join(root, "system.json"),
    `${JSON.stringify(
      {
        format: "electrical-system/0.1",
        project: { name: `Synthetic ${tag}` },
        sources: ["source.json"],
        libraries: [{ name: "core", version: "0.2.0" }],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(root, "source.json"),
    `${JSON.stringify(await pumpVariantObjects(phaseNames), null, 2)}\n`,
  );
  const locked = await lockProject(root);
  assert.ok(locked.ok, JSON.stringify(locked));
  const compiled = await compileProject(root);
  assert.ok(compiled.ok, JSON.stringify(compiled));
  return {
    ir: compiled.ir,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function assertSourceTailLabels(
  graph: Readonly<PresentationGraph>,
  layout: Readonly<NormalizedSchematicLayout>,
  expectedNames: readonly string[],
) {
  const netLabels = layout.labels.filter(
    (label) => label.role === "net" && label.ownerKind === "edge",
  );
  expect(netLabels.map((label) => label.text).sort()).toEqual(expectedNames);
  const nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
  const deviceFrames = layout.nodes.filter((node) => node.kind === "device");
  for (const label of netLabels) {
    const edge = graph.edges.find(
      (candidate) => candidate.id === label.ownerId,
    );
    assert.ok(edge);
    const sourceNode = graph.nodes.find((node) =>
      node.ports.some((port) => port.id === edge.sourcePortId),
    );
    const ownerDeviceId =
      sourceNode?.kind === "symbol" ? sourceNode.deviceGroupId : undefined;
    for (const frame of deviceFrames) {
      if (frame.id === ownerDeviceId) continue;
      const overlaps =
        Math.min(label.x + label.width, frame.x + frame.width) >
          Math.max(label.x, frame.x) &&
        Math.min(label.y + label.height, frame.y + frame.height) >
          Math.max(label.y, frame.y);
      expect(overlaps, `${label.text} overlaps ${frame.id}`).toBe(false);
    }
    const route = layout.edges.find((candidate) => candidate.id === edge.id);
    assert.ok(route);
    const start = route.points[0]!;
    const end = route.points[route.points.length - 1]!;
    const cx = label.x + label.width / 2;
    const cy = label.y + label.height / 2;
    expect(Math.hypot(cx - start.x, cy - start.y)).toBeLessThan(
      Math.hypot(cx - end.x, cy - end.y),
    );
    expect(nodesById.size).toBeGreaterThan(0);
  }
}

const VARIANT_CASES = [
  ["original", undefined, 2, ["L1 480VAC", "L2 480VAC", "L3 480VAC"]],
  [
    "MCC-480V",
    ["MCC-480V-L1", "MCC-480V-L2", "MCC-480V-L3"],
    2,
    ["MCC-480V-L1", "MCC-480V-L2", "MCC-480V-L3"],
  ],
  [
    "MAIN-480VAC",
    ["MAIN-480VAC-L1", "MAIN-480VAC-L2", "MAIN-480VAC-L3"],
    3,
    ["MAIN-480VAC-L1", "MAIN-480VAC-L2", "MAIN-480VAC-L3"],
  ],
  [
    "480VAC-MCC1",
    ["480VAC-MCC1-L1", "480VAC-MCC1-L2", "480VAC-MCC1-L3"],
    3,
    ["480VAC-MCC1-L1", "480VAC-MCC1-L2", "480VAC-MCC1-L3"],
  ],
  [
    "PANEL-A-480VAC",
    ["PANEL-A-480VAC-L1", "PANEL-A-480VAC-L2", "PANEL-A-480VAC-L3"],
    3,
    ["PANEL-A-480VAC-L1", "PANEL-A-480VAC-L2", "PANEL-A-480VAC-L3"],
  ],
  [
    "SUP1-MAIN-BUS-480V",
    ["SUP1-MAIN-BUS-480V-L1", "SUP1-MAIN-BUS-480V-L2", "SUP1-MAIN-BUS-480V-L3"],
    4,
    ["SUP1-MAIN-BUS-480V-L1", "SUP1-MAIN-BUS-480V-L2", "SUP1-MAIN-BUS-480V-L3"],
  ],
  [
    "SUP1-MAIN-BUS-480VAC",
    [
      "SUP1-MAIN-BUS-480VAC-L1",
      "SUP1-MAIN-BUS-480VAC-L2",
      "SUP1-MAIN-BUS-480VAC-L3",
    ],
    4,
    [
      "SUP1-MAIN-BUS-480VAC-L1",
      "SUP1-MAIN-BUS-480VAC-L2",
      "SUP1-MAIN-BUS-480VAC-L3",
    ],
  ],
  [
    "MAIN-PANEL-480VAC-BUS",
    [
      "MAIN-PANEL-480VAC-BUS-L1",
      "MAIN-PANEL-480VAC-BUS-L2",
      "MAIN-PANEL-480VAC-BUS-L3",
    ],
    4,
    [
      "MAIN-PANEL-480VAC-BUS-L1",
      "MAIN-PANEL-480VAC-BUS-L2",
      "MAIN-PANEL-480VAC-BUS-L3",
    ],
  ],
  [
    "MCC1-PANEL-480VAC",
    ["MCC1-PANEL-480VAC-L1", "MCC1-PANEL-480VAC-L2", "MCC1-PANEL-480VAC-L3"],
    3,
    ["MCC1-PANEL-480VAC-L1", "MCC1-PANEL-480VAC-L2", "MCC1-PANEL-480VAC-L3"],
  ],
] as const;

it.each(VARIANT_CASES)(
  "issues TTB Letter landscape power packet within sheet budget for %s (#570 review)",
  async (tag, phaseNames, maxSheets, expectedPainted) => {
    const fixture = await compileVariantFixture(tag, phaseNames);
    try {
      const observed = observedRecoveryEngine();
      const request = {
        format: "schematic-view-request/0.1" as const,
        root: { by: "designation" as const, value: "M1" },
        family: "power" as const,
        flow: "top-to-bottom" as const,
      };
      const prepared = await prepareSchematicDrawing(
        fixture.ir,
        request,
        undefined,
        { layoutEngine: observed.engine },
      );
      assert.ok(prepared.ok, JSON.stringify(prepared));
      for (const call of observed.inputs) {
        for (const edge of call.edges ?? []) {
          for (const label of edge.labels ?? []) {
            if (!label.id?.endsWith(',"net"]')) continue;
            expect(label.layoutOptions?.[ELK_OPTIONS.edgeLabelsPlacement]).toBe(
              "TAIL",
            );
          }
        }
      }
      assertSourceTailLabels(
        prepared.value.graph,
        prepared.value.layout,
        [...expectedPainted, "PE"].sort(),
      );
      const packet = await renderSchematicPacket(fixture.ir, {
        format: "schematic-packet-request/0.1",
        page: { size: "letter", orientation: "landscape" },
        views: [request],
      });
      assert.ok(packet.ok, JSON.stringify(packet));
      expect(packet.value.sheets.length).toBeLessThanOrEqual(maxSheets);
      const painted = packet.value.sheets.flatMap((s) =>
        paintedNetLabelTexts(s.svg),
      );
      for (const name of expectedPainted) expect(painted).toContain(name);
    } finally {
      await fixture.dispose();
    }
  },
);

function injectNetLabelRouteOverlap(out: ElkNode) {
  const edge = out.edges?.find((e) =>
    e.labels?.some((l) => l.id?.endsWith(',"net"]')),
  );
  const label = edge?.labels?.find((l) => l.id?.endsWith(',"net"]'));
  const section = edge?.sections?.[0];
  assert.ok(label && section);
  const a = section.startPoint;
  const b = section.bendPoints?.[0] ?? section.endPoint;
  label.x = (a.x + b.x) / 2 - (label.width ?? 0) / 2;
  label.y = (a.y + b.y) / 2 - (label.height ?? 0) / 2;
}

it("does not add unrelated edge-net/function pairs to collidingNetLabelIds after another collision (#570 review)", async () => {
  const fixture = await compileVariantFixture("label-overlap-filter");
  try {
    const prepared = await prepareSchematicDrawing(fixture.ir, {
      format: "schematic-view-request/0.1",
      root: { by: "designation", value: "M1" },
      family: "power",
      flow: "top-to-bottom",
    });
    assert.ok(prepared.ok);
    const { graph, layout } = prepared.value;
    const edgeNetLabel = layout.labels.find(
      (l) => l.role === "net" && l.ownerKind === "edge",
    );
    const functionLabel = layout.labels.find((l) => l.role === "function");
    const terminalLabel = layout.labels.find((l) => l.role === "terminal");
    assert.ok(edgeNetLabel && functionLabel && terminalLabel);
    const reject = (message: string): never => {
      throw new Error(message);
    };

    const unrelatedReport = createNetLabelCollisionReport();
    recordNetLabelCollision(
      unrelatedReport,
      "label-unrelated",
      "unrelated measured conductor collision",
      "net-unrelated",
    );
    expect(() =>
      checkLabelPairOverlap(
        graph,
        edgeNetLabel,
        functionLabel,
        unrelatedReport,
        reject,
      ),
    ).toThrow(`labels ${edgeNetLabel.id} and ${functionLabel.id} overlap`);
    expect([...unrelatedReport.labelIds]).toEqual(["label-unrelated"]);

    // Edge net label overlapping a terminal marking is deliberately classified
    // as a net-label collision so TTB source widening can resolve it.
    const terminalReport = createNetLabelCollisionReport();
    checkLabelPairOverlap(
      graph,
      edgeNetLabel,
      terminalLabel,
      terminalReport,
      reject,
    );
    expect([...terminalReport.labelIds]).toEqual([edgeNetLabel.id]);
  } finally {
    await fixture.dispose();
  }
});

it("retains distinct retry failure diagnostic context when widened TTB retry also fails (#570 review)", async () => {
  const fixture = await compileVariantFixture("retry-context");
  try {
    const request = {
      format: "schematic-view-request/0.1" as const,
      root: { by: "designation" as const, value: "M1" },
      family: "power" as const,
      flow: "top-to-bottom" as const,
    };

    const runWithRetryFault = async (
      injectRetryFault: (out: ElkNode) => void,
    ) => {
      const engine = createElkEngine();
      const baseLayout = engine.layout.bind(engine);
      let calls = 0;
      engine.layout = async (input, ...args) => {
        const out = await baseLayout(input, ...args);
        if (++calls === 2) injectRetryFault(out);
        return out;
      };
      const result = await prepareSchematicDrawing(
        fixture.ir,
        request,
        undefined,
        { layoutEngine: engine },
      );
      expect(calls).toBe(2);
      assert.ok(!result.ok);
      return result.error;
    };

    const contractErr = await runWithRetryFault((out) => {
      out.id = "wrong-root";
    });
    const labelErr = await runWithRetryFault(injectNetLabelRouteOverlap);

    expect(contractErr.code).toBe("R004");
    expect(labelErr.code).toBe("R004");
    expect(contractErr.message).not.toBe(labelErr.message);
    expect(contractErr.message).toContain("returned root ID changed");
    expect(labelErr.message).toContain("overlaps edge");
    expect(contractErr.details?.widenedRetryFailure).toMatchObject({
      failureKind: "contract-violation",
    });
    expect(labelErr.details?.widenedRetryFailure).toMatchObject({
      failureKind: "net-label-intersection",
    });
  } finally {
    await fixture.dispose();
  }
});
