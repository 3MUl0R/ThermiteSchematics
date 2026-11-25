import { expect, it } from "vitest";
import { createBudget } from "../../../scripts/health-ratchet.mjs";
import { upgradeBudget } from "../../../scripts/health-budget.mjs";
import { seedE2Scope } from "../../../scripts/health-e2-scope.mjs";
import {
  repo,
  put,
  metrics,
  save,
  commit,
  git,
  run,
  fn,
} from "./health-fixture.js";

const e2Path = "evals/agent/harness.mjs";
const otherPath = "packages/example/src/other.ts";

function migratedBaseRepo(lines = 120) {
  const root = repo();
  put(root, e2Path, fn(lines, "existing"));
  const budget = createBudget(metrics(root));
  save(root, budget);
  git(root, "branch", "dev", commit(root));
  return { root, budget };
}

it("seeds legacy v4 evals/agent under-ceiling sizes without grandfathering over-cap bodies", () => {
  const root = repo();
  put(root, e2Path, fn(120, "underCap") + fn(310, "overCap"));
  put(root, otherPath, fn(120, "untouched"));
  const base = metrics(root);
  const legacy = createBudget(base);
  delete legacy.scopes;
  delete legacy.functions[`${e2Path}#underCap`];
  delete legacy.grandfathered.functions[`${e2Path}#overCap`];
  delete legacy.locations.functions[`${e2Path}#overCap`];
  delete legacy.fingerprints.functions[`${e2Path}#overCap`];
  delete legacy.functions[`${otherPath}#untouched`];
  const upgraded = upgradeBudget(legacy, base);
  expect(upgraded.scopes).toEqual({ "evals/agent": true });
  expect(upgraded.functions[`${e2Path}#underCap`]).toBe(120);
  expect(upgraded.grandfathered.functions[`${e2Path}#overCap`]).toBeUndefined();
  expect(upgraded.functions[`${e2Path}#overCap`]).toBeUndefined();
  expect(upgraded.functions[`${otherPath}#untouched`]).toBeUndefined();
  expect(upgraded.reasons[`functions:${e2Path}#underCap`]).toEqual([
    expect.objectContaining({
      from: 70,
      to: 120,
      reason: expect.stringContaining("#484"),
    }),
  ]);
});

it("rejects deleting scopes on a PR head to grow an evals/agent function", () => {
  const { root, budget } = migratedBaseRepo(120);
  put(root, e2Path, fn(140, "existing"));
  const tampered = structuredClone(budget);
  delete tampered.scopes;
  delete tampered.functions[`${e2Path}#existing`];
  save(root, tampered);
  git(root, "add", "-A");
  const result = run(root);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("scopes.evals/agent cannot be removed");
  expect(result.stderr).toContain(
    `${e2Path}#existing: function lines threshold 70 -> 140`,
  );
});

it("fails when a head budget removes the evals/agent scope marker even without growth", () => {
  const { root, budget } = migratedBaseRepo(120);
  for (const mutate of [
    (copy: Record<string, unknown>) => delete copy.scopes,
    (copy: Record<string, unknown>) => {
      copy.scopes = {};
    },
  ]) {
    const tampered = structuredClone(budget);
    mutate(tampered);
    save(root, tampered);
    git(root, "add", "-A");
    const result = run(root);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "scopes.evals/agent cannot be removed or reset",
    );
  }
});

it("fails when a head budget resets the evals/agent scope marker to false", () => {
  const { root, budget } = migratedBaseRepo(120);
  const tampered = structuredClone(budget);
  tampered.scopes = { "evals/agent": false };
  expect(seedE2Scope(tampered, metrics(root)).scopes).toEqual({
    "evals/agent": false,
  });
  save(root, tampered);
  git(root, "add", "-A");
  const result = run(root);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("Invalid health budget scopes");
});

it("fails on evals/agent function growth after migration even if head raises its budget", () => {
  const { root, budget } = migratedBaseRepo(120);
  put(root, e2Path, fn(140, "existing"));
  git(root, "add", "-A");
  const unchangedBudget = run(root);
  expect(unchangedBudget.status, unchangedBudget.stderr).toBe(1);
  expect(unchangedBudget.stderr).toContain(
    `${e2Path}#existing: function lines 120 -> 140`,
  );
  const raised = structuredClone(budget);
  raised.functions[`${e2Path}#existing`] = 140;
  save(root, raised);
  git(root, "add", "-A");
  const raisedBudget = run(root);
  expect(raisedBudget.status, raisedBudget.stderr).toBe(1);
  expect(raisedBudget.stderr).toContain(
    `Allowance cannot rise: functions:${e2Path}#existing 120 -> 140`,
  );
});

it("does not run E2 seed migration from working-tree metrics without an authenticated base", () => {
  const root = repo();
  put(root, e2Path, fn(120, "existing"));
  const legacy = createBudget(metrics(root));
  delete legacy.scopes;
  delete legacy.functions[`${e2Path}#existing`];
  save(root, legacy);
  const env = { THERMITE_HEALTH_ALLOW_NO_BASE: "1" };
  const unmigrated = run(root, [], env);
  expect(unmigrated.status, unmigrated.stderr).toBe(1);
  expect(unmigrated.stderr).toContain(
    `${e2Path}#existing: function lines threshold 70 -> 120`,
  );
  save(root, createBudget(metrics(root)));
  expect(run(root, [], env).status).toBe(0);
});
