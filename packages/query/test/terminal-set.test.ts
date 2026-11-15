import { expect, it } from "vitest";
import { formatTerminalSet, printedPort } from "../src/index.js";
import type { IrFunction } from "@thermite/compiler";
it.each([
  [[], ""],
  [["3"], "3"],
  [["13", "14"], "13–14"],
  [["A1", "A2"], "A1 / A2"],
  [["9", "13"], "9 / 13"],
  [["14", "13"], "14–13"],
  [["01", "02"], "01–02"],
  [
    ["9007199254740992", "9007199254740993"],
    "9007199254740992–9007199254740993",
  ],
  [["PE", "+24V"], "PE / +24V"],
  [["+", "-", "S"], "+ / - / S"],
  [["+", "-"], "+ / -"],
  [["1/2", "3<&>"], "1/2, 3<&>"],
  [["1/L1", "2/T1"], "1/L1, 2/T1"],
  [["X10.1", "X10.2"], "X10.1 / X10.2"],
  [["DC-IN.1", "DC-IN.2"], "DC-IN.1 / DC-IN.2"],
  [["L+", "M"], "L+ / M"],
  [["a–b", "c"], "a–b / c"],
  [["a−b", "c"], "a−b / c"],
  [["a-b", "c/d"], "a-b, c/d"],
  [["a/b", "c", "d"], "a/b, c, d"],
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

it("checks the actual printed names when qualifying native terminal identities", () => {
  expect(formatTerminalSet(["13", "14"], (t) => `K1.${t}`)).toBe("K1.13–K1.14");
  expect(formatTerminalSet(["13", "14"], (t) => `-K1.${t}`)).toBe(
    "-K1.13 / -K1.14",
  );
  expect(formatTerminalSet(["9", "13"], (t) => `K/1.${t}`)).toBe(
    "K/1.9, K/1.13",
  );
  expect(formatTerminalSet(["13", "14"], (t) => `-K/1.${t}`)).toBe(
    "-K/1.13, -K/1.14",
  );
  expect(formatTerminalSet(["+", "-", "S"], (t) => `K1.${t}`)).toBe(
    "K1.+ / K1.- / K1.S",
  );
});

function element(
  names: string[],
): Pick<IrFunction, "id" | "kind" | "terminals"> {
  return {
    id: { deviceUid: "native-device", functionKey: "arbitrary" },
    kind: "contact",
    terminals: names.map((terminalKey) => ({
      deviceUid: "native-device",
      terminalKey,
    })),
  };
}

it.each([
  [["A1", "A2"], "A1–A2"],
  [["13", "14"], "13–14"],
  [["9", "13"], "9–13"],
  [["1/L1", "2/T1"], "1/L1–2/T1"],
  [["A–B", "C"], "A–B / C"],
  [["+24V", "PE"], "+24V / PE"],
])("retains only source-proven element pairs %j", (names, expected) => {
  const native = element(names);
  const before = JSON.stringify(native);
  expect(formatTerminalSet(names, undefined, native)).toBe(expected);
  native.kind = "coil";
  expect(formatTerminalSet(names, undefined, native)).toBe(expected);
  native.kind = "contact";
  expect(JSON.stringify(native)).toBe(before);
});

it("never infers one element from a channel, matching prefix, foreign binding or incomplete set", () => {
  const native = element(["A1", "A2"]);
  expect(formatTerminalSet(["A1", "A2"])).toBe("A1 / A2");
  expect(formatTerminalSet(["A1", "A3"], undefined, native)).toBe("A1 / A3");
  const foreign = {
    ...native,
    terminals: native.terminals.map((t) => ({ ...t, deviceUid: "foreign" })),
  };
  expect(formatTerminalSet(["A1", "A2"], undefined, foreign)).toBe("A1 / A2");
  const channel = {
    ...element(["9", "13"]),
    kind: "channel",
    direction: "input",
  } satisfies Pick<IrFunction, "id" | "kind" | "terminals"> & {
    direction: string;
  };
  expect(formatTerminalSet(["9", "13"], undefined, channel)).toBe("9 / 13");
  expect(
    formatTerminalSet(["A1", "A2"], undefined, element(["A1", "A1"])),
  ).toBe("A1 / A2");
});
