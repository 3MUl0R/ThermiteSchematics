import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import * as runtime from "../src/layout/elk-runtime.js";
import * as headings from "../src/internal/title-data/headings.js";
import * as assembly from "../src/packet/assembly.js";
import { navigationViewKey } from "../src/packet/navigation-identity.js";
import { zone } from "../src/packet/page.js";
import {
  renderSchematicPacket,
  renderSchematicSheets,
  type RenderedSheet,
  type SchematicPacketRequest,
} from "../src/sheets.js";
import {
  selectSignalLoop,
  type SignalLoopViewRequest,
} from "../src/signal-loop.js";
import { SERIES_LOOP_LTR_FALLBACK_NOTICE } from "../src/signal-loop/series-layout.js";
import {
  endpoint,
  request,
  seriesFixture,
  type SeriesModel,
  uid,
  wire,
} from "./series-loop-fixture.js";

const factory = runtime.createElkEngine;
const TABLOID_LANDSCAPE = {
  size: "tabloid",
  orientation: "landscape",
} as const;

afterEach(() => vi.restoreAllMocks());

function fiveStageHighSide(model: SeriesModel) {
  model.objects = model.objects.filter(
    (o) => ![uid(11), uid(12)].includes(o.uid),
  );
  model.objects.push(
    { kind: "device", uid: uid(41), designation: "TB2", type: "series:strip" },
    wire(101, "AI1", "n", "TB1", "1"),
    wire(102, "TB1", "1", "TB2", "1"),
    wire(103, "TB2", "1", "TX1", "p"),
    wire(104, "TX1", "n", "TB2", "2"),
    wire(105, "TB2", "2", "TB1", "2"),
    wire(106, "TB1", "2", "PS1", "n"),
  );
}

function addSecondSeriesLoop(model: SeriesModel) {
  model.objects.push(
    { kind: "device", uid: uid(50), designation: "PS2", type: "series:ps" },
    { kind: "device", uid: uid(51), designation: "TX2", type: "series:tx" },
    { kind: "device", uid: uid(52), designation: "AI2", type: "series:ai" },
    wire(200, "PS2", "p", "AI2", "p"),
    wire(201, "AI2", "n", "TX2", "p"),
    wire(202, "TX2", "n", "PS2", "n"),
  );
}

function addPaginatedControlChain(model: SeriesModel, switches: number) {
  model.types.push(
    {
      kind: "device_type",
      id: "series:sw",
      symbol: "thermite:pushbutton",
      terminals: {
        "13": { connection_policy: "shared" },
        "14": { connection_policy: "shared" },
      },
      functions: {
        sw: { kind: "contact", normal_state: "open", terminals: ["13", "14"] },
      },
    },
    {
      kind: "device_type",
      id: "series:coil",
      symbol: "thermite:relay",
      terminals: {
        A1: { connection_policy: "shared" },
        A2: { connection_policy: "shared" },
      },
      functions: { coil: { kind: "coil", terminals: ["A1", "A2"] } },
    },
  );
  model.objects.push(
    { kind: "device", uid: uid(60), designation: "PS_AUX", type: "series:ps" },
    { kind: "device", uid: uid(61), designation: "K_AUX", type: "series:coil" },
  );
  let prev = { device: "PS_AUX", terminal: "p" };
  let serial = 300;
  for (let i = 0; i < switches; i++) {
    const sw = `S${i + 1}`;
    model.objects.push(
      { kind: "device", uid: uid(70 + i), designation: sw, type: "series:sw" },
      wire(serial++, prev.device, prev.terminal, sw, "13"),
    );
    prev = { device: sw, terminal: "14" };
  }
  model.objects.push(
    wire(serial++, prev.device, prev.terminal, "K_AUX", "A1"),
    wire(serial++, "K_AUX", "A2", "PS_AUX", "n"),
  );
}

