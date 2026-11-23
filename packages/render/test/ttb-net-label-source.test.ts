import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject, lockProject } from "@thermite/compiler";
import { expect, it } from "vitest";
import {
  createSchematicRendererWithDependencies,
  prepareSchematicDrawing,
} from "../src/renderer.js";
import { ELK_OPTIONS } from "../src/layout/options.js";
import { observedRecoveryEngine } from "./helpers/agent-recovery.js";
import type {
  LayoutEdge,
  LayoutLabel,
  LayoutNode,
  NormalizedSchematicLayout,
  PresentationGraph,
} from "../src/types.js";

function systemJson(name: string) {
  return {
    format: "electrical-system/0.1",
    project: { name },
    sources: ["source.json"],
    libraries: [{ name: "core", version: "0.2.0" }],
  };
}

function powerPhaseObjects(withBreaker: boolean) {
  const phases = [
    ["L1", "1/L1", "2/T1", "U", "480VAC-L1", "101"],
    ["L2", "3/L2", "4/T2", "V", "480VAC-L2", "102"],
    ["L3", "5/L3", "6/T3", "W", "480VAC-L3", "103"],
  ] as const;
  return phases.flatMap(([sup, cbIn, cbOut, motor, pot, wireNo], index) => {
    const n = index + 1;
    const wires = withBreaker
      ? [
          {
            uid: `4444444${n}-4444-4444-8444-444444444570`,
            kind: "wire",
            designation: `W-PWR-00${n}`,
            endpoints: [
              { device: "SUP1", terminal: sup },
              { device: "CB1", terminal: cbIn },
            ],
            properties: { label: sup },
          },
          {
            uid: `5555555${n}-5555-4555-8555-555555555570`,
            kind: "wire",
            designation: `W-PWR-01${n}`,
            endpoints: [
              { device: "CB1", terminal: cbOut },
              { device: "M1", terminal: motor },
            ],
            properties: { label: wireNo },
          },
        ]
      : [
          {
            uid: `4444444${n}-4444-4444-8444-444444444570`,
            kind: "wire",
            designation: `W-PWR-00${n}`,
            endpoints: [
              { device: "SUP1", terminal: sup },
              { device: "M1", terminal: motor },
            ],
            properties: { label: sup },
          },
        ];
    return [
      ...wires,
      {
        uid: `6666666${n}-6666-4666-8666-666666666570`,
        kind: "potential",
        name: pot,
        at: { device: "SUP1", terminal: sup },
        electrical: { nominal_voltage: 480, voltage_type: "AC" },
      },
    ];
  });
}

function powerSourceToMotorObjects(withBreaker: boolean) {
  return {
    objects: [
      {
        uid: "11111111-1111-4111-8111-111111111570",
        kind: "device",
        designation: "SUP1",
        type: "core:supply-480v-3ph",
        location: "MAIN-PANEL",
      },
      {
        uid: "33333333-3333-4333-8333-333333333570",
        kind: "device",
        designation: "M1",
        type: "core:motor-3ph",
        location: "FIELD",
      },
      ...(withBreaker
        ? [
            {
              uid: "22222222-2222-4222-8222-222222222570",
              kind: "device",
              designation: "CB1",
              type: "core:breaker-3p",
              location: "MAIN-PANEL",
            },
          ]
        : []),
      ...powerPhaseObjects(withBreaker),
      {
        uid: "44444449-4444-4444-8444-444444444570",
        kind: "wire",
        designation: "W-PWR-PE",
        endpoints: [
          { device: "SUP1", terminal: "PE" },
          { device: "M1", terminal: "PE" },
        ],
        properties: { label: "PE" },
      },
      {
        uid: "66666669-6666-4666-8666-666666666570",
        kind: "potential",
        name: "PE",
        at: { device: "SUP1", terminal: "PE" },
        electrical: { nominal_voltage: 0, voltage_type: "AC" },
      },
    ],
  };
}

