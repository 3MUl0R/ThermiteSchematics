#!/usr/bin/env bun
// Read-only checker/scorer replay for archived completed E2 runs.
// Does not run agents or judges and never writes to the archive or checkouts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyConfinedTree, projectReader } from "./capture-files.mjs";
import { phaseConveyorCalls } from "./conveyor-measurement.mjs";
import { sha256 } from "./snapshot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultCheckerRoot = resolve(here, "../..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const saveJson = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const loadModule = (root, file) =>
  import(pathToFileURL(join(root, "evals/agent", file)).href);

function gitRevision(root) {
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function assertFreeDisk(path, minFreeGiB) {
  if (!minFreeGiB || minFreeGiB <= 0 || process.platform === "win32") return;
  const line = spawnSync("df", ["-k", path], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .at(-1)
    .trim()
    .split(/\s+/);
  const availKiB = Number(line[3]);
  assert(
    Number.isFinite(availKiB) && availKiB >= minFreeGiB * 1024 * 1024,
    `Free disk below ${minFreeGiB} GiB`,
  );
}

function digestTree(dir) {
  const results = {};
  if (!existsSync(dir)) return results;
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else results[relative(dir, full)] = sha256(readFileSync(full));
    }
  };
  walk(dir);
  return results;
}

function resolveFuturePath(target) {
  let current = resolve(target);
  const tail = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync(current) : current;
  return tail.length ? join(base, ...tail) : base;
}

function pathsOverlap(a, b) {
  const relAB = relative(a, b);
  const relBA = relative(b, a);
  return (
    relAB === "" ||
    (!relAB.startsWith("..") && !isAbsolute(relAB)) ||
    relBA === "" ||
    (!relBA.startsWith("..") && !isAbsolute(relBA))
  );
}

function discoverRuns(archiveDir, selected) {
  const entries = readdirSync(archiveDir)
    .sort()
    .filter((name) => {
      const dir = join(archiveDir, name);
      if (!statSync(dir).isDirectory()) return false;
      return readdirSync(dir).some(
        (sub) =>
          /^attempt-\d+$/.test(sub) &&
          existsSync(join(dir, sub, "manifest.json")),
      );
    });
  if (!selected?.length) return entries;
  const resolved = selected.map((prefix) => {
    assert(
      typeof prefix === "string" && prefix.trim().length > 0,
      "Run selector must be a non-empty string.",
    );
    const exact = entries.filter((name) => name === prefix);
    if (exact.length === 1) return exact[0];
    const matches = entries.filter((name) => name.startsWith(prefix + "-"));
    assert(matches.length > 0, `Archived run not found for ${prefix}`);
    assert(
      matches.length === 1,
      `Ambiguous run prefix ${prefix}: matches ${matches.join(", ")}`,
    );
    return matches[0];
  });
  assert.equal(
    new Set(resolved).size,
    resolved.length,
    `Duplicate run selection: ${resolved.join(", ")}`,
  );
  return resolved;
}

function archiveIdentity(archiveDir, selectedDirs) {
  const entries = selectedDirs.map((dirName) => {
    const attemptDir = latestAttemptDir(join(archiveDir, dirName));
    return [dirName, sha256(readFileSync(join(attemptDir, "manifest.json")))];
  });
  return sha256(JSON.stringify(entries));
}

function latestAttemptDir(runDir) {
  const attempts = readdirSync(runDir)
    .filter(
      (name) =>
        /^attempt-\d+$/.test(name) &&
        existsSync(join(runDir, name, "manifest.json")),
    )
    .sort();
  assert(attempts.length > 0, `No archived attempt in ${runDir}`);
  return join(runDir, attempts.at(-1));
}

