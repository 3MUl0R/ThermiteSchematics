import { beforeAll, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileProject,
  lockProject,
  type ElectricalIr,
} from "@thermite/compiler";
import { renderSchematicPacket } from "../src/sheets.js";
import { parseHTML } from "linkedom";
import { required } from "./fixtures.js";
import { points as routePoints } from "./helpers/route-quality.js";
import {
  circuitLandingInk,
  circuitEndpointDefects,
  circuitApproachGap,
  circuitLandingAnchorDefects,
} from "./helpers/circuit-landing-ink.js";
import type { SchematicPacketRequest } from "../src/packet/types.js";
let ir: ElectricalIr, request: SchematicPacketRequest;
beforeAll(async () => {
  const c = await compileProject("examples/self-loop-labels");
  if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
  ir = c.ir;
  request = JSON.parse(
    await readFile("examples/self-loop-labels/packet.json", "utf8"),
  );
});
const cases = (["left-to-right", "top-to-bottom"] as const).flatMap((flow) =>
  [false, true].map((reversed) => ({ flow, reversed })),
);
it.each(cases)(
  "lands separately in both repeated $flow views (reversed=$reversed)",
  async ({ flow, reversed }) => {
    const source = structuredClone(ir);
    if (reversed) for (const wire of source.wires) wire.endpoints.reverse();
    const before = JSON.stringify(source);
    const views = request.views.map((v) => ({ ...v, flow }));
    const r = await renderSchematicPacket(source, { ...request, views });
    expect(r.ok).toBe(true);
    if (!r.ok) throw Error(JSON.stringify(r.error));
    expect(r.value.sheets).toHaveLength(2);
    const a = required(source.wires.find((w) => w.designation === "W2"));
    const b = required(source.wires.find((w) => w.designation === "W3"));
    for (const sheet of r.value.sheets) {
      const ink = circuitLandingInk(sheet.svg, source);
      expect(ink.routes.map((r) => r.uid).sort()).toEqual(
        source.wires.map((w) => w.uid).sort(),
      );
      expect(circuitEndpointDefects(ink)).toEqual([]);
      expect(circuitLandingAnchorDefects(ink)).toEqual([]);
      expect(circuitApproachGap(ink, a.uid, b.uid)).toBeGreaterThanOrEqual(
        0.7 - 0.002,
      );
      const doc = parseHTML(sheet.svg).document;
      expect(doc.querySelectorAll("[data-circuit-junction]")).toHaveLength(0);
      expect(
        [...doc.querySelectorAll("[data-wire-label] text")]
          .map((t) => t.textContent)
          .sort(),
      ).toEqual(["101", "102", "103", "BRIDGE"]);
    }
    expect(JSON.stringify(source)).toBe(before);
  },
);

it.each([
  { kind: "missing", expected: ["W2:route-count"] },
  { kind: "detached", expected: ["W2:I2:detached"] },
  { kind: "forged", expected: ["W2:native-identity"] },
] as const)(
  "detects a $kind conductor without trusting its drawing metadata",
  async ({ kind, expected }) => {
    const r = await renderSchematicPacket(ir, request);
    expect(r.ok).toBe(true);
    if (!r.ok) throw Error(JSON.stringify(r.error));
    const doc = parseHTML(required(r.value.sheets[0]).svg).document;
    const w = required(ir.wires.find((w) => w.designation === "W2"));
    const route = required(
      doc.querySelector(`[data-circuit-conductor="${w.uid}"]`),
    );
    if (kind === "missing") route.remove();
    else if (kind === "forged")
      route.setAttribute(
        "data-endpoints",
        JSON.stringify([
          w.endpoints[0].terminal,
          { ...w.endpoints[1].terminal, terminalKey: "I3" },
        ]),
      );
    else {
      const path = required(route.querySelector('path[stroke="#17212b"]'));
      const ps = routePoints(required(path.getAttribute("d")));
      required(ps.at(-1)).x += 4;
      path.setAttribute(
        "d",
        ps.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" "),
      );
    }
    expect(
      circuitEndpointDefects(circuitLandingInk(doc.toString(), ir)),
    ).toEqual(expected);
  },
);

