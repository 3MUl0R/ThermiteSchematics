import { expect, it } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import {
  horizontalLabelSupport,
  ownedLabelLeader,
  labelLeaderArrow,
} from "../src/layout/wire-label-support.js";
import { ownedWiringLabels } from "../src/layout/wiring-label-support.js";
import { required } from "./fixtures.js";

const ink = { left: 0, right: 20, top: 10, bottom: 15 };
const horizontal = [
  { x: -10, y: 16 },
  { x: 30, y: 16 },
];
const vertical = [
  { x: 21, y: 0 },
  { x: 21, y: 30 },
];
it("requires the full block's own supporting run, preserves valid inline plates and refuses erased owners", () => {
  expect(horizontalLabelSupport(ink, [vertical], 8)).toBe(false);
  expect(
    horizontalLabelSupport(
      ink,
      [
        [
          { x: 5, y: 16 },
          { x: 15, y: 16 },
        ],
      ],
      2,
    ),
  ).toBe(false);
  expect(horizontalLabelSupport(ink, [horizontal], 2)).toBe(true);
  expect(
    horizontalLabelSupport(
      ink,
      [
        [
          { x: -10, y: 12 },
          { x: 30, y: 12 },
        ],
      ],
      2,
    ),
  ).toBe(true);
  expect(horizontalLabelSupport(ink, [], 2)).toBe(false);
  expect(
    horizontalLabelSupport(ink, [horizontal], 2, [
      [
        { x: -10, y: 15.5 },
        { x: 30, y: 15.5 },
      ],
    ]),
  ).toBe(false);
});
it("finds a bounded leader to the owner without crossing text, a foreign conductor, symbol or frame", () => {
  const own = [
      [
        { x: 25, y: -20 },
        { x: 25, y: 40 },
      ],
    ],
    reservation = { left: -2, right: 22, top: 5, bottom: 20 };
  const context = {
    foreign: [],
    obstacles: [],
    bounds: { left: -50, right: 100, top: -50, bottom: 100 },
    strokeClearance: 1,
  };
  const leader = required(ownedLabelLeader(ink, reservation, own, context, 8));
  expect(leader.at(-1)?.x).toBe(25);
  expect(leader.at(-1)?.y).toBeGreaterThanOrEqual(-20);
  expect(leader.at(-1)?.y).toBeLessThanOrEqual(40);
  expect(labelLeaderArrow(leader)[1]).toEqual(leader.at(-1));
  const barrier = [
    { x: 22, y: -50 },
    { x: 22, y: 100 },
  ];
  expect(
    ownedLabelLeader(
      ink,
      reservation,
      own,
      { ...context, foreign: [barrier] },
      8,
    ),
  ).toBeUndefined();
  expect(
    ownedLabelLeader(
      ink,
      reservation,
      own,
      {
        ...context,
        obstacles: [{ left: 22, right: 24, top: -50, bottom: 100 }],
      },
      8,
    ),
  ).toBeUndefined();
  expect(ownedLabelLeader(ink, reservation, [], context, 8)).toBeUndefined();
});
function fixture(): ElkNode {
  return {
    id: "wiring",
    width: 200,
    height: 100,
    children: [],
    edges: [
      {
        id: "e0",
        sources: ["a"],
        targets: ["b"],
        labels: [{ text: "SAME", x: 70, y: 10, width: 60, height: 8 }],
        sections: [
          {
            id: "s0",
            startPoint: { x: 10, y: 40 },
            endPoint: { x: 190, y: 40 },
          },
        ],
      },
      {
        id: "e1",
        sources: ["c"],
        targets: ["d"],
        labels: [{ text: "SAME", x: 70, y: 20, width: 60, height: 8 }],
        sections: [
          {
            id: "s1",
            startPoint: { x: 10, y: 60 },
            endPoint: { x: 190, y: 60 },
          },
        ],
      },
    ],
  };
}
it("places distinct same-text wire captions independently on their actual native routes, keeping bounds and all routes", () => {
  const before = fixture(),
    original = structuredClone(before),
    after = ownedWiringLabels(before);
  expect(
    after.edges?.map((e) =>
      e.labels?.map((l) => ({ x: l.x, y: l.y, text: l.text })),
    ),
  ).toEqual([
    [{ x: 10, y: 36, text: "SAME" }],
    [{ x: 10, y: 56, text: "SAME" }],
  ]);
  expect(after.edges?.map((e) => e.sections)).toEqual(
    before.edges?.map((e) => e.sections),
  );
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);
  expect(before).toEqual(original);
});
it("selects the longest free owned segment and preserves a valid old inline plate", () => {
  const graph = fixture(),
    edge = required(graph.edges?.[0]),
    section = required(edge.sections?.[0]);
  section.bendPoints = [
    { x: 80, y: 40 },
    { x: 80, y: 80 },
  ];
  section.endPoint = { x: 190, y: 80 };
  const result = ownedWiringLabels(graph),
    label = required(result.edges?.[0]?.labels?.[0]);
  expect(label.y).toBe(76);
  expect(label.x).toBe(80);
  expect(ownedWiringLabels(result)).toEqual(result);
});
