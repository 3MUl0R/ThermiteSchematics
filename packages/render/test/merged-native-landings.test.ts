import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { ElectricalIr, TerminalId } from "@thermite/compiler";
import { prepareWiringDrawing } from "../src/wiring.js";
import * as runtime from "../src/layout/elk-runtime.js";
import { MAX_INDEPENDENT_WIRING_LAYOUTS } from "../src/layout/wiring-independent.js";
import { required } from "./fixtures.js";
import { points } from "./helpers/route-quality.js";
import { sharedLengths } from "./helpers/wiring-landings.js";
import { consoleWiringFixture } from "./wiring-landings-fixture.js";
import {
  seriesFixture,
  withCable,
  endpoint,
  uid,
} from "./series-loop-fixture.js";

const factory = runtime.createElkEngine;
function recordingEngine(records: ElkNode[]) {
  const engine = factory(),
    native = engine.layout.bind(engine);
  engine.layout = async (input, options) => {
    records.push(structuredClone(input));
    return native(input, options);
  };
  return engine;
}
afterEach(() => vi.restoreAllMocks());

type WiringRoute = {
  id: string;
  stroke: number;
  ends: string[];
  ps: ReturnType<typeof points>;
};

function wiringPhysicalMark(
  doc: ReturnType<typeof parseHTML>["document"],
  terminal: TerminalId,
) {
  const body = required(
    doc.querySelector(`[data-device-uid="${terminal.deviceUid}"]`),
  );
  const marks = [
    ...body.querySelectorAll(
      `circle[data-terminal-key="${terminal.terminalKey}"]`,
    ),
  ].filter(
    (m) =>
      Number(m.getAttribute("r")) > 0.1 &&
      (m.getAttribute("fill") !== "none" ||
        (m.hasAttribute("stroke") && m.getAttribute("stroke") !== "none")),
  );
  expect(marks).toHaveLength(1);
  const mark = required(marks[0]);
  const shift = required(
    required(body.getAttribute("transform")).match(
      /translate\(([-\d.]+) ([-\d.]+)\)/u,
    ),
  );
  return {
    x: Number(shift[1]) + Number(mark.getAttribute("cx")),
    y: Number(shift[2]) + Number(mark.getAttribute("cy")),
    radius: Number(mark.getAttribute("r")),
  };
}

function wiringRoutes(
  doc: ReturnType<typeof parseHTML>["document"],
  ir: Readonly<ElectricalIr>,
): WiringRoute[] {
  const all = new Map<string, readonly TerminalId[]>([
    ...ir.wires.map(
      (w) => [w.uid, w.endpoints.map((e) => e.terminal)] as const,
    ),
    ...ir.jumpers.map(
      (j) => [j.uid, j.endpoints.map((e) => e.terminal)] as const,
    ),
    ...ir.cableConductors.map(
      (c) =>
        [JSON.stringify(c.id), c.endpoints.map((e) => e.terminal)] as const,
    ),
  ]);
  return [...doc.querySelectorAll("g[data-wiring-conductor]")].map((g) => {
    const id = required(g.getAttribute("data-wiring-conductor"));
    const ends = required(all.get(id));
    const path = required(g.querySelector("path"));
    const ps = points(required(path.getAttribute("d")));
    const [a, b] = ends.map((t) => wiringPhysicalMark(doc, t));
    const first = required(ps[0]),
      last = required(ps.at(-1));
    const dist = (p: typeof first, m: NonNullable<typeof a>) =>
      Math.hypot(p.x - m.x, p.y - m.y) - m.radius;
    expect(
      Math.min(
        Math.max(dist(first, required(a)), dist(last, required(b))),
        Math.max(dist(first, required(b)), dist(last, required(a))),
      ),
    ).toBeLessThanOrEqual(0.0011);
    return {
      id,
      stroke: Number(path.getAttribute("stroke-width")),
      ends: ends.map((t) => JSON.stringify(t)),
      ps,
    };
  });
}

function minClearParallelGap(a: WiringRoute, b: WiringRoute) {
  let minimum = Infinity;
  for (const [axis, cross] of [
    ["x", "y"],
    ["y", "x"],
  ] as const) {
    for (let i = 1; i < a.ps.length; i++)
      for (let j = 1; j < b.ps.length; j++) {
        const p = required(a.ps[i - 1]),
          q = required(a.ps[i]),
          r = required(b.ps[j - 1]),
          s = required(b.ps[j]);
        if (
          Math.abs(p[cross] - q[cross]) > 1e-6 ||
          Math.abs(r[cross] - s[cross]) > 1e-6
        )
          continue;
        const overlap =
          Math.min(Math.max(p[axis], q[axis]), Math.max(r[axis], s[axis])) -
          Math.max(Math.min(p[axis], q[axis]), Math.min(r[axis], s[axis]));
        if (overlap > 3)
          minimum = Math.min(
            minimum,
            Math.abs(p[cross] - r[cross]) - (a.stroke + b.stroke) / 2,
          );
      }
  }
  return minimum;
}