function readArchivedRun(attemptDir) {
  const manifest = readJson(join(attemptDir, "manifest.json"));
  const recorded = readJson(join(attemptDir, "check.json"));
  const priorScore = readJson(join(attemptDir, "score.json"));
  const initial = readJson(join(attemptDir, "initial.json"));
  const final = readJson(join(attemptDir, "final.json"));
  const log = readFileSync(join(attemptDir, "shim.jsonl"), "utf8");
  if (manifest.logHash)
    assert.equal(sha256(log), manifest.logHash, "Archived audit log hash");
  let calls = log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (manifest.task === "D-conveyor" && manifest.timings?.started != null)
    calls = phaseConveyorCalls(
      calls,
      manifest.timings.started,
      manifest.timings.ended,
    );
  const transcriptPath = join(attemptDir, "transcript.jsonl");
  const transcript = existsSync(transcriptPath)
    ? readFileSync(transcriptPath, "utf8")
    : "";
  const validatePath = join(attemptDir, "validate.stdout");
  const validationDiagnostics = existsSync(validatePath)
    ? readJson(validatePath)
    : [];
  const judgePath = join(attemptDir, "judge-packet.json");
  const sourceDiff = existsSync(judgePath)
    ? (readJson(judgePath).sourceDiff ?? "")
    : JSON.stringify(initial.files ?? {}) === JSON.stringify(final.files ?? {})
      ? ""
      : "changed";
  return {
    manifest,
    recorded,
    priorScore,
    initial,
    final,
    calls,
    transcript,
    validationDiagnostics,
    sourceDiff,
  };
}

function buildScoreArgs({
  archived,
  task,
  project,
  engineDir,
  archiveDir,
  engineRoots,
}) {
  const { manifest, initial, final, calls, transcript, validationDiagnostics } =
    archived;
  const agentsFile = join(project, "AGENTS.md");
  return {
    calls,
    initial,
    final,
    transcript,
    context: manifest.context,
    engineRoots: [
      engineDir,
      join(archiveDir, "context/engine"),
      ...engineRoots,
    ],
    allowedLibraryPaths: task.allowedLibraryPaths,
    guideCopy: task.guideCopy,
    runtimeBefore: manifest.runtimeHash?.before,
    runtimeAfter: manifest.runtimeHash?.after,
    guideBytes: existsSync(agentsFile) ? statSync(agentsFile).size : 0,
    expectedWarnings: task.expectedWarnings,
    actualWarnings: validationDiagnostics.filter(
      (d) => d.severity === "warning",
    ),
    requiredTopics: task.requiredTopics,
    allowedUnused: task.allowedUnused,
    preserveSource: task.preserveSource,
    undocumentedShapes: task.undocumentedShapes,
    wallTimeMs: manifest.timings?.wallTimeMs ?? 0,
  };
}

function summarizeScoring(metrics, priorScore) {
  return {
    failedCalls: metrics.failedCalls,
    failuresByCode: metrics.failuresByCode,
    violations: metrics.violations.map((v) => v.rule),
    sourceReads: metrics.sourceReads,
    attemptedWrites: metrics.attemptedWrites.length,
    thermiteCalls: metrics.thermiteCalls,
    recordedFailedCalls: priorScore.failedCalls,
    recordedViolationRules: (priorScore.violations ?? []).map((v) => v.rule),
    recordedGuideBytes: priorScore.guideBytes,
    replayedGuideBytes: metrics.guideBytes,
  };
}