function sevenStageHighSide(model: SeriesModel) {
  model.objects = model.objects.filter(
    (o) => ![uid(11), uid(12)].includes(o.uid),
  );
  const strips = ["TB1", "TB2", "TB3", "TB4"];
  strips.forEach((designation, i) => {
    if (!model.objects.some((o) => o.designation === designation))
      model.objects.push({
        kind: "device",
        uid: uid(41 + i),
        designation,
        type: "series:strip",
      });
  });
  model.objects.push(
    wire(101, "AI1", "n", "TB1", "1"),
    wire(102, "TB1", "1", "TB2", "1"),
    wire(103, "TB2", "1", "TB3", "1"),
    wire(104, "TB3", "1", "TB4", "1"),
    wire(105, "TB4", "1", "TX1", "p"),
    wire(106, "TX1", "n", "TB4", "2"),
    wire(107, "TB4", "2", "TB3", "2"),
    wire(108, "TB3", "2", "TB2", "2"),
    wire(109, "TB2", "2", "TB1", "2"),
    wire(110, "TB1", "2", "PS1", "n"),
  );
}

function sixStageDirectLoop(model: SeriesModel) {
  model.objects = model.objects.filter(
    (o) => ![uid(10), uid(11), uid(12)].includes(o.uid),
  );
  const strips = ["TB1", "TB2", "TB3", "TB4", "TB5"];
  strips.forEach((designation, i) => {
    if (!model.objects.some((o) => o.designation === designation))
      model.objects.push({
        kind: "device",
        uid: uid(40 + i),
        designation,
        type: "series:strip",
      });
  });
  let prev = "TX1";
  let serial = 400;
  for (const s of strips) {
    model.objects.push(
      wire(serial++, prev, prev === "TX1" ? "p" : "1", s, "1"),
      wire(serial++, prev, prev === "TX1" ? "n" : "2", s, "2"),
    );
    prev = s;
  }
  model.objects.push(
    wire(serial++, prev, "1", "AI1", "p"),
    wire(serial++, prev, "2", "AI1", "n"),
  );
}

function spyElkDirections(edit?: (graph: ElkNode, direction: string) => void) {
  const directions: string[] = [];
  vi.spyOn(runtime, "createElkEngine").mockImplementation(() => {
    const engine = factory();
    return {
      ...engine,
      layout: async (graph: ElkNode) => {
        const direction = String(
          graph.layoutOptions?.["elk.direction"] ?? "unknown",
        );
        directions.push(direction);
        const result = await engine.layout(graph);
        edit?.(result, direction);
        return result;
      },
    };
  });
  return directions;
}

function visibleText(svg: string) {
  return [...parseHTML(svg).document.querySelectorAll("text")]
    .map((t) => t.textContent ?? "")
    .join(" ")
    .replace(/\s+/gu, " ");
}

function descText(svg: string) {
  return [...parseHTML(svg).document.querySelectorAll("desc")]
    .map((d) => d.textContent ?? "")
    .join("\n");
}

function packetFor(
  view: SignalLoopViewRequest,
  extra: Partial<SchematicPacketRequest> = {},
): SchematicPacketRequest {
  return {
    format: "schematic-packet-request/0.1",
    index: false,
    page: TABLOID_LANDSCAPE,
    views: [view],
    ...extra,
  };
}

function assertMeasuredNoticeBlock(svg: string, authoredNote: string) {
  const { document } = parseHTML(svg);
  const diagram = [...document.querySelectorAll("g[transform]")].find((g) =>
    (g.getAttribute("transform") ?? "").includes("scale("),
  );
  expect(diagram?.getAttribute("transform")).toContain("scale(1)");

  const noteGroup = document.querySelector("[data-engine-notes]");
  expect(noteGroup).not.toBeNull();
  const noteTexts = [...(noteGroup?.querySelectorAll("text") ?? [])];
  const joined = noteTexts
    .map((t) => t.textContent ?? "")
    .join(" ")
    .replace(/\s+/gu, " ");
  expect(joined).toContain(SERIES_LOOP_LTR_FALLBACK_NOTICE);
  expect(joined.indexOf(SERIES_LOOP_LTR_FALLBACK_NOTICE)).toBeLessThan(
    joined.indexOf(authoredNote),
  );
  for (const t of noteTexts) {
    expect(t.getAttribute("font-size")).toBe("2.5");
    let node: Element | null = t;
    while (node) {
      expect(node.getAttribute("transform") ?? "").not.toContain("scale");
      node = node.parentElement;
    }
  }
  expect(descText(svg)).toContain(SERIES_LOOP_LTR_FALLBACK_NOTICE);
  expect(document.querySelector("title")?.textContent ?? "").not.toContain(
    SERIES_LOOP_LTR_FALLBACK_NOTICE,
  );
}

