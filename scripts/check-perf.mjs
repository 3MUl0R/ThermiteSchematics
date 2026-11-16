import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  comparison,
  machineClass,
  measurePair,
  operations,
  startWorker,
  workloads,
} from "./perf-gate/measure.mjs";

export const baselineRevision = "fac3c432dcc7ae63014fa1a5d1f7df2842b9d8b5";
const root = fileURLToPath(new URL("../", import.meta.url));
const git = (directory, ...args) =>
  execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
const write = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
export function validateBaseline(baseline, machine) {
  assert.equal(baseline.format, "thermite-perf-baseline/1");
  assert.equal(baseline.revision, baselineRevision);
  assert.deepEqual(
    baseline.machine,
    machine,
    "Use the pinned baseline's machine class",
  );
  assert.equal(baseline.measurement.warmup, 1);
  assert(baseline.measurement.samples >= 3);
  assert.equal(baseline.measurement.rows.length, 4);
  for (const [name, views] of Object.entries(workloads)) {
    for (const operation of operations) {
      const rows = baseline.measurement.rows.filter(
        (r) => r.name === name && r.operation === operation,
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].views, views);
      comparison(rows[0].baseMedianMs, rows[0].headMedianMs);
    }
  }
}
function verifyBase(directory) {
  assert.equal(git(directory, "rev-parse", "HEAD"), baselineRevision);
  assert.equal(
    git(
      directory,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      "packages",
      "examples",
      "bun.lock",
      "package.json",
    ),
    "",
    "Baseline source must be clean; rebuild it before measuring",
  );
}
async function pair(basePath, headPath, samples) {
  const base = startWorker(basePath);
  const head = startWorker(headPath);
  try {
    return await measurePair(base, head, samples);
  } finally {
    base.close();
    head.close();
  }
}
function options() {
  const { values } = parseArgs({
    options: {
      "base-engine": { type: "string" },
      "head-engine": { type: "string", default: root },
      baseline: {
        type: "string",
        default: join(root, "scripts/perf-baseline.json"),
      },
      samples: { type: "string", default: "5" },
      output: { type: "string" },
      "self-check": { type: "string" },
      "record-baseline": { type: "string" },
    },
  });
  const samples = Number(values.samples);
  assert(Number.isInteger(samples) && samples >= 3 && samples <= 100);
  const repetitions = values["self-check"] ? Number(values["self-check"]) : 1;
  assert(
    Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 100,
  );
  assert(!(values["record-baseline"] && values["self-check"]));
  return { values, samples, repetitions };
}
function prepareBase(values, headPath, resource) {
  if (values["record-baseline"] || values["self-check"]) {
    resource.basePath = headPath;
    if (values["record-baseline"]) verifyBase(headPath);
  } else if (values["base-engine"]) {
    resource.basePath = realpathSync(resolve(values["base-engine"]));
    verifyBase(resource.basePath);
  } else {
    resource.temporary = mkdtempSync(
      join(realpathSync(tmpdir()), "thermite-perf-"),
    );
    resource.basePath = join(resource.temporary, "base");
    git(
      root,
      "worktree",
      "add",
      "--detach",
      resource.basePath,
      baselineRevision,
    );
    resource.added = true;
    for (const args of [
      ["install", "--frozen-lockfile"],
      ["run", "build"],
    ])
      execFileSync(process.execPath, args, {
        cwd: resource.basePath,
        stdio: ["ignore", "ignore", "inherit"],
        timeout: 120000,
      });
    verifyBase(resource.basePath);
  }
}
function printComparison(result, baseline, iteration) {
  for (const row of result.rows) {
    const pinned = baseline?.measurement.rows.find(
      (r) => r.name === row.name && r.operation === row.operation,
    );
    console.log(
      `${iteration + 1} ${row.name} ${row.operation}: base ${row.baseMedianMs.toFixed(2)} ms, head ${row.headMedianMs.toFixed(2)} ms, ${((row.ratio - 1) * 100).toFixed(1)}% ${row.pass ? "PASS" : "FAIL"}${pinned ? ` (pinned ${pinned.baseMedianMs.toFixed(2)} ms)` : ""}`,
    );
  }
}
function finish(report, values, repetitions, started) {
  report.loadAfter = loadavg();
  report.elapsedMs = performance.now() - started;
  report.failedComparisons = report.comparisons.filter((r) => !r.pass).length;
  report.pass = report.failedComparisons === 0;
  if (values["self-check"])
    report.falsePositiveRate = report.failedComparisons / repetitions;
  if (values.output) write(values.output, report);
  if (values["record-baseline"]) {
    assert(
      report.pass,
      "Baseline self-comparison unstable; retain evidence and retry under quieter load",
    );
    write(values["record-baseline"], {
      format: "thermite-perf-baseline/1",
      revision: baselineRevision,
      createdAt: report.createdAt,
      machine: report.machine,
      loadBefore: report.loadBefore,
      loadAfter: report.loadAfter,
      measurement: report.comparisons[0],
    });
  }
  console.log(
    `${report.mode}: ${report.failedComparisons}/${repetitions} failed; ${(report.elapsedMs / 1000).toFixed(1)} s; load ${report.loadBefore.join("/")} -> ${report.loadAfter.join("/")}`,
  );
  if (!report.pass) process.exitCode = 1;
}
async function main() {
  const started = performance.now();
  const { values, samples, repetitions } = options();
  const headPath = realpathSync(resolve(values["head-engine"]));
  const machine = machineClass();
  const baseline = values["record-baseline"]
    ? null
    : JSON.parse(readFileSync(values.baseline));
  if (baseline) validateBaseline(baseline, machine);
  const report = {
    format: "thermite-perf-gate/1",
    mode: values["record-baseline"]
      ? "baseline"
      : values["self-check"]
        ? "head-vs-head"
        : "gate",
    createdAt: new Date().toISOString(),
    machine,
    loadBefore: loadavg(),
    headRevision: git(headPath, "rev-parse", "HEAD"),
    headStatus: git(headPath, "status", "--porcelain"),
    baselineRevision,
    thresholdRatio: 1.2,
    comparisons: [],
  };
  const resource = {};
  try {
    prepareBase(values, headPath, resource);
    for (let iteration = 0; iteration < repetitions; iteration++) {
      const result = await pair(resource.basePath, headPath, samples);
      report.comparisons.push(result);
      printComparison(result, baseline, iteration);
    }
    finish(report, values, repetitions, started);
  } finally {
    if (resource.temporary) {
      if (resource.added)
        git(root, "worktree", "remove", "--force", resource.basePath);
      rmSync(resource.temporary, { recursive: true, force: true });
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
