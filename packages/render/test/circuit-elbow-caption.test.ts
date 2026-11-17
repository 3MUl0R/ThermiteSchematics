import { beforeAll, expect, it } from "vitest";
import { captionHostWitness } from "./helpers/circuit-caption-host.js";
import { circuitCaptionPlacement } from "../src/circuit/caption-placement.js";
import type { CircuitLabelState } from "../src/circuit/layout-routes.js";
let native: CircuitLabelState;
beforeAll(async () => {
  [, , , native] = await captionHostWitness();
});
const label = { index: 0, x: 10, y: 10, width: 12, height: 3.8, text: "103" };
function fixture(points: readonly { x: number; y: number }[]) {
  return {
    ...native,
    cs: native.cs.slice(0, 1).map((c) => ({ ...c, jumper: false })),
    labels: [label],
    segments: points
      .slice(1)
      .map((b, i) => ({ index: 0, a: points[i] ?? b, b })),
    graph: { id: "plate-host", width: 50, height: 40, children: [], edges: [] },
  };
}
it("rejects a whole plate that hides an elbow outside the text's glyph ink", () => {
  const state = fixture([
    { x: 0, y: 11.9 },
    { x: 21.5, y: 11.9 },
    { x: 21.5, y: 30 },
  ]);
  expect(circuitCaptionPlacement("103", 0, label, state)).toBeUndefined();
});
it("keeps a valid straight inline plate", () => {
  const state = fixture([
    { x: 0, y: 11.9 },
    { x: 35, y: 11.9 },
  ]);
  expect(
    circuitCaptionPlacement("103", 0, label, state)?.points,
  ).toBeUndefined();
  expect(circuitCaptionPlacement("103", 0, label, state)).toBeDefined();
});
it("keeps a nearby endpoint outside the plate, but never masks one", () => {
  const clear = fixture([
    { x: 9.5, y: 11.9 },
    { x: 35, y: 11.9 },
  ]);
  const hidden = fixture([
    { x: 12, y: 11.9 },
    { x: 35, y: 11.9 },
  ]);
  expect(circuitCaptionPlacement("103", 0, label, clear)).toBeDefined();
  expect(circuitCaptionPlacement("103", 0, label, hidden)).toBeUndefined();
});

it("keeps a straight vertical plate but exposes a terminal hidden in its top margin", () => {
  const clear = fixture([
    { x: 16, y: 0 },
    { x: 16, y: 30 },
  ]);
  const hidden = fixture([
    { x: 16, y: 10.5 },
    { x: 16, y: 30 },
  ]);
  expect(circuitCaptionPlacement("103", 0, label, clear)).toBeDefined();
  expect(circuitCaptionPlacement("103", 0, label, hidden)).toBeUndefined();
});
it("does not hide a second owned leg behind an otherwise valid straight host", () => {
  const state = fixture([
    { x: 0, y: 11.9 },
    { x: 35, y: 11.9 },
    { x: 35, y: 30 },
    { x: 16, y: 30 },
    { x: 16, y: 0 },
  ]);
  expect(circuitCaptionPlacement("103", 0, label, state)).toBeUndefined();
});
