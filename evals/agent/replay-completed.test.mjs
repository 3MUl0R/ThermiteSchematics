import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCliArgs, replayCompleted } from "./replay-completed.mjs";
import { sha256, snapshot } from "./snapshot.mjs";
import { ok, replaceObject, write } from "./task-support.mjs";

const supported = process.platform !== "win32";
const engineDir = resolve(".");
const thermite = join(engineDir, "thermite.mjs");
const replayScript = resolve("evals/agent/replay-completed.mjs");

function createSyntheticRun(
  work,
  archiveDir,
  dirName,
  { task = "T01", agent = "reference" } = {},
) {
  const runDir = join(archiveDir, dirName);
  const attemptDir = join(runDir, "attempt-001");
  const project = join(attemptDir, "project");
  mkdirSync(attemptDir, { recursive: true });
  ok({ project: work, thermite }, "init", project);
  const initial = snapshot(project);
  const ctx = { project, thermite };
  replaceObject(ctx, "PS1", "description", "Pump control supply");
  const viewArgs = ["view", "PS1", "--loads", "-o", "drawings/ps1-loads.pdf"];
  const beforeView = snapshot(project);
  ok(ctx, ...viewArgs);
  const final = snapshot(project);
  const log =
    JSON.stringify({
      phase: "agent",
      exit: 0,
      argv: viewArgs,
      before: beforeView,
      after: final,
    }) + "\n";
  writeFileSync(join(attemptDir, "shim.jsonl"), log);
  writeFileSync(join(attemptDir, "transcript.jsonl"), "");
  write(join(attemptDir, "initial.json"), initial);
  write(join(attemptDir, "final.json"), final);
  write(join(attemptDir, "validate.stdout"), []);
  write(join(attemptDir, "check.json"), {
    pass: true,
    checks: { validates: true, field: true, pdf: true },
  });
  write(join(attemptDir, "score.json"), {
    failedCalls: 0,
    violations: [],
    guideBytes: readFileSync(join(project, "AGENTS.md")).length,
  });
  write(join(attemptDir, "manifest.json"), {
    task,
    taskVersion: "1.0.0",
    agent,
    attempt: 1,
    context: "source",
    judgement: "not-required",
    logHash: sha256(log),
    runtimeHash: { before: "r0", after: "r0" },
    timings: { wallTimeMs: 100 },
  });
  return attemptDir;
}

