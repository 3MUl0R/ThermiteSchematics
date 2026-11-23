import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { compileProject, lockProject } from "@thermite/compiler";
import { expect, it } from "vitest";
import {
  createSchematicRenderer,
  createSchematicRendererWithDependencies,
  prepareSchematicDrawing,
} from "../src/renderer.js";
import { renderSchematicPacket } from "../src/index.js";
import { ELK_OPTIONS } from "../src/layout/options.js";
import { observedRecoveryEngine } from "./helpers/agent-recovery.js";
import type {
  LayoutEdge,
  LayoutLabel,
  LayoutNode,
  NormalizedSchematicLayout,
  PresentationGraph,
} from "../src/types.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

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
    return {
      root,
      ir: compiled.ir,
      dispose: () => rm(root, { recursive: true }),
    };
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
      expect(observed.inputs).toHaveLength(flow === "top-to-bottom" ? 2 : 1);
      for (const input of observed.inputs) {
        const netInputLabels =
          input.edges
            ?.flatMap((e) => e.labels ?? [])
            .filter((l) => l.id?.endsWith(',"net"]')) ?? [];
        expect(netInputLabels).toHaveLength(4);
        for (const inputLabel of netInputLabels) {
          expect(
            inputLabel.layoutOptions?.[ELK_OPTIONS.edgeLabelsPlacement],
          ).toBe("TAIL");
        }
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
      expect(paintedNetLabelTexts(rendered.value.svg)).toEqual([
        "480VAC-L1",
        "480VAC-L2",
        "480VAC-L3",
      ]);
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
    expect(observed.inputs).toHaveLength(2);
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

function transformerSecondaryObjects(potentialName: string) {
  const unused = (keys: readonly string[], reason: string) => ({
    terminals: Object.fromEntries(
      keys.map((k) => [k, { status: "intentionally-unused", reason }]),
    ),
  });
  const wire = (n: number, a: [string, string], b: [string, string]) => ({
    uid: `62000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
    kind: "wire",
    designation: `W${n - 4}`,
    endpoints: [
      { device: a[0], terminal: a[1] },
      { device: b[0], terminal: b[1] },
    ],
  });
  return {
    objects: [
      {
        uid: "62000000-0000-4000-8000-000000000001",
        kind: "device",
        designation: "XT1",
        type: "core:terminal-block-8",
        connectionReview: unused(
          ["3", "4", "5", "6", "7", "8"],
          "Outside this synthetic two-terminal primary interface.",
        ),
      },
      {
        uid: "62000000-0000-4000-8000-000000000002",
        kind: "device",
        designation: "T1",
        type: "core:control-transformer",
      },
      {
        uid: "62000000-0000-4000-8000-000000000003",
        kind: "device",
        designation: "R1",
        type: "core:relay-1co",
        connectionReview: unused(
          ["11", "12", "14"],
          "Only the unrated coil is used by this synthetic drawing fixture.",
        ),
      },
      {
        uid: "62000000-0000-4000-8000-000000000004",
        kind: "device",
        designation: "H1",
        type: "core:pilot-light",
      },
      wire(5, ["XT1", "1"], ["T1", "H1"]),
      wire(6, ["XT1", "2"], ["T1", "H2"]),
      wire(7, ["T1", "X1"], ["R1", "A1"]),
      wire(8, ["T1", "X2"], ["R1", "A2"]),
      wire(9, ["T1", "X1"], ["H1", "X1"]),
      wire(10, ["T1", "X2"], ["H1", "X2"]),
      {
        uid: "62000000-0000-4000-8000-000000000099",
        kind: "potential",
        name: potentialName,
        at: { device: "T1", terminal: "X2" },
        electrical: { nominal_voltage: 24, voltage_type: "AC" },
      },
    ],
  };
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

it.each(["24V-RET", "24VAC-CONTROL-RETURN"] as const)(
  "renders TTB rooted control transformer winding with secondary potential %s (#570)",
  async (potentialName) => {
    const fixture = await compileMinimalFixture(
      `transformer-${potentialName}`,
      transformerSecondaryObjects(potentialName),
    );
    try {
      const request = {
        format: "schematic-view-request/0.1" as const,
        root: { by: "designation" as const, value: "R1" },
        family: "control" as const,
        flow: "top-to-bottom" as const,
      };
      const rendered = await createSchematicRenderer().render(
        fixture.ir,
        request,
      );
      assert.ok(rendered.ok, JSON.stringify(rendered));
      expect(paintedNetLabelTexts(rendered.value.svg)).toEqual([potentialName]);
      const cli = await execFileAsync(process.execPath, [
        join(REPO_ROOT, "thermite.mjs"),
        "view",
        "R1",
        "--project",
        fixture.root,
        "--actuation",
        "--flow",
        "top-to-bottom",
        "--json",
      ]).catch(
        (error: { code?: number; stdout?: string; stderr?: string }) => ({
          exitCode: error.code,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
        }),
      );
      expect("exitCode" in cli ? cli.exitCode : 0).toBe(0);
    } finally {
      await fixture.dispose();
    }
  },
);

it.each([
  ["pump-original", undefined, 2, ["L1 480VAC", "L2 480VAC", "L3 480VAC"]],
  [
    "pump-mcc1-panel",
    ["MCC1-PANEL-480VAC-L1", "MCC1-PANEL-480VAC-L2", "MCC1-PANEL-480VAC-L3"],
    4,
    ["MCC1-PANEL-480VAC-L1", "MCC1-PANEL-480VAC-L2", "MCC1-PANEL-480VAC-L3"],
  ],
] as const)(
  "issues TTB Letter landscape power packet without sheet regression (%s) (#570)",
  async (tag, names, maxSheets, expectedPainted) => {
    const fixture = await compileMinimalFixture(
      tag,
      await pumpVariantObjects(names),
    );
    try {
      const request = {
        format: "schematic-view-request/0.1" as const,
        root: { by: "designation" as const, value: "M1" },
        family: "power" as const,
        flow: "top-to-bottom" as const,
      };
      const prepared = await prepareSchematicDrawing(fixture.ir, request);
      assert.ok(prepared.ok, JSON.stringify(prepared));
      assertNetLabelsAtRouteSource(
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

it("preserves native 96-unit TTB source geometry when L01/L02/L03 labels already fit (#570)", async () => {
  const fixture = await compileMinimalFixture(
    "pump-l01-l02-l03",
    await pumpVariantObjects(["L01", "L02", "L03"]),
  );
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
    expect(observed.inputs).toHaveLength(1);
    const source = prepared.value.graph.nodes.find(
      (n) => n.kind === "symbol" && n.symbolId === "ais:power-source-3ph",
    );
    assert.ok(source && source.kind === "symbol");
    expect(source.symbolSize).toEqual({ width: 96, height: 36 });
    assertNetLabelsAtRouteSource(prepared.value.graph, prepared.value.layout, [
      "L01",
      "L02",
      "L03",
      "PE",
    ]);
  } finally {
    await fixture.dispose();
  }
});
