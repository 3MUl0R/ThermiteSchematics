import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileProject } from "@thermite/compiler";
import { expect, it } from "vitest";
import { prepareCircuitView } from "../src/circuit.js";
import {
  circuitDocument,
  nativeJunctionRays,
} from "./helpers/junction-rays.js";

for (const flow of ["left-to-right", "top-to-bottom"] as const) {
  it(`prints ordinary circuit endpoints hollow in ${flow}`, async () => {
    const c = await compileProject("examples/functional-symbols");
    assert.ok(c.ok);
    const request = JSON.parse(
      await readFile(
        "examples/functional-symbols/packet-left-to-right.request.json",
        "utf8",
      ),
    ).views[0];
    const drawing = await prepareCircuitView(c.ir, { ...request, flow });
    const markers = drawing.groups.flatMap((g) => [
      ...circuitDocument(g.content).querySelectorAll(
        "[data-terminal-id] > circle",
      ),
    ]);
    expect(markers.length).toBeGreaterThan(0);
    expect([...new Set(markers.map((m) => m.getAttribute("fill")))]).toEqual([
      "white",
    ]);
    expect([
      ...new Set(markers.map((m) => m.getAttribute("stroke-width"))),
    ]).toEqual([".3"]);
  });

  it(`retains the real three-way junction and detects hidden routes in ${flow}`, async () => {
    const c = await compileProject("examples/self-loop-labels");
    assert.ok(c.ok);
    const request = JSON.parse(
      await readFile("examples/self-loop-labels/packet.json", "utf8"),
    ).views[0];
    const drawing = await prepareCircuitView(c.ir, { ...request, flow });
    const group = drawing.groups[0];
    assert.ok(group);
    const doc = circuitDocument(group.content);
    const dots = [...doc.querySelectorAll("[data-circuit-junction]")];
    expect(dots).toHaveLength(1);
    const dot = dots[0];
    assert.ok(dot);
    expect(dot.getAttribute("fill")).toBe("#17212b");
    expect(dot.getAttribute("data-device-uid")).toBe(
      "65000000-0000-4000-8000-000000000002",
    );
    expect(dot.getAttribute("data-terminal-key")).toBe("I2");
    expect(nativeJunctionRays(dot, doc)).toEqual(
      flow === "left-to-right"
        ? ["east", "south", "west"]
        : ["north", "south", "west"],
    );
    const route = doc.querySelector(
      '[data-conductor-designation="W2"] path[stroke="#17212b"]',
    );
    assert.ok(route);
    route.remove();
    expect(nativeJunctionRays(dot, doc)).toEqual(
      flow === "left-to-right" ? ["east", "south"] : ["south", "west"],
    );
    dot.setAttribute("data-terminal-key", "I3");
    expect(nativeJunctionRays(dot, doc)).toEqual([]);
  });
}
