import { expect, it } from "vitest";
import { createBudget } from "../../../scripts/health-ratchet.mjs";
import { upgradeBudget } from "../../../scripts/health-budget.mjs";
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
  const root = repo();
  put(root, e2Path, fn(120, "existing"));
  const budget = createBudget(metrics(root));
  save(root, budget);
  git(root, "branch", "dev", commit(root));
  put(root, e2Path, fn(140, "existing"));
  const tampered = structuredClone(budget);
  delete tampered.scopes;
  delete tampered.functions[`${e2Path}#existing`];
  save(root, tampered);
  git(root, "add", "-A");
  const result = run(root);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(
    `${e2Path}#existing: function lines 120 -> 140`,
  );
});
