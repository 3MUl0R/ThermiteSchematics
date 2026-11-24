import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import {
  decodeOutlineJson,
  encodeOutlineJson,
} from "./helpers/svg-outline-geometry.js";

it("preserves NaN, infinities and negative zero across top-level and nested values", () => {
  expect(encodeOutlineJson(NaN)).toBe('{"__n":"NaN"}');
  expect(encodeOutlineJson(Infinity)).toBe('{"__n":"Infinity"}');
  expect(encodeOutlineJson(-Infinity)).toBe('{"__n":"-Infinity"}');
  expect(encodeOutlineJson(-0)).toBe('{"__n":"-0"}');

  expect(Number.isNaN(decodeOutlineJson(encodeOutlineJson(NaN)))).toBe(true);
  expect(decodeOutlineJson(encodeOutlineJson(Infinity))).toBe(Infinity);
  expect(decodeOutlineJson(encodeOutlineJson(-Infinity))).toBe(-Infinity);
  expect(Object.is(decodeOutlineJson(encodeOutlineJson(-0)), -0)).toBe(true);

  const payload = {
    texts: [
      { length: NaN, x: -0, y: 0, matrix: [1, 0, -0, 1, Infinity, -Infinity] },
      { length: Infinity, clips: [[{ x: -Infinity, y: NaN }]] },
      { length: -Infinity, plate: [{ x: -0, y: 12.5 }] },
      { length: -0, text: "NaN", note: "-0" },
    ],
    shapes: [
      {
        points: [
          { x: -Infinity, y: 20 },
          { x: Infinity, y: 20 },
          { x: NaN, y: -1e308 },
        ],
        stroke: 0.5,
      },
    ],
    nested: [[NaN, Infinity, -Infinity, -0, 0], { a: { b: -0 } }],
  };

  const encoded = encodeOutlineJson(payload);
  expect(encoded).toContain('{"__n":"NaN"}');
  expect(encoded).toContain('{"__n":"Infinity"}');
  expect(encoded).toContain('{"__n":"-Infinity"}');
  expect(encoded).toContain('{"__n":"-0"}');

  const decoded = decodeOutlineJson<typeof payload>(encoded);
  expect(isDeepStrictEqual(decoded, payload)).toBe(true);
  expect(Object.is(decoded.texts[0]!.x, -0)).toBe(true);
  expect(Object.is(decoded.texts[0]!.y, 0)).toBe(true);
  expect(Object.is(decoded.texts[3]!.length, -0)).toBe(true);
});

it("leaves ordinary numbers, strings, nulls and non-matching objects unchanged", () => {
  const ordinary = {
    zero: 0,
    integers: [-42, 0, 1, 9007199254740991],
    floats: [-1e308, -0.25, Number.MIN_VALUE, 3.14159, 1e308],
    primitives: [null, true, false, "", "NaN", "Infinity", "-Infinity", "-0"],
    unmatched: [
      { __n: "unknown" },
      { __n: "NaN", extra: 1 },
      { __n: 0 },
      { __n: null },
    ],
  };

  const encoded = encodeOutlineJson(ordinary);
  expect(encoded).not.toContain('{"__n":"-0"}');
  expect(encoded).not.toContain('{"__n":"Infinity"}');
  expect(encoded).not.toContain('{"__n":"-Infinity"}');

  const decoded = decodeOutlineJson<typeof ordinary>(encoded);
  expect(isDeepStrictEqual(decoded, ordinary)).toBe(true);
  expect(Object.is(decoded.zero, 0)).toBe(true);
});
