import { expect, it, vi } from "vitest";
import { compileProject } from "@thermite/compiler";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { fullyCoincidentCaption } from "../src/circuit/coincident-caption.js";
import * as captions from "../src/circuit/caption-plan.js";
import type { CircuitLabelState } from "../src/circuit/layout-routes.js";
import { InlineLabelCollisionError } from "../src/layout/inline-label-error.js";
import { renderSchematicPacket } from "../src/sheets.js";
import { jumperChainCircuitFixture } from "./circuit-fixture.js";
import base from "./fixtures/coincident-caption-base.json";
import { required } from "./fixtures.js";
import { printableTextWidth } from "../src/text-metrics.js";
type Segment = CircuitLabelState["segments"][number];
const segment = (index: number, x: number, end: number): Segment => ({
  index,
  a: { x, y: 10 },
  b: { x: end, y: 10 },
});
it("admits only complete foreign collinear coverage, including stitched and reversed segments", () => {
  expect(
    fullyCoincidentCaption(0, [
      segment(0, 0, 20),
      segment(1, 10, 0),
      segment(2, 10, 20),
    ]),
  ).toBe(true);
  expect(
    fullyCoincidentCaption(0, [
      segment(0, 0, 20),
      segment(1, 0, 9),
      segment(2, 10, 20),
    ]),
  ).toBe(false);
  expect(
    fullyCoincidentCaption(0, [segment(0, 0, 20), segment(1, 0, 19.99)]),
  ).toBe(false);
  expect(
    fullyCoincidentCaption(0, [
      segment(0, 0, 20),
      { ...segment(1, 0, 20), a: { x: 0, y: 10.01 }, b: { x: 20, y: 10.01 } },
    ]),
  ).toBe(false);
  expect(
    fullyCoincidentCaption(0, [segment(0, 0, 20), segment(0, 0, 20)]),
  ).toBe(false);
  expect(fullyCoincidentCaption(0, [])).toBe(false);
  expect(fullyCoincidentCaption(0, [segment(0, 0, 0), segment(1, 0, 20)])).toBe(
    false,
  );
  expect(
    fullyCoincidentCaption(0, [
      { index: 0, a: { x: 0, y: 0 }, b: { x: 20, y: 10 } },
      segment(1, 0, 20),
    ]),
  ).toBe(false);
  expect(
    fullyCoincidentCaption(0, [
      { index: 0, a: { x: 10, y: 0 }, b: { x: 10, y: 20 } },
      { index: 1, a: { x: 10, y: 20 }, b: { x: 10, y: 0 } },
    ]),
  ).toBe(true);
  expect(
    fullyCoincidentCaption(0, [
      segment(0, 0, 20),
      segment(1, 0, 20),
      { index: 0, a: { x: 20, y: 10 }, b: { x: 20, y: 11 } },
    ]),
  ).toBe(false);
});
async function example(name: string) {
  const dir = `libraries/siemens-pilot/examples/${name}`,
    compiled = await compileProject(dir);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  return renderSchematicPacket(
    compiled.ir,
    JSON.parse(await readFile(`${dir}/packet.request.json`, "utf8")),
  );
}
it.each(base.cases)(
  "keeps the coincident caption identities and leader-free plates in $name",
  async (fixture) => {
    const rendered = await example(fixture.name);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
    expect(rendered.value.sheets).toHaveLength(fixture.pages);
    expect(base.cases.map((f) => f.labels.length)).toEqual([2, 2, 3, 1, 3, 1]);
    for (const label of fixture.labels) {
      const doc = parseHTML(
          required(rendered.value.sheets[label.sheet - 1]).svg,
        ).document,
        actual = required(
          doc.querySelector(
            `[data-circuit-group="${label.group}"] [data-wire-label="${label.uid}"]`,
          ),
        );
      const prior = parseHTML(`<svg>${label.svg}</svg>`).document;
      const printed = required(actual.querySelector("text"));
      expect(printed.textContent, label.uid).toBe(
        prior.querySelector("text")?.textContent,
      );
      expect(printed.getAttribute("font-size")).toBe("2.5");
      const plateWidth = Number(
        actual.querySelector("rect")?.getAttribute("width"),
      );
      expect(plateWidth).toBeGreaterThan(0);
      expect(plateWidth).toBeLessThanOrEqual(
        printableTextWidth(printed.textContent ?? "", 2.5) + 1.501,
      );
      expect(
        doc.querySelectorAll(`[data-label-leader-owner="${label.uid}"]`),
      ).toHaveLength(0);
    }
  },
);
it("still fails closed when an ambiguous coincident owner has a partly uncovered tail", async () => {
  const original = captions.plannedCircuitCaption;
  let witness: Parameters<typeof original> | undefined;
  const spy = vi
    .spyOn(captions, "plannedCircuitCaption")
    .mockImplementation((...args) => {
      const [line, , label, state] = args;
      if (
        line === "FIXED2" &&
        fullyCoincidentCaption(label.index, state.segments)
      )
        witness ??= args;
      return original(...args);
    });
  try {
    expect((await example("6es7131-4rd02-0ab0")).ok).toBe(true);
  } finally {
    spy.mockRestore();
  }
  const [line, i, label, state] = required(witness),
    end = required(
      state.segments.filter((s) => s.index === label.index).at(-1),
    ).b,
    partial = {
      ...state,
      segments: [
        ...state.segments,
        { index: label.index, a: end, b: { x: end.x + 0.25, y: end.y } },
      ],
    };
  expect(fullyCoincidentCaption(label.index, partial.segments)).toBe(false);
  expect(() => original(line, i, label, partial)).toThrow(
    InlineLabelCollisionError,
  );
});

it("recovers the ABB and both-flow external jumper positives without a new refusal or page", async () => {
  const dir = "libraries/abb-pilot/examples/1sna356204r1100",
    c = await compileProject(dir);
  expect(c.ok).toBe(true);
  if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
  const abb = await renderSchematicPacket(
    c.ir,
    JSON.parse(await readFile(`${dir}/packet.request.json`, "utf8")),
  );
  expect(abb.ok).toBe(true);
  if (!abb.ok) throw Error(JSON.stringify(abb.error));
  expect(abb.value.sheets).toHaveLength(1);
  const f = await jumperChainCircuitFixture();
  try {
    for (const flow of ["left-to-right", "top-to-bottom"]) {
      const request = {
          format: "schematic-packet-request/0.1",
          views: [{ ...f.view, flow }],
        },
        before = JSON.stringify([f.ir, request]),
        rendered = await renderSchematicPacket(f.ir, request);
      expect(rendered.ok, flow).toBe(true);
      if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
      expect(rendered.value.sheets).toHaveLength(1);
      expect(JSON.stringify([f.ir, request])).toBe(before);
    }
  } finally {
    await f.dispose();
  }
});
