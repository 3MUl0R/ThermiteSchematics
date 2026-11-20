// The harness reads and runs things after a sandboxed agent exits, with the
// harness user's privileges. None of it may follow or execute what the agent
// left in its writable roots.
import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  judgePacket,
  recheckRun,
  runHooks,
  runOne,
  selectedDiff,
} from "./run.mjs";
import { projectReader } from "./capture-files.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const moduleURL = (path) => pathToFileURL(join(root, path)).href;
const temporary = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const confined = ["darwin", "linux"].includes(process.platform);
const packetFor = (project, source) =>
  judgePacket({
    project,
    source,
    runtime: "/runtime",
    finalMessage: "",
    sourceDiff: "",
    task: { rubric: ["Judge the outputs"] },
  });
// A prepared engine that runs the built CLI, and a task directory.
function fixture(work, task, files) {
  const prepared = join(work, "prepared"),
    taskDir = join(work, "task");
  mkdirSync(prepared);
  mkdirSync(taskDir);
  writeFileSync(
    join(prepared, "thermite.mjs"),
    `if(process.env.THERMITE_PROBE_MARKER)(await import("node:fs")).writeFileSync(process.env.THERMITE_PROBE_MARKER,"ran");const{runThermite}=await import(${JSON.stringify(moduleURL("packages/cli/dist/alpha.js"))});process.exitCode=await runThermite();`,
  );
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      template: "starter",
      prompt: "Leave executable content behind.",
      expectedWarnings: [],
      reference: "reference.mjs",
      ...task,
    }),
  );
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(taskDir, name), text);
  return { prepared, taskDir, context: { path: prepared, commit: "test" } };
}
const marker = (path) =>
  `import{writeFileSync as mark}from"node:fs";mark(${JSON.stringify(path)},"ran");`;

