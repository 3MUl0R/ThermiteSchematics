import { expect, it } from "vitest";
import {
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
import { replayCompleted } from "./replay-completed.mjs";
import { sha256, snapshot } from "./snapshot.mjs";
import { ok, replaceObject, write } from "./task-support.mjs";

const supported = process.platform !== "win32";
const engineDir = resolve(".");
const thermite = join(engineDir, "thermite.mjs");

it("replays a completed archived run into a separate output dir without modifying the archive", async () => {
  if (!supported) return;
  const work = mkdtempSync(join(realpathSync(tmpdir()), "replay-completed-"));
  try {
    const archiveDir = join(work, "archive");
    const outputDir = join(work, "output");
    const runDir = join(archiveDir, "T01-reference-A-1-synthetic");
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
      task: "T01",
      taskVersion: "1.0.0",
      agent: "reference",
      attempt: 1,
      context: "source",
      judgement: "not-required",
      logHash: sha256(log),
      runtimeHash: { before: "r0", after: "r0" },
      timings: { wallTimeMs: 100 },
    });

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