function dcSourceWidePotentialObjects() {
  return {
    objects: [
      {
        uid: "11111111-1111-4111-8111-111111112570",
        kind: "device",
        designation: "PS1",
        type: "core:psu-24vdc",
        location: "MAIN-PANEL",
      },
      {
        uid: "22222222-2222-4222-8222-222222222570",
        kind: "device",
        designation: "H1",
        type: "core:pilot-light",
        location: "DOOR",
      },
      {
        uid: "33333331-3333-4333-8333-333333332570",
        kind: "wire",
        designation: "W-DC-1",
        endpoints: [
          { device: "PS1", terminal: "+" },
          { device: "H1", terminal: "X1" },
        ],
        properties: { label: "DC1" },
      },
      {
        uid: "33333332-3333-4333-8333-333333332570",
        kind: "wire",
        designation: "W-DC-2",
        endpoints: [
          { device: "H1", terminal: "X2" },
          { device: "PS1", terminal: "-" },
        ],
        properties: { label: "DC2" },
      },
      {
        uid: "44444441-4444-4444-8444-444444442570",
        kind: "potential",
        name: "24VDC-CONTROL-BUS",
        at: { device: "PS1", terminal: "+" },
        electrical: { nominal_voltage: 24, voltage_type: "DC" },
      },
      {
        uid: "44444442-4444-4444-8444-444444442570",
        kind: "potential",
        name: "0VDC-COMMON-BUS",
        at: { device: "PS1", terminal: "-" },
        electrical: { nominal_voltage: 0, voltage_type: "DC" },
      },
    ],
  };
}