it("separates dual incoming native wiring landings at TB1.1 and TB1.2 without adding terminals (P11 shape)", async () => {
  const f = await seriesFixture(withCable);
  try {
    const drawing = await prepareWiringDrawing(f.ir, {
      format: "wiring-view-request/0.1",
      title: "Pressure loop physical wiring",
      conductors: ["W10", "CB1/A", "CB1/B", "W11", "W12"],
      deviceOrder: ["PS1", "TX1", "TB1", "AI1"],
    });
    const doc = parseHTML(`<svg>${drawing.content}</svg>`).document;
    const anchors = [...doc.querySelectorAll("[data-wiring-landing-for]")];
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    for (const anchor of anchors) {
      expect(anchor.getAttribute("fill")).toBe("none");
      expect(anchor.getAttribute("stroke")).toBe("none");
      expect(Number(anchor.getAttribute("r"))).toBe(0.001);
    }
    const routes = wiringRoutes(doc, f.ir);
    expect(routes).toHaveLength(5);
    for (const [i, a] of routes.entries())
      for (const b of routes.slice(i + 1)) {
        if (!a.ends.some((t) => b.ends.includes(t))) continue;
        expect(sharedLengths(a.ps, b.ps)).toEqual([]);
        expect(minClearParallelGap(a, b)).toBeGreaterThanOrEqual(0.7 - 1e-6);
      }
    expect(doc.querySelectorAll("circle[data-wiring-junction]")).toHaveLength(
      0,
    );
  } finally {
    await f.dispose();
  }
});

it("keeps a genuinely single wiring conductor directly on its physical terminal with no landing anchors", async () => {
  const f = await seriesFixture();
  try {
    const drawing = await prepareWiringDrawing(f.ir, {
      format: "wiring-view-request/0.1",
      title: "Single conductor control",
      conductors: ["W10"],
      deviceOrder: ["PS1", "TX1"],
    });
    const doc = parseHTML(`<svg>${drawing.content}</svg>`).document;
    expect(doc.querySelectorAll("[data-wiring-landing-for]")).toHaveLength(0);
    expect(doc.querySelectorAll("circle[data-wiring-junction]")).toHaveLength(
      0,
    );
    expect(wiringRoutes(doc, f.ir)).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

it("separates a real authored jumper/bridge sharing a terminal with a wire while preserving jumper stroke", async () => {
  const f = await seriesFixture((m) => {
    withCable(m);
    m.objects = m.objects.filter((o) => o.uid !== uid(11));
    m.objects.push({
      kind: "jumper",
      uid: uid(11),
      designation: "J11",
      endpoints: [endpoint("AI1", "p"), endpoint("TB1", "2")],
    });
  });
  try {
    const drawing = await prepareWiringDrawing(f.ir, {
      format: "wiring-view-request/0.1",
      title: "Authored jumper sharing terminal",
      conductors: ["W10", "CB1/A", "CB1/B", "J11", "W12"],
      deviceOrder: ["PS1", "TX1", "TB1", "AI1"],
    });
    const doc = parseHTML(`<svg>${drawing.content}</svg>`).document;
    const routes = wiringRoutes(doc, f.ir);
    expect(routes).toHaveLength(5);
    const jumper = required(routes.find((r) => r.id === uid(11)));
    expect(jumper.stroke).toBe(0.7);
    for (const [i, a] of routes.entries())
      for (const b of routes.slice(i + 1)) {
        if (!a.ends.some((t) => b.ends.includes(t))) continue;
        expect(sharedLengths(a.ps, b.ps)).toEqual([]);
        expect(minClearParallelGap(a, b)).toBeGreaterThanOrEqual(0.7 - 1e-6);
      }
    expect(doc.querySelectorAll("circle[data-wiring-junction]")).toHaveLength(
      0,
    );
  } finally {
    await f.dispose();
  }
});

it("keeps existing #337 operator-console wiring views byte-identical", async () => {
  const source = await consoleWiringFixture();
  // Refreshed for additive RL1 data-text-role attributes (#642; byte-identical after strip).
  const expected = [
    [0, "12657d7015b9b2d9f13ec192c6ae94eea52a0956bf058cc39efe1a0ef8392e38"],
    [3, "d0c93ee85b144ca597db97dff99744bb38e8b539f526fa05ceeeb73be699213a"],
  ] as const;
  for (const [index, sha256] of expected) {
    const drawing = await prepareWiringDrawing(
      source.ir,
      source.request.views[index],
    );
    expect(createHash("sha256").update(drawing.content).digest("hex")).toBe(
      sha256,
    );
  }
});

it("uses three ELK calls on the symmetric fallback witness while #337 controls still use two", async () => {
  expect(MAX_INDEPENDENT_WIRING_LAYOUTS).toBe(3);
  const f = await seriesFixture(withCable);
  try {
    const fallbackCalls: ElkNode[] = [];
    vi.spyOn(runtime, "createElkEngine").mockImplementation(() =>
      recordingEngine(fallbackCalls),
    );
    await prepareWiringDrawing(f.ir, {
      format: "wiring-view-request/0.1",
      title: "Pressure loop physical wiring",
      conductors: ["W10", "CB1/A", "CB1/B", "W11", "W12"],
      deviceOrder: ["PS1", "TX1", "TB1", "AI1"],
    });
    expect(fallbackCalls).toHaveLength(3);
    const baseWidth = required(required(fallbackCalls[0]).children?.[0]).width;
    expect(required(required(fallbackCalls[1]).children?.[0]).width).toBe(
      required(baseWidth) * 2,
    );
    expect(required(required(fallbackCalls[2]).children?.[0]).width).toBe(
      required(baseWidth) * 8,
    );
  } finally {
    vi.restoreAllMocks();
    await f.dispose();
  }
  const source = await consoleWiringFixture();
  for (const index of [0, 3]) {
    const controlCalls: ElkNode[] = [];
    vi.spyOn(runtime, "createElkEngine").mockImplementation(() =>
      recordingEngine(controlCalls),
    );
    await prepareWiringDrawing(source.ir, source.request.views[index]);
    expect(controlCalls).toHaveLength(2);
    vi.restoreAllMocks();
  }
});
