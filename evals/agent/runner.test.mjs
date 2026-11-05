import { it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { judgePacket } from "./run.mjs";
import { launchCommand, freshEnvironment, assertIsolation } from "./launch.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const moduleURL = (path) => pathToFileURL(join(root, path)).href;
it("pins both GI launch commands and rejects ancestor instructions and memory", () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "eval-isolation-")));
  try {
    const project = join(work, "project");
    mkdirSync(project);
    const env = freshEnvironment(join(work, "isolated"), {
      PATH: process.env.PATH,
      CODEX_INSTRUCTIONS: "untrusted",
    });
    expect(env.CODEX_INSTRUCTIONS).toBeUndefined();
    expect(assertIsolation(project, env).asserted).toBe(true);
    writeFileSync(join(env.CODEX_HOME, "memory.md"), "old memory");
    expect(() => assertIsolation(project, env)).toThrow(/not fresh/);
    rmSync(join(env.CODEX_HOME, "memory.md"));
    writeFileSync(join(project, "CLAUDE.md"), "@AGENTS.md\n");
    expect(() => assertIsolation(project, env)).toThrow(/Unexpected/);
    expect(assertIsolation(project, env, { claudeLoader: true }).asserted).toBe(
      true,
    );
    rmSync(join(project, "CLAUDE.md"));
    writeFileSync(join(work, "AGENTS.md"), "unexpected");
    expect(() => assertIsolation(project, env)).toThrow(/Ancestor/);
    for (const agent of ["claude", "codex"]) {
      const command = launchCommand({
        agent,
        project,
        runtime: "/runtime",
        prompt: "task",
      });
      expect(command[0]).toBe(agent);
      expect(command).toContain(
        agent === "claude" ? "stream-json" : "--ephemeral",
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
it("reference pipeline rechecks the kept workspace without another agent attempt", async () => {
  const work = realpathSync(
    mkdtempSync(join(tmpdir(), "eval-reference-test-")),
  );
  let kept;
  try {
    const prepared = join(work, "prepared"),
      taskDir = join(work, "task"),
      evidence = join(work, "evidence"),
      ready = join(work, "ready");
    mkdirSync(prepared);
    mkdirSync(taskDir);
    writeFileSync(
      join(prepared, "thermite.mjs"),
      `const{runThermite}=await import(${JSON.stringify(moduleURL("packages/cli/dist/alpha.js"))});process.exitCode=await runThermite();`,
    );
    writeFileSync(
      join(taskDir, "task.json"),
      readFileSync(join(root, "evals/agent/tasks/T01/task.json")),
    );
    writeFileSync(
      join(taskDir, "setup.mjs"),
      `import{setup}from${JSON.stringify(moduleURL("evals/agent/tasks.mjs"))};export default ctx=>setup("T01",ctx);`,
    );
    writeFileSync(
      join(taskDir, "reference.mjs"),
      `import{reference}from${JSON.stringify(moduleURL("evals/agent/tasks.mjs"))};import{readFileSync,existsSync,writeFileSync}from"node:fs";export default ctx=>{const p=ctx.project+"/reference-count";writeFileSync(p,String((existsSync(p)?Number(readFileSync(p,"utf8")):0)+1));process.exitCode=1;return reference("T01",ctx);}`,
    );
    writeFileSync(
      join(taskDir, "check.mjs"),
      `import{check}from${JSON.stringify(moduleURL("evals/agent/tasks.mjs"))};import{CheckerInfrastructureError}from${JSON.stringify(moduleURL("evals/agent/checker.mjs"))};import{existsSync}from"node:fs";export default ctx=>{if(!existsSync(${JSON.stringify(ready)}))throw new CheckerInfrastructureError("renderer unavailable");return check("T01",ctx);}`,
    );
    const { runOne, recheckRun } = await import("./run.mjs");
    const original = await runOne({
      taskDir,
      prepared: { path: prepared, commit: "test-adapter" },
      evidence,
    });
    kept = original.workspace;
    expect(original.exitAfterCompletion).toBe(true);
    expect(original.warnings).toContainEqual({
      code: "exit-after-completion",
      exit: 1,
    });
    expect(original).toMatchObject({
      model: null,
      effort: null,
      modelPin: null,
      modelOverrides: { model: null, effort: null },
    });
    expect(original.runKey).toContain("T01/reference/1/");
    expect(original.status, JSON.stringify(original)).toBe("checker-error");
    const { sha256 } = await import("./snapshot.mjs");
    const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
    expect(original.promptHash).toBe(
      sha256(`Thermite is at {{THERMITE}}.\n\n${task.prompt}`),
    );
    expect(readFileSync(join(kept, "project/reference-count"), "utf8")).toBe(
      "1",
    );
    writeFileSync(ready, "ready");
    writeFileSync(join(taskDir, "changed-context.md"), "Changed checker input");
    const checkFile = join(taskDir, "check.mjs");
    writeFileSync(
      checkFile,
      readFileSync(checkFile, "utf8")
        .replace("export default ctx=>", "export default async ctx=>")
        .replace(
          'return check("T01",ctx);',
          'const result=await check("T01",ctx);return {...result,forcedCode:true};',
        ),
    );

    await expect(recheckRun({ evidence })).rejects.toThrow(
      /Task directory changed/,
    );
    const result = await recheckRun({ evidence, forceRecheck: true });
    expect(result).toMatchObject({
      attempt: 1,
      checkerRechecks: 1,
      status: "complete",
      workspace: null,
      outcome: { pass: true },
    });
    expect(result.metrics.violations).toEqual([]);
    expect(result.usage).toEqual(original.usage);
    expect(result.forceRecheck).toBe(true);
    expect(result.outcome.forcedCode).toBe(true);
    expect(result.checkerTaskTreeHash).not.toBe(original.taskTreeHash);
    expect(result.checkerRecheckHistory[0].forced).toBe(true);
    expect(result.harnessHash).toBe(original.harnessHash);
    expect(
      readFileSync(join(evidence, "project/reference-count"), "utf8"),
    ).toBe("1");
    expect(
      JSON.parse(readFileSync(join(evidence, "checker-history-001.json")))
        .status,
    ).toBe("checker-error");
  } finally {
    if (kept) rmSync(kept, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}, 25000);

it("judge packet removes run identities and includes rubric deliverables", () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "eval-judge-")));
  try {
    mkdirSync(join(work, "drawings"));
    writeFileSync(
      join(work, "requirement-matrix.json"),
      '[{"requirement":"motor"}]',
    );
    const binary = Buffer.from("AA/GPT/A", "base64");
    writeFileSync(join(work, "drawings/provider.pdf"), binary);
    const packet = judgePacket({
      project: work,
      runtime: "/runtime",
      finalMessage:
        "Anthropic OpenAI GPT Claude Opus 4.5 Codex Opus Sonnet Haiku Fable o-series o3-pro o4-mini-high Gemini DeepSeek Grok Llama Qwen Mistral Copilot arm B. PLC output O1 and O2.1, voltage 4.5, model o1, codex sandbox, xhigh, Codex CLI 0.164.0, Claude Code v2.1.280, 2.1.280 (Claude Code), claude --version printed 2.1.280, CLI version 0.164.0, thermite CLI 0.2.0, thermite CLI version 0.2.0",
      sourceDiff: "/runtime/example",
      task: { rubric: ["Preserve unknown facts"] },
    });
    const text = JSON.stringify({
      ...packet,
      outputs: Object.fromEntries(
        Object.entries(packet.outputs).filter(([key]) => !key.endsWith(".pdf")),
      ),
    });
    expect(text).not.toMatch(
      /Anthropic|OpenAI|GPT|Claude|Codex|Opus|Sonnet|Haiku|Fable|o-series|o3-pro|o4-mini|Gemini|DeepSeek|Grok|Llama|Qwen|Mistral|Copilot|arm B|\/runtime/,
    );
    expect(packet.outputs["requirement-matrix.json"]).toBeTruthy();
    expect(packet.finalMessage).toContain("PLC output O1 and O2.1");
    expect(packet.finalMessage).not.toContain("0.164.0");
    expect(packet.finalMessage).toContain("thermite CLI version 0.2.0");
    expect(packet.finalMessage).toContain("sandbox");
    expect(packet.finalMessage).not.toContain("<identity> 4.5");
    expect(packet.finalMessage).not.toContain("-high");
    expect(packet.finalMessage).toContain("voltage 4.5");
    expect(packet.finalMessage).not.toContain("model o1");
    expect(packet.finalMessage).not.toMatch(/xhigh|0\.164\.0|2\.1\.280/);
    expect(packet.finalMessage).toContain("thermite CLI 0.2.0");
    expect(packet).not.toHaveProperty("agent");
    expect(packet.rubric).toHaveLength(1);
    expect(packet.outputs["drawings/provider.pdf"]).toBe(
      binary.toString("base64"),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
