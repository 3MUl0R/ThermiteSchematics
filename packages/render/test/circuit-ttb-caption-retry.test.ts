import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import {
  renderSchematicPacket,
  type RenderedPacket,
  type SchematicPacketRequest,
} from "../src/index.js";
import * as inline from "../src/layout/circuit-inline.js";
import { createElkEngine } from "../src/layout/elk-runtime.js";
import {
  circuitInlineContext,
  circuitInlineTrace,
  type CircuitInlineContext,
} from "../src/layout/circuit-inline-context.js";
import * as circuitDrawing from "../src/circuit/layout-drawing.js";
import * as inlinePlate from "../src/circuit/inline-plate.js";
import { paginateCircuitGroup, prepareCircuitView } from "../src/circuit.js";
import { InlineLabelCollisionError } from "../src/layout/inline-label-error.js";
import { CircuitCaptionCollisionError } from "../src/circuit/caption-error.js";
import { required } from "./fixtures.js";

let baseIr: ElectricalIr;
let baseRequest: SchematicPacketRequest;

beforeAll(async () => {
  const root = new URL(
    "../../../examples/functional-symbols/",
    import.meta.url,
  );
  const compiled = await compileProject(fileURLToPath(root));
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  baseIr = compiled.ir;
  baseRequest = JSON.parse(
    await readFile(new URL("packet-left-to-right.request.json", root), "utf8"),
  );
});

afterEach(() => vi.restoreAllMocks());

function ttbRequest(
  request: SchematicPacketRequest,
  overrides?: Partial<SchematicPacketRequest>,
): SchematicPacketRequest {
  return {
    ...request,
    ...overrides,
    views: request.views.map((view) =>
      view.format === "circuit-view-request/0.1"
        ? { ...view, flow: "top-to-bottom" as const }
        : view,
    ),
  };
}

function wideMiddleCaptionFixture() {
  const ir = structuredClone(baseIr);
  const target = required(ir.wires.find((w) => w.designation === "W9"));
  target.properties = {
    ...target.properties,
    label: "212",
    size: "18AWG",
    color: "blue/white-wide-caption",
  };
  const view = required(
    baseRequest.views.find((v) => v.format === "circuit-view-request/0.1"),
  );
  if (view.format !== "circuit-view-request/0.1")
    throw Error("Expected circuit view");
  const levelGroup = required(view.groups.find((g) => g.id === "level-sensor"));
  const request: SchematicPacketRequest = {
    format: "schematic-packet-request/0.1",
    page: { size: "tabloid", orientation: "landscape" },
    views: [
      {
        ...view,
        flow: "top-to-bottom",
        groups: [levelGroup],
      },
    ],
  };
  return { ir, request, target };
}

function inlineOptionOf(input: ElkNode): string[] {
  return (input.edges ?? []).flatMap((e) =>
    (e.labels ?? []).map(
      (l) => l.layoutOptions?.["elk.edgeLabels.inline"] ?? "",
    ),
  );
}

async function renderInlineOnly(
  ir: ElectricalIr,
  request: SchematicPacketRequest,
) {
  const real = inline.layoutCircuitGroup;
  const spy = vi
    .spyOn(inline, "layoutCircuitGroup")
    .mockImplementation(async (input, run, strokes, portGroups) => {
      if (inlineOptionOf(input).includes("false"))
        throw new Error("Inline-only test control forbids non-inline retry.");
      return real(input, run, strokes, portGroups);
    });
  try {
    return await renderSchematicPacket(ir, request);
  } finally {
    spy.mockRestore();
  }
}

function withSyntheticJog(graph: ElkNode): ElkNode {
  const copy = structuredClone(graph);
  const edge = required(copy.edges?.[0]);
  const section = required(edge.sections?.[0]);
  const start = section.startPoint;
  const end = section.endPoint;
  const midY = Number(((start.y + end.y) / 2).toFixed(3));
  section.bendPoints = [
    { x: start.x, y: midY },
    { x: start.x + 1.5, y: midY },
    { x: start.x + 1.5, y: midY + 1.5 },
    { x: end.x, y: midY + 1.5 },
  ];
  return copy;
}

