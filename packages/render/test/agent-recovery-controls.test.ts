import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject, lockProject } from "@thermite/compiler";
import { expect, it, vi } from "vitest";
import {
  agentRefusalFixture,
  pumpPower,
  sensorTrace,
} from "./agent-refusals-fixture.js";
import { agentPresentation } from "./helpers/agent-recovery.js";
import * as contextForkOrder from "../src/layout/context-fork-order.js";
import * as directLoadRoutes from "../src/layout/direct-load-routes.js";
import * as recoveryModule from "../src/layout/rooted-recovery.js";
import { rootedRecovery } from "../src/layout/rooted-recovery.js";
import {
  buildElkAdapterGraph,
  layoutPresentationGraph,
} from "../src/layout/elk-adapter.js";
import { createElkEngine } from "../src/layout/elk-runtime.js";
import { ELK_OPTIONS } from "../src/layout/options.js";
import {
  normalizeAndValidateLayout,
  type LayoutFailureKind,
  type LayoutValidationOutcome,
} from "../src/layout/validate-output.js";
import { buildPresentationGraph } from "../src/presentation.js";
import { selectSemanticSubgraph } from "../src/selection.js";
import { projectDeviceTypeSymbolMappings } from "../src/symbols/mappings.js";
import type { PresentationGraph, SelectedSubgraph } from "../src/types.js";
import { SYMBOL_CATALOG } from "../src/symbols/catalog.js";
import { normalizeSchematicView } from "../src/view-spec.js";

function failure(
  graph: PresentationGraph,
  failureKind: LayoutFailureKind,
): LayoutValidationOutcome {
  return {
    ok: false,
    failureKind,
    error: {
      code: "R004",
      message: "control",
      family: graph.view.family,
      root: graph.view.root.designation,
    },
  };
}

it("retries only the measured failure and the same physical pass-through", async () => {
  const fixture = await agentRefusalFixture("sensor");
  try {
    const { graph } = agentPresentation(fixture.ir, {
      ...sensorTrace,
      flow: "left-to-right",
    });
    const reason = failure(graph, "ambiguous-intersection");
    expect(rootedRecovery(graph, reason)).toBe("trace-order");
    for (const kind of [
      "contract-violation",
      "symbol-intersection",
      "net-label-intersection",
    ] as const)
      expect(rootedRecovery(graph, failure(graph, kind))).toBeUndefined();
    const withoutTerminals = {
      ...graph,
      nodes: graph.nodes.filter(
        (n) => n.kind !== "symbol" || n.classification !== "terminal",
      ),
    };
    expect(rootedRecovery(withoutTerminals, reason)).toBeUndefined();
    const mismatched = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.kind !== "symbol" || n.classification !== "terminal"
          ? n
          : {
              ...n,
              ports: n.ports.map((p, i) => ({
                ...p,
                terminal: {
                  ...p.terminal,
                  terminalKey: p.terminal.terminalKey + i,
                },
              })),
            },
      ),
    };
    expect(rootedRecovery(mismatched, reason)).toBeUndefined();
  } finally {
    await fixture.dispose();
  }
});

it("never switches net labels to HEAD on vertical power net-label overlaps", async () => {
  const fixture = await agentRefusalFixture("pump");
  try {
    for (const flow of ["top-to-bottom", "left-to-right"] as const) {
      const { graph } = agentPresentation(fixture.ir, {
        ...pumpPower,
        flow,
      });
      for (const kind of [
        "net-label-intersection",
        "contract-violation",
      ] as const) {
        expect(rootedRecovery(graph, failure(graph, kind))).toBeUndefined();
      }
      const build = buildElkAdapterGraph(graph);
      const netLabels = build.graph.edges
        ?.flatMap((edge) => edge.labels ?? [])
        .filter((label) => label.id?.endsWith(',"net"]'));
      expect(netLabels).toHaveLength(4);
      for (const label of netLabels ?? []) {
        expect(label.layoutOptions).toMatchObject({
          [ELK_OPTIONS.edgeLabelsPlacement]: "TAIL",
        });
      }
    }
  } finally {
    await fixture.dispose();
  }
});

