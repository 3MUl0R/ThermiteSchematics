import { describe, expect, it } from "vitest";

import { isVisibleStrokeColour } from "./m3-conductor-ink.mjs";

describe("m3 conductor ink colour fallback", () => {
  it("treats shorthand and full hex strokes alike", () => {
    expect(isVisibleStrokeColour("#abc")).toBe(true);
    expect(isVisibleStrokeColour("#aabbcc")).toBe(true);
    expect(isVisibleStrokeColour("rgb(170, 187, 204)")).toBe(true);
  });

  it("still rejects transparent shorthand and full hex strokes", () => {
    expect(isVisibleStrokeColour("#abc0")).toBe(false);
    expect(isVisibleStrokeColour("#aabbcc00")).toBe(false);
  });
});
