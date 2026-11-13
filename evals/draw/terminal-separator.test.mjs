import { expect, it } from "vitest";
import { terminalSet } from "./printed-vocabulary.mjs";
import { functionKeys } from "./checks.mjs";
it.each([
  [["13", "14"], "13–14"],
  [["1/L1", "2/T1"], "1/L1–2/T1"],
  [["X10.1", "X10.2"], "X10.1–X10.2"],
  [["+", "-"], "+ / -"],
  [["L+", "M"], "L+ / M"],
  [["DC-IN.1", "DC-IN.2"], "DC-IN.1 / DC-IN.2"],
  [["A–B", "C"], "A–B / C"],
  [["A−B", "C"], "A−B / C"],
  [["A+B", "C"], "A+B / C"],
  [["1/L1", "2/T1", "PE"], "1/L1, 2/T1, PE"],
  [["A/B-", "C"], "A/B-, C"],
  [["+", "-", "S"], "+ / - / S"],
  [["A"], "A"],
  [[], ""],
])("DQ-05 independent S2 terminal oracle %j", (names, printed) => {
  expect(terminalSet(names)).toBe(printed);
});
it("DQ-05 owned native contact caption accepts the S2 pair and rejects the old separator", () => {
  const ir = {
    devices: [{ uid: "k", designation: "K1" }],
    functions: [
      {
        id: { deviceUid: "k", functionKey: "pole" },
        kind: "contact",
        normal_state: "open",
        terminals: [{ terminalKey: "1/L1" }, { terminalKey: "2/T1" }],
      },
    ],
  };
  const rowKey = JSON.stringify(["k", ["pole"]]);
  const row = {
    text: "NO contact 1/L1–2/T1",
    row: rowKey,
    columnIndex: 1,
    element: "caption",
  };
  const context = {
    sheet: { view: { kind: "references" } },
    packet: {
      sheets: [{ references: [{ deviceUid: "k", functions: ["pole"] }] }],
    },
  };
  const check = () => functionKeys({ texts: [row] }, ir, context);
  expect(check()).toEqual([]);
  row.text = "NO contact 1/L1 / 2/T1";
  expect(check()).toHaveLength(1);
});