it("judge packets refuse linked artifacts and traversal instead of following them", () => {
  const work = temporary("eval-judge-links-");
  try {
    const project = join(work, "project"),
      outside = join(work, "outside");
    mkdirSync(join(project, "drawings"), { recursive: true });
    mkdirSync(outside);
    // A harness-readable file outside the run.
    writeFileSync(join(outside, "secret.json"), '"harness secret"');
    writeFileSync(join(project, "drawings/ok.json"), '"agent output"');
    if (!confined) {
      expect(() => packetFor(project, null)).toThrow("unavailable on Windows");
      return;
    }
    const source = projectReader(project);
    try {
      symlinkSync(
        join(outside, "secret.json"),
        join(project, "drawings/leak.json"),
      );
      symlinkSync(join(outside, "secret.json"), join(project, "friction.md"));
      const linkedFiles = packetFor(project, source);
      expect(JSON.stringify(linkedFiles)).not.toContain("harness secret");
      expect(linkedFiles.outputs).toEqual({
        "drawings/ok.json": '"agent output"',
      });
      expect(linkedFiles.refusedOutputs.sort()).toEqual([
        "drawings/leak.json",
        "friction.md",
      ]);
      // The reader takes no traversal components and lists only directories.
      expect(() => source.read("../outside/secret.json")).toThrow();
      expect(() => source.read("drawings/../friction.md")).toThrow();
      expect(() => source.list("..")).toThrow();
      expect(() => source.list("drawings/ok.json")).toThrow();
      rmSync(join(project, "drawings"), { recursive: true });
      symlinkSync(outside, join(project, "drawings"));
      const linkedDirectory = packetFor(project, source);
      expect(JSON.stringify(linkedDirectory)).not.toContain("harness secret");
      expect(linkedDirectory.outputs).toEqual({});
      expect(linkedDirectory.refusedOutputs.sort()).toEqual([
        "drawings",
        "friction.md",
      ]);
    } finally {
      source.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("judge packets refuse a replaced or unsearchable project root as a whole", () => {
  if (!confined) return;
  const work = temporary("eval-judge-root-");
  const project = join(work, "project"),
    sibling = join(work, "sibling");
  try {
    mkdirSync(join(project, "drawings"), { recursive: true });
    mkdirSync(sibling);
    writeFileSync(join(project, "friction.md"), "agent notes");
    // A harness-readable project with ordinary files, outside the run.
    writeFileSync(join(sibling, "friction.md"), "sibling secret");
    const pinned = projectReader(project);
    try {
      renameSync(project, join(work, "original"));
      symlinkSync(sibling, project);
      const replaced = packetFor(project, pinned);
      expect(JSON.stringify(replaced)).not.toContain("sibling secret");
      expect(replaced.outputs).toEqual({});
      expect(replaced.refusedOutputs).toEqual(["."]);
      unlinkSync(project);
      renameSync(join(work, "original"), project);
      expect(packetFor(project, pinned).outputs).toEqual({
        "friction.md": "agent notes",
      });
      // Readable but not searchable: inspection fails, so nothing is taken.
      if (process.getuid?.() !== 0) {
        chmodSync(project, 0o600);
        const unsearchable = packetFor(project, pinned);
        expect(unsearchable.outputs).toEqual({});
        expect(unsearchable.refusedOutputs).toEqual(["."]);
      }
    } finally {
      chmodSync(project, 0o700);
      pinned.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("source diffs match the repository diff without running its Git configuration", () => {
  const work = temporary("eval-source-diff-");
  try {
    const project = join(work, "project"),
      before = join(work, "before"),
      scratch = join(work, "scratch");
    mkdirSync(project);
    mkdirSync(scratch);
    writeFileSync(join(project, "system.json"), '{"a":1}\n');
    writeFileSync(join(project, "kept.json"), '{"k":1}\n');
    writeFileSync(join(project, "gone.json"), '{"g":1}\n');
    // Names that contain the synthetic old/ and new/ components, need Git's
    // quoting, or hold binary bytes.
    const tricky = [
      "parts a/old/device.json",
      "parts b/new/device.json",
      "naïve.json",
      "blob.pdf",
      "devices/room and /dev/null",
    ];
    const binary = (name) => name === "blob.pdf" || name.endsWith("/dev/null");
    for (const name of tricky) {
      mkdirSync(dirname(join(project, name)), { recursive: true });
      writeFileSync(join(project, name), binary(name) ? "\0a" : "1\n");
    }
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    };
    const git = (...args) =>
      execFileSync("git", args, { cwd: project, env, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("add", ".");
    git(
      "-c",
      "user.name=E",
      "-c",
      "user.email=e@invalid",
      "commit",
      "-qm",
      "x",
    );
    cpSync(project, before, {
      recursive: true,
      filter: (path) => !path.includes(".git"),
    });
    writeFileSync(join(project, "system.json"), '{"a":2}\n');
    writeFileSync(join(project, "added.json"), '{"n":1}\n');
    mkdirSync(join(project, "added and /dev"), { recursive: true });
    writeFileSync(join(project, "added and /dev/null"), "\0n");
    for (const name of tricky)
      writeFileSync(join(project, name), binary(name) ? "\0b" : "2\n");
    const paths = [
      "system.json",
      "kept.json",
      "added.json",
      "added and /dev/null",
      ...tricky,
    ];
    const read = (path) =>
      existsSync(join(project, path))
        ? readFileSync(join(project, path))
        : null;
    git("add", "--intent-to-add", ".");
    const repository = git("diff", "--no-ext-diff", "--", ...paths);
    expect(repository).toContain("diff --git a/added.json b/added.json");
    expect(repository).toContain(
      "--- a/parts a/old/device.json\t\n+++ b/parts a/old/device.json\t",
    );
    expect(repository).toContain('"a/na\\303\\257ve.json"');
    expect(repository).toContain(
      "Binary files a/blob.pdf and b/blob.pdf differ",
    );
    expect(repository).toContain(
      "Binary files a/devices/room and /dev/null and b/devices/room and /dev/null differ",
    );
    expect(repository).toContain(
      "Binary files /dev/null and b/added and /dev/null differ",
    );
    expect(selectedDiff({ before, scratch, paths, read })).toBe(repository);
    // A removed source is shown; staging every path hid it before.
    rmSync(join(project, "gone.json"));
    expect(
      selectedDiff({ before, scratch, paths: ["gone.json"], read }),
    ).toContain("diff --git a/gone.json b/gone.json\ndeleted file mode");
    expect(
      selectedDiff({
        before,
        scratch,
        paths: ["kept.json"],
        read: () => {
          throw new Error("linked");
        },
      }),
    ).toBe("Refused (not an ordinary file): kept.json");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("post-agent calls ignore the agent's runtime, Bun config, .env and Git configuration", async () => {
  if (process.platform === "win32") return;
  const work = temporary("eval-runtime-tamper-");
  try {
    const evidence = join(work, "evidence"),
      ranRuntime = join(work, "ran-tampered-runtime"),
      ranPreload = join(work, "ran-project-preload"),
      ranDotenv = join(work, "ran-project-dotenv"),
      ranGit = join(work, "ran-project-git"),
      diffFile = join(work, "source-diff.txt");
    // The "agent" prepends code to its runtime's real CLI, adds a project
    // bunfig.toml preload and a .env variable the CLI reacts to, configures a
    // Git monitor and text conversion, and edits a source. Anything that runs
    // afterwards leaves a marker.
    const hook = `#!/bin/sh\necho ran >> '${ranGit}'\ncat "$1" 2>/dev/null\n`;
    const { taskDir, context } = fixture(
      work,
      { id: "tamper" },
      {
        "reference.mjs": `import{appendFileSync,chmodSync,readFileSync,writeFileSync}from"node:fs";import{join}from"node:path";export default ctx=>{const real=join(ctx.runtime,"thermite.real.mjs");writeFileSync(real,${JSON.stringify(marker(ranRuntime))}+readFileSync(real,"utf8"));writeFileSync(join(ctx.project,"preload.mjs"),${JSON.stringify(marker(ranPreload))});writeFileSync(join(ctx.project,"bunfig.toml"),'preload = ["./preload.mjs"]\\n');writeFileSync(join(ctx.project,".env"),"THERMITE_PROBE_MARKER="+${JSON.stringify(ranDotenv)}+"\\n");const hook=join(ctx.project,"hook.sh");writeFileSync(hook,${JSON.stringify(hook)});chmodSync(hook,0o755);appendFileSync(join(ctx.project,".git/config"),"[core]\\n\\tfsmonitor = "+hook+"\\n[diff \\"evil\\"]\\n\\ttextconv = "+hook+"\\n");writeFileSync(join(ctx.project,".gitattributes"),"* diff=evil\\n");appendFileSync(join(ctx.project,"system.json"),"\\n");return "Reference complete";}`,
        "check.mjs": `import{writeFileSync}from"node:fs";import{ok}from${JSON.stringify(moduleURL("evals/agent/task-support.mjs"))};export default ctx=>{writeFileSync(${JSON.stringify(diffFile)},ctx.sourceDiff);ok(ctx,"validate",".");return {pass:true};}`,
      },
    );
    const run = await runOne({ taskDir, prepared: context, evidence });
    expect(run.status, JSON.stringify(run)).toBe("complete");
    expect(run.outcome.pass, JSON.stringify(run.outcome)).toBe(true);
    expect(existsSync(ranRuntime)).toBe(false);
    expect(existsSync(ranPreload)).toBe(false);
    expect(existsSync(ranDotenv)).toBe(false);
    expect(existsSync(ranGit)).toBe(false);
    expect(readFileSync(diffFile, "utf8")).toContain(
      "diff --git a/system.json b/system.json",
    );
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

it("rechecks stage receipts outside the run directory and refuse a replaced project", async () => {
  if (!confined) return;
  const work = temporary("eval-recheck-boundary-");
  let kept;
  try {
    const evidence = join(work, "evidence"),
      mode = join(work, "mode");
    // A process the agent left behind writes into the run directory while the
    // checker runs; "forge" stands in for it.
    const { prepared, taskDir, context } = fixture(
      work,
      { id: "recheck-boundary" },
      {
        "reference.mjs": `export default ()=>"Reference complete";`,
        "check.mjs": `import{existsSync,mkdirSync,readFileSync,writeFileSync}from"node:fs";import{dirname,join}from"node:path";import{CheckerInfrastructureError}from${JSON.stringify(moduleURL("evals/agent/checker.mjs"))};export default ctx=>{const mode=existsSync(${JSON.stringify(mode)})?readFileSync(${JSON.stringify(mode)},"utf8"):"";if(mode==="forge"){const staging=join(dirname(ctx.project),"recheck-1");mkdirSync(staging,{recursive:true});writeFileSync(join(staging,"recheck.json"),JSON.stringify({forged:true}));}if(mode!=="ready")throw new CheckerInfrastructureError("checker unavailable");return {pass:true};}`,
      },
    );
    const original = await runOne({ taskDir, prepared: context, evidence });
    kept = original.workspace;
    expect(original.status, JSON.stringify(original)).toBe("checker-error");
    writeFileSync(mode, "forge");
    const forged = await recheckRun({ evidence, prepared: context });
    expect(forged.status).toBe("checker-error");
    expect(readFileSync(join(evidence, "recheck.json"), "utf8")).not.toContain(
      "forged",
    );
    // A failed recheck leaves nothing behind that blocks the next one.
    writeFileSync(mode, "ready");
    renameSync(prepared, prepared + ".away");
    await expect(recheckRun({ evidence, prepared: context })).rejects.toThrow();
    renameSync(prepared + ".away", prepared);
    // A copy of the project at the same path is a different root.
    const project = join(kept, "project");
    renameSync(project, project + ".original");
    cpSync(project + ".original", project, { recursive: true });
    await expect(recheckRun({ evidence, prepared: context })).rejects.toThrow(
      "Project root was replaced",
    );
    rmSync(project, { recursive: true, force: true });
    renameSync(project + ".original", project);
    const result = await recheckRun({ evidence, prepared: context });
    expect(result.status, JSON.stringify(result)).toBe("complete");
    expect(result.checkerRechecks).toBe(2);
  } finally {
    if (kept) rmSync(kept, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}, 60000);

it("run diffs cover removed library documents and a source replaced by a directory", async () => {
  if (!confined) return;
  const work = temporary("eval-diff-selection-");
  try {
    const diffFile = join(work, "source-diff.txt");
    // The "agent" removes a library type, and moves a source below a
    // directory of the same name, selecting it in the manifest.
    const { taskDir, context } = fixture(
      work,
      { id: "diff-selection" },
      {
        "reference.mjs": `import{mkdirSync,readFileSync,rmSync,writeFileSync}from"node:fs";import{join}from"node:path";export default ctx=>{const p=(f)=>join(ctx.project,f);rmSync(p("libraries/core/types/relay-1co.json"));const old=readFileSync(p("devices/equipment.json"));rmSync(p("devices/equipment.json"));mkdirSync(p("devices/equipment.json"));writeFileSync(p("devices/equipment.json/member.json"),old);const system=JSON.parse(readFileSync(p("system.json"),"utf8"));system.sources=system.sources.map(s=>s==="devices/equipment.json"?"devices/equipment.json/member.json":s);writeFileSync(p("system.json"),JSON.stringify(system,null,2)+"\\n");return "Reference complete";}`,
        "check.mjs": `import{writeFileSync}from"node:fs";export default ctx=>{writeFileSync(${JSON.stringify(diffFile)},ctx.sourceDiff);return {pass:true};}`,
      },
    );
    const run = await runOne({
      taskDir,
      prepared: context,
      evidence: join(work, "evidence"),
    });
    expect(run.status, JSON.stringify(run)).toBe("complete");
    const diff = readFileSync(diffFile, "utf8");
    for (const [path, change] of [
      ["libraries/core/types/relay-1co.json", "deleted"],
      ["devices/equipment.json", "deleted"],
      ["devices/equipment.json/member.json", "new"],
    ])
      expect(diff).toContain(
        `diff --git a/${path} b/${path}\n${change} file mode`,
      );
    expect(diff).not.toContain("Refused");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 60000);

it("a source below a linked directory is refused, not diffed as deleted", async () => {
  if (!confined) return;
  const work = temporary("eval-linked-parent-");
  try {
    const diffFile = join(work, "source-diff.txt");
    // The "agent" links the library's types directory to a project directory
    // where relay-1co.json is itself a directory.
    const { taskDir, context } = fixture(
      work,
      { id: "linked-parent" },
      {
        "reference.mjs": `import{mkdirSync,renameSync,symlinkSync}from"node:fs";import{join}from"node:path";export default ctx=>{const p=(f)=>join(ctx.project,f);mkdirSync(p("elsewhere/relay-1co.json"),{recursive:true});renameSync(p("libraries/core/types"),p("types-moved"));symlinkSync(p("elsewhere"),p("libraries/core/types"));return "Reference complete";}`,
        "check.mjs": `import{writeFileSync}from"node:fs";export default ctx=>{writeFileSync(${JSON.stringify(diffFile)},ctx.sourceDiff);return {pass:true};}`,
      },
    );
    const run = await runOne({
      taskDir,
      prepared: context,
      evidence: join(work, "evidence"),
    });
    expect(run.status, JSON.stringify(run)).toBe("complete");
    const diff = readFileSync(diffFile, "utf8");
    expect(diff).toContain(
      "Refused (not an ordinary file): libraries/core/types/relay-1co.json",
    );
    expect(diff).not.toContain("diff --git a/libraries/core/types/");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 60000);

it.each([
  ["absent", false],
  ["a regular file", true],
])(
  "a run whose project root is gone (%s at its path) still records the whole-root refusal",
  async (label, occupied) => {
    if (!confined) return;
    const work = temporary("eval-missing-root-");
    try {
      const evidence = join(work, "evidence");
      const { taskDir, context } = fixture(
        work,
        { id: "missing-root", rubric: ["Judge the outputs"] },
        {
          "reference.mjs": `import{renameSync,writeFileSync}from"node:fs";export default ctx=>{writeFileSync(ctx.project+"/friction.md","moved notes");renameSync(ctx.project,ctx.project+".gone");if(${JSON.stringify(occupied)})writeFileSync(ctx.project,"a file now");return "Reference complete";}`,
          "check.mjs": `export default ()=>({pass:true});`,
        },
      );
      const run = await runOne({ taskDir, prepared: context, evidence });
      expect(run.status).toBe("infrastructure-failure");
      const packet = JSON.parse(
        readFileSync(join(evidence, "judge-packet.json"), "utf8"),
      );
      expect(packet.outputs).toEqual({});
      expect(packet.refusedOutputs).toEqual(["."]);
      expect(JSON.stringify(packet)).not.toContain("moved notes");
      expect(run.infrastructureError).toContain("Project root is missing");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  60000,
);

it("a run whose project root was replaced records the whole-root refusal", async () => {
  if (!confined) return;
  const work = temporary("eval-replaced-root-");
  try {
    const evidence = join(work, "evidence");
    // The "agent" swaps its project for an identical copy at the same path.
    const { taskDir, context } = fixture(
      work,
      { id: "replaced-root", rubric: ["Judge the outputs"] },
      {
        "reference.mjs": `import{cpSync,renameSync,writeFileSync}from"node:fs";export default ctx=>{writeFileSync(ctx.project+"/friction.md","copied notes");renameSync(ctx.project,ctx.project+".original");cpSync(ctx.project+".original",ctx.project,{recursive:true});return "Reference complete";}`,
        "check.mjs": `export default ()=>({pass:true});`,
      },
    );
    const run = await runOne({ taskDir, prepared: context, evidence });
    expect(run.status, JSON.stringify(run)).toBe("complete");
    expect(run.judgement).toBe("pending-two-judges");
    const packet = JSON.parse(
      readFileSync(join(evidence, "judge-packet.json"), "utf8"),
    );
    expect(packet.outputs).toEqual({});
    expect(packet.refusedOutputs).toEqual(["."]);
    expect(JSON.stringify(packet)).not.toContain("copied notes");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 60000);

it("a detected root loss stays refused when the directory is restored before collection", async () => {
  if (!confined) return;
  const work = temporary("eval-restored-root-");
  try {
    const evidence = join(work, "evidence");
    const { taskDir, context } = fixture(
      work,
      { id: "restored-root", rubric: ["Judge the outputs"] },
      {
        "reference.mjs": `import{renameSync,writeFileSync}from"node:fs";export default ctx=>{writeFileSync(ctx.project+"/friction.md","restored notes");renameSync(ctx.project,ctx.project+".gone");writeFileSync(ctx.project,"a file now");return "Reference complete";}`,
        "check.mjs": `export default ()=>({pass:true});`,
      },
    );
    // Between the harness's check and packet collection, the pinned
    // directory returns to its path.
    runHooks.afterRootLoss = (project) => {
      rmSync(project);
      renameSync(project + ".gone", project);
    };
    const run = await runOne({ taskDir, prepared: context, evidence });
    expect(run.status).toBe("infrastructure-failure");
    const packet = JSON.parse(
      readFileSync(join(evidence, "judge-packet.json"), "utf8"),
    );
    expect(packet.outputs).toEqual({});
    expect(packet.sourceDiff).toBeNull();
    expect(packet.refusedOutputs).toEqual(["."]);
    expect(JSON.stringify(packet)).not.toContain("restored notes");
  } finally {
    delete runHooks.afterRootLoss;
    rmSync(work, { recursive: true, force: true });
  }
}, 60000);

it("agent runs and rechecks are refused on Windows before any setup", async () => {
  if (confined) return;
  const work = temporary("eval-windows-refusal-");
  try {
    const evidence = join(work, "evidence");
    await expect(
      runOne({ taskDir: join(work, "task"), prepared: {}, evidence }),
    ).rejects.toThrow("unavailable on Windows");
    await expect(
      recheckRun({ evidence, prepared: { path: work } }),
    ).rejects.toThrow("unavailable on Windows");
    expect(existsSync(evidence)).toBe(false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
