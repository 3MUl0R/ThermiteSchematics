import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  compileProject,
  type CompiledProjectPresentation,
  type ElectricalIr,
} from "@thermite/compiler";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import {
  renderSchematicPacket,
  type SchematicPacketRequest,
} from "../src/index.js";
import * as inline from "../src/layout/circuit-inline.js";
import {
  circuitInlineTrace,
  type CircuitInlineContext,
} from "../src/layout/circuit-inline-context.js";
import {
  elkPacketWorkTrace,
  elkWorkLedger,
  elkWorkScope,
} from "../src/layout/elk-work.js";
import { InlineLabelCollisionError } from "../src/layout/inline-label-error.js";
import { CircuitCaptionCollisionError } from "../src/circuit/caption-error.js";
import * as captionPlacement from "../src/circuit/caption-placement.js";
import * as circuitDrawing from "../src/circuit/layout-drawing.js";
import * as inlinePlate from "../src/circuit/inline-plate.js";
import * as assembly from "../src/packet/assembly.js";
import * as navigationFinalize from "../src/packet/navigation-finalize.js";
import * as referencesFinal from "../src/packet/references-final.js";
import { required } from "./fixtures.js";

const execFileAsync = promisify(execFile);
const functionalRoot = fileURLToPath(
  new URL("../../../examples/functional-symbols/", import.meta.url),
);
const thermiteBin = fileURLToPath(
  new URL("../../../thermite.mjs", import.meta.url),
);

type CircuitView = Extract<
  SchematicPacketRequest["views"][number],
  { format: "circuit-view-request/0.1" }
>;

let baseIr: ElectricalIr;
let basePresentation: CompiledProjectPresentation | undefined;
let baseCircuitView: CircuitView;

beforeAll(async () => {
  const compiled = await compileProject(functionalRoot);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  baseIr = compiled.ir;
  basePresentation = compiled.presentation;
  const req: SchematicPacketRequest = JSON.parse(
    await readFile(
      join(functionalRoot, "packet-left-to-right.request.json"),
      "utf8",
    ),
  );
  const view = req.views.find((v) => v.format === "circuit-view-request/0.1");
  if (!view || view.format !== "circuit-view-request/0.1")
    throw Error("Expected circuit view");
  baseCircuitView = view;
});

afterEach(() => vi.restoreAllMocks());

function inlineModes(input: ElkNode): string[] {
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
      if (inlineModes(input).includes("false"))
        throw new Error("Inline-only control forbids non-inline retry.");
      return real(input, run, strokes, portGroups);
    });
  try {
    return await renderSchematicPacket(ir, request, basePresentation);
  } finally {
    spy.mockRestore();
  }
}

function probeFixture(label = "PW11 MMMMMMMMMM") {
  const ir = structuredClone(baseIr);
  const wire = required(ir.wires.find((w) => w.designation === "W11"));
  wire.properties = { ...wire.properties, label };
  const group = required(
    baseCircuitView.groups.find((g) => g.id === "conductivity-probe"),
  );
  const request: SchematicPacketRequest = {
    format: "schematic-packet-request/0.1",
    page: { size: "a4", orientation: "portrait", marginMm: 25 },
    views: [{ ...baseCircuitView, flow: "top-to-bottom", groups: [group] }],
  };
  return { ir, group, request };
}

function longNotes() {
  const chunk = Array.from({ length: 38 }, () => "MMMMMMMMM").join(" ");
  return Array.from({ length: 12 }, (_, i) => `${i + 1} ${chunk}`);
}

function crossGroupRequest(
  group: CircuitView["groups"][number],
  includeSecond: boolean,
): SchematicPacketRequest {
  const first = { ...group, id: "first", label: "First" };
  const second = {
    ...group,
    id: "second",
    label: "M".repeat(120),
    lineReference: "M".repeat(40),
  };
  return {
    format: "schematic-packet-request/0.1",
    page: { size: "letter", orientation: "landscape", marginMm: 20.75 },
    views: [
      {
        ...baseCircuitView,
        flow: "top-to-bottom",
        groups: includeSecond ? [first, second] : [first],
      },
    ],
  };
}

