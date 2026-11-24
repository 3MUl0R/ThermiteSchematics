import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { required } from "./fixtures.js";

const functionalRoot = fileURLToPath(
  new URL("../../../examples/functional-symbols/", import.meta.url),
);

type CircuitView = Extract<
  SchematicPacketRequest["views"][number],
  { format: "circuit-view-request/0.1" }
>;

const reportView = {
  format: "documentation-view-request/0.1" as const,
  kind: "bom" as const,
};

const missingRootedView = {
  format: "schematic-view-request/0.1" as const,
  root: { by: "designation" as const, value: "No such device" },
  family: "control" as const,
  flow: "left-to-right" as const,
};

const page = {
  size: "a4" as const,
  orientation: "portrait" as const,
  marginMm: 25,
};

interface SheetLimitFixture {
  nativeIr: ElectricalIr;
  wideIr: ElectricalIr;
  presentation: CompiledProjectPresentation | undefined;
  viewA: CircuitView;
  padView: CircuitView;
  sheetsPerReport: number;
  inlineKey: string;
  blockedLayout: ElkNode;
}

let fixture: SheetLimitFixture;

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
  presentation: CompiledProjectPresentation | undefined,
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
    return await renderSchematicPacket(ir, request, presentation);
  } finally {
    spy.mockRestore();
  }
}

