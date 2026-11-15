import { expect, it } from "vitest";
import ts from "typescript";
import {
  countTypeAssertions,
  typeAssertionRegressions,
} from "../../../scripts/health-casts.mjs";
import {
  createBudget,
  regressions,
  acceptBudget,
} from "../../../scripts/health-ratchet.mjs";
import {
  repo,
  put,
  metrics,
  save,
  commit,
  git,
  run,
} from "./health-fixture.js";
it("counts as/angle assertions but excludes as const, angle const and satisfies", () => {
  const source = ts.createSourceFile(
    "casts.ts",
    "const a=x as string; const b=<number>x; const c=x as const; const d=<const>x; const e=x satisfies string;",
    ts.ScriptTarget.Latest,
    true,
  );
  expect(source.parseDiagnostics).toEqual([]);
  expect(countTypeAssertions(source).count).toBe(2);
});
it("rejects the C7e cbe6108 substitution: 1008 to 993 non-null, 17 points of false headroom", () => {
  const root = repo(),
    path = "packages/render/src/view-spec.ts";
  const before =
    "declare const input:{value?:string};\n" +
    "void input.value!;\n".repeat(1008);
  put(root, path, before);
  const base = metrics(root),
    budget = createBudget(base);
  budget.ceilings.nonNullAssertions = 1010;
  save(root, budget);
  const sha = commit(root);
  git(root, "branch", "dev", sha);
  const after = before.replace(
    "void input.value!;\n".repeat(15),
    "void (input.value as string);\n".repeat(15),
  );
  put(root, path, after);
  const current = metrics(root),
    reference = { budget, metrics: base };
  expect(base.files[path].nonNullAssertions).toBe(1008);
  expect(current.files[path].nonNullAssertions).toBe(993);
  expect(
    budget.ceilings.nonNullAssertions - current.files[path].nonNullAssertions,
  ).toBe(17);
  expect(regressions(current, budget, reference)).toEqual([
    expect.stringContaining("Type assertion allowance requires exact reason"),
  ]);
  expect(() =>
    acceptBudget(current, budget, "not an implicit cast allowance", reference),
  ).toThrow("Type assertion");
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("0 -> 15");
  expect(result.stderr).not.toMatch(/Cannot parse|compile error/i);
});
it("requires an exact per-file cast allowance and preserves every earlier reason", () => {
  const root = repo(),
    path = "packages/example/src/cast.ts",
    id = "typeAssertions:" + path;
  put(root, path, "declare const x:unknown; void x;");
  const base = metrics(root),
    budget = createBudget(base);
  put(root, path, "declare const x:unknown; void (x as string);");
  const current = metrics(root),
    reference = { budget, metrics: base };
  expect(typeAssertionRegressions(current, budget, reference)).toHaveLength(1);
  budget.reasons[id] = [
    {
      identity: id,
      from: 0,
      to: 1,
      reason: "Reviewed narrowing after an explicit guard",
    },
  ];
  expect(typeAssertionRegressions(current, budget, reference)).toEqual([]);
  budget.reasons[id][0].to = 2;
  expect(typeAssertionRegressions(current, budget, reference)).toHaveLength(1);
});
