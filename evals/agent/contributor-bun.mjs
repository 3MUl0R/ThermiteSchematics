import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

const outputs = [
  ["packages/cli/dist/alpha.js", "packages/cli/src/alpha.ts"],
  ["packages/query/dist/ordering.js", "packages/query/src/ordering.ts"],
  ["packages/query/dist/ordering.d.ts", "packages/query/src/ordering.ts"],
];

// Bun's component walk can retain Windows 8.3 aliases from TEMP. The
// native filesystem lookup returns the final path that Git also reports.
const windows = process.platform === "win32";
export const contributorRealpath = windows ? realpathSync.native : realpathSync;

export function sameContributorPath(path, expected) {
  return (
    typeof path === "string" &&
    isAbsolute(path) &&
    relative(expected, path) === ""
  );
}

export function matchesContributorPath(path, expected) {
  return (
    sameContributorPath(path, expected) ||
    (windows &&
      typeof path === "string" &&
      isAbsolute(path) &&
      existsSync(path) &&
      sameContributorPath(contributorRealpath(path), expected))
  );
}

function fileEvidence(checkout, file) {
  const path = join(checkout, file);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || !sameContributorPath(contributorRealpath(path), path))
      return { file };
    return {
      file,
      modified: stat.mtimeMs,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { file };
  }
}

export function contributorBuildOutputs(checkout) {
  return outputs.map(([file, source]) => ({
    ...fileEvidence(checkout, file),
    input: fileEvidence(checkout, source),
  }));
}

export function testResult(path) {
  try {
    const { numPassedTests, numTotalTests, numFailedTests, testResults } =
      JSON.parse(readFileSync(path, "utf8"));
    return {
      passed: numPassedTests,
      total: numTotalTests,
      failed: numFailedTests,
      files: testResults.map((test) => test.name),
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

export function contributorInvocation(args, from, focused) {
  const argv = [...args];
  let cwd = from;
  if (argv[0] === "--cwd" && argv.length > 1) {
    cwd = resolve(from, argv[1]);
    argv.splice(0, 2);
  } else if (argv[0]?.startsWith("--cwd=")) {
    cwd = resolve(from, argv.shift().slice("--cwd=".length));
  }
  if (windows && existsSync(cwd)) cwd = contributorRealpath(cwd);
  if (argv.length === 2 && argv[0] === "run" && argv[1] === "build")
    return { cwd, argv, kind: "build" };
  if (
    argv.length === 2 &&
    ["install", "i"].includes(argv[0]) &&
    argv[1] === "--frozen-lockfile"
  )
    return { cwd, argv: ["install", "--frozen-lockfile"], kind: "install" };
  if (argv[0] === "run") argv.shift();
  if (
    argv[0] &&
    matchesContributorPath(resolve(cwd, argv[0]), join(cwd, "scripts/test.mjs"))
  ) {
    const test = argv.findIndex(
      (arg, index) =>
        index > 0 &&
        matchesContributorPath(resolve(cwd, arg), join(cwd, focused)),
    );
    if (test >= 0) {
      argv[0] = "scripts/test.mjs";
      argv[test] = focused;
      return { cwd, argv, kind: "focused" };
    }
  }
  return { cwd };
}

function observe(argv) {
  const config = JSON.parse(
    readFileSync(new URL("./contributor.json", import.meta.url), "utf8"),
  );
  const invocation = contributorInvocation(
    argv,
    contributorRealpath(process.cwd()),
    config.focused,
  );
  const { cwd, kind } = sameContributorPath(invocation.cwd, config.checkout)
    ? invocation
    : {};
  const timing =
    kind === "focused" ? join(cwd, "coverage/test-timings.json") : null;
  if (timing) rmSync(timing, { force: true });
  const inputs =
    kind === "build"
      ? contributorBuildOutputs(cwd).map((file) => file.input.sha256)
      : null;
  const started = Date.now();
  const command = spawnSync(process.execPath, kind ? invocation.argv : argv, {
    ...(kind && { cwd }),
    stdio: "inherit",
    env: timing ? { ...process.env, THERMITE_TEST_TIMINGS: "1" } : process.env,
  });
  if (kind)
    appendFileSync(
      config.log,
      JSON.stringify({
        kind,
        argv: invocation.argv,
        requestedArgv: argv,
        cwd,
        started,
        ended: Date.now(),
        exit: command.status,
        signal: command.signal,
        ...(timing && { tests: testResult(timing) }),
        ...(inputs && {
          outputs: contributorBuildOutputs(cwd).filter(
            ({ input }, index) => input.sha256 === inputs[index],
          ),
        }),
      }) + "\n",
    );
  if (command.error) throw command.error;
  process.exitCode = command.status ?? 1;
}
if (import.meta.main) observe(process.argv.slice(2));