async function evaluateVersion(options) {
  const { version, root, engineDir, attemptDir, project, scratch } = options;
  const { config, replayOut, archived } = options;
  const { manifest, priorScore, initial, final, calls } = archived;
  const { validationDiagnostics } = archived;
  const task = readJson(
    join(root, "evals/agent/tasks", manifest.task, "task.json"),
  );
  const { score } = await loadModule(root, "score-log.mjs");
  const { evaluateChecker } = await loadModule(root, "checker.mjs");
  const checker = (await loadModule(root, `tasks/${manifest.task}/check.mjs`))
    .default;
  const evidence = join(scratch, version);
  mkdirSync(evidence, { recursive: true });
  try {
    const scoreArgs = buildScoreArgs({ ...options, task });
    const ctx = {
      task,
      project,
      originalProject: project,
      evidence,
      captureEvidence: attemptDir,
      thermite: join(engineDir, "thermite.mjs"),
      calls,
      initial,
      final,
      sourceDiff: archived.sourceDiff,
      validationDiagnostics,
      promptVersion: manifest.taskVersion,
      metrics: score(scoreArgs),
      env: {
        PATH: process.env.PATH,
        TMPDIR: scratch,
        THERMITE_EVAL_BUN_CONFIG: config,
      },
    };
    const outcome = await evaluateChecker(checker, ctx);
    const metrics = score({
      ...scoreArgs,
      taskOutcome: outcome,
      expectedWarnings: outcome.expectedWarnings ?? task.expectedWarnings,
      actualWarnings: outcome.actualWarnings ?? scoreArgs.actualWarnings,
    });
    const scoring = summarizeScoring(metrics, priorScore);
    saveJson(join(replayOut, `${version}-check.json`), outcome);
    saveJson(join(replayOut, `${version}-score.json`), scoring);
    const result = {
      pass: outcome.pass,
      failed: Object.entries(outcome.checks ?? {})
        .filter(([, value]) => !value)
        .map(([key]) => key),
      ...(outcome.error ? { error: outcome.error } : {}),
      scoring,
    };
    if (manifest.task === "D-conveyor")
      result.regenerated = digestTree(join(evidence, "checker-bundle"));
    return { result, outcome };
  } finally {
    rmSync(evidence, { recursive: true, force: true });
  }
}

