import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import {
  cpSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
const focused = "packages/query/test/views-and-ordering.test.ts";
const source = "packages/query/src/ordering.ts";
export const mutation = {
  before: "export const compareAlias = compareText;",
  after:
    "export const compareAlias = (left: string, right: string) => compareText(right, left);",
};
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
export function ignoreFixtureDependencies(repository) {
  // Linked contributor worktrees share this private exclusion, not engine policy.
  const exclude = resolve(
    repository,
    git(repository, "rev-parse", "--git-path", "info/exclude"),
  );
  appendFileSync(exclude, "\n/node_modules\n");
}
export function dependencyOverlay(runtime, repository) {
  const dependencies = join(repository, "node_modules");
  mkdirSync(dependencies, { recursive: true });
  for (const name of readdirSync(join(runtime, "node_modules"))) {
    if (name.startsWith(".")) continue;
    symlinkSync(
      join(runtime, "node_modules", name),
      join(dependencies, name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  mkdirSync(join(dependencies, ".bin"));
  const metadata = JSON.parse(
    readFileSync(join(runtime, "node_modules/typescript/package.json")),
  );
  const target = pathToFileURL(
    join(runtime, "node_modules/typescript", metadata.bin.tsc),
  ).href;
  writeFileSync(
    join(dependencies, ".bin/tsc"),
    `#!/usr/bin/env bun\nawait import(${JSON.stringify(target)});\n`,
    { mode: 0o755 },
  );
}
export function setup(ctx, seeded = false) {
  assert(
    existsSync(join(ctx.runtime, source)),
    "R tasks require --context source",
  );
  const repository = join(ctx.project, "engine");
  cpSync(ctx.runtime, repository, {
    recursive: true,
    filter: (p) =>
      !["node_modules", "dist", ".git"].includes(basename(p)) &&
      !p.endsWith(".tsbuildinfo") &&
      !basename(p).startsWith("eval-"),
  });
  cpSync(
    join(ctx.runtime, "thermite.real.mjs"),
    join(repository, "thermite.mjs"),
  );
  cpSync(join(repository, "AGENTS.md"), join(ctx.project, "AGENTS.md"));
  // Private cache/bin roots; package contents remain read-only shared input.
  dependencyOverlay(ctx.runtime, repository);
  if (seeded) {
    const path = join(repository, source),
      text = readFileSync(path, "utf8");
    assert(
      text.includes(mutation.before),
      "Seed no longer matches pinned source",
    );
    writeFileSync(path, text.replace(mutation.before, mutation.after));
  }
  git(repository, "init", "--quiet");
  ignoreFixtureDependencies(repository);
  git(repository, "add", ".");
  git(
    repository,
    "-c",
    "user.name=Eval",
    "-c",
    "user.email=eval@invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "Frozen contributor fixture",
  );
  if (seeded) {
    const result = run(repository, ["run", "test", "--", focused]);
    writeFileSync(
      join(ctx.evidence, "contributor-seed-test.json"),
      JSON.stringify(result, null, 2),
    );
    assert.equal(result.exit, 1, "Seeded test must fail before the agent");
    assert(
      (result.stdout + result.stderr).includes("to be less than 0"),
      "Seed must expose alias-order contract failure",
    );
  }
  writeFileSync(
    join(ctx.evidence, "contributor-seed.json"),
    JSON.stringify({ revision: git(repository, "rev-parse", "HEAD"), seeded }),
  );
}
function run(directory, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: directory,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, VITEST_MAX_WORKERS: "2" },
  });
  return {
    exit: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
export async function check(ctx, seeded = false) {
  const repository = join(ctx.project, seeded ? "engine" : "worktree");
  if (!existsSync(repository))
    return { pass: false, checks: { worktree: false } };
  const baseline = JSON.parse(
    readFileSync(join(ctx.evidence, "contributor-seed.json")),
  ).revision;
  const changes = git(repository, "diff", baseline, "--name-only")
    .split("\n")
    .filter(Boolean);
  const testsUnchanged =
    readFileSync(join(repository, focused), "utf8") ===
    readFileSync(join(ctx.runtime, focused), "utf8");
  const checks = {
    sourceScope: changes.every((p) => (seeded ? p === source : false)),
    testsUnchanged,
  };
  if (!seeded)
    checks.worktree =
      git(repository, "rev-parse", "--git-common-dir") !== ".git" &&
      git(
        join(ctx.project, "engine"),
        "worktree",
        "list",
        "--porcelain",
      ).includes(repository);
  // Independent reruns do not trust agent-authored success logs or modified tests.
  if (!testsUnchanged) return { pass: false, checks };
  const focusedResult = run(repository, ["run", "test", "--", focused]);
  const buildResult = run(repository, ["run", "build"]);
  checks.focused = focusedResult.exit === 0;
  checks.build = buildResult.exit === 0;
  if (seeded && checks.build) {
    const { compareAlias } = await import(
      pathToFileURL(join(repository, "packages/query/dist/ordering.js")).href
    );
    checks.regression =
      compareAlias("A", "B") < 0 &&
      compareAlias("B", "A") > 0 &&
      compareAlias("A", "A") === 0;
  }
  if (seeded && !checks.build) checks.regression = false;
  writeFileSync(
    join(ctx.evidence, "contributor-check.json"),
    JSON.stringify({ checks, focusedResult, buildResult }, null, 2),
  );
  return { pass: Object.values(checks).every(Boolean), checks };
}
export function reference(ctx, seeded = false) {
  const repository = join(ctx.project, seeded ? "engine" : "worktree");
  if (!seeded) {
    git(
      join(ctx.project, "engine"),
      "worktree",
      "add",
      "--detach",
      "../worktree",
    );
    symlinkSync(
      join(ctx.project, "engine/node_modules"),
      join(repository, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } else {
    const path = join(repository, source);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(mutation.after, mutation.before),
    );
  }
  const result = run(repository, ["run", "test", "--", focused]);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(run(repository, ["run", "build"]).exit, 0);
  return "Completed focused tests and source build.";
}
