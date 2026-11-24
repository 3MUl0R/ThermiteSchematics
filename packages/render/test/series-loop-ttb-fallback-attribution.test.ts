import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileProject,
  lockProject,
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
import * as assembly from "../src/packet/assembly.js";
import * as signalLoop from "../src/signal-loop.js";
import type { SignalLoopViewRequest } from "../src/signal-loop.js";
import { SERIES_LOOP_LTR_FALLBACK_NOTICE } from "../src/signal-loop/series-layout.js";
import { required } from "./fixtures.js";
import { endpoint, seriesModel } from "./series-loop-fixture.js";

const functionalRoot = fileURLToPath(
  new URL("../../../examples/functional-symbols/", import.meta.url),
);

type CircuitView = Extract<
  SchematicPacketRequest["views"][number],
  { format: "circuit-view-request/0.1" }
>;

const TABLOID_LANDSCAPE = {
  size: "tabloid" as const,
  orientation: "landscape" as const,
};

const bomView = {
  format: "documentation-view-request/0.1" as const,
  kind: "bom" as const,
};

const missingRootedView = {
  format: "schematic-view-request/0.1" as const,
  root: { by: "designation" as const, value: "LOOPFB-MISSING" },
  family: "control" as const,
  flow: "left-to-right" as const,
};

const loopTtb: SignalLoopViewRequest = {
  format: "signal-loop-view-request/0.1",
  from: { device: "SL_TX1", function: "signal" },
  to: { device: "SL_AI1", function: "input" },
  loopPower: { device: "SL_PS1", function: "output" },
  flow: "top-to-bottom",
};

const loopLtr: SignalLoopViewRequest = { ...loopTtb, flow: "left-to-right" };

interface AttributionFixture {
  ir: ElectricalIr;
  nativeIr: ElectricalIr;
  presentation: CompiledProjectPresentation | undefined;
  captionView: CircuitView;
  padView: CircuitView;
  bomSheets: number;
  notesMarginMm: number;
  dispose: () => Promise<void>;
}

let fx: AttributionFixture;

