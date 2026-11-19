import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const outputs = [
  ["packages/cli/dist/alpha.js", "packages/cli/src/alpha.ts"],
  ["packages/query/dist/ordering.js", "packages/query/src/ordering.ts"],
  ["packages/query/dist/ordering.d.ts", "packages/query/src/ordering.ts"],
];

function fileEvidence(checkout, file) {
  const path = join(checkout, file);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || realpathSync(path) !== path) return { file };
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
    argv.length === 2 &&
    resolve(cwd, argv[0]) === join(cwd, "scripts/test.mjs") &&
    resolve(cwd, argv[1]) === join(cwd, focused)
  )
    return { cwd, argv: ["scripts/test.mjs", focused], kind: "focused" };
  return { cwd };
}

function observe(argv) {
  const config = JSON.parse(
    readFileSync(new URL("./contributor.json", import.meta.url), "utf8"),
  );
  const invocation = contributorInvocation(
    argv,
    realpathSync(process.cwd()),
    config.focused,
  );
  const { cwd, kind } = invocation.cwd === config.checkout ? invocation : {};
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