function assertConservedConductors(
  svg: string,
  selected: ReturnType<typeof selectSignalLoop>,
) {
  const { document } = parseHTML(svg);
  const emitted = [...document.querySelectorAll("[data-loop-conductor]")].map(
    (el) => ({
      id: el.getAttribute("data-loop-conductor"),
      net: el.getAttribute("data-net-id"),
      ends: el.getAttribute("data-terminal-ends"),
    }),
  );
  expect(emitted.map((c) => c.id).sort()).toEqual(
    selected.conductors.map((c) => c.id).sort(),
  );
  for (const c of selected.conductors) {
    const match = emitted.find((r) => r.id === c.id);
    expect(match?.net).toBe(c.net);
    expect(match?.ends).toBeTruthy();
  }
}

function assertSheetReferencesMatchSvg(
  loopSheet: RenderedSheet,
  sheets: readonly RenderedSheet[],
  withIndex: boolean,
) {
  const { document } = parseHTML(loopSheet.svg);
  const drawingBounds = { x: 28, y: 31, w: 375.8, h: 196.4 };
  for (const ref of loopSheet.references) {
    expect(ref.xMm).toBeDefined();
    expect(ref.yMm).toBeDefined();
    if (ref.xMm !== undefined && ref.yMm !== undefined)
      expect(ref.zone).toBe(zone(ref.xMm, ref.yMm, drawingBounds));
    expect(
      document.querySelector(`[data-device-uid="${ref.deviceUid}"]`),
    ).not.toBeNull();
  }
  if (!withIndex) return;
  const indexSheet = sheets.find(
    (s) =>
      s.view.format === "documentation-view/0.1" && s.view.kind === "index",
  );
  expect(visibleText(indexSheet?.svg ?? "")).toContain(
    `${loopSheet.number} TX1 - signal loop`,
  );
  const refText = sheets
    .filter(
      (s) =>
        s.view.format === "documentation-view/0.1" &&
        s.view.kind === "references",
    )
    .map((s) => visibleText(s.svg))
    .join(" ");
  for (const ref of loopSheet.references)
    expect(refText).toContain(`${loopSheet.number} / ${ref.zone}`);
}