function slUid(n: number): string {
  return `75000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function slWire(n: number, a: string, at: string, b: string, bt: string) {
  return {
    kind: "wire",
    uid: slUid(n),
    designation: `SLW${n}`,
    endpoints: [endpoint(a, at), endpoint(b, bt)],
  };
}

function seriesLoopAdditions() {
  const devices = [
    ["SL_PS1", "series:ps", 1],
    ["SL_TX1", "series:tx", 2],
    ["SL_AI1", "series:ai", 3],
    ["SL_TB1", "series:strip", 4],
    ["SL_TB2", "series:strip", 5],
  ] as const;
  return [
    ...devices.map(([designation, type, id]) => ({
      kind: "device",
      uid: slUid(id),
      designation,
      type,
      ...(designation === "SL_AI1"
        ? {
            description:
              "Process PLC analog input module 4-20 mA channel 0 field transmitter interface card with isolated loop return",
          }
        : {}),
    })),
    slWire(10, "SL_PS1", "p", "SL_AI1", "p"),
    slWire(101, "SL_AI1", "n", "SL_TB1", "1"),
    slWire(102, "SL_TB1", "1", "SL_TB2", "1"),
    slWire(105, "SL_TB2", "2", "SL_TB1", "2"),
    slWire(106, "SL_TB1", "2", "SL_PS1", "n"),
    {
      kind: "cable",
      uid: slUid(30),
      designation: "SL_CB1",
      type: "series:cable4",
      conductors: [
        {
          id: "1",
          usage: "in-use",
          endpoints: [endpoint("SL_TX1", "p"), endpoint("SL_TB2", "1")],
        },
        {
          id: "2",
          usage: "in-use",
          endpoints: [endpoint("SL_TX1", "n"), endpoint("SL_TB2", "2")],
        },
        {
          id: "3",
          usage: "spare",
          endpoints: [endpoint("SL_TX1", "s1"), endpoint("SL_TB2", "3")],
        },
        {
          id: "4",
          usage: "spare",
          endpoints: [endpoint("SL_TX1", "s2"), endpoint("SL_TB2", "4")],
        },
      ],
    },
  ];
}

function seriesLoopTypes() {
  const { types } = seriesModel(true);
  const tx = required(types.find((t) => t.id === "series:tx"));
  tx.terminals.s1 = { connection_policy: "shared" };
  tx.terminals.s2 = { connection_policy: "shared" };
  types.push({
    kind: "cable_type",
    id: "series:cable4",
    conductors: [
      { id: "1", color: "brown" },
      { id: "2", color: "blue" },
      { id: "3", color: "black" },
      { id: "4", color: "white" },
    ],
  });
  return types;
}

async function compileCombinedProject(wideCaption: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "thermite-loopfb-attr-"));
  await cp(functionalRoot, dir, { recursive: true });
  await mkdir(join(dir, "series-library"));
  const types = seriesLoopTypes();
  await writeFile(
    join(dir, "series-library/library.json"),
    JSON.stringify({
      name: "series",
      version: "0.1.0",
      sources: ["types.json"],
    }),
  );
  await writeFile(
    join(dir, "series-library/types.json"),
    JSON.stringify({ types }),
  );
  const sysPath = join(dir, "system.json");
  const sys = JSON.parse(await readFile(sysPath, "utf8"));
  sys.libraries.push({
    name: "series",
    version: "0.1.0",
    path: "series-library",
  });
  await writeFile(sysPath, JSON.stringify(sys, null, 2));
  const srcPath = join(dir, "source.json");
  const src = JSON.parse(await readFile(srcPath, "utf8"));
  if (wideCaption) {
    const w9 = required(
      src.objects.find((o: { designation?: string }) => o.designation === "W9"),
    );
    w9.properties = {
      ...w9.properties,
      label: "212",
      size: "18AWG",
      color: "blue/white-wide-caption",
    };
  }
  src.objects.push(...seriesLoopAdditions());
  for (let i = 1; i <= 180; i++) {
    src.objects.push({
      kind: "device",
      uid: `85125999-4000-4000-a000-${String(i).padStart(12, "0")}`,
      designation: `EX${String(i).padStart(3, "0")}`,
      type: "functional-symbols:conductivity",
      description: `Synthetic BOM row ${i}`,
    });
  }
  await writeFile(srcPath, JSON.stringify(src, null, 2));
  const locked = await lockProject(dir);
  if (!locked.ok) throw Error(JSON.stringify(locked.diagnostics));
  const compiled = await compileProject(dir);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  return { compiled, dir };
}

function packetFor(
  views: SchematicPacketRequest["views"],
  page: SchematicPacketRequest["page"] = TABLOID_LANDSCAPE,
): SchematicPacketRequest {
  return {
    format: "schematic-packet-request/0.1",
    index: false,
    page,
    views,
  };
}

function inlineModes(input: ElkNode): string[] {
  return (input.edges ?? []).flatMap((e) =>
    (e.labels ?? []).map(
      (l) => l.layoutOptions?.["elk.edgeLabels.inline"] ?? "",
    ),
  );
}

async function renderNoLoopRetry(
  ir: ElectricalIr,
  request: SchematicPacketRequest,
  presentation: CompiledProjectPresentation | undefined,
) {
  const real = signalLoop.prepareSignalLoopDrawing;
  const spy = vi
    .spyOn(signalLoop, "prepareSignalLoopDrawing")
    .mockImplementation((i, req, accept, notices) => {
      if (notices?.includes(SERIES_LOOP_LTR_FALLBACK_NOTICE))
        throw new Error("No-loop-retry control forbids LTR fallback.");
      return real(i, req, accept, notices);
    });
  try {
    return await renderSchematicPacket(ir, request, presentation);
  } finally {
    spy.mockRestore();
  }
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

function capPaddingViews(existingSheets: number) {
  const padCount = Math.floor((100 - existingSheets) / fx.bomSheets) + 1;
  return Array.from({ length: padCount }, () => ({ ...bomView }));
}

function exact100Views(existingSheets: number) {
  const remaining = 100 - existingSheets;
  const bomCount = Math.floor(remaining / fx.bomSheets);
  const padCount = remaining - bomCount * fx.bomSheets;
  return [
    ...Array.from({ length: bomCount }, () => ({ ...bomView })),
    ...Array.from({ length: padCount }, () => ({ ...fx.padView })),
  ];
}

async function loadCircuitViews() {
  const req: SchematicPacketRequest = JSON.parse(
    await readFile(
      join(functionalRoot, "packet-left-to-right.request.json"),
      "utf8",
    ),
  );
  const base = req.views.find((v) => v.format === "circuit-view-request/0.1");
  if (!base || base.format !== "circuit-view-request/0.1")
    throw Error("Expected circuit view");
  const level = required(base.groups.find((g) => g.id === "level-sensor"));
  const transformer = required(base.groups.find((g) => g.id === "transformer"));
  return {
    captionView: {
      ...base,
      title: "Level sensor TTB",
      flow: "top-to-bottom" as const,
      groups: [level],
    },
    padView: {
      ...base,
      title: "Pad transformer",
      flow: "left-to-right" as const,
      groups: [transformer],
    },
  };
}

const lateNotesLoop: SignalLoopViewRequest = {
  ...loopLtr,
  enclosures: [
    {
      label: "Main electrical cabinet",
      devices: ["SL_TB1", "SL_PS1", "SL_AI1"],
    },
  ],
  notes: Array.from({ length: 6 }, () => "W".repeat(240)),
};

async function findTightNotesMargin(
  ir: ElectricalIr,
  presentation: CompiledProjectPresentation | undefined,
): Promise<number> {
  const attempts: unknown[] = [];
  for (const marginMm of [15, 20, 22, 24, 25]) {
    const page = { ...TABLOID_LANDSCAPE, marginMm };
    const [rec, flooded] = await Promise.all([
      renderSchematicPacket(ir, packetFor([loopTtb], page), presentation),
      renderSchematicPacket(ir, packetFor([lateNotesLoop], page), presentation),
    ]);
    if (rec.ok && !flooded.ok) return marginMm;
    attempts.push({
      marginMm,
      rec: rec.ok ? "ok" : rec.error.message,
      flooded: flooded.ok ? "ok" : flooded.error.message,
    });
  }
  throw Error(
    `Could not find shared margin where loop recovers and notes fail: ${JSON.stringify(attempts)}`,
  );
}

beforeAll(async () => {
  const [wide, native, { captionView, padView }] = await Promise.all([
    compileCombinedProject(true),
    compileCombinedProject(false),
    loadCircuitViews(),
  ]);
  const [bom, notesMarginMm] = await Promise.all([
    renderSchematicPacket(
      wide.compiled.ir,
      packetFor([bomView]),
      wide.compiled.presentation,
    ),
    findTightNotesMargin(wide.compiled.ir, wide.compiled.presentation),
  ]);
  if (!bom.ok) throw Error("Expected BOM view to render");
  fx = {
    ir: wide.compiled.ir,
    nativeIr: native.compiled.ir,
    presentation: wide.compiled.presentation,
    captionView,
    padView,
    bomSheets: bom.value.sheets.length,
    notesMarginMm,
    dispose: async () => {
      await Promise.all([
        rm(wide.dir, { recursive: true, force: true }),
        rm(native.dir, { recursive: true, force: true }),
      ]);
    },
  };
});

afterAll(async () => {
  await fx?.dispose();
});

afterEach(() => vi.restoreAllMocks());

describe("series loop LTR fallback attribution regressions (#552 review)", () => {
  it("keeps a later view's Q001 refusal byte-identical to the explicit-LTR native control", async () => {
    const [nativeRes, headRes] = await Promise.all([
      renderSchematicPacket(
        fx.ir,
        packetFor([loopLtr, missingRootedView]),
        fx.presentation,
      ),
      renderSchematicPacket(
        fx.ir,
        packetFor([loopTtb, missingRootedView]),
        fx.presentation,
      ),
    ]);
    expect(nativeRes.ok).toBe(false);
    if (!nativeRes.ok) {
      expect(nativeRes.error.code).toBe("Q001");
      expect(nativeRes.error.details?.viewIndex).toBe(1);
    }
    expect(JSON.stringify(headRes)).toBe(JSON.stringify(nativeRes));
  });

  it("keeps the native in-loop 100-sheet cap R006 when a later view crosses the cap with a view pending", async () => {
    const padding = capPaddingViews(1);
    const [nativeRes, headRes] = await Promise.all([
      renderSchematicPacket(
        fx.ir,
        packetFor([loopLtr, ...padding, missingRootedView]),
        fx.presentation,
      ),
      renderSchematicPacket(
        fx.ir,
        packetFor([loopTtb, ...padding, missingRootedView]),
        fx.presentation,
      ),
    ]);
    expect(nativeRes.ok).toBe(false);
    if (!nativeRes.ok) {
      expect(nativeRes.error.code).toBe("R006");
      expect(nativeRes.error.message).toContain(
        "Packet exceeds the 100-sheet alpha limit",
      );
      const views = nativeRes.error.details?.views;
      expect(Array.isArray(views) ? views.length : 0).toBe(padding.length + 1);
    }
    expect(JSON.stringify(headRes)).toBe(JSON.stringify(nativeRes));
  });

  it("keeps a later LTR loop's notes-fit R006 byte-identical to the explicit-LTR native control", async () => {
    const page = { ...TABLOID_LANDSCAPE, marginMm: fx.notesMarginMm };
    const [nativeRes, headRes] = await Promise.all([
      renderSchematicPacket(
        fx.ir,
        packetFor([loopLtr, lateNotesLoop], page),
        fx.presentation,
      ),
      renderSchematicPacket(
        fx.ir,
        packetFor([loopTtb, lateNotesLoop], page),
        fx.presentation,
      ),
    ]);
    expect(nativeRes.ok).toBe(false);
    if (!nativeRes.ok) {
      expect(nativeRes.error.code).toBe("R006");
      expect(nativeRes.error.details?.viewIndex).toBe(1);
    }
    expect(JSON.stringify(headRes)).toBe(JSON.stringify(nativeRes));
  });

  it("returns the recovered loop's own TTB R006 when its own drafts cross 100 while views remain pending", async () => {
    const prefix = exact100Views(0);
    const crossingIndex = prefix.length;
    const req = packetFor([...prefix, loopTtb, missingRootedView]);
    const [devControl, headRes] = await Promise.all([
      renderNoLoopRetry(fx.ir, req, fx.presentation),
      renderSchematicPacket(fx.ir, req, fx.presentation),
    ]);
    expect(devControl.ok).toBe(false);
    if (!devControl.ok) {
      expect(devControl.error.code).toBe("R006");
      expect(devControl.error.details?.viewIndex).toBe(crossingIndex);
    }
    expect(JSON.stringify(headRes)).toBe(JSON.stringify(devControl));

    // Preceded by an earlier caption recovery: crossing loop still keeps its own TTB R006.
    const prefixAfterCap = exact100Views(1);
    const withEarlierCap = packetFor([
      fx.captionView,
      ...prefixAfterCap,
      loopTtb,
      missingRootedView,
    ]);
    const [devWithCap, headWithCap] = await Promise.all([
      renderNoLoopRetry(fx.ir, withEarlierCap, fx.presentation),
      renderSchematicPacket(fx.ir, withEarlierCap, fx.presentation),
    ]);
    expect(devWithCap.ok).toBe(false);
    if (!devWithCap.ok) {
      expect(devWithCap.error.code).toBe("R006");
      expect(devWithCap.error.details?.viewIndex).toBe(
        1 + prefixAfterCap.length,
      );
    }
    expect(JSON.stringify(headWithCap)).toBe(JSON.stringify(devWithCap));
  });

  it("restores the first recovered loop's TTB R006 when the last view crosses the cap or assembly fails", async () => {
    const isolated = await renderNoLoopRetry(
      fx.ir,
      packetFor([loopTtb]),
      fx.presentation,
    );
    expect(isolated.ok).toBe(false);

    const lastViewCap = await renderSchematicPacket(
      fx.ir,
      packetFor([loopTtb, ...capPaddingViews(1)]),
      fx.presentation,
    );
    expect(JSON.stringify(lastViewCap)).toBe(JSON.stringify(isolated));

    vi.spyOn(assembly, "assembleSheets").mockImplementationOnce(() => {
      throw new Error("Injected packet-wide assembly failure");
    });
    const assemblyFailed = await renderSchematicPacket(
      fx.ir,
      packetFor([loopTtb, bomView]),
      fx.presentation,
    );
    expect(JSON.stringify(assemblyFailed)).toBe(JSON.stringify(isolated));
  });

  it("orders caption-then-loop recoveries for packet-wide failures and preserves unrelated later refusals", async () => {
    const trace: CircuitInlineContext[] = [];
    const okPacket = await circuitInlineTrace.run(trace, () =>
      renderSchematicPacket(
        fx.ir,
        packetFor([fx.captionView, loopTtb]),
        fx.presentation,
      ),
    );
    expect(okPacket.ok, JSON.stringify(okPacket)).toBe(true);
    expect(trace[0]?.runs[0]?.captionFallbacks.size).toBe(1);
    if (okPacket.ok) {
      const i907 = (okPacket.value.coverage.diagnostics ?? []).filter(
        (d) => d.code === "I907",
      );
      expect(i907).toHaveLength(1);
      expect(i907[0]?.message).toContain('View 2 "SL_TX1 - signal loop"');
    }

    const firstCaptionCause = await renderInlineOnly(
      fx.ir,
      packetFor([fx.captionView]),
      fx.presentation,
    );
    expect(firstCaptionCause.ok).toBe(false);

    vi.spyOn(assembly, "assembleSheets").mockImplementationOnce(() => {
      throw new Error("Injected packet-wide assembly failure");
    });
    const packetWide = await renderSchematicPacket(
      fx.ir,
      packetFor([fx.captionView, loopTtb]),
      fx.presentation,
    );
    expect(JSON.stringify(packetWide)).toBe(JSON.stringify(firstCaptionCause));

    const lastCap = await renderSchematicPacket(
      fx.ir,
      packetFor([fx.captionView, loopTtb, ...capPaddingViews(2)]),
      fx.presentation,
    );
    expect(JSON.stringify(lastCap)).toBe(JSON.stringify(firstCaptionCause));

    const [nativeLater, headLater] = await Promise.all([
      renderSchematicPacket(
        fx.nativeIr,
        packetFor([fx.captionView, loopLtr, missingRootedView]),
        fx.presentation,
      ),
      renderSchematicPacket(
        fx.ir,
        packetFor([fx.captionView, loopTtb, missingRootedView]),
        fx.presentation,
      ),
    ]);
    expect(nativeLater.ok).toBe(false);
    if (!nativeLater.ok) {
      expect(nativeLater.error.code).toBe("Q001");
      expect(nativeLater.error.details?.viewIndex).toBe(2);
    }
    expect(JSON.stringify(headLater)).toBe(JSON.stringify(nativeLater));
  });

  it("orders loop-then-caption recoveries for packet-wide failures and preserves unrelated later refusals", async () => {
    const trace: CircuitInlineContext[] = [];
    const okPacket = await circuitInlineTrace.run(trace, () =>
      renderSchematicPacket(
        fx.ir,
        packetFor([loopTtb, fx.captionView]),
        fx.presentation,
      ),
    );
    expect(okPacket.ok, JSON.stringify(okPacket)).toBe(true);
    expect(trace[0]?.runs[0]?.captionFallbacks.size).toBe(1);
    if (okPacket.ok) {
      const i907 = (okPacket.value.coverage.diagnostics ?? []).filter(
        (d) => d.code === "I907",
      );
      expect(i907).toHaveLength(1);
      expect(i907[0]?.message).toContain('View 1 "SL_TX1 - signal loop"');
    }

    const firstLoopCause = await renderNoLoopRetry(
      fx.ir,
      packetFor([loopTtb]),
      fx.presentation,
    );
    expect(firstLoopCause.ok).toBe(false);

    vi.spyOn(assembly, "assembleSheets").mockImplementationOnce(() => {
      throw new Error("Injected packet-wide assembly failure");
    });
    const packetWide = await renderSchematicPacket(
      fx.ir,
      packetFor([loopTtb, fx.captionView]),
      fx.presentation,
    );
    expect(JSON.stringify(packetWide)).toBe(JSON.stringify(firstLoopCause));

    const lastCap = await renderSchematicPacket(
      fx.ir,
      packetFor([loopTtb, fx.captionView, ...capPaddingViews(2)]),
      fx.presentation,
    );
    expect(JSON.stringify(lastCap)).toBe(JSON.stringify(firstLoopCause));

    const [nativeLater, headLater] = await Promise.all([
      renderSchematicPacket(
        fx.nativeIr,
        packetFor([loopLtr, fx.captionView, missingRootedView]),
        fx.presentation,
      ),
      renderSchematicPacket(
        fx.ir,
        packetFor([loopTtb, fx.captionView, missingRootedView]),
        fx.presentation,
      ),
    ]);
    expect(nativeLater.ok).toBe(false);
    if (!nativeLater.ok) {
      expect(nativeLater.error.code).toBe("Q001");
      expect(nativeLater.error.details?.viewIndex).toBe(2);
    }
    expect(JSON.stringify(headLater)).toBe(JSON.stringify(nativeLater));
  });
});