async function compileMinimalFixture(
  name: string,
  source: Record<string, unknown>,
) {
  const root = await mkdtemp(join(tmpdir(), "thermite-netlabel-"));
  try {
    await writeFile(
      join(root, "system.json"),
      JSON.stringify(systemJson(name)),
    );
    await writeFile(join(root, "source.json"), JSON.stringify(source));
    const locked = await lockProject(root);
    assert.ok(locked.ok, JSON.stringify(locked.diagnostics));
    const compiled = await compileProject(root);
    assert.ok(compiled.ok, JSON.stringify(compiled.diagnostics));
    return { ir: compiled.ir, dispose: () => rm(root, { recursive: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function distanceAlongRoute(edge: LayoutEdge, label: LayoutLabel) {
  const cx = label.x + label.width / 2;
  const cy = label.y + label.height / 2;
  let total = 0;
  let best = Infinity;
  let at = 0;
  for (let i = 1; i < edge.points.length; i++) {
    const a = edge.points[i - 1]!;
    const b = edge.points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue;
    const u = Math.max(
      0,
      Math.min(
        1,
        ((cx - a.x) * (b.x - a.x) + (cy - a.y) * (b.y - a.y)) / (len * len),
      ),
    );
    const d = Math.hypot(
      cx - (a.x + u * (b.x - a.x)),
      cy - (a.y + u * (b.y - a.y)),
    );
    if (d < best) {
      best = d;
      at = total + u * len;
    }
    total += len;
  }
  return { at, total };
}

function boxesOverlap(
  a: Pick<LayoutNode, "x" | "y" | "width" | "height">,
  b: Pick<LayoutNode, "x" | "y" | "width" | "height">,
) {
  return (
    Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
  );
}

function assertNetLabelsAtRouteSource(
  presentation: PresentationGraph,
  layout: NormalizedSchematicLayout,
  expectedNames: readonly string[],
) {
  const edgeById = new Map(layout.edges.map((e) => [e.id, e]));
  const presEdgeById = new Map(presentation.edges.map((e) => [e.id, e]));
  const ownerDeviceGroupByPort = new Map(
    presentation.nodes.flatMap((n) =>
      n.kind === "symbol"
        ? n.ports.map((p) => [p.id, n.deviceGroupId] as const)
        : [],
    ),
  );
  const deviceBoxes = layout.nodes.filter((n) => n.kind === "device");
  const terminalLabels = layout.labels.filter((l) => l.role === "terminal");
  const netLabels = layout.labels.filter((l) => l.role === "net");
  expect(netLabels.map((l) => l.text).sort()).toEqual(expectedNames);
  for (const netLabel of netLabels) {
    const edge = edgeById.get(netLabel.ownerId);
    const presEdge = presEdgeById.get(netLabel.ownerId);
    assert.ok(edge && presEdge);
    const { at, total } = distanceAlongRoute(edge, netLabel);
    expect(at).toBeLessThanOrEqual(total / 2 + 0.05);
    const sourceDeviceGroupId = ownerDeviceGroupByPort.get(
      presEdge.sourcePortId,
    );
    for (const deviceBox of deviceBoxes) {
      if (deviceBox.id === sourceDeviceGroupId) continue;
      expect(boxesOverlap(netLabel, deviceBox)).toBe(false);
    }
    for (const terminalLabel of terminalLabels) {
      expect(boxesOverlap(netLabel, terminalLabel)).toBe(false);
    }
  }
}

it.each([
  ["SUP1 -> CB1 -> M1", true, "top-to-bottom"],
  ["SUP1 -> CB1 -> M1", true, "left-to-right"],
  ["SUP1 -> M1 direct", false, "top-to-bottom"],
  ["SUP1 -> M1 direct", false, "left-to-right"],
] as const)(
  "places source net labels at route source outside non-owner frames (%s, %s)",
  async (label, withBreaker, flow) => {
    const fixture = await compileMinimalFixture(
      label,
      powerSourceToMotorObjects(withBreaker),
    );
    try {
      const observed = observedRecoveryEngine();
      const request = {
        format: "schematic-view-request/0.1" as const,
        root: { by: "designation" as const, value: "M1" },
        family: "power" as const,
        flow,
      };
      const prepared = await prepareSchematicDrawing(
        fixture.ir,
        request,
        undefined,
        { layoutEngine: observed.engine },
      );
      assert.ok(prepared.ok, JSON.stringify(prepared));
      expect(observed.inputs).toHaveLength(1);
      const netInputLabels =
        observed.inputs[0]?.edges
          ?.flatMap((e) => e.labels ?? [])
          .filter((l) => l.id?.endsWith(',"net"]')) ?? [];
      expect(netInputLabels).toHaveLength(4);
      for (const inputLabel of netInputLabels) {
        expect(
          inputLabel.layoutOptions?.[ELK_OPTIONS.edgeLabelsPlacement],
        ).toBe("TAIL");
      }
      assertNetLabelsAtRouteSource(
        prepared.value.graph,
        prepared.value.layout,
        ["480VAC-L1", "480VAC-L2", "480VAC-L3", "PE"],
      );
      const rendered = await createSchematicRendererWithDependencies().render(
        fixture.ir,
        request,
      );
      assert.ok(rendered.ok, JSON.stringify(rendered));
      for (const name of ["480VAC-L1", "480VAC-L2", "480VAC-L3"]) {
        expect(rendered.value.svg).toContain(name);
      }
    } finally {
      await fixture.dispose();
    }
  },
);

it("widens a TTB DC source symbol when a source net label exceeds default port pitch", async () => {
  const fixture = await compileMinimalFixture(
    "DC wide net label",
    dcSourceWidePotentialObjects(),
  );
  try {
    const observed = observedRecoveryEngine();
    const prepared = await prepareSchematicDrawing(
      fixture.ir,
      {
        format: "schematic-view-request/0.2",
        root: { by: "designation", value: "PS1" },
        intent: { kind: "loads" },
        flow: "top-to-bottom",
      },
      undefined,
      { layoutEngine: observed.engine },
    );
    assert.ok(prepared.ok, JSON.stringify(prepared));
    expect(observed.inputs).toHaveLength(1);
    assertNetLabelsAtRouteSource(prepared.value.graph, prepared.value.layout, [
      "0VDC-COMMON-BUS",
      "24VDC-CONTROL-BUS",
    ]);
  } finally {
    await fixture.dispose();
  }
});

it("rejects a net label placed inside a non-owner device frame", async () => {
  const fixture = await compileMinimalFixture(
    "non-owner device frame guard",
    powerSourceToMotorObjects(true),
  );
  try {
    const { buildElkAdapterGraph, layoutPresentationGraph } =
      await import("../src/layout/elk-adapter.js");
    const { createElkEngine } = await import("../src/layout/elk-runtime.js");
    const { agentPresentation } = await import("./helpers/agent-recovery.js");
    const { graph, selected } = agentPresentation(fixture.ir, {
      format: "schematic-view-request/0.1",
      root: { by: "designation", value: "M1" },
      family: "power",
      flow: "top-to-bottom",
    });
    const baseEngine = createElkEngine();
    const realLayout = baseEngine.layout.bind(baseEngine);
    const engine = createElkEngine();
    engine.layout = async (input, options) => {
      const output = await realLayout(input, options);
      const cb1 = output.children
        ?.flatMap((loc) => loc.children ?? [])
        .find((dev) => dev.labels?.[0]?.text === "CB1");
      const loc = output.children?.find((l) =>
        l.children?.some((d) => d === cb1),
      );
      const netLabel = output.edges
        ?.flatMap((e) => e.labels ?? [])
        .find((l) => l.text === "480VAC-L1");
      assert.ok(cb1 && loc && netLabel);
      netLabel.x = (loc.x ?? 0) + (cb1.x ?? 0) + 4;
      netLabel.y = (loc.y ?? 0) + (cb1.y ?? 0) + 4;
      return output;
    };
    const build = buildElkAdapterGraph(graph, selected);
    expect(build.graph.edges?.length).toBeGreaterThan(0);
    const outcome = await layoutPresentationGraph(graph, { engine, selected });
    expect(outcome).toMatchObject({
      ok: false,
      failureKind: "net-label-intersection",
      error: { code: "R004" },
    });
  } finally {
    await fixture.dispose();
  }
});