async function compileExpandedProject(wide: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "thermite-capretry-limit-"));
  try {
    await cp(functionalRoot, dir, { recursive: true });
    const srcPath = join(dir, "source.json");
    const src = JSON.parse(await readFile(srcPath, "utf8"));
    if (wide) {
      const w11 = src.objects.find(
        (o: { designation?: string }) => o.designation === "W11",
      );
      w11.properties = { ...w11.properties, label: "PW11 MMMMMMMMMM" };
    }
    for (let i = 1; i <= 144; i++) {
      src.objects.push({
        kind: "device",
        uid: `85124999-4000-4000-a000-${String(i).padStart(12, "0")}`,
        designation: `EX${String(i).padStart(3, "0")}`,
        type: "functional-symbols:conductivity",
        description: `Synthetic report row ${i}`,
      });
    }
    await writeFile(srcPath, JSON.stringify(src, null, 2));
    const compiled = await compileProject(dir);
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    return compiled;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function packetRequest(
  views: SchematicPacketRequest["views"],
): SchematicPacketRequest {
  return { format: "schematic-packet-request/0.1", page, views };
}

async function renderWithInjectedCollision(request: SchematicPacketRequest) {
  const trace: CircuitInlineContext[] = [];
  trace.push = function (context) {
    const run = inline.circuitLayoutRun();
    run.baseline.set(fixture.inlineKey, fixture.blockedLayout);
    context.runs = [run];
    return Array.prototype.push.call(this, context);
  };
  const outcome = await circuitInlineTrace.run(trace, () =>
    renderSchematicPacket(fixture.nativeIr, request, fixture.presentation),
  );
  return {
    outcome,
    fallbacks: trace[0]?.runs[0]?.captionFallbacks.size ?? 0,
  };
}

async function loadBaseViews(): Promise<{
  viewA: CircuitView;
  padView: CircuitView;
}> {
  const req: SchematicPacketRequest = JSON.parse(
    await readFile(
      join(functionalRoot, "packet-left-to-right.request.json"),
      "utf8",
    ),
  );
  const baseCircuit = req.views.find(
    (v) => v.format === "circuit-view-request/0.1",
  );
  if (!baseCircuit || baseCircuit.format !== "circuit-view-request/0.1")
    throw Error("Expected circuit view");
  const probe = required(
    baseCircuit.groups.find((g) => g.id === "conductivity-probe"),
  );
  const transformer = required(
    baseCircuit.groups.find((g) => g.id === "transformer"),
  );
  return {
    viewA: {
      ...baseCircuit,
      title: "View A - conductivity probe",
      flow: "top-to-bottom",
      groups: [probe],
    },
    padView: {
      ...baseCircuit,
      title: "Pad - transformer",
      flow: "left-to-right",
      groups: [transformer],
    },
  };
}

beforeAll(async () => {
  const [nativeCompiled, wideCompiled, { viewA, padView }] = await Promise.all([
    compileExpandedProject(false),
    compileExpandedProject(true),
    loadBaseViews(),
  ]);
  const nativeTrace: CircuitInlineContext[] = [];
  const devWideTrace: CircuitInlineContext[] = [];
  const [nativeA, devWideA, report] = await Promise.all([
    circuitInlineTrace.run(nativeTrace, () =>
      renderSchematicPacket(
        nativeCompiled.ir,
        packetRequest([viewA]),
        nativeCompiled.presentation,
      ),
    ),
    circuitInlineTrace.run(devWideTrace, () =>
      renderInlineOnly(
        wideCompiled.ir,
        packetRequest([viewA]),
        wideCompiled.presentation,
      ),
    ),
    renderSchematicPacket(
      nativeCompiled.ir,
      packetRequest([reportView]),
      nativeCompiled.presentation,
    ),
  ]);
  if (!nativeA.ok || devWideA.ok || !report.ok)
    throw Error("Unexpected fixture setup outcome");
  fixture = {
    nativeIr: nativeCompiled.ir,
    wideIr: wideCompiled.ir,
    presentation: nativeCompiled.presentation,
    viewA,
    padView,
    sheetsPerReport: report.value.sheets.length,
    inlineKey: required(
      [...required(nativeTrace[0]?.runs[0]).baseline.keys()][0],
    ),
    blockedLayout: required(
      [...required(devWideTrace[0]?.runs[0]).baseline.values()][0],
    ),
  };
});

afterEach(() => vi.restoreAllMocks());

describe("TTB circuit caption retry in-loop sheet-limit guards (#552)", () => {
  it("keeps the native alpha-limit R006 when a later non-recovered view crosses 100 while views remain pending", async () => {
    const canFit = Math.floor((100 - 1) / fixture.sheetsPerReport);
    const reports = Array.from({ length: canFit + 1 }, () => ({
      ...reportView,
    }));
    const early = packetRequest([fixture.viewA, ...reports, missingRootedView]);
    const finalView = packetRequest([fixture.viewA, ...reports]);

    const nativeEarly = await renderSchematicPacket(
      fixture.nativeIr,
      early,
      fixture.presentation,
    );
    expect(nativeEarly.ok).toBe(false);
    if (!nativeEarly.ok) {
      expect(nativeEarly.error.code).toBe("R006");
      expect(nativeEarly.error.message).toContain(
        "Packet exceeds the 100-sheet alpha limit",
      );
      const views = nativeEarly.error.details?.views;
      expect(Array.isArray(views) ? views.length : 0).toBe(canFit + 2);
    }

    const injectedEarly = await renderWithInjectedCollision(early);
    expect(injectedEarly.fallbacks).toBe(1);
    expect(JSON.stringify(injectedEarly.outcome)).toBe(
      JSON.stringify(nativeEarly),
    );

    const wideTrace: CircuitInlineContext[] = [];
    const wideEarly = await circuitInlineTrace.run(wideTrace, () =>
      renderSchematicPacket(fixture.wideIr, early, fixture.presentation),
    );
    expect(wideTrace[0]?.runs[0]?.captionFallbacks.size).toBe(1);
    expect(JSON.stringify(wideEarly)).toBe(JSON.stringify(nativeEarly));

    const devFinal = await renderInlineOnly(
      fixture.wideIr,
      finalView,
      fixture.presentation,
    );
    const wideFinal = await renderSchematicPacket(
      fixture.wideIr,
      finalView,
      fixture.presentation,
    );
    expect(devFinal.ok).toBe(false);
    expect(JSON.stringify(wideFinal)).toBe(JSON.stringify(devFinal));
  });

  it("returns the recovered view's own caption R006 when its own drafts cross 100 while views remain pending", async () => {
    const bomCount = Math.floor(100 / fixture.sheetsPerReport);
    const padCount = 100 - bomCount * fixture.sheetsPerReport;
    const boms = Array.from({ length: bomCount }, () => ({ ...reportView }));
    const pads = Array.from({ length: padCount }, () => ({
      ...fixture.padView,
    }));
    const crossingView: CircuitView = {
      ...fixture.viewA,
      title: "View Crossing - conductivity probe",
    };
    const crossingIndex = bomCount + padCount;
    const req = packetRequest([
      ...boms,
      ...pads,
      crossingView,
      missingRootedView,
    ]);

    const nativeRes = await renderSchematicPacket(
      fixture.nativeIr,
      req,
      fixture.presentation,
    );
    expect(nativeRes.ok).toBe(false);
    if (!nativeRes.ok)
      expect(nativeRes.error.message).toContain(
        "Packet exceeds the 100-sheet alpha limit",
      );

    const devWide = await renderInlineOnly(
      fixture.wideIr,
      req,
      fixture.presentation,
    );
    expect(devWide.ok).toBe(false);
    if (!devWide.ok)
      expect(devWide.error.details?.viewIndex).toBe(crossingIndex);

    const wideTrace: CircuitInlineContext[] = [];
    const wideRes = await circuitInlineTrace.run(wideTrace, () =>
      renderSchematicPacket(fixture.wideIr, req, fixture.presentation),
    );
    expect(wideTrace[0]?.runs.at(-1)?.captionFallbacks.size).toBe(1);
    expect(JSON.stringify(wideRes)).toBe(JSON.stringify(devWide));

    // Also verify when an earlier view recovered too: crossing view keeps its own caption R006.
    const twoRecovered = packetRequest([
      fixture.viewA,
      ...boms,
      ...pads.slice(0, -1),
      crossingView,
      missingRootedView,
    ]);
    const twoWide = await renderSchematicPacket(
      fixture.wideIr,
      twoRecovered,
      fixture.presentation,
    );
    expect(twoWide.ok).toBe(false);
    if (!twoWide.ok) {
      expect(twoWide.error.code).toBe("R006");
      expect(twoWide.error.details?.viewIndex).toBe(crossingIndex);
      expect(twoWide.error.details?.viewTitle).toBe(crossingView.title);
      expect(twoWide.error.message).toContain(
        "Circuit conductivity-probe: caption PW11 MMMMMMMMMM",
      );
    }
  });
});