it("leaves root fan-out to its existing search budget", async () => {
  const fixture = await agentRefusalFixture("sensor");
  try {
    const { graph } = agentPresentation(fixture.ir, {
      ...sensorTrace,
      flow: "left-to-right",
    });
    const rootUid = fixture.ir.devices.find((d) => d.designation === "B1")?.uid;
    const signal = graph.nodes
      .find((n) => n.kind === "symbol" && n.deviceUid === rootUid)
      ?.ports.find((p) => p.symbolPortId === "signal");
    assert.ok(signal);
    const forked = {
      ...graph,
      edges: graph.edges.map((e) =>
        e.sourcePortId === signal.id || e.targetPortId === signal.id
          ? { ...e, kind: "boundary-segment" as const }
          : e,
      ),
    };
    expect(
      rootedRecovery(forked, failure(forked, "ambiguous-intersection")),
    ).toBeUndefined();
  } finally {
    await fixture.dispose();
  }
});

it("rejects a detached recovered endpoint and preserves the original refusal", async () => {
  const fixture = await agentRefusalFixture("sensor");
  try {
    const { graph } = agentPresentation(fixture.ir, {
      ...sensorTrace,
      flow: "left-to-right",
    });
    const build = buildElkAdapterGraph(graph);
    const engine = createElkEngine(),
      layout = engine.layout.bind(engine);
    let calls = 0,
      first: LayoutValidationOutcome | undefined;
    engine.layout = async (input, options) => {
      const output = await layout(input, options);
      if (++calls === 1)
        first = normalizeAndValidateLayout(
          graph,
          build.graph,
          output,
          SYMBOL_CATALOG,
        );
      else {
        const section = output.edges?.[0]?.sections?.[0];
        assert.ok(section);
        const prior = section.bendPoints?.at(-1) ?? section.startPoint;
        const end = section.endPoint;
        if (Math.abs(prior.x - end.x) > 0.001)
          end.x += Math.sign(prior.x - end.x) * 0.5;
        else end.y += Math.sign(prior.y - end.y) * 0.5;
      }
      return output;
    };
    const result = await layoutPresentationGraph(graph, { engine });
    assert.ok(first && !first.ok);
    expect(result).toEqual(first);
    expect(calls).toBe(2);
  } finally {
    await fixture.dispose();
  }
});

async function runRetryOrder(
  graph: PresentationGraph,
  selected: SelectedSubgraph,
  succeedOnCall?: number,
) {
  const baseEngine = createElkEngine();
  const realLayout = baseEngine.layout.bind(baseEngine);
  const sequence: string[] = [];
  let calls = 0;
  const forkSpy = vi
    .spyOn(contextForkOrder, "contextForkOrderAlternatives")
    .mockImplementation(function* (candidate) {
      sequence.push("context-fork");
      yield candidate;
    });
  const routeSpy = vi
    .spyOn(directLoadRoutes, "rootedRouteAlternatives")
    .mockImplementation(function* (candidate) {
      sequence.push("rooted-route");
      yield candidate;
    });
  const realRecovery = recoveryModule.rootedRecovery;
  const recoverySpy = vi
    .spyOn(recoveryModule, "rootedRecovery")
    .mockImplementation((g, outcome) => {
      sequence.push("rooted-recovery");
      return realRecovery(g, outcome);
    });
  const engine = createElkEngine();
  engine.layout = async (input, options) => {
    calls++;
    const strategy =
      input.layoutOptions?.[ELK_OPTIONS.considerModelOrderStrategy] ?? "UNSET";
    sequence.push(`layout:${strategy}`);
    if (succeedOnCall === calls) {
      const validInput = structuredClone(input);
      validInput.layoutOptions = {
        ...validInput.layoutOptions,
        [ELK_OPTIONS.considerModelOrderStrategy]: "NONE",
      };
      return realLayout(validInput, options);
    }
    return realLayout(input, options);
  };
  try {
    const result = await layoutPresentationGraph(graph, { engine, selected });
    assert.ok(result.ok);
    return sequence;
  } finally {
    forkSpy.mockRestore();
    routeSpy.mockRestore();
    recoverySpy.mockRestore();
  }
}

