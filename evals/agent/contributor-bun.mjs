import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const outputs = [
  "packages/cli/dist/alpha.js",
  "packages/query/dist/ordering.js",
  "packages/query/dist/ordering.d.ts",
];

export function contributorBuildOutputs(checkout) {
  return outputs.map((file) => {
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
  });
}

function testResult(path) {
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

function observe(argv) {
  const config = JSON.parse(
    readFileSync(new URL("./contributor.json", import.meta.url), "utf8"),
  );
  const cwd = realpathSync(process.cwd());
  const key = JSON.stringify(argv);
  const kind =
    cwd === config.checkout
      ? new Map([
          [JSON.stringify(["install", "--frozen-lockfile"]), "install"],
          [JSON.stringify(["scripts/test.mjs", config.focused]), "focused"],
          [JSON.stringify(["run", "build"]), "build"],
        ]).get(key)
      : undefined;
  const timing = join(cwd, "coverage/test-timings.json");
  if (kind === "focused") rmSync(timing, { force: true });
  const started = Date.now();
  const command = spawnSync(process.execPath, argv, {
    stdio: "inherit",
    env:
      kind === "focused"
        ? { ...process.env, THERMITE_TEST_TIMINGS: "1" }
        : process.env,
  });
  if (kind)
    appendFileSync(
      config.log,
      JSON.stringify({
        kind,
        argv,
        cwd,
        started,
        ended: Date.now(),
        exit: command.status,
        signal: command.signal,
        ...(kind === "focused" && { tests: testResult(timing) }),
        ...(kind === "build" && { outputs: contributorBuildOutputs(cwd) }),
      }) + "\n",
    );
  if (command.error) throw command.error;
  process.exitCode = command.status ?? 1;
}
if (import.meta.main) observe(process.argv.slice(2));