async function replayOneRun({
  dirName,
  archiveDir,
  engineDir,
  checkerDir,
  outputDir,
  scratch,
  config,
  engineRoots,
}) {
  const attemptDir = latestAttemptDir(join(archiveDir, dirName));
  const archived = readArchivedRun(attemptDir);
  const { manifest, recorded } = archived;
  const project = join(scratch, "project");
  const reader = projectReader(join(attemptDir, "project"));
  try {
    copyConfinedTree(reader, project);
  } finally {
    reader.close();
  }
  const label = `${manifest.task}-${manifest.agent}`;
  const replayOut = join(outputDir, dirName);
  mkdirSync(replayOut, { recursive: true });
  const entry = {
    run: label,
    dir: dirName,
    attempt: manifest.attempt,
    recorded: recorded.pass,
    recordedFailed: Object.entries(recorded.checks ?? {})
      .filter(([, value]) => !value)
      .map(([key]) => key),
    judgement: manifest.judgement,
  };
  try {
    const outcomes = {};
    for (const [version, root] of [
      ["old", engineDir],
      ["new", checkerDir],
    ]) {
      const evaluated = await evaluateVersion({
        version,
        root,
        engineDir,
        archiveDir,
        attemptDir,
        project,
        scratch,
        config,
        replayOut,
        engineRoots,
        archived,
      });
      entry[version] = evaluated.result;
      outcomes[version] = evaluated.outcome;
    }
    if (manifest.task === "D-conveyor") {
      entry.conveyorOutcomeIdentical =
        JSON.stringify(outcomes.old) === JSON.stringify(outcomes.new);
      entry.conveyorBytesIdentical =
        JSON.stringify(entry.old.regenerated) ===
        JSON.stringify(entry.new.regenerated);
    }
    return entry;
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

export async function replayCompleted({
  archiveDir,
  engineDir,
  outputDir,
  checkerDir = defaultCheckerRoot,
  runs = null,
  resume = false,
  minFreeGiB = 15,
  engineRoots = [],
  onRun = null,
}) {
  assert(
    typeof minFreeGiB === "number" &&
      Number.isFinite(minFreeGiB) &&
      minFreeGiB >= 0,
    `Invalid minFreeGiB value: ${minFreeGiB}`,
  );
  const archive = realpathSync(archiveDir);
  const engine = realpathSync(engineDir);
  const checker = realpathSync(checkerDir);
  const destinationPath = resolveFuturePath(outputDir);
  for (const [label, dir] of [
    ["archive", archive],
    ["engine", engine],
    ["checker", checker],
  ]) {
    assert(
      !pathsOverlap(destinationPath, dir),
      `Output directory must not overlap ${label} directory (${dir}).`,
    );
  }
  const selectedDirs = discoverRuns(archive, runs);
  const archiveFingerprint = archiveIdentity(archive, selectedDirs);
  mkdirSync(outputDir, { recursive: true });
  const destination = realpathSync(outputDir);
  const resultsPath = join(destination, "results.json");
  const engineRev = gitRevision(engine);
  const checkerRev = gitRevision(checker);
  const previous =
    resume && existsSync(resultsPath) ? readJson(resultsPath) : null;
  if (previous) {
    assert.equal(previous.engine, engineRev, "Resume engine revision mismatch");
    assert.equal(
      previous.checker,
      checkerRev,
      "Resume checker revision mismatch",
    );
    assert.equal(
      previous.archive,
      archive,
      "Resume archive directory mismatch",
    );
    assert.equal(
      previous.archiveFingerprint,
      archiveFingerprint,
      "Resume archive identity mismatch",
    );
    assert.deepEqual(
      previous.selectedRuns,
      selectedDirs,
      "Resume selected runs mismatch",
    );
  }
  const summary = previous?.summary ?? [];
  const buildPayload = () => ({
    archive,
    archiveFingerprint,
    selectedRuns: selectedDirs,
    engine: engineRev,
    checker: checkerRev,
    errors: {
      old: summary.filter((row) => row.old?.error).length,
      new: summary.filter((row) => row.new?.error).length,
    },
    summary,
  });
  const scratch = mkdtempSync(
    join(realpathSync(tmpdir()), "e2-replay-completed-"),
  );
  const config = join(scratch, "bunfig.toml");
  writeFileSync(config, "env = false\n");
  try {
    for (const dirName of selectedDirs) {
      if (summary.some((row) => row.dir === dirName)) continue;
      assertFreeDisk(scratch, minFreeGiB);
      const entry = await replayOneRun({
        dirName,
        archiveDir: archive,
        engineDir: engine,
        checkerDir: checker,
        outputDir: destination,
        scratch,
        config,
        engineRoots,
      });
      summary.push(entry);
      saveJson(resultsPath, buildPayload());
      onRun?.(entry);
    }
    const payload = buildPayload();
    saveJson(resultsPath, payload);
    return payload;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function parseCliArgs(argv) {
  const positional = [];
  const options = { runs: [], engineRoots: [], resume: false };
  const nextValue = (flag, index) => {
    assert(index + 1 < argv.length, `Missing value for ${flag}`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--resume") options.resume = true;
    else if (arg === "--checker") options.checkerDir = nextValue(arg, i++);
    else if (arg === "--run") options.runs.push(nextValue(arg, i++));
    else if (arg === "--engine-root")
      options.engineRoots.push(nextValue(arg, i++));
    else if (arg === "--min-free-gib") {
      const raw = nextValue(arg, i++);
      const value = raw.trim() === "" ? Number.NaN : Number(raw);
      assert(
        Number.isFinite(value) && value >= 0,
        `Invalid --min-free-gib value: ${raw}`,
      );
      options.minFreeGiB = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else positional.push(arg);
  }
  assert(
    positional.length === 3,
    "Usage: bun evals/agent/replay-completed.mjs <archive-dir> <engine-dir> <output-dir> [--checker <dir>] [--run <prefix>] [--resume] [--engine-root <dir>] [--min-free-gib <n>]",
  );
  return {
    archiveDir: positional[0],
    engineDir: positional[1],
    outputDir: positional[2],
    ...options,
    runs: options.runs.length ? options.runs : null,
  };
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const parsed = parseCliArgs(process.argv.slice(2));
  const payload = await replayCompleted({
    ...parsed,
    onRun(entry) {
      console.log(
        entry.run,
        "recorded",
        entry.recorded,
        "old",
        entry.old.pass,
        entry.old.failed.join(","),
        entry.old.error?.message ? `oldError=${entry.old.error.message}` : "",
        "new",
        entry.new.pass,
        entry.new.failed.join(","),
        entry.new.error?.message ? `newError=${entry.new.error.message}` : "",
        entry.conveyorOutcomeIdentical ?? "",
        entry.conveyorBytesIdentical ?? "",
      );
    },
  });
  console.log(
    `Checker errors: old=${payload.errors.old} new=${payload.errors.new} (runs=${payload.summary.length})`,
  );
  if (payload.errors.old > 0 || payload.errors.new > 0) process.exitCode = 1;
}