it("tries context-fork and rooted-route alternatives before model-order NONE recovery", async () => {
  const fixture = await agentRefusalFixture("sensor");
  try {
    const { graph, selected } = agentPresentation(fixture.ir, {
      ...sensorTrace,
      flow: "left-to-right",
    });
    expect(await runRetryOrder(graph, selected)).toEqual([
      "layout:NODES_AND_EDGES",
      "context-fork",
      "layout:NODES_AND_EDGES",
      "rooted-route",
      "layout:NODES_AND_EDGES",
      "rooted-recovery",
      "layout:NONE",
    ]);
    expect(await runRetryOrder(graph, selected, 2)).toEqual([
      "layout:NODES_AND_EDGES",
      "context-fork",
      "layout:NODES_AND_EDGES",
    ]);
    expect(await runRetryOrder(graph, selected, 3)).toEqual([
      "layout:NODES_AND_EDGES",
      "context-fork",
      "layout:NODES_AND_EDGES",
      "rooted-route",
      "layout:NODES_AND_EDGES",
    ]);
  } finally {
    await fixture.dispose();
  }
});

const TWO_TERMINAL_MOTOR_TYPE = {
  types: [
    {
      kind: "device_type",
      id: "local:motor-2t",
      description: "Two-terminal motor load",
      symbol: "thermite:motor",
      terminals: {
        T1: { role: "power_input", required: true },
        T2: { role: "power_input", required: true },
      },
      functions: { motor_load: { kind: "load", terminals: ["T1", "T2"] } },
      internal_relations: [],
    },
  ],
};

const TWO_TERMINAL_MOTOR_SOURCE = {
  objects: [
    {
      uid: "11111111-1111-4111-8111-111111111111",
      kind: "device",
      designation: "SUP1",
      type: "core:supply-480v-3ph",
      location: "MAIN-PANEL",
    },
    {
      uid: "22222222-2222-4222-8222-222222222222",
      kind: "device",
      designation: "M1",
      type: "local:motor-2t",
      location: "FIELD",
    },
    {
      uid: "33333333-3333-4333-8333-333333333333",
      kind: "wire",
      designation: "W101",
      endpoints: [
        { device: "SUP1", terminal: "L1" },
        { device: "M1", terminal: "T1" },
      ],
      properties: { label: "101" },
    },
    {
      uid: "44444444-4444-4444-8444-444444444444",
      kind: "wire",
      designation: "W102",
      endpoints: [
        { device: "SUP1", terminal: "L2" },
        { device: "M1", terminal: "T2" },
      ],
      properties: { label: "102" },
    },
    {
      uid: "55555555-5555-4555-8555-555555555555",
      kind: "potential",
      name: "L1 480VAC",
      at: { device: "SUP1", terminal: "L1" },
      electrical: { nominal_voltage: 480, voltage_type: "AC" },
    },
    {
      uid: "66666666-6666-4666-8666-666666666666",
      kind: "potential",
      name: "L2 480VAC",
      at: { device: "SUP1", terminal: "L2" },
      electrical: { nominal_voltage: 480, voltage_type: "AC" },
    },
  ],
};