type NonCaptionCase = {
  name: string;
  expectedText: string;
  mutate?: (graph: ElkNode) => void;
  throwError?: () => Error;
};

const NON_CAPTION_CASES: readonly NonCaptionCase[] = [
  {
    name: "moved route endpoint",
    expectedText: "route endpoints moved away",
    mutate: (graph) => {
      const section = required(graph.edges?.[0]?.sections?.[0]);
      section.startPoint.y += 1;
    },
  },
  {
    name: "conductor crossing device",
    expectedText: "crosses device",
    mutate: (graph) => {
      const node = required(graph.children?.[0]);
      const section = required(graph.edges?.[0]?.sections?.[0]);
      const cx = required(node.x) + required(node.width) / 2;
      const cy = required(node.y) + required(node.height) / 2;
      section.bendPoints = [
        { x: section.startPoint.x, y: cy },
        { x: cx, y: cy },
        { x: cx, y: section.endPoint.y },
      ];
    },
  },
  {
    name: "unrelated conductor overlap",
    expectedText: "overlap",
    mutate: (graph) => {
      const e0 = required(graph.edges?.[0]?.sections?.[0]);
      const e1 = required(graph.edges?.[1]?.sections?.[0]);
      const y = Number(((e0.startPoint.y + e0.endPoint.y) / 2).toFixed(3));
      e0.bendPoints = [
        { x: e0.startPoint.x, y },
        { x: e0.endPoint.x, y },
      ];
      e1.bendPoints = [
        { x: e1.startPoint.x, y },
        { x: e0.startPoint.x, y },
        { x: e0.endPoint.x, y },
        { x: e1.endPoint.x, y },
      ];
    },
  },
  {
    name: "ambiguous junction (base InlineLabelCollisionError)",
    expectedText: "unrelated wire touches a source-terminal junction",
    throwError: () =>
      new InlineLabelCollisionError(
        "Circuit level-sensor: unrelated wire touches a source-terminal junction.",
      ),
  },
];