it("rejects a dot-only repair with native ends still landed on the same mark", async () => {
  const r = await renderSchematicPacket(ir, request);
  expect(r.ok).toBe(true);
  if (!r.ok) throw Error(JSON.stringify(r.error));
  const doc = parseHTML(required(r.value.sheets[0]).svg).document;
  const a = required(ir.wires.find((w) => w.designation === "W2"));
  const b = required(ir.wires.find((w) => w.designation === "W3"));
  const path = (uid: string) =>
    required(
      doc.querySelector(
        `[data-circuit-conductor="${uid}"] path[stroke="#17212b"]`,
      ),
    );
  const incoming = routePoints(required(path(a.uid).getAttribute("d")));
  const loop = routePoints(required(path(b.uid).getAttribute("d")));
  const y = required(incoming.at(-1)).y;
  required(loop[0]).y = y;
  required(loop[1]).y = y;
  path(b.uid).setAttribute(
    "d",
    loop.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" "),
  );
  for (const dot of doc.querySelectorAll("[data-circuit-junction]"))
    dot.remove();
  const ink = circuitLandingInk(doc.toString(), ir);
  expect(circuitEndpointDefects(ink)).toEqual([]);
  expect(circuitApproachGap(ink, a.uid, b.uid)).toBeCloseTo(-0.32, 3);
});

const groupedBusRequest: SchematicPacketRequest = {
  format: "schematic-packet-request/0.1",
  page: { size: "tabloid", orientation: "landscape" },
  views: [
    {
      format: "circuit-view-request/0.1",
      title: "Grouped terminal bus",
      flow: "top-to-bottom",
      groups: [
        {
          id: "g",
          conductors: ["W1", "W2"],
          functions: [
            { device: { by: "designation", value: "TB0" }, key: "terminal1" },
            { device: { by: "designation", value: "TB1" }, key: "terminal1" },
            { device: { by: "designation", value: "TB1" }, key: "terminal2" },
          ],
        },
      ],
    },
  ],
};

async function compileGroupedBusProject(root: string): Promise<ElectricalIr> {
  await writeFile(
    join(root, "system.json"),
    JSON.stringify({
      format: "electrical-system/0.1",
      project: { name: "Grouped bus duplicate port review" },
      sources: ["source.json"],
      libraries: [{ name: "core", version: "0.2.0" }],
    }),
  );
  await writeFile(
    join(root, "source.json"),
    JSON.stringify({
      objects: [
        {
          kind: "device",
          uid: "95000000-0000-4000-8000-000000000001",
          designation: "TB0",
          type: "core:terminal-block-8",
        },
        {
          kind: "device",
          uid: "95000000-0000-4000-8000-000000000002",
          designation: "TB1",
          type: "core:terminal-block-8",
        },
        {
          kind: "wire",
          uid: "95000000-0000-4000-8000-000000000011",
          designation: "W1",
          endpoints: [
            { device: "TB0", terminal: "1" },
            { device: "TB1", terminal: "1" },
          ],
        },
        {
          kind: "wire",
          uid: "95000000-0000-4000-8000-000000000012",
          designation: "W2",
          endpoints: [
            { device: "TB1", terminal: "1" },
            { device: "TB1", terminal: "2" },
          ],
        },
        {
          kind: "wire",
          uid: "95000000-0000-4000-8000-000000000013",
          designation: "W3",
          endpoints: [
            { device: "TB1", terminal: "1" },
            { device: "TB0", terminal: "2" },
          ],
        },
      ],
    }),
  );
  const locked = await lockProject(root);
  if (!locked.ok) throw Error(JSON.stringify(locked.diagnostics));
  const compiled = await compileProject(root);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  return compiled.ir;
}

it("keeps the 6 mm north label baseline for grouped bus terminals without an actual split landing (#628)", async () => {
  const root = await mkdtemp(join(tmpdir(), "thermite-grouped-bus-628-"));
  try {
    const busIr = await compileGroupedBusProject(root);
    const result = await renderSchematicPacket(busIr, groupedBusRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(JSON.stringify(result.error));
    expect(result.value.sheets).toHaveLength(1);
    const doc = parseHTML(required(result.value.sheets[0]).svg).document;
    const w1 = required(doc.querySelector('[data-conductor-designation="W1"]'));
    const w2 = required(doc.querySelector('[data-conductor-designation="W2"]'));
    expect(w1.getAttribute("data-layout-target-port")).toBe("n1p0");
    expect(w2.getAttribute("data-layout-source-port")).toBe("n1p1");
    expect(doc.querySelectorAll("[data-circuit-landing-for]")).toHaveLength(0);
    const tb1North = required(
      doc.querySelector('[data-layout-port="n1p0"] text'),
    );
    expect(tb1North.textContent).toBe("1 [+1]");
    expect(Number(tb1North.getAttribute("y"))).toBeCloseTo(6, 3);
    const tb1SecondNorth = required(
      doc.querySelector('[data-layout-port="n1p2"] text'),
    );
    expect(tb1SecondNorth.textContent).toBe("2");
    expect(Number(tb1SecondNorth.getAttribute("y"))).toBeCloseTo(6, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