it("replays a completed archived run into a separate output dir without modifying the archive", async () => {
  if (!supported) return;
  const work = mkdtempSync(join(realpathSync(tmpdir()), "replay-completed-"));
  try {
    const archiveDir = join(work, "archive");
    const outputDir = join(work, "output");
    createSyntheticRun(work, archiveDir, "T01-reference-A-1-synthetic");

    const beforeArchive = snapshot(archiveDir, { documents: false });
    const result = await replayCompleted({
      archiveDir,
      engineDir,
      checkerDir: engineDir,
      outputDir,
      minFreeGiB: 0,
    });
    const afterArchive = snapshot(archiveDir, { documents: false });

    expect(afterArchive).toEqual(beforeArchive);
    expect(result.summary).toHaveLength(1);
    expect(result.errors).toEqual({ old: 0, new: 0 });
    expect(result.summary[0]).toMatchObject({
      run: "T01-reference",
      dir: "T01-reference-A-1-synthetic",
      recorded: true,
      old: { pass: true, failed: [] },
      new: { pass: true, failed: [] },
    });
    expect(existsSync(join(outputDir, "results.json"))).toBe(true);
    expect(
      existsSync(join(outputDir, "T01-reference-A-1-synthetic/new-check.json")),
    ).toBe(true);
    expect(
      existsSync(join(outputDir, "T01-reference-A-1-synthetic/old-score.json")),
    ).toBe(true);

    const resumed = await replayCompleted({
      archiveDir,
      engineDir,
      checkerDir: engineDir,
      outputDir,
      resume: true,
      minFreeGiB: 0,
    });
    expect(resumed.summary).toHaveLength(1);
    expect(snapshot(archiveDir, { documents: false })).toEqual(beforeArchive);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 60000);

it("rejects overlapping output dirs before creating anything and binds resume to archive and selected runs", async () => {
  if (!supported) return;
  const work = mkdtempSync(join(realpathSync(tmpdir()), "replay-guards-"));
  try {
    const archiveDir = join(work, "archive");
    const secondArchiveDir = join(work, "archive-copy");
    const outputDir = join(work, "output");
    createSyntheticRun(work, archiveDir, "T01-alpha-A-1-one", {
      agent: "alpha",
    });
    createSyntheticRun(work, archiveDir, "T01-beta-A-1-two", { agent: "beta" });
    cpSync(archiveDir, secondArchiveDir, { recursive: true });

    const beforeArchive = snapshot(archiveDir, { documents: false });
    const nestedInArchive = join(archiveDir, "nested-out");
    for (const badOut of [
      archiveDir,
      nestedInArchive,
      work,
      engineDir,
      join(engineDir, "evals/out/never-created-replay-test"),
    ]) {
      await expect(
        replayCompleted({
          archiveDir,
          engineDir,
          checkerDir: engineDir,
          outputDir: badOut,
          minFreeGiB: 0,
        }),
      ).rejects.toThrow(/must not overlap/);
    }
    expect(existsSync(nestedInArchive)).toBe(false);
    expect(
      existsSync(join(engineDir, "evals/out/never-created-replay-test")),
    ).toBe(false);
    expect(snapshot(archiveDir, { documents: false })).toEqual(beforeArchive);

    // Ambiguous run prefix must fail before creating outputDir.
    await expect(
      replayCompleted({
        archiveDir,
        engineDir,
        checkerDir: engineDir,
        outputDir,
        runs: ["T01"],
        minFreeGiB: 0,
      }),
    ).rejects.toThrow(/Ambiguous run prefix T01/);
    expect(existsSync(outputDir)).toBe(false);

    // Invalid numeric minFreeGiB must be rejected in both API and CLI parser.
    for (const bad of ["abc", "-1", "", "Infinity"]) {
      expect(() =>
        parseCliArgs([archiveDir, engineDir, outputDir, "--min-free-gib", bad]),
      ).toThrow(/Invalid --min-free-gib/);
    }
    expect(() =>
      parseCliArgs([archiveDir, engineDir, outputDir, "--min-free-gib"]),
    ).toThrow(/Missing value/);
    expect(() =>
      parseCliArgs([archiveDir, engineDir, outputDir, "--unknown"]),
    ).toThrow(/Unknown option/);

    // Run one unambiguous selection, then verify resume rejects different archive or selection.
    const first = await replayCompleted({
      archiveDir,
      engineDir,
      checkerDir: engineDir,
      outputDir,
      runs: ["T01-alpha"],
      minFreeGiB: 0,
    });
    expect(first.selectedRuns).toEqual(["T01-alpha-A-1-one"]);

    await expect(
      replayCompleted({
        archiveDir: secondArchiveDir,
        engineDir,
        checkerDir: engineDir,
        outputDir,
        runs: ["T01-alpha"],
        resume: true,
        minFreeGiB: 0,
      }),
    ).rejects.toThrow(/Resume archive/);

    await expect(
      replayCompleted({
        archiveDir,
        engineDir,
        checkerDir: engineDir,
        outputDir,
        runs: ["T01-beta"],
        resume: true,
        minFreeGiB: 0,
      }),
    ).rejects.toThrow(/Resume (archive identity|selected runs)/);

    const sameResume = await replayCompleted({
      archiveDir,
      engineDir,
      checkerDir: engineDir,
      outputDir,
      runs: ["T01-alpha"],
      resume: true,
      minFreeGiB: 0,
    });
    expect(sameResume.summary).toHaveLength(1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 90000);

it("prints old and new checker-error totals and exits nonzero when any checker error occurs", () => {
  if (!supported) return;
  const work = mkdtempSync(join(realpathSync(tmpdir()), "replay-errors-"));
  try {
    const archiveDir = join(work, "archive");
    const outputDir = join(work, "output");
    const badCheckerDir = join(work, "bad-checker");
    createSyntheticRun(work, archiveDir, "T01-reference-A-1-err");

    // Minimal checker root whose T01 checker throws an error while old checker succeeds.
    mkdirSync(join(badCheckerDir, "evals/agent/tasks/T01"), {
      recursive: true,
    });
    cpSync(
      join(engineDir, "evals/agent/tasks/T01/task.json"),
      join(badCheckerDir, "evals/agent/tasks/T01/task.json"),
    );
    cpSync(
      join(engineDir, "evals/agent/checker.mjs"),
      join(badCheckerDir, "evals/agent/checker.mjs"),
    );
    writeFileSync(
      join(badCheckerDir, "evals/agent/score-log.mjs"),
      `export function score() { return { failedCalls: 0, failuresByCode: {}, violations: [], sourceReads: 0, attemptedWrites: [], thermiteCalls: 0, guideBytes: 0 }; }\n`,
    );
    writeFileSync(
      join(badCheckerDir, "evals/agent/tasks/T01/check.mjs"),
      `export default async function () { throw new Error("synthetic checker boom"); }\n`,
    );

    const run = spawnSync(
      process.execPath,
      [
        replayScript,
        archiveDir,
        engineDir,
        outputDir,
        "--checker",
        badCheckerDir,
        "--min-free-gib",
        "0",
      ],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("newError=synthetic checker boom");
    expect(run.stdout).toContain("Checker errors: old=0 new=1 (runs=1)");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 60000);
