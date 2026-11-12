import { expect, it } from "vitest";
import { formatTerminalSet, printedPort } from "../src/index.js";
it.each([
  [[], ""],
  [["3"], "3"],
  [["13", "14"], "13–14"],
  [["A1", "A2"], "A1–A2"],
  [["+", "-", "S"], "+ / - / S"],
  [["+", "-"], "+ / -"],
  [["1/2", "3<&>"], "1/2 / 3<&>"],
  [
    Array.from({ length: 12 }, (_, i) => String(i + 1)),
    "1 / 2 / 3 / 4 / 5 / 6 / 7 / 8 / 9 / 10 / 11 / 12",
  ],
] as const)("formats authored terminal set %j as %s", (names, expected) => {
  expect(formatTerminalSet(names)).toBe(expected);
});
it("keeps distinct port markings even when descriptions and connector metadata repeat", () => {
  const type = {
    ports: {
      P1: {
        medium: "ethernet" as const,
        description: "Ethernet",
        connector: "RJ45",
      },
      P2: {
        medium: "ethernet" as const,
        description: "Ethernet",
        connector: "RJ45",
      },
      P3: { medium: "ethernet" as const, description: "P3" },
    },
  };
  expect(["P1", "P2", "P3"].map((p) => printedPort(type, p))).toEqual([
    "P1 — Ethernet",
    "P2 — Ethernet",
    "P3",
  ]);
});

it("uses authored terminal names to select the separator for qualified identities", () => {
  expect(formatTerminalSet(["13", "14"], (t) => `K1.${t}`)).toBe("K1.13–K1.14");
  expect(formatTerminalSet(["+", "-", "S"], (t) => `K1.${t}`)).toBe(
    "K1.+ / K1.- / K1.S",
  );
});
