import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { contributorBuildOutputs } from "../../agent/contributor-bun.mjs";
import { focus } from "./support.mjs";

export function observedCommands(ctx, repository) {
  const log = join(ctx.evidence, "contributor-commands.jsonl");
  const rows = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
  return rows.filter((r) => r.cwd === repository);
}

const invoked = (row, kind, ...argv) =>
  row.kind === kind &&
  row.exit === 0 &&
  JSON.stringify(row.argv) === JSON.stringify(argv);

export function completedWorkflow(rows, repository, { install = false } = {}) {
  const test = rows.find(
    (r) =>
      invoked(r, "focused", "scripts/test.mjs", focus) &&
      r.tests?.total > 0 &&
      r.tests.total === r.tests.passed &&
      r.tests.failed === 0 &&
      r.tests.files.length === 1 &&
      resolve(r.tests.files[0]) === join(repository, focus),
  );
  const outputs = contributorBuildOutputs(repository);
  const matchingBuilds = rows.filter(
    (r) =>
      invoked(r, "build", "run", "build") &&
      JSON.stringify(r.outputs) === JSON.stringify(outputs),
  );
  // A successful incremental rebuild can retain bytes and timestamps from an
  // earlier observed build in the same checkout. Require a measured origin
  // for those artifacts and an actual rebuild after the focused test.
  const fresh = matchingBuilds.some((r) =>
    outputs.every((file) => file.sha256 && file.modified >= r.started - 1),
  );
  const built =
    test && fresh && matchingBuilds.some((r) => r.started >= test.ended);
  return {
    ...(install && {
      installed:
        !!test &&
        rows.some(
          (r) =>
            invoked(r, "install", "install", "--frozen-lockfile") &&
            r.ended <= test.started,
        ),
    }),
    focused: !!test,
    freshBuild: !!built,
  };
}
