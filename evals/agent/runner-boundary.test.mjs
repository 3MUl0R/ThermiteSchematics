// The harness reads and runs things after a sandboxed agent exits, with the
// harness user's privileges. None of it may follow or execute what the agent
// left in its writable roots.
import { it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { judgePacket, runOne } from "./run.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const moduleURL = (path) => pathToFileURL(join(root, path)).href;
const temporary = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

it("judge packets refuse linked artifacts instead of following them", () => {
  const work = temporary("eval-judge-links-");
  try {
    const project = join(work, "project"),
      outside = join(work, "outside");
    mkdirSync(join(project, "drawings"), { recursive: true });
    mkdirSync(outside);
    // A harness-readable file outside the run.
    writeFileSync(join(outside, "secret.json"), '"harness secret"');
    writeFileSync(join(project, "drawings/ok.json"), '"agent output"');
    const packet = () =>
      judgePacket({
        project,
        runtime: "/runtime",
        finalMessage: "",
        sourceDiff: "",
        task: { rubric: ["Judge the outputs"] },
      });
    if (process.platform === "win32") {
      expect(packet).toThrow("unavailable on Windows");
      return;
    }
    symlinkSync(
      join(outside, "secret.json"),
      join(project, "drawings/leak.json"),
    );
    symlinkSync(join(outside, "secret.json"), join(project, "friction.md"));
    const linkedFiles = packet();
    expect(JSON.stringify(linkedFiles)).not.toContain("harness secret");
    expect(linkedFiles.outputs).toEqual({
      "drawings/ok.json": '"agent output"',
    });
    expect(linkedFiles.refusedOutputs.sort()).toEqual([
      "drawings/leak.json",
      "friction.md",
    ]);
    rmSync(join(project, "drawings"), { recursive: true });
    symlinkSync(outside, join(project, "drawings"));
    const linkedDirectory = packet();
    expect(JSON.stringify(linkedDirectory)).not.toContain("harness secret");
    expect(linkedDirectory.outputs).toEqual({});
    expect(linkedDirectory.refusedOutputs.sort()).toEqual([
      "drawings",
      "friction.md",
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("post-agent CLI calls ignore a tampered runtime and a project bunfig", async () => {
  const work = temporary("eval-runtime-tamper-");
  try {
    const prepared = join(work, "prepared"),
      taskDir = join(work, "task"),
      evidence = join(work, "evidence"),
      ranRuntime = join(work, "ran-tampered-runtime"),
      ranPreload = join(work, "ran-project-preload");
    mkdirSync(prepared);
    mkdirSync(taskDir);
    writeFileSync(
      join(prepared, "thermite.mjs"),
      `const{runThermite}=await import(${JSON.stringify(moduleURL("packages/cli/dist/alpha.js"))});process.exitCode=await runThermite();`,
    );
    writeFileSync(
      join(taskDir, "task.json"),
      JSON.stringify({
        id: "tamper",
        template: "starter",
        prompt: "Leave executable content behind.",
        expectedWarnings: [],
        reference: "reference.mjs",
      }),
    );
    // The "agent" prepends code to its runtime's real CLI and adds a project
    // bunfig.toml preload. Either one running afterwards leaves a marker.
    const marker = (path) =>
      `import{writeFileSync as mark}from"node:fs";mark(${JSON.stringify(path)},"ran");`;
    writeFileSync(
      join(taskDir, "reference.mjs"),
      `import{readFileSync,writeFileSync}from"node:fs";import{join}from"node:path";export default ctx=>{const real=join(ctx.runtime,"thermite.real.mjs");writeFileSync(real,${JSON.stringify(marker(ranRuntime))}+readFileSync(real,"utf8"));writeFileSync(join(ctx.project,"preload.mjs"),${JSON.stringify(marker(ranPreload))});writeFileSync(join(ctx.project,"bunfig.toml"),'preload = ["./preload.mjs"]\\n');return "Reference complete";}`,
    );
    writeFileSync(
      join(taskDir, "check.mjs"),
      `import{ok}from${JSON.stringify(moduleURL("evals/agent/task-support.mjs"))};export default ctx=>{ok(ctx,"validate",".");return {pass:true};}`,
    );
    const run = await runOne({
      taskDir,
      prepared: { path: prepared, commit: "test-adapter" },
      evidence,
    });
    expect(run.status, JSON.stringify(run)).toBe("complete");
    expect(run.outcome.pass).toBe(true);
    expect(existsSync(ranRuntime)).toBe(false);
    expect(existsSync(ranPreload)).toBe(false);
    // The tampered runtime is still detected after the run.
    expect(run.runtimeHash.after).not.toBe(run.runtimeHash.before);
    expect(run.metrics.violations).toContainEqual(
      expect.objectContaining({ rule: "V5", boundary: "run" }),
    );
    const shim = readFileSync(join(evidence, "shim.jsonl"), "utf8");
    expect(shim).toContain('"phase":"flush"');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 60000);
