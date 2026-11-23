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
import {
  createSchematicRendererWithDependencies,
  prepareSchematicDrawing,
} from "../src/renderer.js";
import { textInk } from "../src/packet/rooted-caption.js";
import { OUTER_SVG_PADDING } from "../src/symbols/catalog.js";
import { printableLabelGeometry } from "../src/symbols/printable-label.js";
import type {
  NormalizedSchematicLayout,
  PresentationGraph,
} from "../src/types.js";
import { observedRecoveryEngine } from "./helpers/agent-recovery.js";
import { parseSvg } from "./off-view-fixtures.js";
import {
  byDesignation,
  robustnessFixture,
} from "./render-robustness-fixture.js";

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

function numericAttr(el: Element, name: string): number {
  const raw = el.getAttribute(name);
  assert.ok(raw !== null, `Missing attribute ${name}`);
  const value = Number(raw);
  assert.ok(Number.isFinite(value), `Non-numeric ${name}=${raw}`);
  return value;
}

interface Rect2D {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface LocationRegionGeometry {
  name: string;
  frame: Rect2D;
  heading: Rect2D;
}

function boxesOverlap(a: Rect2D, b: Rect2D): boolean {
  return (
    a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom
  );
}

function extractLocationRegions(
  graph: Readonly<PresentationGraph>,
  layout: Readonly<NormalizedSchematicLayout>,
): LocationRegionGeometry[] {
  return graph.locationGroups.map((group) => {
    const box = layout.nodes.find((n) => n.id === group.id);
    const label = layout.labels.find((l) => l.id === group.label.id);
    assert.ok(box && label);
    const ink = printableLabelGeometry(
      label,
      group.label.printableText ?? group.label.text,
      group.label.textLength,
    ).ink;
    return {
      name: group.label.text,
      frame: {
        left: box.x + OUTER_SVG_PADDING,
        right: box.x + box.width + OUTER_SVG_PADDING,
        top: box.y + OUTER_SVG_PADDING,
        bottom: box.y + box.height + OUTER_SVG_PADDING,
      },
      heading: {
        left: Math.min(label.x, ink.left) + OUTER_SVG_PADDING,
        right: Math.max(label.x + label.width, ink.right) + OUTER_SVG_PADDING,
        top: Math.min(label.y, ink.top) + OUTER_SVG_PADDING,
        bottom:
          Math.max(label.y + label.height, ink.bottom) + OUTER_SVG_PADDING,
      },
    };
  });
}

function parseSheetViewports(doc: ParentNode) {
  const viewports = [
    ...doc.querySelectorAll("svg[data-layout-config-version]"),
  ];
  expect(viewports.length).toBeGreaterThan(0);
  return viewports.map((svg) => {
    const vb = (svg.getAttribute("viewBox") ?? "")
      .trim()
      .split(/\s+/u)
      .map(Number);
    assert.equal(vb.length, 4);
    const [vx, vy, vw, vh] = vb;
    assert.ok(
      vx !== undefined &&
        vy !== undefined &&
        vw !== undefined &&
        vh !== undefined,
    );
    const sx = numericAttr(svg, "x");
    const sy = numericAttr(svg, "y");
    const sw = numericAttr(svg, "width");
    const sh = numericAttr(svg, "height");
    return {
      svg,
      inner: { left: vx, right: vx + vw, top: vy, bottom: vy + vh },
      outer: { left: sx, right: sx + sw, top: sy, bottom: sy + sh },
    };
  });
}

function countCompleteNativeHeadings(
  sheetNumber: number,
  region: LocationRegionGeometry,
  visibleViewports: readonly { svg: Element; inner: Rect2D }[],
): number {
  let paintedNative = 0;
  for (const { svg, inner } of visibleViewports) {
    for (const el of svg.querySelectorAll("text.label-location")) {
      if (el.textContent !== region.name) continue;
      const tx = numericAttr(el, "x");
      const ty = numericAttr(el, "y");
      const tl = Number(el.getAttribute("textLength") ?? "0");
      const fs = numericAttr(el, "font-size");
      const textBox: Rect2D = {
        left: Math.min(tx, region.heading.left),
        right: Math.max(tx + tl, region.heading.right),
        top: Math.min(ty - fs, region.heading.top),
        bottom: Math.max(ty, region.heading.bottom),
      };
      if (!boxesOverlap(textBox, inner)) continue;
      paintedNative++;
      expect(
        textBox.left,
        `Sheet ${sheetNumber} ${region.name} heading clipped on left`,
      ).toBeGreaterThanOrEqual(inner.left - 0.002);
      expect(
        textBox.right,
        `Sheet ${sheetNumber} ${region.name} heading clipped on right`,
      ).toBeLessThanOrEqual(inner.right + 0.002);
      expect(
        textBox.top,
        `Sheet ${sheetNumber} ${region.name} heading clipped on top`,
      ).toBeGreaterThanOrEqual(inner.top - 0.002);
      expect(
        textBox.bottom,
        `Sheet ${sheetNumber} ${region.name} heading clipped on bottom`,
      ).toBeLessThanOrEqual(inner.bottom + 0.002);
    }
  }
  return paintedNative;
}

function assertSheetLocationHeadings(
  sheetNumber: number,
  svgText: string,
  regions: readonly LocationRegionGeometry[],
) {
  const doc = parseSvg(svgText);
  const viewportBoxes = parseSheetViewports(doc);
  const fragmentCaptions = [
    ...doc.querySelectorAll("text.location-fragment-caption"),
  ];
  for (const caption of fragmentCaptions) {
    const ink = textInk(
      caption.textContent ?? "",
      numericAttr(caption, "x"),
      numericAttr(caption, "y"),
      numericAttr(caption, "font-size"),
      true,
    );
    const inside = viewportBoxes.some(
      ({ outer }) =>
        ink.x >= outer.left - 0.01 &&
        ink.x + ink.w <= outer.right + 0.01 &&
        ink.y >= outer.top - 0.01 &&
        ink.y + ink.h <= outer.bottom + 0.01,
    );
    expect(
      inside,
      `Sheet ${sheetNumber} fragment caption ${caption.textContent} extends beyond viewport`,
    ).toBe(true);
  }
  for (const region of regions) {
    const visibleViewports = viewportBoxes.filter(({ inner }) =>
      boxesOverlap(region.frame, inner),
    );
    if (!visibleViewports.length) continue;
    const paintedNative = countCompleteNativeHeadings(
      sheetNumber,
      region,
      visibleViewports,
    );
    const matchingFragments = fragmentCaptions.filter(
      (el) => el.getAttribute("data-location-name") === region.name,
    ).length;
    expect(
      paintedNative + matchingFragments,
      `Sheet ${sheetNumber} region ${region.name} heading count (native=${paintedNative}, fragment=${matchingFragments})`,
    ).toBe(1);
  }
}

it("keeps one complete location heading per region inside its viewport on MAIN-PANEL-480VAC-BUS Letter sheets (#570 review)", async () => {
  const phaseNames = [
    "MAIN-PANEL-480VAC-BUS-L1",
    "MAIN-PANEL-480VAC-BUS-L2",
    "MAIN-PANEL-480VAC-BUS-L3",
  ] as const;
  const fixture = await compileVariantFixture(
    "main-panel-bus-headings",
    phaseNames,
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
    const packet = await renderSchematicPacket(fixture.ir, {
      format: "schematic-packet-request/0.1",
      page: { size: "letter", orientation: "landscape" },
      views: [request],
    });
    assert.ok(packet.ok, JSON.stringify(packet));
    expect(packet.value.sheets).toHaveLength(4);
    const regions = extractLocationRegions(
      prepared.value.graph,
      prepared.value.layout,
    );
    for (const sheet of packet.value.sheets) {
      assertSheetLocationHeadings(sheet.number, sheet.svg, regions);
    }
  } finally {
    await fixture.dispose();
  }
});

async function rewriteLoadPotentials(root: string, length: number) {
  const file = resolve(root, "potentials/potentials.json");
  const rawPotentials: unknown = JSON.parse(await readFile(file, "utf8"));
  assert.ok(
    typeof rawPotentials === "object" &&
      rawPotentials !== null &&
      "objects" in rawPotentials &&
      Array.isArray(rawPotentials.objects),
  );
  for (const obj of rawPotentials.objects) {
    if (typeof obj !== "object" || obj === null || !("name" in obj)) continue;
    if (obj.name === "+24VDC") {
      obj.name = "DC" + "MAIN".repeat(8).slice(0, length - 2);
    }
    if (obj.name === "0VDC") {
      obj.name = "RETURN" + "BUS".repeat(10).slice(0, length - 6);
    }
  }
  await writeFile(file, JSON.stringify(rawPotentials));
}

function collectDcOutputWidths(node: ElkNode): [string, number | undefined][] {
  const collected: [string, number | undefined][] = (
    node.children ?? []
  ).flatMap(collectDcOutputWidths);
  if (node.id.includes("dc_output")) collected.push([node.id, node.width]);
  return collected;
}

function createWideningFaultLoadsEngine() {
  const engine = createElkEngine();
  const baseLayout = engine.layout.bind(engine);
  const dcOutputWidths: [string, number | undefined][][] = [];
  engine.layout = async (input, ...args) => {
    dcOutputWidths.push(collectDcOutputWidths(input));
    const out = await baseLayout(input, ...args);
    if (dcOutputWidths.length === 1) {
      const edge = out.edges?.find((e) =>
        e.labels?.some(
          (l) => l.id?.endsWith(',"net"]') && l.text?.startsWith("RETURN"),
        ),
      );
      const label = edge?.labels?.find((l) => l.id?.endsWith(',"net"]'));
      const section = edge?.sections?.[0];
      assert.ok(label && section);
      const a = section.startPoint;
      const b = section.bendPoints?.[0] ?? section.endPoint;
      label.x = (a.x + b.x) / 2 - (label.width ?? 0) / 2;
      label.y = (a.y + b.y) / 2 - (label.height ?? 0) / 2;
    }
    if (
      dcOutputWidths.length === 2 &&
      JSON.stringify(dcOutputWidths[0]) !== JSON.stringify(dcOutputWidths[1])
    ) {
      out.id = "fault-injected-return-root";
    }
    return out;
  };
  return { engine, dcOutputWidths };
}

it.each([12, 21])(
  "falls through to loads route search after a failed TTB widening retry (length %i) (#570 review)",
  async (length) => {
    const fixture = await robustnessFixture();
    try {
      await fixture.compile("minimal", 0, { plc2Location: "FIELD" });
      await rewriteLoadPotentials(fixture.root, length);
      const compiled = await compileProject(fixture.root);
      assert.ok(compiled.ok, JSON.stringify(compiled));
      const { engine, dcOutputWidths } = createWideningFaultLoadsEngine();
      const result = await createSchematicRendererWithDependencies({
        layoutEngine: engine,
      }).render(
        compiled.ir,
        {
          format: "schematic-view-request/0.2",
          root: byDesignation("PS1"),
          intent: { kind: "loads" },
          flow: "top-to-bottom",
        },
        compiled.presentation,
      );
      expect(JSON.stringify(dcOutputWidths[1])).not.toBe(
        JSON.stringify(dcOutputWidths[0]),
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(dcOutputWidths.length).toBe(5);
    } finally {
      await fixture.close();
    }
  },
);