async function twoTerminalMotorFixture() {
  const root = await mkdtemp(join(tmpdir(), "thermite-motor2t-recovery-"));
  try {
    await mkdir(join(root, "libraries/local/types"), { recursive: true });
    await writeFile(
      join(root, "libraries/local/library.json"),
      JSON.stringify({
        name: "local",
        version: "0.1.0",
        sources: ["types/**/*.json"],
      }),
    );
    await writeFile(
      join(root, "libraries/local/types/motor-2t.json"),
      JSON.stringify(TWO_TERMINAL_MOTOR_TYPE),
    );
    await writeFile(
      join(root, "source.json"),
      JSON.stringify(TWO_TERMINAL_MOTOR_SOURCE),
    );
    await writeFile(
      join(root, "system.json"),
      JSON.stringify({
        format: "electrical-system/0.1",
        project: { name: "Synthetic two-terminal motor recovery witness" },
        sources: ["source.json"],
        libraries: [
          { name: "core", version: "0.2.0" },
          { name: "local", version: "0.1.0", path: "libraries/local" },
        ],
      }),
    );
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

it("keeps two-terminal motor TTB net labels at TAIL without HEAD recovery", async () => {
  const fixture = await twoTerminalMotorFixture();
  try {
    const { graph, selected } = agentPresentation(fixture.ir, {
      format: "schematic-view-request/0.1",
      root: { by: "designation", value: "M1" },
      family: "power",
      flow: "top-to-bottom",
    });
    expect(selected.paths.map((p) => p.lane)).toEqual(["positive", "return"]);
    expect(selected.paths.map((p) => p.powerRole)).toEqual([
      "non-pe",
      "non-pe",
    ]);
    expect(
      rootedRecovery(graph, failure(graph, "net-label-intersection")),
    ).toBeUndefined();
    const result = await layoutPresentationGraph(graph, { selected });
    assert.ok(result.ok, JSON.stringify(result));
    const build = buildElkAdapterGraph(graph, selected);
    const netLabels = build.graph.edges
      ?.flatMap((edge) => edge.labels ?? [])
      .filter((label) => label.id?.endsWith(',"net"]'));
    expect(netLabels).toHaveLength(2);
    for (const label of netLabels ?? []) {
      expect(label.layoutOptions).toMatchObject({
        [ELK_OPTIONS.edgeLabelsPlacement]: "TAIL",
      });
    }
  } finally {
    await fixture.dispose();
  }
});

const THREE_PHASE_MOTOR_PE_TYPE = {
  types: [
    {
      kind: "device_type",
      id: "local:motor-3ph-t4-pe",
      description: "Three-phase motor with authored protective_earth terminal",
      symbol: "thermite:motor-3ph",
      terminals: {
        T1: { role: "power_input", required: true },
        T2: { role: "power_input", required: true },
        T3: { role: "power_input", required: true },
        T4: { role: "protective_earth", required: true },
      },
      functions: {
        motor_load: { kind: "load", terminals: ["T1", "T2", "T3"] },
        protective_earth: { kind: "bus", terminals: ["T4"] },
      },
      internal_relations: [],
    },
  ],
};

const THREE_PHASE_MOTOR_PE_SOURCE = {
  objects: [
    {
      uid: "11111111-1111-4111-8111-111111111121",
      kind: "device",
      designation: "SUP1",
      type: "core:supply-480v-3ph",
      location: "MAIN-PANEL",
    },
    {
      uid: "22222222-2222-4222-8222-222222222221",
      kind: "device",
      designation: "M1",
      type: "local:motor-3ph-t4-pe",
      location: "FIELD",
    },
    {
      uid: "33333333-3333-4333-8333-333333333321",
      kind: "wire",
      designation: "W101",
      endpoints: [
        { device: "SUP1", terminal: "L1" },
        { device: "M1", terminal: "T1" },
      ],
      properties: { label: "101" },
    },
    {
      uid: "44444444-4444-4444-8444-444444444421",
      kind: "wire",
      designation: "W102",
      endpoints: [
        { device: "SUP1", terminal: "L2" },
        { device: "M1", terminal: "T2" },
      ],
      properties: { label: "102" },
    },
    {
      uid: "55555555-5555-4555-8555-555555555521",
      kind: "wire",
      designation: "W103",
      endpoints: [
        { device: "SUP1", terminal: "L3" },
        { device: "M1", terminal: "T3" },
      ],
      properties: { label: "103" },
    },
    {
      uid: "66666666-6666-4666-8666-666666666621",
      kind: "wire",
      designation: "W104",
      endpoints: [
        { device: "SUP1", terminal: "PE" },
        { device: "M1", terminal: "T4" },
      ],
      properties: { label: "104" },
    },
    {
      uid: "77777777-7777-4777-8777-777777777721",
      kind: "potential",
      name: "P0",
      at: { device: "SUP1", terminal: "L1" },
      electrical: { nominal_voltage: 480, voltage_type: "AC" },
    },
    {
      uid: "88888888-8888-4888-8888-888888888821",
      kind: "potential",
      name: "P1",
      at: { device: "SUP1", terminal: "L2" },
      electrical: { nominal_voltage: 480, voltage_type: "AC" },
    },
    {
      uid: "99999999-9999-4999-8999-999999999921",
      kind: "potential",
      name: "P2",
      at: { device: "SUP1", terminal: "L3" },
      electrical: { nominal_voltage: 480, voltage_type: "AC" },
    },
    {
      uid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21",
      kind: "potential",
      name: "P3",
      at: { device: "SUP1", terminal: "PE" },
      electrical: { nominal_voltage: 480, voltage_type: "AC" },
    },
  ],
};

async function threePhaseMotorPeFixture() {
  const root = await mkdtemp(join(tmpdir(), "thermite-motor3ph-pe-"));
  try {
    await mkdir(join(root, "libraries/local/types"), { recursive: true });
    await writeFile(
      join(root, "libraries/local/library.json"),
      JSON.stringify({
        name: "local",
        version: "0.1.0",
        sources: ["types/**/*.json"],
      }),
    );
    await writeFile(
      join(root, "libraries/local/types/motor-3ph-t4-pe.json"),
      JSON.stringify(THREE_PHASE_MOTOR_PE_TYPE),
    );
    await writeFile(
      join(root, "source.json"),
      JSON.stringify(THREE_PHASE_MOTOR_PE_SOURCE),
    );
    await writeFile(
      join(root, "system.json"),
      JSON.stringify({
        format: "electrical-system/0.1",
        project: { name: "Synthetic PE without PE source mapping witness" },
        sources: ["source.json"],
        libraries: [
          { name: "core", version: "0.2.0" },
          { name: "local", version: "0.1.0", path: "libraries/local" },
        ],
      }),
    );
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

async function layoutWithInjectedNetLabelOverlap(
  graph: PresentationGraph,
  selected: SelectedSubgraph,
  edgeId: string,
) {
  const baseEngine = createElkEngine();
  const realLayout = baseEngine.layout.bind(baseEngine);
  const engine = createElkEngine();
  const inputs: Parameters<typeof realLayout>[0][] = [];
  engine.layout = async (input, options) => {
    inputs.push(structuredClone(input));
    const output = await realLayout(input, options);
    if (inputs.length === 1) {
      const edge = output.edges?.find((e) => e.id === edgeId);
      const label = edge?.labels?.find((l) => l.id?.endsWith(',"net"]'));
      const section = edge?.sections?.[0];
      assert.ok(label && section);
      const start = section.startPoint;
      const end = section.bendPoints?.[0] ?? section.endPoint;
      label.x = (start.x + end.x) / 2 - (label.width ?? 0) / 2;
      label.y = (start.y + end.y) / 2 - (label.height ?? 0) / 2;
    }
    return output;
  };
  const result = await layoutPresentationGraph(graph, { engine, selected });
  return { result, inputs };
}

function peNoSourceMappingPresentation(
  ir: Awaited<ReturnType<typeof threePhaseMotorPeFixture>>["ir"],
) {
  const mappings = projectDeviceTypeSymbolMappings(ir).map((m) => ({
    ...m,
    boundaryTerminals: m.boundaryTerminals.map((b) =>
      b.boundaryKind === "protective-earth-source"
        ? { ...b, boundaryKind: "power-source" as const }
        : b,
    ),
  }));
  expect(
    mappings
      .flatMap((m) => m.boundaryTerminals)
      .some((b) => b.boundaryKind === "protective-earth-source"),
  ).toBe(false);
  const normalized = normalizeSchematicView(ir, {
    format: "schematic-view-request/0.1",
    root: { by: "designation", value: "M1" },
    family: "power",
    flow: "top-to-bottom",
  });
  assert.ok(normalized.ok);
  const selected = selectSemanticSubgraph({
    ir,
    ...normalized.value,
    mappings,
  });
  assert.ok(selected.ok);
  const built = buildPresentationGraph({
    ir,
    selected: selected.value,
    mappings,
  });
  assert.ok(built.ok);
  return { graph: built.value.graph, selected: selected.value };
}

function wireEdgeFor(graph: PresentationGraph, designation: string) {
  const edge = graph.edges.find(
    (e) =>
      e.conductor?.kind === "wire" && e.conductor.designation === designation,
  );
  assert.ok(edge?.netLabel);
  return edge;
}

it("rejects injected net-label overlaps as R004 without retrying HEAD on PE or non-PE edges", async () => {
  const fixture = await threePhaseMotorPeFixture();
  try {
    const { graph, selected } = peNoSourceMappingPresentation(fixture.ir);
    expect(selected.paths.map((p) => p.powerRole)).toEqual([
      "non-pe",
      "non-pe",
      "non-pe",
      "protective-earth",
    ]);
    expect(
      selected.protectiveEarthTerminals?.some((t) => t.terminalKey === "T4"),
    ).toBe(true);
    for (const wire of ["W104", "W101"] as const) {
      const edge = wireEdgeFor(graph, wire);
      const attempt = await layoutWithInjectedNetLabelOverlap(
        graph,
        selected,
        edge.id,
      );
      expect(attempt.inputs).toHaveLength(1);
      expect(attempt.result).toMatchObject({
        ok: false,
        failureKind: "net-label-intersection",
        error: { code: "R004" },
      });
    }
  } finally {
    await fixture.dispose();
  }
});
