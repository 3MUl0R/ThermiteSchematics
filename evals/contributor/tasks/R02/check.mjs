import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../../agent/snapshot.mjs";
import { write } from "../../../agent/task-support.mjs";
import {
  bun,
  contributorState,
  focus,
  ordering,
  ownInstall,
  regularInside,
  reported,
  sourceChanges,
} from "../support.mjs";
import { completedWorkflow, observedCommands } from "../receipts.mjs";

const neighbor = "packages/query/test/inspect.test.ts";
// Run the observation in a fresh process. The module is never imported in the
// evaluator process and the independent tests stay outside the checkout.
const hidden = `
import assert from "node:assert/strict";
import { compareAlias } from "./packages/query/dist/ordering.js";
const aliases = ["a", "Z", "A.2", "", "A.10", "A", "A"];
assert.deepEqual(aliases.sort(compareAlias), ["", "A", "A", "A.10", "A.2", "Z", "a"]);
assert(compareAlias("Z", "A") > 0);
assert.equal(compareAlias("A", "A"), 0);
`;

export default function check(ctx) {
  const repository = join(realpathSync(ctx.project), "engine");
  const { revision, cleanSource } = contributorState(ctx);
  const changes = sourceChanges(ctx, repository, revision);
  const checks = {
    confined: changes.length === 1 && changes[0] === ordering,
    originalBehavior:
      regularInside(repository, ordering) &&
      sha256(readFileSync(join(repository, ordering))) === cleanSource,
    ownInstall: ownInstall(repository),
    report: reported(ctx),
    ...completedWorkflow(observedCommands(ctx, repository), repository),
  };
  if (!Object.values(checks).every(Boolean)) return { pass: false, checks };
  const focused = bun(ctx, repository, "scripts/test.mjs", focus, neighbor);
  const builtQuery = bun(ctx, repository, "-e", hidden);
  checks.independentFocused = focused.exit === 0;
  checks.hidden = builtQuery.exit === 0;
  write(join(ctx.evidence, "contributor-check.json"), { focused, builtQuery });
  return { pass: Object.values(checks).every(Boolean), checks };
}
