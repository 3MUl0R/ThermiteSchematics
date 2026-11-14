import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import {
  createBudget,
  regressions,
  historyRegressions,
  acceptBudget,
  lowerBudget,
} from "../../../scripts/health-ratchet.mjs";
import {
  lineSimilarity,
  allowanceMatches,
} from "../../../scripts/health-continuity.mjs";
import {
  repo,
  put,
  git,
  metrics,
  save,
  commit,
  run,
  fn,
} from "./health-fixture.js";
const file = "packages/example/test/code.test.ts";
it("normalized line similarity uses multiset overlap and the 0.5 boundary", () => {
  expect(lineSimilarity(["a", "b"], ["a", "x"])).toBe(0.5);
  expect(lineSimilarity(["a", "a"], ["a", "b"])).toBe(0.5);
  expect(lineSimilarity(["a", "b", "c"], ["a", "x", "y"])).toBeLessThan(0.5);
  expect(lineSimilarity([], [])).toBe(0);
});
it("rejects the review's unrelated 454-line replacement of the real package-smoke body", () => {
  const text = readFileSync(
    new URL("../../compiler/test/package-smoke.test.ts", import.meta.url),
    "utf8",
  );
  const source = ts.createSourceFile(
    "smoke.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  let original: ts.Node | undefined;
  function find(node: ts.Node) {
    if (ts.isFunctionLike(node) && node.body) {
      const n =
        source.getLineAndCharacterOfPosition(node.end).line -
        source.getLineAndCharacterOfPosition(node.getStart(source)).line +
        1;
      if (n === 1278) original = node.body;
    }
    ts.forEachChild(node, find);
  }
  find(source);
  expect(original).toBeDefined();
  const root = repo(),
    path = "packages/compiler/test/package-smoke.test.ts";
  put(
    root,
    path,
    `describe('packed',()=>{it('install together',async()=>${original!.getText(source)});});\n`,
  );
  const base = metrics(root),
    budget = createBudget(base);
  save(root, budget);
  const sha = commit(root);
  git(root, "branch", "dev", sha);
  const id = Object.keys(budget.grandfathered.functions).find((k) =>
    k.endsWith("/it callback"),
  )!;
  put(
    root,
    path,
    `describe('packed',()=>{\nit('brand new unrelated over-cap logic',()=>{\n${"void 987654321;\n".repeat(452)}});\n});\n`,
  );
  const current = metrics(root);
  expect(current.functions[id]).toBe(454);
  expect(
    lineSimilarity(base.bodyLines[id], current.bodyLines[id]),
  ).toBeLessThan(0.5);
  const result = run(root);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(
    "ceiling 300 -> 454 (new or unmatched content)",
  );
});
it("an earlier callback shifts its key while the same over-cap content keeps its allowance", () => {
  const root = repo();
  const small = "[1].map(x => x);\n",
    big = `[1].map(value=>{\n${"void value;\n".repeat(328)}return value;\n});\n`;
  put(root, file, small + big);
  const base = metrics(root),
    budget = createBudget(base),
    id = Object.keys(budget.grandfathered.functions)[0];
  put(root, file, small + small + big);
  const current = metrics(root),
    reference = { budget, metrics: base };
  const matches = allowanceMatches(current, budget, reference);
  const key = Object.keys(matches.functions).find(
    (k) => matches.functions[k].id === id,
  )!;
  expect(key).not.toBe(id);
  expect(matches.functions[key].similarity).toBe(1);
  expect(regressions(current, budget, reference)).toEqual([]);
  expect(historyRegressions(current, budget, budget, base)).toEqual([]);
  const next = lowerBudget(current, budget, reference);
  expect(next.locations.functions[id]).toBe(key);
  put(root, file, small + small + small + big);
  const again = metrics(root);
  expect(historyRegressions(again, next, next, current)).toEqual([]);
});
it("a fingerprint cannot be redirected to a sub-cap body for a future over-cap replacement", () => {
  const root = repo();
  put(
    root,
    file,
    fn(380, "large") + fn(200, "small").replaceAll("void value;", "void 1234;"),
  );
  const base = metrics(root),
    budget = createBudget(base),
    id = Object.keys(budget.grandfathered.functions)[0],
    next = structuredClone(budget);
  next.locations.functions[id] = file + "#small";
  next.fingerprints.functions[id] = base.bodyHashes[file + "#small"];
  expect(historyRegressions(base, next, budget, base).join("\n")).toContain(
    "Refresh grandfathered content fingerprint",
  );
  // Leaving an unmatched record after deletion must not preserve a future grant.
  put(root, file, fn(200, "small").replaceAll("void value;", "void 1234;"));
  const current = metrics(root);
  expect(historyRegressions(current, next, budget, base).join("\n")).toContain(
    "Retire unmatched or sub-cap",
  );
});
it("runThermite +5 lines is accepted with a reason after its sub-cap record retires", () => {
  const root = repo(),
    path = "packages/cli/src/alpha.ts";
  put(root, path, fn(380, "runThermite"));
  const original = metrics(root),
    budget = createBudget(original);
  put(root, path, fn(52, "runThermite"));
  const base = metrics(root),
    retired = lowerBudget(base, budget, { budget, metrics: original });
  expect(retired.grandfathered.functions).toEqual({});
  save(root, retired);
  const sha = commit(root);
  git(root, "branch", "dev", sha);
  put(root, path, fn(57, "runThermite"));
  const result = run(root, [
    "--accept",
    "--reason",
    "five lines under the normal threshold",
  ]);
  expect(result.status, result.stderr).toBe(0);
});
it("a banked sub-cap outlier can grow again under the ordinary per-item policy", () => {
  const root = repo();
  put(root, file, fn(380));
  const before = metrics(root),
    budget = createBudget(before);
  put(root, file, fn(200));
  const base = metrics(root),
    retired = lowerBudget(base, budget, { budget, metrics: before });
  put(root, file, fn(205));
  const current = metrics(root),
    next = acceptBudget(current, retired, "normal under-cap growth", {
      budget: retired,
      metrics: base,
    });
  expect(next.grandfathered.functions).toEqual({});
  expect(historyRegressions(current, next, retired, base)).toEqual([]);
});
it("a stale index.ts 1369 reason cannot authorize 2869 or a hand-edited 2870 budget", () => {
  const root = repo(),
    path = "packages/cli/src/index.ts";
  put(root, path, "// lines\n".repeat(1334));
  const original = metrics(root),
    first = createBudget(original);
  put(root, path, "// lines\n".repeat(1369));
  const base = metrics(root),
    budget = acceptBudget(base, first, "original extraction", {
      budget: first,
      metrics: original,
    });
  expect(budget.reasons[`files:${path}`]).toEqual({
    identity: `files:${path}`,
    from: 1334,
    to: 1369,
    reason: "original extraction",
  });
  save(root, budget);
  const sha = commit(root);
  git(root, "branch", "dev", sha);
  put(root, path, "// lines\n".repeat(2869));
  const next = structuredClone(budget);
  next.files[path] = 2870;
  save(root, next);
  let result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("1369 -> 2869 (budget 2870)");
  next.files[path] = 2869;
  save(root, next);
  result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("needs exact reason");
  result = run(root, ["--accept", "--reason", "specific second raise"]);
  expect(result.status, result.stderr).toBe(0);
  const current = JSON.parse(
    readFileSync(root + "/scripts/health-budget.json", "utf8"),
  );
  expect(current.reasons[`files:${path}`]).toEqual({
    identity: `files:${path}`,
    from: 1369,
    to: 2869,
    reason: "specific second raise",
  });
});
