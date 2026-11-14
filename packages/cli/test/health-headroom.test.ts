import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { measure, measureSources } from "../../../scripts/health-measure.mjs";
import { allowanceMatches } from "../../../scripts/health-continuity.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url)),
  base = measure(root),
  budget = JSON.parse(
    readFileSync(root + "/scripts/health-budget.json", "utf8"),
  );

// Probe continuity separately from the decreasing size cap: insert 70/71 real
// AST-token lines, keeping every nested/sibling candidate in the measured file.
// These probes do not authorize the resulting size growth.
function probe(key: string, added: number) {
  const path = key.split("#", 1)[0],
    original = readFileSync(root + "/" + path, "utf8"),
    parsed = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true),
    [start, end] = base.bodyRanges[key];
  let offset: number | undefined;
  function find(node: ts.Node) {
    if (
      ts.isFunctionLike(node) &&
      node.getStart(parsed) === start &&
      node.end === end &&
      node.body &&
      ts.isBlock(node.body)
    )
      offset = node.body.end - 1;
    ts.forEachChild(node, find);
  }
  find(parsed);
  expect(offset, key).toBeDefined();
  const text =
      original.slice(0, offset) +
      "\n" +
      Array.from(
        { length: added },
        (_, n) => `void "health headroom probe ${n}";\n`,
      ).join("") +
      original.slice(offset),
    measured = measureSources([path], () => text),
    current = { ...base };
  for (const field of [
    "files",
    "functions",
    "bodyRanges",
    "bodyHashes",
    "bodyLines",
    "fileHashes",
    "fileLines",
  ] as const)
    current[field] = {
      ...Object.fromEntries(
        Object.entries(base[field]).filter(
          ([k]) => k !== path && !k.startsWith(path + "#"),
        ),
      ),
      ...measured[field],
    };
  return allowanceMatches(current, budget, { budget, metrics: base }).functions[
    key
  ];
}
it.each(Object.keys(budget.grandfathered.functions))(
  "provides exactly 70 added-line continuity headroom: %s",
  (id) => {
    const key = budget.locations.functions[id];
    expect(probe(key, 70), id).toMatchObject({ id, added: 70 });
    expect(probe(key, 71)?.id, id).not.toBe(id);
  },
);