describe("TTB circuit caption non-inline retry (#552)", () => {
  it("recovers a 3-parallel-vertical-wire TTB caption refusal once with beside-wire ELK labels", async () => {
    const { ir, request, target } = wideMiddleCaptionFixture();
    const inlineOnly = await renderInlineOnly(ir, request);
    expect(inlineOnly.ok).toBe(false);
    if (inlineOnly.ok) throw Error("Expected inline-only refusal");
    expect(inlineOnly.error.code).toBe("R006");
    expect(inlineOnly.error.message).toContain(
      "cannot be associated with its conductor",
    );

    const seenModes: string[][] = [];
    const real = inline.layoutCircuitGroup;
    const spy = vi
      .spyOn(inline, "layoutCircuitGroup")
      .mockImplementation((input, run, strokes, portGroups) => {
        seenModes.push(inlineOptionOf(input));
        return real(input, run, strokes, portGroups);
      });
    const traces: CircuitInlineContext[] = [];
    const recovered = await circuitInlineTrace.run(traces, () =>
      renderSchematicPacket(ir, request),
    );
    spy.mockRestore();
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw Error(JSON.stringify(recovered.error));
    expect(seenModes.length).toBeGreaterThanOrEqual(2);
    expect(seenModes[0]?.every((v) => v === "true")).toBe(true);
    expect(seenModes[1]?.every((v) => v === "false")).toBe(true);

    const run = required(traces[0]?.runs[0]);
    expect(run.attempts).toBeGreaterThanOrEqual(2);
    expect(run.captionFallbacks.size).toBe(1);
    expect(traces[0]?.baselineLayouts).toBeGreaterThanOrEqual(2);

    const svg = required(recovered.value.sheets[0]).svg;
    const doc = parseHTML(svg).document;
    const labelNode = required(
      doc.querySelector(`[data-wire-label="${target.uid}"]`) ?? undefined,
    );
    expect(labelNode.textContent).toContain("212");
    expect(labelNode.getAttribute("data-circuit-caption-fallback")).toBeNull();
    expect(
      doc.querySelector(`[data-label-leader-owner="${target.uid}"]`),
    ).toBeNull();

    // Same group in LTR passes natively in 1 layout, byte-identical to inline-only.
    const ltrRequest: SchematicPacketRequest = {
      ...request,
      views: request.views.map((v) =>
        v.format === "circuit-view-request/0.1"
          ? { ...v, flow: "left-to-right" as const }
          : v,
      ),
    };
    const ltrBaseline = await renderInlineOnly(ir, ltrRequest);
    const ltrCandidate = await renderSchematicPacket(ir, ltrRequest);
    expect(ltrCandidate).toEqual(ltrBaseline);
  });

  it("keeps already-passing LTR and TTB packets byte-identical with zero extra layouts", async () => {
    for (const q of [baseRequest, ttbRequest(baseRequest)]) {
      const before = await renderInlineOnly(baseIr, q);
      const traces: CircuitInlineContext[] = [];
      const after = await circuitInlineTrace.run(traces, () =>
        renderSchematicPacket(baseIr, q),
      );
      expect(after.ok).toBe(true);
      expect(after).toEqual(before);
      for (const run of traces[0]?.runs ?? []) {
        expect(run.captionFallbacks.size).toBe(0);
      }
    }
  });

  it("replays accepted baseline mode when a recovered TTB group is selected for quality", async () => {
    const { ir, request } = wideMiddleCaptionFixture();
    const realLayout = inline.layoutCircuitGroup;
    const qualityInputs: string[][] = [];
    vi.spyOn(inline, "layoutCircuitGroup").mockImplementation(
      async (input, run, strokes, portGroups) => {
        const modes = inlineOptionOf(input);
        const ctx = circuitInlineContext.getStore();
        if (ctx?.qualityPhase) qualityInputs.push(modes);
        const graph = await realLayout(input, run, strokes, portGroups);
        if (!ctx?.qualityPhase && modes.every((v) => v === "false") && run) {
          const jogged = withSyntheticJog(graph);
          run.baseline.set(JSON.stringify(input), structuredClone(jogged));
        }
        return graph;
      },
    );
    const traces: CircuitInlineContext[] = [];
    const result = await circuitInlineTrace.run(traces, () =>
      renderSchematicPacket(ir, request),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(JSON.stringify(result.error));
    const trace = required(traces[0]);
    const run = required(trace.runs[0]);
    expect(run.captionFallbacks.size).toBe(1);
    expect(trace.viewDecisions.length).toBe(1);
    expect(qualityInputs.length).toBeGreaterThanOrEqual(1);
    for (const modes of qualityInputs) {
      expect(modes.every((v) => v === "false")).toBe(true);
    }
  });

  it("rejects a quality-only caption collision without new recovery or spending native budget", async () => {
    const q = ttbRequest(baseRequest, {
      page: { size: "a3", orientation: "landscape" },
    });
    const nativeSpy = vi
      .spyOn(inline, "layoutCircuitGroup")
      .mockImplementation(async (input, run) => {
        const graph = await createElkEngine().layout(structuredClone(input));
        run?.baseline.set(JSON.stringify(input), structuredClone(graph));
        return graph;
      });
    const nativePacket = await renderSchematicPacket(baseIr, q);
    nativeSpy.mockRestore();
    if (!nativePacket.ok) throw Error(JSON.stringify(nativePacket.error));

    const realRender = circuitDrawing.renderCircuitLayout;
    const realLayout = inline.layoutCircuitGroup;
    const layoutModes: { quality: boolean; modes: string[] }[] = [];
    vi.spyOn(inline, "layoutCircuitGroup").mockImplementation(
      (input, run, strokes, portGroups) => {
        layoutModes.push({
          quality: Boolean(circuitInlineContext.getStore()?.qualityPhase),
          modes: inlineOptionOf(input),
        });
        return realLayout(input, run, strokes, portGroups);
      },
    );
    vi.spyOn(circuitDrawing, "renderCircuitLayout").mockImplementation(
      (state, fs, pins, selfLoops, vertical) => {
        if (circuitInlineContext.getStore()?.qualityPhase)
          throw new CircuitCaptionCollisionError(
            "Injected quality-only caption collision.",
          );
        return realRender(state, fs, pins, selfLoops, vertical);
      },
    );

    const traces: CircuitInlineContext[] = [];
    const result = await circuitInlineTrace.run(traces, () =>
      renderSchematicPacket(baseIr, q),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(JSON.stringify(result.error));
    const trace = required(traces[0]);
    expect(trace.selected.size).toBe(0);
    expect(trace.viewDecisions[0]?.reason).toBe("composition fit");
    expect(layoutModes.every((m) => m.modes.every((v) => v === "true"))).toBe(
      true,
    );
    for (const run of trace.runs) {
      expect(run.captionFallbacks.size).toBe(0);
      expect(run.qualityAttempts).toBeLessThanOrEqual(4);
    }
    const svgs = (p: RenderedPacket) => p.sheets.map((s) => s.svg);
    expect(svgs(result.value)).toEqual(svgs(nativePacket.value));
  });

  it("preserves the exact first R006 when the non-inline retry also fails", async () => {
    const { ir, request } = wideMiddleCaptionFixture();
    const first = await renderInlineOnly(ir, request);
    expect(first.ok).toBe(false);
    if (first.ok) throw Error("Expected first R006");

    const seenModes: string[][] = [];
    const realLayout = inline.layoutCircuitGroup;
    vi.spyOn(inline, "layoutCircuitGroup").mockImplementation(
      (input, run, strokes, portGroups) => {
        seenModes.push(inlineOptionOf(input));
        return realLayout(input, run, strokes, portGroups);
      },
    );
    const realRender = circuitDrawing.renderCircuitLayout;
    let calls = 0;
    vi.spyOn(circuitDrawing, "renderCircuitLayout").mockImplementation(
      (state, fs, pins, selfLoops, vertical) => {
        calls++;
        if (calls === 2)
          throw new CircuitCaptionCollisionError(
            "Secondary fallback collision should not replace first R006.",
          );
        return realRender(state, fs, pins, selfLoops, vertical);
      },
    );

    const traces: CircuitInlineContext[] = [];
    const second = await circuitInlineTrace.run(traces, () =>
      renderSchematicPacket(ir, request),
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw Error("Expected refusal");
    expect(seenModes).toHaveLength(2);
    expect(seenModes[0]?.every((v) => v === "true")).toBe(true);
    expect(seenModes[1]?.every((v) => v === "false")).toBe(true);
    expect(traces[0]?.runs[0]?.attempts).toBe(2);
    expect(second.error).toEqual(first.error);
  });

  it("preserves the exact first R006 when a recovered group's parts cannot issue", async () => {
    const { ir, request } = wideMiddleCaptionFixture();
    const sensor = required(ir.devices.find((d) => d.designation === "LS1"));
    sensor.description = "Wide vertical sensor description ".repeat(12);
    const tightPageRequest: SchematicPacketRequest = {
      ...request,
      page: { size: "a4", orientation: "landscape", marginMm: 25 },
    };
    const first = await renderInlineOnly(ir, tightPageRequest);
    expect(first.ok).toBe(false);
    if (first.ok) throw Error("Expected first R006");
    expect(first.error.message).toContain(
      "cannot be associated with its conductor",
    );

    const seenModes: string[][] = [];
    const realLayout = inline.layoutCircuitGroup;
    const spy = vi
      .spyOn(inline, "layoutCircuitGroup")
      .mockImplementation((input, run, strokes, portGroups) => {
        seenModes.push(inlineOptionOf(input));
        return realLayout(input, run, strokes, portGroups);
      });
    const result = await renderSchematicPacket(ir, tightPageRequest);
    spy.mockRestore();
    expect(result.ok).toBe(false);
    if (result.ok) throw Error("Expected refusal");
    // Whole group recovered with non-inline retry, entered pagination, failed to fit,
    // and preserved the exact first caption R006 instead of a part-fit error.
    expect(seenModes.length).toBeGreaterThan(2);
    expect(seenModes[1]?.every((v) => v === "false")).toBe(true);
    expect(result.error).toEqual(first.error);
  });

  it("retries once on plate-obstruction cause in TTB and applies retry to pagination parts", async () => {
    const { ir, request } = wideMiddleCaptionFixture();
    const normalIr = structuredClone(baseIr);
    const seenModes: string[][] = [];
    const realLayout = inline.layoutCircuitGroup;
    const layoutSpy = vi
      .spyOn(inline, "layoutCircuitGroup")
      .mockImplementation((input, run, strokes, portGroups) => {
        seenModes.push(inlineOptionOf(input));
        return realLayout(input, run, strokes, portGroups);
      });
    const realPlate = inlinePlate.circuitCaptionPlate;
    let firstPlateCall = true;
    const plateSpy = vi
      .spyOn(inlinePlate, "circuitCaptionPlate")
      .mockImplementation((label, state, ink) => {
        if (ink && firstPlateCall) {
          firstPlateCall = false;
          return undefined;
        }
        return realPlate(label, state, ink);
      });
    const traces: CircuitInlineContext[] = [];
    const plateResult = await circuitInlineTrace.run(traces, () =>
      renderSchematicPacket(normalIr, request),
    );
    plateSpy.mockRestore();
    layoutSpy.mockRestore();
    expect(plateResult.ok).toBe(true);
    expect(seenModes.length).toBeGreaterThanOrEqual(2);
    expect(seenModes[0]?.every((v) => v === "true")).toBe(true);
    expect(seenModes[1]?.every((v) => v === "false")).toBe(true);

    // Pagination probe/part retry: verify the same single-retry rule runs on probes/parts.
    const view = required(request.views[0]);
    if (view.format !== "circuit-view-request/0.1")
      throw Error("Expected circuit view");
    const prepared = await prepareCircuitView(ir, view);
    const whole = required(prepared.groups[0]);
    const partModes: string[][] = [];
    let failFirstPartProbe = true;
    const partLayoutSpy = vi
      .spyOn(inline, "layoutCircuitGroup")
      .mockImplementation((input, run, strokes, portGroups) => {
        partModes.push(inlineOptionOf(input));
        return realLayout(input, run, strokes, portGroups);
      });
    const partPlateSpy = vi
      .spyOn(inlinePlate, "circuitCaptionPlate")
      .mockImplementation((label, state, ink) => {
        if (ink && failFirstPartProbe) {
          failFirstPartProbe = false;
          return undefined;
        }
        return realPlate(label, state, ink);
      });
    const parts = await paginateCircuitGroup(
      ir,
      view,
      0,
      whole,
      (d) => d.width < whole.width - 1,
    );
    partPlateSpy.mockRestore();
    partLayoutSpy.mockRestore();
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(partModes.some((m) => m.every((v) => v === "false"))).toBe(true);
  });

  it("does not retry non-caption route, overlap, junction or endpoint failures", async () => {
    const { ir, request } = wideMiddleCaptionFixture();
    for (const c of NON_CAPTION_CASES) {
      const seenModes: string[][] = [];
      const realLayout = inline.layoutCircuitGroup;
      const layoutSpy = vi
        .spyOn(inline, "layoutCircuitGroup")
        .mockImplementation(async (input, run, strokes, portGroups) => {
          seenModes.push(inlineOptionOf(input));
          const graph = await realLayout(input, run, strokes, portGroups);
          c.mutate?.(graph);
          return graph;
        });
      const throwError = c.throwError;
      const renderSpy = throwError
        ? vi
            .spyOn(circuitDrawing, "renderCircuitLayout")
            .mockImplementation(() => {
              throw throwError();
            })
        : undefined;
      const traces: CircuitInlineContext[] = [];
      const result = await circuitInlineTrace.run(traces, () =>
        renderSchematicPacket(ir, request),
      );
      renderSpy?.mockRestore();
      layoutSpy.mockRestore();
      expect(result.ok, c.name).toBe(false);
      if (result.ok) throw Error(`Expected ${c.name} refusal`);
      expect(result.error.code, c.name).toBe("R006");
      expect(result.error.message, c.name).toContain(c.expectedText);
      expect(seenModes, c.name).toHaveLength(1);
      expect(
        seenModes[0]?.every((v) => v === "true"),
        c.name,
      ).toBe(true);
      expect(traces[0]?.runs[0]?.attempts, c.name).toBe(1);
    }
  });
});