describe("series signal-loop landscape tabloid LTR fallback", () => {
  it("recovers a height-bound TTB series loop on landscape tabloid with notice, I907, and conserved identity", async () => {
    const f = await seriesFixture(fiveStageHighSide, true);
    try {
      const directions = spyElkDirections();
      const authoredNote = "Authored field verification note.";
      const authored = request({
        flow: "top-to-bottom",
        notes: [authoredNote],
      });
      const result = await renderSchematicPacket(
        f.ir,
        packetFor(authored, { index: true }),
      );
      expect(authored.flow).toBe("top-to-bottom");
      expect(directions).toEqual(["DOWN", "RIGHT"]);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;

      const loopSheet = result.value.sheets[0];
      expect(loopSheet).toBeDefined();
      if (!loopSheet) return;
      expect(loopSheet.continuations).toEqual([]);
      expect(loopSheet.circuitContinuations).toBeUndefined();
      expect(loopSheet.communicationContinuations).toBeUndefined();
      expect(loopSheet.svg).not.toContain("data-continuation-id");

      assertMeasuredNoticeBlock(loopSheet.svg, authoredNote);
      assertConservedConductors(
        loopSheet.svg,
        selectSignalLoop(f.ir, authored),
      );

      const refText = result.value.sheets
        .filter(
          (s) =>
            s.view.format === "documentation-view/0.1" &&
            s.view.kind === "references",
        )
        .map((s) => visibleText(s.svg))
        .join(" ");
      expect(refText).toContain(SERIES_LOOP_LTR_FALLBACK_NOTICE);

      const diags = result.value.coverage.diagnostics ?? [];
      expect(diags.filter((d) => d.code === "I907")).toEqual([
        {
          code: "I907",
          severity: "info",
          ...f.ir.project.source,
          message: `View 1 "TX1 - signal loop": ${SERIES_LOOP_LTR_FALLBACK_NOTICE}`,
        },
      ]);
      expect(diags.filter((d) => d.code === "I906")).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it("prints the notice with references disabled and emits I907 in renderSchematicSheets", async () => {
    const f = await seriesFixture(fiveStageHighSide, true);
    try {
      const authored = request({ flow: "top-to-bottom" });
      const noRefs = await renderSchematicPacket(
        f.ir,
        packetFor(authored, { index: true, references: false }),
      );
      expect(noRefs.ok).toBe(true);
      if (noRefs.ok) {
        const firstSvg = noRefs.value.sheets[0]?.svg ?? "";
        expect(visibleText(firstSvg)).toContain(
          SERIES_LOOP_LTR_FALLBACK_NOTICE,
        );
        expect(descText(firstSvg)).toContain(SERIES_LOOP_LTR_FALLBACK_NOTICE);
      }

      const standalone = await renderSchematicSheets(
        f.ir,
        authored,
        undefined,
        TABLOID_LANDSCAPE,
      );
      expect(standalone.ok).toBe(true);
      if (standalone.ok)
        expect(
          (standalone.value.coverage.diagnostics ?? []).map((d) => d.code),
        ).toEqual(["I907"]);
    } finally {
      await f.dispose();
    }
  });

  it("does not invoke LTR ELK for native TTB success or the three-stage notes guard", async () => {
    const f = await seriesFixture((m) => {
      for (const type of m.types)
        type.description =
          "Synthetic field interface qualification for note-space fit";
    });
    try {
      const nativeDirs = spyElkDirections();
      const nativeOk = await renderSchematicPacket(
        f.ir,
        packetFor(request({ flow: "top-to-bottom" })),
      );
      expect(nativeOk.ok).toBe(true);
      expect(nativeDirs).toEqual(["DOWN"]);
      if (nativeOk.ok) {
        expect(
          (nativeOk.value.coverage.diagnostics ?? []).filter(
            (d) => d.code === "I907",
          ),
        ).toEqual([]);
        expect(visibleText(nativeOk.value.sheets[0]?.svg ?? "")).not.toContain(
          SERIES_LOOP_LTR_FALLBACK_NOTICE,
        );
      }

      vi.restoreAllMocks();
      const notesDirs = spyElkDirections();
      const notesRefused = await renderSchematicPacket(
        f.ir,
        packetFor(
          request({
            flow: "top-to-bottom",
            notes: Array.from({ length: 6 }, () => "W".repeat(240)),
          }),
        ),
      );
      expect(notesRefused.ok).toBe(false);
      expect(notesDirs).toEqual(["DOWN"]);
      if (!notesRefused.ok) {
        expect(notesRefused.error.code).toBe("R006");
        expect(notesRefused.error.message).toContain("orientation or flow");
      }
    } finally {
      await f.dispose();
    }
  });

  it.each([
    ["letter landscape", { size: "letter", orientation: "landscape" } as const],
    ["a4 landscape", { size: "a4", orientation: "landscape" } as const],
    ["a3 landscape", { size: "a3", orientation: "landscape" } as const],
  ])("does not retry LTR on %s", async (_, page) => {
    const f = await seriesFixture(fiveStageHighSide, true);
    try {
      const directions = spyElkDirections();
      const result = await renderSchematicPacket(
        f.ir,
        packetFor(request({ flow: "top-to-bottom" }), { page }),
      );
      expect(result.ok).toBe(false);
      expect(directions).toEqual(["DOWN"]);
      if (!result.ok) expect(result.error.code).toBe("R006");
    } finally {
      await f.dispose();
    }
  });

  it("does not retry LTR for direct loops, width-bound failures, or selection failures", async () => {
    const directF = await seriesFixture(sixStageDirectLoop);
    const seriesF = await seriesFixture(fiveStageHighSide, true);
    try {
      const directDirs = spyElkDirections();
      const directResult = await renderSchematicPacket(
        directF.ir,
        packetFor({
          format: "signal-loop-view-request/0.1",
          from: { device: "TX1", function: "signal" },
          to: { device: "AI1", function: "input" },
          flow: "top-to-bottom",
        }),
      );
      expect(directResult.ok).toBe(false);
      expect(directDirs).toEqual(["DOWN"]);

      vi.restoreAllMocks();
      const widthDirs = spyElkDirections((g, dir) => {
        if (dir === "DOWN") g.width = 450;
      });
      const widthResult = await renderSchematicPacket(
        seriesF.ir,
        packetFor(request({ flow: "top-to-bottom" })),
      );
      expect(widthResult.ok).toBe(false);
      expect(widthDirs).toEqual(["DOWN"]);

      vi.restoreAllMocks();
      const selDirs = spyElkDirections();
      const badSel = await renderSchematicPacket(
        seriesF.ir,
        packetFor(
          request({
            flow: "top-to-bottom",
            loopPower: { device: "MISSING", function: "output" },
          }),
        ),
      );
      expect(badSel.ok).toBe(false);
      expect(selDirs).toEqual([]);
    } finally {
      await directF.dispose();
      await seriesF.dispose();
    }
  });

  it("does not retry LTR on title-capacity refusal", async () => {
    const f = await seriesFixture(fiveStageHighSide, true);
    try {
      const titleDirs = spyElkDirections();
      vi.spyOn(headings, "headingCapacity").mockReturnValueOnce({
        ok: false,
        error: {
          code: "R006",
          root: "packet",
          reason: "unprintable-layout",
          message:
            "Sheet 1 field sheetTitle requires 170 code points; 160 are available.",
        },
      });
      const badTitle = await renderSchematicPacket(
        f.ir,
        packetFor(request({ flow: "top-to-bottom" })),
      );
      expect(badTitle.ok).toBe(false);
      expect(titleDirs).toEqual(["DOWN"]);
      if (!badTitle.ok)
        expect(badTitle.error.message).toContain("160 are available");
    } finally {
      await f.dispose();
    }
  });

  it("preserves exact original TTB R006 when LTR fit fails, LTR guard throws, or post-draft assembly fails", async () => {
    const f = await seriesFixture(fiveStageHighSide, true);
    const f7 = await seriesFixture(sevenStageHighSide, true);
    try {
      const flooded = packetFor(
        request({
          flow: "top-to-bottom",
          notes: Array.from({ length: 6 }, () => "W".repeat(240)),
        }),
        { page: { size: "tabloid", orientation: "landscape", marginMm: 25 } },
      );
      const floodedDirs = spyElkDirections();
      const floodedResult = await renderSchematicPacket(f7.ir, flooded);
      expect(floodedDirs).toEqual(["DOWN", "RIGHT"]);
      expect(floodedResult.ok).toBe(false);
      if (!floodedResult.ok) {
        expect(floodedResult.error.code).toBe("R006");
        expect(floodedResult.error.message).toContain(
          'Packet view[0] "TX1 - signal loop": Series loop notes and diagram cannot fit at readable size.',
        );
      }

      vi.restoreAllMocks();
      const guardDirs = spyElkDirections((g, dir) => {
        if (dir !== "RIGHT") return;
        const section = g.edges?.[0]?.sections?.[0];
        if (section)
          section.bendPoints = [
            { x: section.startPoint.x + 0.1, y: section.startPoint.y + 0.2 },
          ];
      });
      const guardRefused = await renderSchematicPacket(
        f.ir,
        packetFor(request({ flow: "top-to-bottom" })),
      );
      expect(guardDirs).toEqual(["DOWN", "RIGHT"]);
      expect(guardRefused.ok).toBe(false);
      if (!guardRefused.ok) {
        expect(guardRefused.error.code).toBe("R006");
        expect(guardRefused.error.message).not.toContain("Non-orthogonal");
      }

      vi.restoreAllMocks();
      vi.spyOn(assembly, "assembleSheets").mockImplementationOnce(() => {
        throw new Error("Injected post-draft assembly failure");
      });
      const assemblyRefused = await renderSchematicPacket(
        f.ir,
        packetFor(request({ flow: "top-to-bottom" })),
      );
      expect(assemblyRefused).toEqual(guardRefused);
    } finally {
      await f.dispose();
      await f7.dispose();
    }
  });

  it("attributes fallback notices unambiguously in references when multiple signal loops exist", async () => {
    const f = await seriesFixture((m) => {
      fiveStageHighSide(m);
      addSecondSeriesLoop(m);
    }, true);
    try {
      const loop2: SignalLoopViewRequest = {
        format: "signal-loop-view-request/0.1",
        from: { device: "TX2", function: "signal" },
        to: { device: "AI2", function: "input" },
        loopPower: { device: "PS2", function: "output" },
        flow: "top-to-bottom",
      };
      const result = await renderSchematicPacket(f.ir, {
        format: "schematic-packet-request/0.1",
        index: true,
        page: TABLOID_LANDSCAPE,
        views: [request({ flow: "top-to-bottom" }), loop2],
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      const refText = result.value.sheets
        .filter(
          (s) =>
            s.view.format === "documentation-view/0.1" &&
            s.view.kind === "references",
        )
        .map((s) => visibleText(s.svg))
        .join(" ");
      expect(refText).toContain(
        `Sheet 1 (TX1 - signal loop): ${SERIES_LOOP_LTR_FALLBACK_NOTICE}`,
      );
      expect(refText).not.toContain("Sheet 2 (TX2 - signal loop):");
      expect(
        (result.value.coverage.diagnostics ?? []).filter(
          (d) => d.code === "I907",
        ),
      ).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  });

  it.each([
    ["standard with index", { layout: "standard", index: true } as const],
    ["compact with index", { layout: "compact", index: true } as const],
    ["compact index disabled", { layout: "compact", index: false } as const],
  ])(
    "preserves authored view identity, references, zones, and adjacent continuations (%s)",
    async (_, options) => {
      const f = await seriesFixture((m) => {
        fiveStageHighSide(m);
        addPaginatedControlChain(m, 10);
      }, true);
      try {
        const loopView = request({ flow: "top-to-bottom" });
        const controlView = {
          format: "schematic-view-request/0.1" as const,
          root: { by: "designation" as const, value: "K_AUX" },
          family: "control" as const,
          flow: "left-to-right" as const,
        };
        const result = await renderSchematicPacket(f.ir, {
          format: "schematic-packet-request/0.1",
          page: TABLOID_LANDSCAPE,
          views: [controlView, loopView, controlView],
          ...options,
        });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) return;

        const loopSheet = result.value.sheets.find(
          (s) =>
            s.view.format === "documentation-view/0.1" &&
            s.view.kind === "signal-loop",
        );
        expect(loopSheet).toBeDefined();
        if (!loopSheet) return;
        expect(loopSheet.continuations).toEqual([]);
        expect(loopSheet.references.map((r) => r.designation).sort()).toEqual([
          "AI1",
          "PS1",
          "TB1",
          "TB2",
          "TX1",
        ]);
        expect(loopSheet.svg).toContain(
          `data-navigation-view="${navigationViewKey(f.ir, loopView, 0)}"`,
        );
        assertSheetReferencesMatchSvg(
          loopSheet,
          result.value.sheets,
          options.index,
        );

        const contSheets = result.value.sheets.filter(
          (s) => s.continuations.length > 0,
        );
        expect(contSheets.length).toBeGreaterThan(0);
        for (const sheet of contSheets)
          for (const cont of sheet.continuations) {
            expect(cont.toSheet).toBeGreaterThanOrEqual(1);
            expect(cont.toSheet).toBeLessThanOrEqual(
              result.value.sheets.length,
            );
            expect(cont.toSheet).not.toBe(loopSheet.number);
          }
      } finally {
        await f.dispose();
      }
    },
  );

  it("keeps spare cable cores and enclosures valid on LTR fallback", async () => {
    const f = await seriesFixture((m) => {
      fiveStageHighSide(m);
      m.objects = m.objects.filter(
        (o) => ![uid(103), uid(104)].includes(o.uid),
      );
      m.types.push({
        kind: "cable_type",
        id: "series:cable4",
        conductors: [
          { id: "A", color: "brown" },
          { id: "B", color: "blue" },
          { id: "C", color: "black" },
        ],
      });
      m.objects.push({
        kind: "cable",
        uid: uid(33),
        designation: "CB1",
        type: "series:cable4",
        conductors: [
          {
            id: "A",
            usage: "in-use",
            endpoints: [endpoint("TX1", "p"), endpoint("TB2", "1")],
          },
          {
            id: "B",
            usage: "in-use",
            endpoints: [endpoint("TX1", "n"), endpoint("TB2", "2")],
          },
          {
            id: "C",
            usage: "spare",
            endpoints: [endpoint("TX1", "spare"), endpoint("TB2", "3")],
          },
        ],
      });
    }, true);
    try {
      const result = await renderSchematicPacket(
        f.ir,
        packetFor(
          request({
            flow: "top-to-bottom",
            enclosures: [{ label: "Cabinet", devices: ["TB1", "PS1", "AI1"] }],
          }),
        ),
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      const svg = result.value.sheets[0]?.svg ?? "";
      expect(svg).toContain('stroke-dasharray="2 1"');
      expect(visibleText(svg)).toContain("Cabinet");
      expect(visibleText(svg)).toContain(SERIES_LOOP_LTR_FALLBACK_NOTICE);
    } finally {
      await f.dispose();
    }
  });
});
