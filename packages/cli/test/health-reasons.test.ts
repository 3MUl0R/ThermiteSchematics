import { expect, it } from "vitest";
import {
  acceptBudget,
  createBudget,
  lowerBudget,
  historyRegressions,
} from "../../../scripts/health-ratchet.mjs";
import {
  migrateReasonLists,
  reasonHistoryRegressions,
} from "../../../scripts/health-reasons.mjs";
import { fn, repo, put, metrics } from "./health-fixture.js";
it("appends successive raises and partial reductions without replacing their reasons", () => {
  const root = repo(),
    path = "packages/example/src/history.ts",
    id = "functions:" + path + "#existing";
  put(root, path, fn(80));
  const base = metrics(root),
    budget = createBudget(base);
  put(root, path, fn(90));
  const ninety = metrics(root),
    first = acceptBudget(ninety, budget, "first", { budget, metrics: base });
  put(root, path, fn(95));
  const second = acceptBudget(metrics(root), first, "second", {
    budget: first,
    metrics: ninety,
  });
  expect(second.reasons[id]).toEqual([
    { identity: id, from: 80, to: 90, reason: "first" },
    { identity: id, from: 90, to: 95, reason: "second" },
  ]);
  put(root, path, fn(93));
  const current = metrics(root),
    next = lowerBudget(current, second, { budget: first, metrics: ninety });
  expect(next.reasons[id]).toEqual([
    ...second.reasons[id],
    { identity: id, from: 90, to: 93, reason: "second" },
  ]);
  expect(historyRegressions(current, next, first, ninety)).toEqual([]);
  const forged = structuredClone(next);
  forged.reasons[id].shift();
  expect(reasonHistoryRegressions(forged, first).join()).toContain(
    "must append",
  );
});
it("migrates v4 single reason records losslessly and leaves arrays idempotent", () => {
  const old = {
    version: 4,
    reasons: {
      item: { identity: "item", from: 70, to: 80, reason: "original" },
    },
  };
  const next = migrateReasonLists(old);
  expect(next).toEqual({ ...old, reasons: { item: [old.reasons.item] } });
  expect(migrateReasonLists(next)).toEqual(next);
  expect(old.reasons.item.reason).toBe("original");
});
