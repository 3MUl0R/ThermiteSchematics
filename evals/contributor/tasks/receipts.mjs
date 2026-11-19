import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  contributorBuildOutputs,
  testResult,
} from "../../agent/contributor-bun.mjs";
import { transcriptInvocations } from "./direct-commands.mjs";
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

function passedFocus(tests, repository) {
  return (
    tests?.total > 0 &&
    tests.total === tests.passed &&
    tests.failed === 0 &&
    tests.files.length === 1 &&
    resolve(tests.files[0]) === join(repository, focus)
  );
}

function sameFile(current, observed) {
  return (
    observed?.file === current.file &&
    observed.sha256 === current.sha256 &&
    observed.input?.sha256 === current.input.sha256
  );
}

function matchingFreshBuilds(rows, outputs) {
  const builds = rows.filter((r) => r.kind === "build" && r.exit === 0);
  // Check each artifact's origin, then bind the current inputs and bytes to
  // the observed build. Incremental builds can retain outputs.
  const fresh = outputs.every(
    (file) =>
      file.sha256 &&
      file.input.sha256 &&
      builds.some((build) =>
        build.outputs.some(
          (old) => old.modified >= build.started - 1 && sameFile(file, old),
        ),
      ),
  );
  return fresh
    ? builds.filter(({ outputs: observed }) =>
        outputs.every((file) => observed.some((old) => sameFile(file, old))),
      )
    : [];
}

function observedWorkflow(rows, builds, repository, queryRepair) {
  const tests = rows.filter(
    (r) =>
      r.kind === "focused" && r.exit === 0 && passedFocus(r.tests, repository),
  );
  return {
    focused: tests.length > 0,
    installed: tests.some((test) => installedBefore(rows, test.started)),
    freshBuild: tests.some((test) =>
      builds.some((build) => queryRepair || build.started >= test.ended),
    ),
  };
}

const installedBefore = (rows, time) =>
  rows.some(
    (row) => row.kind === "install" && row.exit === 0 && row.ended <= time,
  );

function directWorkflow(ctx, repository, rows, outputs, builds, queryRepair) {
  const invocations = transcriptInvocations(ctx, repository);
  if (!invocations.some(({ direct }) => direct)) return {};
  const start = statSync(join(ctx.evidence, "contributor-seed.json")).mtimeMs;
  const timing = join(repository, "coverage/test-timings.json");
  if (!passedFocus(testResult(timing), repository)) return {};
  const testedAt = statSync(timing).mtimeMs;
  if (testedAt < start) return {};
  const testIndex = invocations.findLastIndex(({ kind }) => kind === "focused");
  if (testIndex < 0) return {};
  const buildInvocations = queryRepair
    ? invocations
    : invocations.slice(testIndex + 1);
  const directBuild = buildInvocations.some(
    ({ kind, direct }) => direct && kind === "build",
  );
  return {
    focused: invocations[testIndex].direct,
    installed:
      installedBefore(rows, testedAt) ||
      invocations
        .slice(0, testIndex)
        .some(({ kind, direct }) => direct && kind === "install"),
    freshBuild:
      builds.some(({ started }) => queryRepair || started >= testedAt - 1) ||
      (directBuild &&
        outputs.every(
          (file) =>
            file.sha256 &&
            file.input.sha256 &&
            file.modified >= Math.max(start, file.input.modified) - 1,
        )),
  };
}

export function completedWorkflow(
  ctx,
  repository,
  { install = false, queryRepair = false } = {},
) {
  // The implementation-only repair is verified by executing the current CLI.
  // Its declaration and downstream CLI JS can remain unchanged across builds.
  const outputs = contributorBuildOutputs(repository).filter(
    ({ file }) => !queryRepair || file === "packages/query/dist/ordering.js",
  );
  const rows = observedCommands(ctx, repository);
  const builds = matchingFreshBuilds(rows, outputs);
  // R01 exercises the sequence. R02 may build before the focused test so
  // long as its artifact is tied to the delivered repair.
  const observed = observedWorkflow(rows, builds, repository, queryRepair);
  const direct = directWorkflow(
    ctx,
    repository,
    rows,
    outputs,
    builds,
    queryRepair,
  );
  return {
    ...(install && { installed: observed.installed || !!direct.installed }),
    focused: observed.focused || !!direct.focused,
    freshBuild: observed.freshBuild || !!direct.freshBuild,
  };
}
