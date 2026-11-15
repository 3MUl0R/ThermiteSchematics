import { expect, it } from "vitest";
import { terminalSet } from "./printed-vocabulary.mjs";
import { functionKeys } from "./checks.mjs";
import { readFile } from "node:fs/promises";
import ts from "typescript";
it.each([
  [["13", "14"], "13–14"],
  [["9", "13"], "9 / 13"],
  [["A1", "A2"], "A1 / A2"],
  [["PE", "+24V"], "PE / +24V"],
  [["1/L1", "2/T1"], "1/L1, 2/T1"],
  [["X10.1", "X10.2"], "X10.1 / X10.2"],
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
        terminals: [
          { deviceUid: "k", terminalKey: "1/L1" },
          { deviceUid: "k", terminalKey: "2/T1" },
        ],
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

it("DQ-05 distinguishes native coil/contact pairs from channel bindings and printed qualifiers", () => {
  const fn = {
    id: { deviceUid: "k", functionKey: "arbitrary" },
    kind: "coil",
    terminals: ["A1", "A2"].map((terminalKey) => ({
      deviceUid: "k",
      terminalKey,
    })),
  };
  expect(terminalSet(["A1", "A2"], fn)).toBe("A1–A2");
  expect(terminalSet(["A1", "A2"], { ...fn, kind: "channel" })).toBe("A1 / A2");
  expect(terminalSet(["A1", "A3"], fn)).toBe("A1 / A3");
  expect(terminalSet(["A1", "A2"], fn, ["-K1.A1", "-K1.A2"])).toBe(
    "-K1.A1 / -K1.A2",
  );
  expect(terminalSet(["9", "13"], undefined, ["K/1.9", "K/1.13"])).toBe(
    "K/1.9, K/1.13",
  );
  const foreign = {
    ...fn,
    terminals: fn.terminals.map((t) => ({ ...t, deviceUid: "foreign" })),
  };
  expect(terminalSet(["A1", "A2"], foreign)).toBe("A1 / A2");
});

it("DQ-05 rejects the old channel range and checks qualified I/O cells independently", () => {
  const fn = {
    id: { deviceUid: "ai", functionKey: "ch0" },
    kind: "channel",
    direction: "input",
    terminals: ["9", "13"].map((terminalKey) => ({
      deviceUid: "ai",
      terminalKey,
    })),
  };
  const ir = { devices: [{ uid: "ai", designation: "-AI1" }], functions: [fn] };
  const row = {
    text: "9 / 13",
    row: JSON.stringify(["ai", "ch0"]),
    columnIndex: 1,
    element: "channel",
  };
  const context = { sheet: { view: { kind: "io" } } };
  expect(functionKeys({ texts: [row] }, ir, context)).toEqual([]);
  row.text = "9–13";
  expect(functionKeys({ texts: [row] }, ir, context)).toHaveLength(1);
  row.columnIndex = 6;
  row.text = "-AI1.9 / -AI1.13";
  expect(functionKeys({ texts: [row] }, ir, context)).toEqual([]);
  row.text = "-AI1.9–-AI1.13";
  expect(functionKeys({ texts: [row] }, ir, context)).toHaveLength(1);
});

it("keeps the terminal oracle's entire import graph independent of renderer/query formatters", async () => {
  const directory = new URL("./", import.meta.url);
  const seen = new Set();
  async function visit(file) {
    if (seen.has(file.href)) return;
    seen.add(file.href);
    const source = await readFile(file, "utf8");
    const modules = ts.preProcessFile(source, true, true).importedFiles;
    for (const { fileName } of modules) {
      if (fileName.startsWith("node:")) continue;
      expect(fileName, `${file.href} imports production code`).toMatch(
        /^\.\//u,
      );
      const target = new URL(fileName, file);
      expect(
        target.href.startsWith(directory.href),
        `oracle imports ${target.href}`,
      ).toBe(true);
      await visit(target);
    }
  }
  await visit(new URL("./printed-vocabulary.mjs", import.meta.url));
});