async function compileManyGroupsProject(count: number, blocked: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "thermite-capretry-many-"));
  await cp(functionalRoot, dir, { recursive: true });
  const objects: unknown[] = [];
  const groups: CircuitView["groups"][number][] = [];
  let seq = 5;
  const uid = () =>
    `80000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
  for (let i = 1; i <= count; i++) {
    const tag = String(i).padStart(2, "0");
    const cp = `CP1-${tag}`,
      x1 = `X1-${tag}`,
      w11 = `W11-${tag}`,
      w12 = `W12-${tag}`;
    objects.push(
      {
        kind: "device",
        uid: uid(),
        designation: cp,
        type: "functional-symbols:conductivity",
      },
      {
        kind: "device",
        uid: uid(),
        designation: x1,
        type: "functional-symbols:interface12",
      },
      {
        kind: "wire",
        uid: uid(),
        designation: w11,
        endpoints: [
          { device: cp, terminal: "A" },
          { device: x1, terminal: "3" },
        ],
        properties: {
          label: blocked ? `P${tag} ${"M".repeat(9 + i)}` : `W${tag}A`,
        },
      },
      {
        kind: "wire",
        uid: uid(),
        designation: w12,
        endpoints: [
          { device: cp, terminal: "B" },
          { device: x1, terminal: "4" },
        ],
      },
    );
    groups.push({
      id: `probe-${tag}`,
      label: `Probe ${tag}`,
      functions: [{ device: { by: "designation", value: cp }, key: "probe" }],
      conductors: [w11, w12],
    });
  }
  await writeFile(
    join(dir, "source.json"),
    JSON.stringify({ objects }, null, 2),
  );
  const compiled = await compileProject(dir);
  await rm(dir, { recursive: true, force: true });
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const request: SchematicPacketRequest = {
    format: "schematic-packet-request/0.1",
    page: { size: "a3", orientation: "landscape" },
    views: [{ ...baseCircuitView, flow: "top-to-bottom", groups }],
  };
  return { ir: compiled.ir, presentation: compiled.presentation, request };
}

function addSyntheticJog(graph: ElkNode): ElkNode {
  const copy = structuredClone(graph);
  const section = required(copy.edges?.[0]?.sections?.[0]);
  const a = section.startPoint;
  const b = section.endPoint;
  const y = (a.y + b.y) / 2;
  section.bendPoints = [
    { x: a.x, y },
    { x: a.x + 1, y },
    { x: a.x + 1, y: y + 1 },
    { x: b.x, y: y + 1 },
  ];
  return copy;
}

async function runCliPacket(projectDir: string, request: unknown) {
  const reqPath = join(projectDir, "probe.request.json");
  const outPath = join(projectDir, "probe.out.json");
  await writeFile(reqPath, JSON.stringify(request));
  try {
    const res = await execFileAsync(process.execPath, [
      thermiteBin,
      "packet",
      "--project",
      projectDir,
      "--input",
      reqPath,
      "--json",
      "-o",
      outPath,
    ]);
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number"
        ? error.code
        : 1;
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr
        : "";
    return { code, stdout: "", stderr };
  }
}

async function runPartitionProbe(
  ir: ElectricalIr,
  request: SchematicPacketRequest,
  nonInlineKey: string,
  recoveredGraph: ElkNode,
  options: {
    baselineHeight?: number;
    qualityWholeHeight?: number;
    recomposition: boolean;
    failPartInQuality?: boolean;
  },
) {
  const injected: CircuitInlineContext[] = [];
  const trace = inline.circuitLayoutRun();
  if (options.baselineHeight !== undefined)
    trace.baseline.set(nonInlineKey, {
      ...recoveredGraph,
      height: options.baselineHeight,
    });
  const originalGet = trace.baseline.get.bind(trace.baseline);
  let context: CircuitInlineContext | undefined;
  trace.baseline.get = (key) => {
    const saved = originalGet(key);
    if (!saved || !context?.qualityPhase || !options.recomposition)
      return saved;
    if (trace.quality && key === nonInlineKey)
      return options.qualityWholeHeight !== undefined
        ? { ...recoveredGraph, height: options.qualityWholeHeight }
        : recoveredGraph;
    if (trace.quality && options.failPartInQuality && trace.printed.has(key))
      return { ...saved, height: 250 };
    if (!trace.quality && trace.printed.has(key)) return addSyntheticJog(saved);
    return saved;
  };
  injected.push = function (ctx) {
    context = ctx;
    ctx.runs = [trace];
    return Array.prototype.push.call(this, ctx);
  };
  const outcome = await circuitInlineTrace.run(injected, () =>
    renderSchematicPacket(ir, request, basePresentation),
  );
  const parts = outcome.ok
    ? outcome.value.sheets.flatMap((s) =>
        Array.from(s.svg.matchAll(/data-circuit-part="(\d+)"/g), (m) =>
          Number(m[1]),
        ),
      )
    : [];
  return { outcome, parts, context };
}

async function captureRenderErrorsByFlow(
  ir: ElectricalIr,
  group: CircuitView["groups"][number],
) {
  const realRender = circuitDrawing.renderCircuitLayout;
  const seen: { vertical: boolean; error: unknown }[] = [];
  vi.spyOn(circuitDrawing, "renderCircuitLayout").mockImplementation(
    (routeState, fs, pins, selfLoops, vertical) => {
      try {
        return realRender(routeState, fs, pins, selfLoops, vertical);
      } catch (error) {
        seen.push({ vertical, error });
        throw error;
      }
    },
  );
  for (const flow of ["left-to-right", "top-to-bottom"] as const) {
    await renderSchematicPacket(
      ir,
      {
        format: "schematic-packet-request/0.1",
        page: { size: "a4", orientation: "portrait", marginMm: 25 },
        views: [{ ...baseCircuitView, flow, groups: [group] }],
      },
      basePresentation,
    );
  }
  return {
    ltr: required(seen.find((s) => !s.vertical)).error,
    ttb: required(seen.find((s) => s.vertical)).error,
  };
}

async function controlledCaptionCollisionHarness(viewA: CircuitView) {
  const { ir: wideIr, request: wideReq } = probeFixture();
  const wideOnlyA: SchematicPacketRequest = { ...wideReq, views: [viewA] };
  const devFailedA: CircuitInlineContext[] = [];
  const failed = await circuitInlineTrace.run(devFailedA, () =>
    renderInlineOnly(wideIr, wideOnlyA),
  );
  expect(failed.ok).toBe(false);
  const wideInlineLayout = required(
    [...required(devFailedA[0]?.runs[0]).baseline.values()][0],
  );
  const nativeOnlyA: SchematicPacketRequest = { ...wideReq, views: [viewA] };
  const sample: CircuitInlineContext[] = [];
  const nativeOk = await circuitInlineTrace.run(sample, () =>
    renderSchematicPacket(baseIr, nativeOnlyA, basePresentation),
  );
  expect(nativeOk.ok).toBe(true);
  const inlineKey = required(
    [...required(sample[0]?.runs[0]).baseline.keys()][0],
  );
  return async (request: SchematicPacketRequest) => {
    const trace: CircuitInlineContext[] = [];
    trace.push = function (context) {
      const run = inline.circuitLayoutRun();
      run.baseline.set(inlineKey, wideInlineLayout);
      context.runs = [run];
      return Array.prototype.push.call(this, context);
    };
    const outcome = await circuitInlineTrace.run(trace, () =>
      renderSchematicPacket(baseIr, request, basePresentation),
    );
    return {
      outcome,
      runs: trace[0]?.runs ?? [],
      fallbacks: trace[0]?.runs[0]?.captionFallbacks.size ?? 0,
    };
  };
}

const packetR006 = (
  message: string,
  details?: Readonly<Record<string, unknown>>,
) => ({
  ok: false as const,
  error: {
    code: "R006" as const,
    root: "packet" as const,
    reason: "unprintable-layout" as const,
    message,
    ...(details ? { details } : {}),
  },
});

async function expectPacketWideRestores(
  wideIr: ElectricalIr,
  req: SchematicPacketRequest,
  expected: Awaited<ReturnType<typeof renderSchematicPacket>>,
  nativeMatch: string,
) {
  const nativeRes = await renderSchematicPacket(baseIr, req, basePresentation);
  expect(nativeRes.ok).toBe(false);
  if (!nativeRes.ok) expect(nativeRes.error.message).toContain(nativeMatch);
  expect(await renderSchematicPacket(wideIr, req, basePresentation)).toEqual(
    expected,
  );
}

describe("TTB circuit caption retry review guards (#552)", () => {
  it("preserves the first caption R006 through notes-fit and CLI composition failures", async () => {
    const { ir, group, request } = probeFixture();
    expect(
      (await renderSchematicPacket(ir, request, basePresentation)).ok,
    ).toBe(true);
    const withNotes: SchematicPacketRequest = {
      ...request,
      views: [
        {
          ...baseCircuitView,
          flow: "top-to-bottom",
          groups: [group],
          notes: longNotes(),
        },
      ],
    };
    const devNotes = await renderInlineOnly(ir, withNotes);
    const headNotes = await renderSchematicPacket(
      ir,
      withNotes,
      basePresentation,
    );
    expect(devNotes.ok).toBe(false);
    expect(headNotes).toEqual(devNotes);
    if (!headNotes.ok) {
      expect(headNotes.error.details?.groupId).toBe("conductivity-probe");
      expect(headNotes.error.message).toContain(
        "Circuit conductivity-probe: caption PW11 MMMMMMMMMM",
      );
    }
    const tmp = await mkdtemp(join(tmpdir(), "thermite-capretry-notes-"));
    try {
      await cp(functionalRoot, tmp, { recursive: true });
      const srcPath = join(tmp, "source.json");
      const src = JSON.parse(await readFile(srcPath, "utf8"));
      const w11 = src.objects.find(
        (o: { designation?: string }) => o.designation === "W11",
      );
      w11.properties = { ...w11.properties, label: "PW11 MMMMMMMMMM" };
      await writeFile(srcPath, JSON.stringify(src, null, 2));
      const cli = await runCliPacket(tmp, withNotes);
      expect(cli.code).toBe(1);
      const parsed = JSON.parse(cli.stderr);
      expect(parsed.error).toEqual(devNotes.ok ? null : devNotes.error);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps another view's Q001 when a recovered circuit view precedes a missing rooted device", async () => {
    const { ir: wideIr, group, request } = probeFixture();
    const viewA: CircuitView = {
      ...baseCircuitView,
      title: "View A - conductivity probe",
      flow: "top-to-bottom",
      groups: [group],
    };
    const viewB = {
      format: "schematic-view-request/0.1" as const,
      root: { by: "designation" as const, value: "No such device" },
      family: "control" as const,
      flow: "left-to-right" as const,
    };
    const both: SchematicPacketRequest = { ...request, views: [viewA, viewB] };
    const nativeControl = await renderSchematicPacket(
      baseIr,
      both,
      basePresentation,
    );
    expect(nativeControl.ok).toBe(false);
    if (!nativeControl.ok) {
      expect(nativeControl.error.code).toBe("Q001");
      expect(nativeControl.error.details?.viewIndex).toBe(1);
    }

    const renderWithCollision = await controlledCaptionCollisionHarness(viewA);
    const injectedA = await renderWithCollision({ ...request, views: [viewA] });
    const injectedBoth = await renderWithCollision(both);
    expect(injectedA.outcome.ok).toBe(true);
    expect(injectedA.fallbacks).toBe(1);
    expect(injectedBoth.outcome.ok).toBe(false);
    expect(injectedBoth.fallbacks).toBe(1);
    expect(JSON.stringify(injectedBoth.outcome)).toBe(
      JSON.stringify(nativeControl),
    );

    const wideBoth = await renderSchematicPacket(
      wideIr,
      both,
      basePresentation,
    );
    expect(JSON.stringify(wideBoth)).toBe(JSON.stringify(nativeControl));
  });

  it("keeps another circuit view's notes-fit R006 after an earlier recovered circuit view", async () => {
    const { ir: wideIr, group, request } = probeFixture();
    const viewA: CircuitView = {
      ...baseCircuitView,
      title: "View A - conductivity probe",
      flow: "top-to-bottom",
      groups: [group],
    };
    const transformer = required(
      baseCircuitView.groups.find((g) => g.id === "transformer"),
    );
    const viewB: CircuitView = {
      ...baseCircuitView,
      title: "View B - transformer notes",
      flow: "left-to-right",
      groups: [transformer],
      notes: longNotes(),
    };
    const bothNotes: SchematicPacketRequest = {
      ...request,
      views: [viewA, viewB],
    };

    const nativeNotes = await renderSchematicPacket(
      baseIr,
      bothNotes,
      basePresentation,
    );
    expect(nativeNotes.ok).toBe(false);
    if (!nativeNotes.ok) {
      expect(nativeNotes.error.code).toBe("R006");
      expect(nativeNotes.error.details?.viewIndex).toBe(1);
      expect(nativeNotes.error.message).toMatch(
        /view\[1\].*Circuit notes cannot fit/,
      );
    }

    const renderWithCollision = await controlledCaptionCollisionHarness(viewA);
    const injectedNotes = await renderWithCollision(bothNotes);
    expect(injectedNotes.fallbacks).toBe(1);
    expect(injectedNotes.runs[1]?.attempts).toBe(1);
    expect(injectedNotes.runs[1]?.captionFallbacks.size).toBe(0);
    expect(JSON.stringify(injectedNotes.outcome)).toBe(
      JSON.stringify(nativeNotes),
    );

    const wideTrace: CircuitInlineContext[] = [];
    const wideNotes = await circuitInlineTrace.run(wideTrace, () =>
      renderSchematicPacket(wideIr, bothNotes, basePresentation),
    );
    expect(wideTrace[0]?.runs[0]?.captionFallbacks.size).toBe(1);
    expect(wideTrace[0]?.runs[1]?.attempts).toBe(1);
    expect(wideTrace[0]?.runs[1]?.captionFallbacks.size).toBe(0);
    expect(JSON.stringify(wideNotes)).toBe(JSON.stringify(nativeNotes));
  });

  it("restores the first recovered caption R006 on packet-wide assembly and composition failures", async () => {
    const { ir: wideIr, group, request } = probeFixture();
    const transformer = required(
      baseCircuitView.groups.find((g) => g.id === "transformer"),
    );
    const bothValid: SchematicPacketRequest = {
      ...request,
      views: [
        {
          ...baseCircuitView,
          title: "View A - conductivity probe",
          flow: "top-to-bottom",
          groups: [group],
        },
        {
          ...baseCircuitView,
          title: "View B - transformer",
          flow: "left-to-right",
          groups: [transformer],
        },
      ],
    };
    expect(
      (await renderSchematicPacket(wideIr, bothValid, basePresentation)).ok,
    ).toBe(true);
    const devA = await renderInlineOnly(wideIr, bothValid);
    expect(devA.ok).toBe(false);

    vi.spyOn(navigationFinalize, "finalizeNavigation").mockReturnValue(
      packetR006("Synthetic packet navigation failure.", {
        navigationInvariant: true,
      }),
    );
    await expectPacketWideRestores(
      wideIr,
      bothValid,
      devA,
      "Synthetic packet navigation failure.",
    );
    vi.restoreAllMocks();

    vi.spyOn(referencesFinal, "finalReferenceDrafts").mockReturnValue(
      packetR006(
        "A bounded final index cannot fit within the 100-sheet packet limit.",
      ),
    );
    await expectPacketWideRestores(
      wideIr,
      { ...bothValid, index: true },
      devA,
      "100-sheet packet limit",
    );
    vi.restoreAllMocks();

    const realAppend = assembly.appendViewDrafts;
    vi.spyOn(assembly, "appendViewDrafts").mockImplementation(
      (drafts, incoming, viewIndex, ...rest) => {
        const nextRef = realAppend(drafts, incoming, viewIndex, ...rest);
        if (viewIndex === 1 && drafts[0])
          while (drafts.length <= 100) drafts.push(drafts[0]);
        return nextRef;
      },
    );
    await expectPacketWideRestores(
      wideIr,
      bothValid,
      devA,
      "100-sheet alpha limit",
    );
  });

  it("keys recovery mode and first cause per logical group, preserving first-group identity", async () => {
    const { ir, group } = probeFixture();
    expect(
      (
        await renderSchematicPacket(
          ir,
          crossGroupRequest(group, false),
          basePresentation,
        )
      ).ok,
    ).toBe(true);

    const both = crossGroupRequest(group, true);
    const devBoth = await renderInlineOnly(ir, both);
    const headBoth = await renderSchematicPacket(ir, both, basePresentation);
    expect(devBoth.ok).toBe(false);
    expect(headBoth).toEqual(devBoth);
    if (!headBoth.ok) {
      expect(headBoth.error.details?.groupId).toBe("first");
      expect(headBoth.error.message).toContain("Circuit first: caption");
    }

    const twoFitting: SchematicPacketRequest = {
      format: "schematic-packet-request/0.1",
      page: { size: "a3", orientation: "landscape" },
      views: [
        {
          ...baseCircuitView,
          flow: "top-to-bottom",
          groups: [
            { ...group, id: "first", label: "First" },
            { ...group, id: "second", label: "Second" },
          ],
        },
      ],
    };
    const traces: CircuitInlineContext[] = [];
    const work = { calls: 0, cacheHits: 0, outsideSearchCalls: 0 };
    const issued = await elkPacketWorkTrace.run(work, () =>
      circuitInlineTrace.run(traces, () =>
        renderSchematicPacket(ir, twoFitting, basePresentation),
      ),
    );
    expect(issued.ok).toBe(true);
    expect(traces[0]?.runs[0]?.captionFallbacks.size).toBe(2);
    expect(work.calls).toBe(2);
  });

  it("enforces the 48-placement ceiling on the 47-attempt public-entry probe", async () => {
    const { ir, request } = probeFixture();
    const devSingle = await renderInlineOnly(ir, request);
    expect(devSingle.ok).toBe(false);

    const cases: readonly [number, number, boolean][] = [
      [0, 48, true],
      [47, 48, false],
      [47, 1, false],
    ];
    for (const [start, limit, expectOk] of cases) {
      const contexts: CircuitInlineContext[] = [];
      const run = inline.circuitLayoutRun();
      run.attempts = start;
      contexts.push = function (ctx) {
        ctx.runs = [run];
        return Array.prototype.push.call(this, ctx);
      };
      const ledger = elkWorkLedger("ceiling-test", limit);
      const outcome = await elkWorkScope.run(ledger, () =>
        circuitInlineTrace.run(contexts, () =>
          renderSchematicPacket(ir, request, basePresentation),
        ),
      );
      expect(outcome.ok).toBe(expectOk);
      if (expectOk) {
        expect(ledger.calls).toBe(2);
        expect(run.attempts).toBe(2);
        expect(run.captionFallbacks.size).toBe(1);
      } else {
        expect(outcome).toEqual(devSingle);
        expect(ledger.calls).toBe(1);
        expect(ledger.dispatches).toBe(1);
        expect(run.attempts).toBe(48);
        expect(run.captionFallbacks.size).toBe(0);
      }
    }
  });

  it("stops retrying past 48 placements across 25 blocked groups while leaving 50 native groups uncapped", async () => {
    const blocked25 = await compileManyGroupsProject(25, true);
    const dev25 = await renderInlineOnly(blocked25.ir, blocked25.request);
    const traces25: CircuitInlineContext[] = [];
    const work25 = { calls: 0, cacheHits: 0, outsideSearchCalls: 0 };
    const head25 = await elkPacketWorkTrace.run(work25, () =>
      circuitInlineTrace.run(traces25, () =>
        renderSchematicPacket(
          blocked25.ir,
          blocked25.request,
          blocked25.presentation,
        ),
      ),
    );
    expect(head25.ok).toBe(false);
    expect(head25).toEqual(dev25);
    expect(work25.calls).toBe(49);
    expect(traces25[0]?.runs[0]?.attempts).toBe(49);
    expect(traces25[0]?.runs[0]?.captionFallbacks.size).toBe(24);

    const native50 = await compileManyGroupsProject(50, false);
    const traces50: CircuitInlineContext[] = [];
    const head50 = await circuitInlineTrace.run(traces50, () =>
      renderSchematicPacket(
        native50.ir,
        native50.request,
        native50.presentation,
      ),
    );
    expect(head50.ok).toBe(true);
    expect(traces50[0]?.runs[0]?.attempts).toBe(50);
    expect(traces50[0]?.runs[0]?.captionFallbacks.size).toBe(0);
  });

  it("replays the accepted partition during quality recomposition and rejects partition changes", async () => {
    const { ir, request } = probeFixture();
    const sample: CircuitInlineContext[] = [];
    const control = await circuitInlineTrace.run(sample, () =>
      renderSchematicPacket(ir, request, basePresentation),
    );
    expect(control.ok).toBe(true);
    const oldRun = required(sample[0]?.runs[0]);
    const nonInlineKey = required([...oldRun.printed][0]);
    const recoveredGraph = required(oldRun.baseline.get(nonInlineKey));

    // 1) quality-partition-probe repro: baseline [1, 2] stays [1, 2] on recomposition.
    const base = await runPartitionProbe(
      ir,
      request,
      nonInlineKey,
      recoveredGraph,
      {
        baselineHeight: 250,
        recomposition: false,
      },
    );
    const replayed = await runPartitionProbe(
      ir,
      request,
      nonInlineKey,
      recoveredGraph,
      { baselineHeight: 250, recomposition: true },
    );
    expect(base.parts).toEqual([1, 2]);
    expect(replayed.parts).toEqual([1, 2]);
    if (base.outcome.ok && replayed.outcome.ok)
      expect(replayed.outcome.value.sheets.length).toBe(
        base.outcome.value.sheets.length,
      );

    // 2) If quality geometry breaks a replayed part's fit, reject quality candidate.
    const rejectedPart = await runPartitionProbe(
      ir,
      request,
      nonInlineKey,
      recoveredGraph,
      { baselineHeight: 250, recomposition: true, failPartInQuality: true },
    );
    expect(rejectedPart.outcome.ok).toBe(true);
    expect(rejectedPart.parts).toEqual([1, 2]);
    expect(rejectedPart.context?.selected.size).toBe(0);
    expect(rejectedPart.context?.viewDecisions[0]?.reason).toBe(
      "composition fit",
    );

    // 3) If baseline-whole recovered group overflows in quality, reject candidate.
    const rejectedWhole = await runPartitionProbe(
      ir,
      request,
      nonInlineKey,
      recoveredGraph,
      { recomposition: true, qualityWholeHeight: 250 },
    );
    expect(rejectedWhole.outcome.ok).toBe(true);
    expect(rejectedWhole.parts).toEqual([]);
    expect(rejectedWhole.context?.selected.size).toBe(0);
    expect(rejectedWhole.context?.viewDecisions[0]?.reason).toBe(
      "composition fit",
    );
  });

  it("raises CircuitCaptionCollisionError only in TTB and keeps InlineLabelCollisionError in LTR", async () => {
    const { ir, group } = probeFixture("W11");

    // 1) caption-plan.ts:31 unplaceable caption path
    vi.spyOn(captionPlacement, "circuitCaptionPlacement").mockReturnValue(
      undefined,
    );
    const planErrors = await captureRenderErrorsByFlow(ir, group);
    expect(planErrors.ltr).toBeInstanceOf(InlineLabelCollisionError);
    expect(planErrors.ltr).not.toBeInstanceOf(CircuitCaptionCollisionError);
    expect(planErrors.ttb).toBeInstanceOf(CircuitCaptionCollisionError);
    vi.restoreAllMocks();

    // 2) layout-drawing.ts:159 plate obstruction path
    vi.spyOn(inlinePlate, "circuitCaptionPlate").mockReturnValue(undefined);
    const plateErrors = await captureRenderErrorsByFlow(ir, group);
    expect(plateErrors.ltr).toBeInstanceOf(InlineLabelCollisionError);
    expect(plateErrors.ltr).not.toBeInstanceOf(CircuitCaptionCollisionError);
    expect(plateErrors.ttb).toBeInstanceOf(CircuitCaptionCollisionError);
  });
});
