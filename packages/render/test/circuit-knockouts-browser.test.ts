import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import type { Browser, Page } from "playwright";
import {
  displaySheet,
  drawingContextOptions,
  launch,
} from "../../../evals/draw/browser.mjs";
import { renderCircuitLayout } from "../src/circuit/layout-drawing.js";
import { circuitRouteState } from "../src/circuit/layout-routes.js";
import type {
  DeviceNode,
  PhysicalConductor,
  Point,
} from "../src/circuit/types.js";
import { InlineLabelCollisionError } from "../src/layout/inline-label-error.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launch();
  const context = await browser.newContext({
    ...drawingContextOptions,
    deviceScaleFactor: 300 / 96,
  });
  page = await context.newPage();
});

afterAll(async () => {
  await browser?.close();
});

type RouteSpec = {
  id: string;
  points: Point[];
  jumper?: boolean;
  netId?: string;
};

function stubNode(
  id: string,
  uid: string,
  portId: string,
  pt: Point,
  outDx: number,
  outDy: number,
): { node: DeviceNode; elk: ElkNode } {
  const x = outDx > 0 ? pt.x - 1 : outDx < 0 ? pt.x : pt.x - 0.5;
  const y = outDy > 0 ? pt.y - 1 : outDy < 0 ? pt.y : pt.y - 0.5;
  const node: DeviceNode = {
    id,
    device: {
      uid,
      designation: uid,
      typeId: "stub",
      description: "",
      locationId: null,
      properties: {},
      terminals: [],
      functions: [],
    },
    functions: [],
    rows: [],
    width: 1,
    height: 1,
    pins: [
      {
        id: portId,
        x: pt.x - x,
        y: pt.y - y,
        side: "EAST",
        terminal: { deviceUid: uid, terminalKey: "1" },
        label: "1",
        outside: 0,
      },
    ],
    relationLabels: [],
    tagColumnCaptions: [],
    tagBox: null,
    tagLane: null,
    enclosure: null,
    bodyX: 0,
    bodyY: 0,
    bodyWidth: 1,
    bodyHeight: 1,
  };
  return { node, elk: { id, x, y, width: 1, height: 1 } };
}

function buildRouteEntry(spec: RouteSpec, i: number) {
  const start = spec.points[0];
  const next = spec.points[1];
  const end = spec.points.at(-1);
  const prev = spec.points.at(-2);
  if (!start || !next || !end || !prev) throw new Error("Invalid route spec");
  const src = stubNode(
    `ns${i}`,
    `S${i}`,
    `ps${i}`,
    start,
    Math.sign(next.x - start.x),
    Math.sign(next.y - start.y),
  );
  const tgt = stubNode(
    `nt${i}`,
    `T${i}`,
    `pt${i}`,
    end,
    Math.sign(prev.x - end.x),
    Math.sign(prev.y - end.y),
  );
  const conductor: PhysicalConductor = {
    id: spec.id,
    name: spec.id,
    label: spec.id,
    ends: [
      { deviceUid: `S${i}`, terminalKey: "1" },
      { deviceUid: `T${i}`, terminalKey: "1" },
    ],
    netId: spec.netId ?? `net-${i}`,
    detail: "",
    jumper: Boolean(spec.jumper),
  };
  const edge: ElkExtendedEdge = {
    id: `e${i}`,
    sources: [`ps${i}`],
    targets: [`pt${i}`],
    sections: [
      {
        id: `sec${i}`,
        startPoint: start,
        endPoint: end,
        bendPoints: spec.points.slice(1, -1),
      },
    ],
  };
  return { src, tgt, conductor, edge };
}

