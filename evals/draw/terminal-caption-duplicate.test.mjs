import { describe, expect, it } from "vitest";
import { duplicateTerminalCaption } from "./terminal-caption-duplicate.mjs";

const cases = [
  // [text, terminal, outsideConnections, expected]
  ["1", "1", undefined, false],
  ["1 [+2]", "1", 2, false],
  ["1 [ +2 ]", "1", 2, false],
  ["[ +1 ] [ +1 ]", "[ +1 ]", 1, false],
  ["[ +1 ] [ +1 ]", "[ +1 ]", undefined, true],
  ["A A", "A A", undefined, false],
  ["A A [+1]", "A A", undefined, false],
  ["A A [+1]", "A A", 1, false],
  ["A A [ +1 ]", "A A", 1, false],
  ["[1] [1]", "[1] [1]", undefined, false],
  ["1 1", "1", undefined, true],
  ["1 1 [+2]", "1", 2, true],
  ["1 1 [ +2 ]", "1", 2, true],
  ["A A A A", "A A", undefined, true],
  // Repeated tokens that differ from the resolved key stay duplicates (#554 review).
  ["2 2", "1", undefined, true],
  ["2 2 [+1]", "1", 1, true],
  // Unresolved terminal keeps the base repeated-token rule.
  ["3 3", undefined, undefined, true],
  ["3", undefined, undefined, false],
];

describe("duplicateTerminalCaption (DQ-17)", () => {
  it.each(cases)(
    "%j owned by %j (+%j) → %j",
    (text, terminal, outsideConnections, expected) => {
      expect(
        duplicateTerminalCaption({ text, terminal, outsideConnections }),
      ).toBe(expected);
    },
  );
});
