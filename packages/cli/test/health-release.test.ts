import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createBudget } from "../../../scripts/health-ratchet.mjs";
import { readHistory } from "../../../scripts/health-history.mjs";
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
const path = "packages/cli/src/alpha.ts";
it.each(["dev", "release"])(
  "seeds a missing %s budget from committed base source and rejects a forged ceiling",
  (target) => {
    const root = repo();
    put(root, path, fn(380, "existingDebt"));
    const base = commit(root, "source predates health budgets");
    git(root, "update-ref", `refs/remotes/origin/${target}`, base);
    // The current tree is smaller; seeding from it would incorrectly permit 390.
    put(root, path, fn(350, "existingDebt"));
    const budget = createBudget(metrics(root));
    save(root, budget);
    const env = { GITHUB_BASE_REF: target };
    const history = readHistory(root, env);
    expect(history.budgetSource).toBe("base-source");
    expect(history.target).toBe(target);
    expect(history.budget.grandfathered.functions[`${path}#existingDebt`]).toBe(
      380,
    );
    let result = run(root, [], env);
    expect(result.status, result.stderr).toBe(0);
    budget.ceilings.nonNullAssertions++;
    save(root, budget);
    result = run(root, [], env);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "ceilings.nonNullAssertions cannot rise: 0 -> 1",
    );
  },
);
it.each([false, true])(
  "allows the 52 to 72 to 82 dev chain against release (committed base budget: %s)",
  (hasBudget) => {
    const root = repo();
    put(root, path, fn(52, "runThermite"));
    if (hasBudget) save(root, createBudget(metrics(root)));
    const release = commit(root, "release at 52 lines");
    git(root, "update-ref", "refs/remotes/origin/release", release);
    git(root, "update-ref", "refs/remotes/origin/dev", release);
    if (!hasBudget) save(root, createBudget(metrics(root)));
    for (const size of [72, 82]) {
      put(root, path, fn(size, "runThermite"));
      const accepted = run(
        root,
        ["--accept", "--reason", `reviewed dev growth to ${size}`],
        { GITHUB_BASE_REF: "dev" },
      );
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(run(root, [], { GITHUB_BASE_REF: "dev" }).status).toBe(0);
      const sha = commit(root, `dev at ${size} lines`);
      git(root, "update-ref", "refs/remotes/origin/dev", sha);
    }
    const budget = JSON.parse(
      readFileSync(root + "/scripts/health-budget.json", "utf8"),
    );
    expect(budget.reasons[`functions:${path}#runThermite`]).toMatchObject({
      from: 72,
      to: 82,
    });
    let result = run(root, [], { GITHUB_BASE_REF: "release" });
    expect(result.status, result.stderr).toBe(0);
    put(root, path, fn(77, "runThermite"));
    const lowered = run(root, ["--lower"], { GITHUB_BASE_REF: "dev" });
    expect(lowered.status, lowered.stderr).toBe(0);
    const banked = commit(root, "dev partially lowers to 77 lines");
    git(root, "update-ref", "refs/remotes/origin/dev", banked);
    result = run(root, [], { GITHUB_BASE_REF: "release" });
    expect(result.status, result.stderr).toBe(0);
    put(root, "packages/cli/src/new.ts", fn(301, "brandNew"));
    put(root, "tools/new.py", "# line\n".repeat(3001));
    metrics(root);
    result = run(root, [], { GITHUB_BASE_REF: "release" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "functions ceiling 300 -> 301 (new or unmatched content)",
    );
    expect(result.stderr).toContain(
      "files ceiling 3000 -> 3001 (new or unmatched content)",
    );
  },
);