function renderRoutesSvg(specs: RouteSpec[], width = 60, height = 50) {
  const entries = specs.map((spec, i) => buildRouteEntry(spec, i));
  const nodes = entries.flatMap((e) => [e.src.node, e.tgt.node]);
  const children = entries.flatMap((e) => [e.src.elk, e.tgt.elk]);
  const cs = entries.map((e) => e.conductor);
  const edges = entries.map((e) => e.edge);
  const graph: ElkNode = { id: "g", width, height, children, edges };
  const state = circuitRouteState(
    graph,
    nodes,
    cs,
    { id: "knockout-test" },
    {
      key: (t) => JSON.stringify([t.deviceUid, t.terminalKey]),
      fkey: (f) => f.id.functionKey,
      compare: (a, b) => a.localeCompare(b),
      n: (v) => Number(v.toFixed(3)).toString(),
      text: () => "",
      conductorLabelLines: (c) => [c.label],
      circuitDeviceTags: () => [],
      emitNode: () => "",
    },
  );
  const drawing = renderCircuitLayout(state, [], new Map(), new Set(), false);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="white"/>${drawing.content}</svg>`;
}

type Run = { dark: boolean; startMm: number; endMm: number; widthMm: number };

async function screenshotClip(
  axis: "vertical" | "horizontal",
  atMm: number,
  fromMm: number,
  toMm: number,
) {
  return page.evaluate(
    ({ axis, atMm, fromMm, toMm }) => {
      const el = document.querySelector("body > svg");
      if (!(el instanceof SVGSVGElement)) throw new Error("Missing SVG");
      const r = el.getBoundingClientRect();
      const v = el.viewBox.baseVal;
      const sx = r.width / v.width;
      const sy = r.height / v.height;
      return axis === "vertical"
        ? {
            x: r.x + (atMm - 0.5) * sx,
            y: r.y + fromMm * sy,
            width: sx,
            height: (toMm - fromMm) * sy,
          }
        : {
            x: r.x + fromMm * sx,
            y: r.y + (atMm - 0.5) * sy,
            width: (toMm - fromMm) * sx,
            height: sy,
          };
    },
    { axis, atMm, fromMm, toMm },
  );
}

async function scanLine(
  svg: string,
  axis: "vertical" | "horizontal",
  atMm: number,
  fromMm: number,
  toMm: number,
): Promise<Run[]> {
  await displaySheet(page, svg);
  const clip = await screenshotClip(axis, atMm, fromMm, toMm);
  const buf = await page.screenshot({ clip, scale: "device" });
  return page.evaluate(
    async ({ b64, axis, fromMm, toMm }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Missing 2d context");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const count = axis === "vertical" ? canvas.height : canvas.width;
      const mid = Math.floor(
        (axis === "vertical" ? canvas.width : canvas.height) / 2,
      );
      const mmPerPx = (toMm - fromMm) / count;
      const runs: Run[] = [];
      for (let i = 0; i < count; i++) {
        const x = axis === "vertical" ? mid : i;
        const y = axis === "vertical" ? i : mid;
        const idx = (y * canvas.width + x) * 4;
        const r = data[idx] ?? 255;
        const g = data[idx + 1] ?? 255;
        const b = data[idx + 2] ?? 255;
        const dark = 0.299 * r + 0.587 * g + 0.114 * b < 200;
        const last = runs.at(-1);
        if (last && last.dark === dark) {
          last.endMm = fromMm + (i + 1) * mmPerPx;
          last.widthMm = last.endMm - last.startMm;
        } else {
          runs.push({
            dark,
            startMm: fromMm + i * mmPerPx,
            endMm: fromMm + (i + 1) * mmPerPx,
            widthMm: mmPerPx,
          });
        }
      }
      return runs;
    },
    { b64: buf.toString("base64"), axis, fromMm, toMm },
  );
}

describe("circuit close-parallel knockouts (#630)", () => {
  it("preserves full composited stroke widths on LTR 3-conductor 0.625 mm parallel approaches", async () => {
    const svg = renderRoutesSvg([
      {
        id: "W1",
        points: [
          { x: 6, y: 19.375 },
          { x: 46, y: 19.375 },
        ],
      },
      {
        id: "W2",
        points: [
          { x: 6, y: 20.0 },
          { x: 46, y: 20.0 },
        ],
      },
      {
        id: "W3",
        points: [
          { x: 6, y: 20.625 },
          { x: 46, y: 20.625 },
        ],
      },
    ]);
    const runs = await scanLine(svg, "vertical", 25, 17, 23);
    const darkRuns = runs.filter((r) => r.dark);
    expect(darkRuns).toHaveLength(3);
    for (const d of darkRuns) expect(d.widthMm).toBeGreaterThanOrEqual(0.28);
    const whiteBetween = runs.filter(
      (r) => !r.dark && r.startMm > 19.375 && r.endMm < 20.625,
    );
    expect(whiteBetween).toHaveLength(2);
    for (const w of whiteBetween) expect(w.widthMm).toBeGreaterThanOrEqual(0.2);
  });

  it("preserves full composited widths and early crossing knockouts on TTB 3-conductor approaches", async () => {
    const ttbSvg = renderRoutesSvg([
      {
        id: "X1",
        points: [
          { x: 5, y: 25 },
          { x: 45, y: 25 },
        ],
      },
      {
        id: "W1",
        points: [
          { x: 19.375, y: 6 },
          { x: 19.375, y: 44 },
        ],
      },
      {
        id: "W2",
        points: [
          { x: 20.0, y: 6 },
          { x: 20.0, y: 44 },
        ],
      },
      {
        id: "W3",
        points: [
          { x: 20.625, y: 6 },
          { x: 20.625, y: 44 },
        ],
      },
    ]);
    const ttbDark = (await scanLine(ttbSvg, "horizontal", 35, 17, 23)).filter(
      (r) => r.dark,
    );
    expect(ttbDark).toHaveLength(3);
    for (const d of ttbDark) expect(d.widthMm).toBeGreaterThanOrEqual(0.28);
    const ttbCross = await scanLine(ttbSvg, "horizontal", 25, 17, 23);
    expect(ttbCross.filter((r) => !r.dark)).toHaveLength(4);
  });

  it("preserves genuine crossing knockouts inside the close-parallel zone in BOTH paint orders", async () => {
    const cross: RouteSpec = {
      id: "X1",
      points: [
        { x: 25, y: 5 },
        { x: 25, y: 40 },
      ],
    };
    const parallel: RouteSpec[] = [
      {
        id: "A",
        points: [
          { x: 6, y: 20.0 },
          { x: 46, y: 20.0 },
        ],
      },
      {
        id: "B",
        points: [
          { x: 6, y: 20.625 },
          { x: 46, y: 20.625 },
        ],
      },
    ];
    const earlySvg = renderRoutesSvg([cross, ...parallel]);
    const earlyAlongCross = await scanLine(earlySvg, "vertical", 25, 17, 23);
    expect(earlyAlongCross.filter((r) => r.dark)).toHaveLength(4);
    expect(earlyAlongCross.filter((r) => !r.dark)).toHaveLength(3);
    for (const w of earlyAlongCross.filter((r) => !r.dark))
      expect(w.widthMm).toBeGreaterThanOrEqual(0.2);
    const earlyParallel = (
      await scanLine(earlySvg, "vertical", 35, 17, 23)
    ).filter((r) => r.dark);
    expect(earlyParallel).toHaveLength(2);
    for (const d of earlyParallel)
      expect(d.widthMm).toBeGreaterThanOrEqual(0.28);

    const lateSvg = renderRoutesSvg([...parallel, cross]);
    const lateAlongA = await scanLine(lateSvg, "horizontal", 20.0, 22, 28);
    expect(lateAlongA.filter((r) => !r.dark)).toHaveLength(2);
    for (const w of lateAlongA.filter((r) => !r.dark))
      expect(w.widthMm).toBeGreaterThanOrEqual(0.25);
    const lateParallel = (
      await scanLine(lateSvg, "vertical", 35, 17, 23)
    ).filter((r) => r.dark);
    expect(lateParallel).toHaveLength(2);
    for (const d of lateParallel)
      expect(d.widthMm).toBeGreaterThanOrEqual(0.28);
  });

  it("preserves crossing knockouts outside the close-parallel zone in both paint orders", async () => {
    const cross: RouteSpec = {
      id: "X1",
      points: [
        { x: 40, y: 5 },
        { x: 40, y: 40 },
      ],
    };
    const parallel: RouteSpec[] = [
      {
        id: "A",
        points: [
          { x: 6, y: 20.0 },
          { x: 24, y: 20.0 },
          { x: 24, y: 10 },
        ],
      },
      {
        id: "B",
        points: [
          { x: 6, y: 20.625 },
          { x: 46, y: 20.625 },
        ],
      },
    ];
    for (const order of [
      [cross, ...parallel],
      [...parallel, cross],
    ]) {
      const svg = renderRoutesSvg(order);
      if (order[0] === cross) {
        const alongX = await scanLine(svg, "vertical", 40, 18, 23);
        expect(alongX.filter((r) => !r.dark)).toHaveLength(2);
        for (const w of alongX.filter((r) => !r.dark))
          expect(w.widthMm).toBeGreaterThanOrEqual(0.28);
      } else {
        const alongB = await scanLine(svg, "horizontal", 20.625, 37, 43);
        expect(alongB.filter((r) => !r.dark)).toHaveLength(2);
        for (const w of alongB.filter((r) => !r.dark))
          expect(w.widthMm).toBeGreaterThanOrEqual(0.28);
      }
    }
  });

  it("protects bend corners and partial parallel overlaps without eroding strokes", async () => {
    const svg = renderRoutesSvg([
      {
        id: "A",
        points: [
          { x: 6, y: 20.0 },
          { x: 22, y: 20.0 },
          { x: 22, y: 8 },
        ],
      },
      {
        id: "B",
        points: [
          { x: 14, y: 20.625 },
          { x: 46, y: 20.625 },
        ],
      },
    ]);
    const overlapDark = (await scanLine(svg, "vertical", 18, 17, 23)).filter(
      (r) => r.dark,
    );
    expect(overlapDark).toHaveLength(2);
    for (const d of overlapDark) expect(d.widthMm).toBeGreaterThanOrEqual(0.28);
    const bendDark = (await scanLine(svg, "vertical", 22, 17, 23)).filter(
      (r) => r.dark,
    );
    const lastBend = bendDark.at(-1);
    expect(lastBend?.widthMm ?? 0).toBeGreaterThanOrEqual(0.28);
  });

  it("handles mixed wire (0.32 mm) and jumper (0.55 mm) widths with crossing knockouts", async () => {
    const svg = renderRoutesSvg([
      {
        id: "X1",
        points: [
          { x: 25, y: 5 },
          { x: 25, y: 40 },
        ],
      },
      {
        id: "W1",
        points: [
          { x: 6, y: 20.0 },
          { x: 46, y: 20.0 },
        ],
      },
      {
        id: "J1",
        points: [
          { x: 6, y: 20.625 },
          { x: 46, y: 20.625 },
        ],
        jumper: true,
      },
    ]);
    const parallelDark = (await scanLine(svg, "vertical", 35, 17, 23)).filter(
      (r) => r.dark,
    );
    expect(parallelDark).toHaveLength(2);
    expect(parallelDark[0]?.widthMm ?? 0).toBeGreaterThanOrEqual(0.28);
    expect(parallelDark[1]?.widthMm ?? 0).toBeGreaterThanOrEqual(0.48);
    const alongCross = await scanLine(svg, "vertical", 25, 17, 23);
    expect(alongCross.filter((r) => !r.dark)).toHaveLength(3);
  });

  it("emits exact unchanged knockout SVG for unaffected routes", () => {
    const svg = renderRoutesSvg([
      {
        id: "W1",
        points: [
          { x: 6, y: 15 },
          { x: 46, y: 15 },
        ],
      },
      {
        id: "W2",
        points: [
          { x: 6, y: 25 },
          { x: 46, y: 25 },
        ],
      },
    ]);
    expect(svg).toContain(
      '<path d="M 6 15 L 46 15" fill="none" stroke="white" stroke-width="1.1"/>',
    );
    expect(svg).toContain(
      '<path d="M 6 25 L 46 25" fill="none" stroke="white" stroke-width="1.1"/>',
    );
    expect(svg).not.toContain('fill="white"/><rect');
  });

  it("rejects layout when close-parallel crossing cannot satisfy both stroke protection and crossing knockout", () => {
    expect(() =>
      renderRoutesSvg([
        {
          id: "X1",
          points: [
            { x: 25, y: 5 },
            { x: 25, y: 40 },
          ],
        },
        {
          id: "A",
          points: [
            { x: 6, y: 20.0 },
            { x: 46, y: 20.0 },
          ],
        },
        {
          id: "B",
          points: [
            { x: 6, y: 20.38 },
            { x: 46, y: 20.38 },
          ],
        },
      ]),
    ).toThrow(InlineLabelCollisionError);
  });
});
