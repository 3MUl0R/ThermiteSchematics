#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { cp as copyAsync } from "node:fs/promises";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { harnessIdentity } from "./checkpoint.mjs";
import { initAudit } from "./audit-files.mjs";
import { captureProcess } from "./process.mjs";
import {
  preflightAuth,
  seedCodexAuth,
  secretValues,
  redactSecrets,
} from "./auth.mjs";
import {
  planAttempt,
  automaticInfra,
  automaticFailures,
  haltingInfra,
  batchHaltReason,
  runKey,
} from "./attempts.mjs";
import { evaluateChecker, CheckerInfrastructureError } from "./checker.mjs";
import { snapshot, sha256 } from "./snapshot.mjs";
import { score } from "./score-log.mjs";
import {
  conveyorMetrics,
  observeConveyorDelivery,
  phaseConveyorCalls,
} from "./conveyor-measurement.mjs";
import { copyConfinedTree, projectReader } from "./capture-files.mjs";
import {
  agentConfiguration,
  freshEnvironment,
  assertIsolation,
} from "./launch.mjs";
import { read, write } from "./task-support.mjs";
import { assertConfinedProjectPaths } from "./source-files.mjs";
import {
  buildRunIdentity,
  createIsolatedEnv,
  populateTaskProject,
  prepareAuthAndLaunch,
  handlePrintAgentCommand,
  executeAgentRun,
} from "./run-setup.mjs";
import {
  stageAndFlushProject,
  buildRunSourceDiff,
  evaluateAndScoreRun,
  buildCompleteManifest,
  writeRunReceipts,
  handleRunFailure,
  cleanupRunResources,
} from "./run-finalize.mjs";
import {
  parseMainArgs,
  validateRunSelection,
  prepareCheckpointContext,
  detectBatchCliVersion,
  resolveUnresolvedAdjudications,
  executeCheckpointTask,
  writeCheckpointSummary,
} from "./run-cli.mjs";
const here = dirname(fileURLToPath(import.meta.url)),
  root = resolve(here, "../..");
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
    encoding: "utf8",
    maxBuffer: 64 << 20,
  }).trim();
const run = (cwd, ...args) =>
  execFileSync(process.execPath, args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 64 << 20,
  });
export function pinnedTypeScriptVersion(engine, commit) {
  try {
    const lock = git(
      engine,
      "--no-replace-objects",
      "cat-file",
      "blob",
      `${commit}:bun.lock`,
    );
    const resolved = Bun.JSONC.parse(lock)?.packages?.typescript?.[0];
    return typeof resolved === "string"
      ? (/^typescript@(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/.exec(
          resolved,
        )?.[1] ?? null)
      : null;
  } catch {
    return null;
  }
}
export async function prepareContext({
  engine = root,
  commit = "HEAD",
  context,
  destination,
}) {
  const pinned = git(engine, "rev-parse", `${commit}^{commit}`),
    build = join(destination, "build"),
    path = join(destination, "engine");
  git(engine, "worktree", "add", "--detach", build, pinned);
  try {
    if (context === "runtime") {
      run(build, "run", "package:pack", "--preview");
      const output = join(build, "release-out/runtime");
      const candidates = readdirSync(output).flatMap((d) =>
        readdirSync(join(output, d))
          .filter((f) => f.endsWith(".zip"))
          .map((f) => join(output, d, f)),
      );
      assert.equal(candidates.length, 1, "Expected exactly one packed runtime");
      const { extractSafeZipArchive } =
        await import("../../scripts/safe-zip-reader.mjs");
      await extractSafeZipArchive(readFileSync(candidates[0]), path);
    } else {
      // A detached worktree of the pinned commit; dependencies come from the local
      // frozen installation, and are rebuilt before any CLI evidence is trusted.
      cpSync(join(engine, "node_modules"), join(build, "node_modules"), {
        recursive: true,
      });
      assert.equal(
        sha256(readFileSync(join(engine, "bun.lock"))),
        sha256(readFileSync(join(build, "bun.lock"))),
        "Install dependencies for the selected commit before source evaluation",
      );
      run(build, "run", "build");
      cpSync(build, path, {
        recursive: true,
        dereference: true,
        filter: (p) => basename(p) !== ".git",
      });
    }
    return {
      path,
      commit: pinned,
      ...(context === "source" && {
        pinnedTypeScript: {
          version: pinnedTypeScriptVersion(engine, pinned),
          module: join(path, "node_modules/typescript/lib/typescript.js"),
        },
      }),
    };
  } finally {
    git(engine, "worktree", "remove", "--force", build);
  }
}
export function installShim(runtime) {
  renameSync(join(runtime, "thermite.mjs"), join(runtime, "thermite.real.mjs"));
  cpSync(join(here, "shim/thermite.mjs"), join(runtime, "thermite.mjs"));
  cpSync(join(here, "shim/observe.mjs"), join(runtime, "eval-observe.mjs"));
  cpSync(join(here, "snapshot.mjs"), join(runtime, "eval-snapshot.mjs"));
  cpSync(join(here, "process.mjs"), join(runtime, "eval-process.mjs"));
  cpSync(
    join(here, "capture-files.mjs"),
    join(runtime, "eval-capture-files.mjs"),
  );
  cpSync(join(here, "audit-files.mjs"), join(runtime, "eval-audit-files.mjs"));
  for (const [from, to] of [
    ["audit.mjs", "eval-audit.mjs"],
    ["auth.mjs", "eval-auth.mjs"],
  ])
    writeFileSync(
      join(runtime, to),
      readFileSync(join(here, from), "utf8")
        .replaceAll('"./snapshot.mjs"', '"./eval-snapshot.mjs"')
        .replaceAll('"./process.mjs"', '"./eval-process.mjs"'),
    );
}
async function copyRuntime(prepared, runtime, task) {
  await copyAsync(prepared, runtime, { recursive: true, dereference: true });
  installShim(runtime);
  if (task.contributor)
    rmSync(join(runtime, "evals/contributor"), {
      recursive: true,
      force: true,
    });
}
// Scratch in the harness home, outside a sandboxed agent's writable roots.
const protectedScratch = (prefix) =>
  realpathSync(mkdtempSync(join(homedir(), prefix)));
// The agent's runtime copy lives in its writable TMPDIR. Post-agent CLI calls
// run a copy made in protected scratch from the same prepared engine. Bun reads
// bunfig.toml and .env files from the project, so those calls name the
// harness's own config instead (see bunConfig in audit.mjs).
async function protectedRuntime(prepared, scratch, task) {
  const runtime = join(scratch, "runtime"),
    config = join(scratch, "bunfig.toml");
  await copyRuntime(prepared, runtime, task);
  writeFileSync(config, "env = false\n");
  return { runtime, config };
}
// The harness's pre-launch copy of the project's regular files. Git metadata
// and installed dependencies (a contributor checkout's) are never diffed.
function copyRegularFiles(from, to, rel = "") {
  for (const entry of readdirSync(join(from, rel), { withFileTypes: true })) {
    const path = rel ? join(rel, entry.name) : entry.name;
    if ([".git", "node_modules"].includes(entry.name)) continue;
    if (entry.isDirectory()) copyRegularFiles(from, to, path);
    else if (entry.isFile()) {
      mkdirSync(dirname(join(to, path)), { recursive: true });
      copyFileSync(join(from, path), join(to, path));
    }
  }
}
// Whether a regular file is at path; a file where a directory was is absence.
function fileAt(path) {
  try {
    return !!lstatSync(path, { throwIfNoEntry: false })?.isFile();
  } catch (error) {
    if (error.code === "ENOTDIR") return false;
    throw error;
  }
}
// The diff of selected project paths, from the pre-launch copy to their post-run
// bytes. `read` returns a path's bytes, null when absent, or throws to refuse
// it. Git never runs in the agent's repository, whose configuration and
// attributes can run programs; it compares copies in protected scratch with no
// configuration, attributes or repository.
export function selectedDiff({ before, scratch, paths, read }) {
  const work = join(scratch, "diff"),
    home = join(work, "home"),
    refused = [];
  rmSync(work, { recursive: true, force: true });
  for (const dir of ["old", "new", "home"])
    mkdirSync(join(work, dir), { recursive: true });
  const put = (side, path, bytes) => {
    mkdirSync(dirname(join(work, side, path)), { recursive: true });
    writeFileSync(join(work, side, path), bytes);
  };
  for (const path of [...new Set(paths)].sort()) {
    let bytes;
    try {
      bytes = read(path);
    } catch {
      refused.push(path);
      continue;
    }
    if (bytes) put("new", path, bytes);
    if (fileAt(join(before, path)))
      put("old", path, readFileSync(join(before, path)));
  }
  const result = spawnSync(
    "git",
    [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--",
      "old",
      "new",
    ],
    {
      cwd: work,
      encoding: "utf8",
      maxBuffer: 64 << 20,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CEILING_DIRECTORIES: scratch,
      },
    },
  );
  assert(
    !result.error && [0, 1].includes(result.status),
    `Source diff failed: ${result.error?.code ?? result.stderr}`,
  );
  // Label paths as the project's, as a diff in its repository would. Only
  // header lines name paths; hunks are left alone.
  let header = false,
    mode = null;
  const diff = result.stdout
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) [header, mode] = [true, null];
      else if (line.startsWith("@@")) header = false;
      if (header && /^(?:new|deleted) file mode /.test(line))
        mode = line.split(" ")[0];
      return header ? relabel(line, mode) : line;
    })
    .join("\n")
    .trim();
  return [
    diff,
    ...refused.map((path) => `Refused (not an ordinary file): ${path}`),
  ]
    .filter(Boolean)
    .join("\n");
}
// A header path field is Git's a/ or b/ prefix, then the synthetic old/ or
// new/ directory, then the project path, possibly inside C-style quotes. Only
// that synthetic component is removed; quoting and spaces are kept.
const field = (text) => text.replace(/^("?[ab]\/)(?:old|new)\//, "$1");
// `mode` is the section's "new" or "deleted" file mode, which alone says
// whether a binary summary names /dev/null; a path can end in " and /dev/null".
function relabel(line, mode) {
  if (line.startsWith("diff --git ")) {
    // Without renames both fields name one path, so they are equally long.
    const rest = line.slice(11),
      half = (rest.length - 1) / 2;
    return `diff --git ${field(rest.slice(0, half))} ${field(rest.slice(half + 1))}`;
  }
  if (line.startsWith("--- ") || line.startsWith("+++ "))
    return line.slice(0, 4) + field(line.slice(4));
  const binary = /^Binary files (.*) differ$/.exec(line)?.[1];
  if (binary === undefined) return line;
  const empty = "/dev/null",
    half = (binary.length - 5) / 2;
  const [from, to] =
    mode === "new"
      ? [empty, binary.slice(empty.length + 5)]
      : mode === "deleted"
        ? [binary.slice(0, -empty.length - 5), empty]
        : [binary.slice(0, half), binary.slice(half + 5)];
  return `Binary files ${field(from)} and ${field(to)} differ`;
}
// Test seams for filesystem transitions that cannot otherwise be timed.
export const runHooks = {};
// Node offers no descriptor-relative, no-follow open on Windows.
const confinedPlatform = ["darwin", "linux"].includes(process.platform);
export const windowsUnavailable =
  "E2 agent runs and rechecks are unavailable on Windows: project files cannot be read there without following links";
const children = new Set();
let stoppingSignal = null;
function captureSetup(binary, args, options = {}) {
  return captureProcess(binary, args, {
    timeout: 120000,
    ...options,
    detached: process.platform !== "win32",
    onChild(child) {
      children.add(child);
      child.once("close", () => children.delete(child));
    },
  });
}
async function setupCommand(binary, args, options) {
  const r = await captureSetup(binary, args, options);
  if (r.error || r.status !== 0)
    throw Object.assign(
      new Error(
        `${binary}: ${r.error?.code ?? r.signal ?? r.status}\n${r.stderr}`,
      ),
      { stage: "setup" },
    );
  return r.stdout;
}
const setupCLI = (ctx, ...args) =>
  setupCommand(process.execPath, [ctx.thermite, ...args], {
    cwd: ctx.project,
    env: ctx.env,
  });
const setupGit = (cwd, ...args) =>
  setupCommand("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
async function agentVersion(binary, options) {
  const result = await captureSetup(binary, ["--version"], options);
  return !result.error && result.status === 0
    ? result.stdout.trim() || null
    : null;
}
function killChild(child, signal = "SIGTERM") {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}
process.once("exit", () => {
  for (const child of children) killChild(child, "SIGKILL");
});
async function loadModule(taskDir, name) {
  const href = pathToFileURL(join(taskDir, name)).href;
  return (
    await import(
      name === "check.mjs"
        ? href + "?taskTree=" + snapshot(taskDir, { documents: false }).hash
        : href
    )
  ).default;
}
async function evaluateTask(taskDir, ctx) {
  return evaluateChecker(async (context) => {
    let checker;
    try {
      checker = await loadModule(taskDir, "check.mjs");
    } catch (error) {
      throw new CheckerInfrastructureError(
        `Checker could not load: ${error.message}`,
      );
    }
    return checker(context);
  }, ctx);
}
function capturedAgent(command, ctx, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: ctx.project,
      env: ctx.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const stdout = [],
      stderr = [];
    let timedOut = false,
      killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
      killTimer = setTimeout(() => killChild(child, "SIGKILL"), 1000);
    }, timeoutMs);
    child.stdout.on("data", (b) => stdout.push(b));
    child.stderr.on("data", (b) => stderr.push(b));
    child.on("error", (error) => {
      clearTimeout(timer);
      children.delete(child);
      resolvePromise({
        exit: null,
        spawnError: error.code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
    child.on("close", async (exit, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      // A CLI can leave background tool children after its own exit.
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, 0);
          killChild(child);
          await new Promise((resolve) => setTimeout(resolve, 100));
          killChild(child, "SIGKILL");
        } catch {}
      }
      children.delete(child);
      resolvePromise({
        exit,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
  });
}
const identity =
  /\b(?:anthropic|openai|chatgpt|gpt(?:[- .]?\d[\w.-]*)?|claude(?:[- .]?(?:opus|sonnet|haiku|fable)(?:[- .]?\d[\w.-]*)?)?|codex(?:-\d[\w.-]*)?|(?:opus|sonnet|haiku|fable)(?:[- .]?\d[\w.-]*)?|gemini|deepseek|grok|llama|qwen|mistral|copilot|o[- ]?series|o[134](?:-(?:pro|mini|preview))(?:-(?:high|medium|low|xhigh|max))?|arm [AB])\b/gi;
export function judgePacket({
  finalMessage,
  sourceDiff,
  project,
  runtime,
  task,
  source,
  rootRefused = false,
}) {
  // The project is agent-written. Artifacts are read without following links,
  // through a reader whose root was pinned before the agent started; anything
  // else is listed as refused. `rootRefused` is a root loss the caller already
  // detected: the packet refuses the whole root without reading the project.
  assert(confinedPlatform, windowsUnavailable);
  const outputs = {},
    binaryOutputs = [],
    refusedOutputs = [];
  const take = (rel) => {
    try {
      return source.read(rel);
    } catch {
      refusedOutputs.push(rel);
    }
  };
  if (rootRefused) refusedOutputs.push(".");
  else
    try {
      for (const name of [
        "drawings",
        "issue.md",
        "review-notes.md",
        "requirement-matrix.json",
        "friction.md",
      ]) {
        if (!source.has(name)) continue;
        if (name !== "drawings") {
          const bytes = take(name);
          if (bytes) outputs[name] = bytes.toString("utf8");
          continue;
        }
        let files;
        try {
          files = source.list(name).sort();
        } catch {
          refusedOutputs.push(name);
          continue;
        }
        for (const file of files) {
          if (!/\.(json|csv|html|svg|pdf)$/.test(file)) continue;
          const rel = `drawings/${file}`,
            bytes = take(rel);
          if (!bytes) continue;
          outputs[rel] = file.endsWith(".pdf")
            ? bytes.toString("base64")
            : bytes.toString("utf8");
          if (file.endsWith(".pdf")) binaryOutputs.push(rel);
        }
      }
    } catch {
      // An entry that cannot be inspected, or a replaced root, refuses the
      // project as a whole.
      for (const key of Object.keys(outputs)) delete outputs[key];
      binaryOutputs.length = 0;
      refusedOutputs.splice(0, Infinity, ".");
    }
  const blindText = (text) =>
    text
      .replaceAll(project, "<project>")
      .replaceAll(runtime ?? project, "<runtime>")
      .replace(/(\bmodel[\s:="\']+)o[134]\b/gi, "$1<identity>")
      .replace(
        /\b\d+(?:\.\d+){1,3}\s*\((?:Claude Code|codex-cli)\)/gi,
        "<identity>",
      )
      .replace(
        /\b(?:claude|codex)\s+--version\s+(?:printed|returned|is)\s+v?\d+(?:\.\d+){1,3}/gi,
        "<identity>",
      )
      .replace(
        /\b(?:(?:codex(?:-cli)?|claude(?:[ -]+code)?)\s+(?:cli\s+)?(?:version\s+)?v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?)\b/gi,
        "<identity>",
      )
      .replace(/\bxhigh\b/gi, "<identity>")
      .replace(
        /\b(?:(thermite)\s+)?CLI\s+version\s+v?\d+(?:\.\d+){1,3}\b/gi,
        (text, engine) => (engine ? text : "<identity>"),
      )
      .replace(identity, "<identity>");
  const blind = (value) =>
    typeof value === "string"
      ? blindText(value)
      : Array.isArray(value)
        ? value.map(blind)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [blindText(k), blind(v)]),
            )
          : value;
  const packet = blind({
    format: "thermite-blinded-judge/1.2",
    finalMessage,
    sourceDiff,
    rubric: task.rubric,
    outputs: Object.fromEntries(
      Object.entries(outputs).filter(([k]) => !binaryOutputs.includes(k)),
    ),
  });
  // Base64 is opaque binary data, never a redaction target.
  for (const path of binaryOutputs)
    packet.outputs[blindText(path)] = outputs[path];
  packet.binaryOutputs = binaryOutputs.map(blindText);
  packet.refusedOutputs = refusedOutputs.map(blindText);
  return packet;
}
function parseCalls(path) {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch {
    return [];
  }
}
function validationDiagnostics(result) {
  for (const text of [result.stdout, result.stderr])
    try {
      const value = JSON.parse(text);
      if (Array.isArray(value)) return value;
      if (value.diagnostics) return value.diagnostics;
    } catch {}
  return [];
}
// A sandboxed Codex agent, and any process it leaves running, can write /tmp
// and the system temporary directory, which hold its run directory and TMPDIR.
// Its final evidence archive must resolve outside them. Returns the canonical
// path, which every later archive write uses so a link cannot redirect it.
export function assertArchiveOutsideSandbox(archive) {
  const resolved = realpathSync(archive);
  const root = [tmpdir(), "/tmp", "/private/tmp"]
    .filter((path) => existsSync(path))
    .map((path) => realpathSync(path))
    .find((root) => resolved === root || resolved.startsWith(root + sep));
  assert(
    !root,
    `Evidence archive ${resolved} is under ${root}, which a sandboxed Codex agent can write; run Codex evals from a checkout outside temporary directories`,
  );
  return resolved;
}
function ownTemp(prefix) {
  return realpathSync(
    mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", prefix)),
  );
}
async function prepareRunForLaunch(run) {
  const { options, state, identity, work, runtime, project, live, audit } = run;
  state.workSource = projectReader(work);
  const task = (state.task = read(join(options.taskDir, "task.json")));
  assert(
    !task.context || task.context === options.context,
    "Task requires --context source",
  );
  await copyRuntime(options.prepared.path, runtime, task);
  identity.task = task.id;
  identity.runKey = runKey(identity);
  state.auditSource = projectReader(audit);
  const env = createIsolatedEnv(run);
  state.secretList = secretValues(env);
  const ctx = {
    task,
    project,
    runtime,
    thermite: join(runtime, "thermite.mjs"),
    env,
    evidence: live,
  };
  await populateTaskProject(run, ctx, env);
  const launched = await prepareAuthAndLaunch(run, ctx, env);
  return { task, env, ctx, launched };
}
function preparePostAgentContext(
  run,
  ctx,
  before,
  launched,
  runResult,
  flushed,
) {
  const { options, state, project } = run;
  ctx.initial = launched.initial;
  ctx.final = flushed.final;
  ctx.calls = flushed.calls;
  if (state.task.contributor) {
    // Contributor scoring still inspects the live Git worktree/install and
    // independently runs its submitted code. See the contributor boundary.
    assert(flushed.rootIntact, "Contributor project root was replaced");
    ctx.project = project;
    ctx.pinnedTypeScript = options.prepared.pinnedTypeScript;
  }
  ctx.sourceDiff = buildRunSourceDiff(run, before, launched.initial, flushed);
  ctx.metrics = score({
    calls: flushed.calls,
    initial: launched.initial,
    final: flushed.final,
    transcript: runResult.execution.stdout,
    context: options.context,
    engineRoots: options.engineRoots,
    allowedLibraryPaths: state.task.allowedLibraryPaths,
    guideCopy: state.task.guideCopy,
  });
}
async function executeRunBody(run) {
  const { options, state, runtime, project } = run;
  const { task, env, ctx, launched } = await prepareRunForLaunch(run);
  if (options.printAgentCommand) {
    state.manifest = handlePrintAgentCommand(run, env, launched);
    return state.manifest;
  }
  if (!launched.authentication.ok)
    throw Object.assign(new Error("Authentication pre-flight failed"), {
      stage: "authentication",
    });
  // Before launch: the harness's copy of the starting sources, and the project
  // root that every post-run read starts from.
  state.scratch = protectedScratch(".thermite-agent-protected-");
  const before = join(state.scratch, "before");
  copyRegularFiles(project, before);
  state.source = projectReader(project);
  state.runtimeSource = projectReader(runtime);
  // The guide the agent's CLI loads at launch.
  const guideBytes = readFileSync(join(before, "AGENTS.md")).length;
  const conveyor = task.id === "D-conveyor";
  const delivery = conveyor
    ? observeConveyorDelivery(state.source, task.deliverables)
    : null;
  const runResult = await executeAgentRun(run, ctx, launched, delivery);
  // The agent has finished; record that before anything reads the project.
  state.finalMessage = runResult.normalized.finalMessage ?? null;
  const flushed = await stageAndFlushProject(run, ctx, runResult, conveyor);
  preparePostAgentContext(run, ctx, before, launched, runResult, flushed);
  const scored = await evaluateAndScoreRun(
    run,
    ctx,
    launched,
    runResult,
    flushed,
    guideBytes,
  );
  state.manifest = buildCompleteManifest(
    run,
    ctx,
    launched,
    runResult,
    flushed,
    scored,
  );
  writeRunReceipts(
    run,
    ctx,
    launched,
    runResult,
    flushed,
    scored,
    delivery,
    guideBytes,
  );
  return state.manifest;
}
function normalizeRunOptions(rawOptions) {
  const defaults = {
    agent: "reference",
    arm: "A",
    context: "source",
    seed: 1,
    attempt: 1,
    printAgentCommand: false,
    engineRoots: [root],
    keep: false,
    forceRerun: false,
    automaticRetry: false,
    reopenInfra: null,
    reopenedHalt: false,
    infraRetryDelayMs: 0,
    checkpointOverride: null,
    timeoutMs: 900000,
  };
  const defined = Object.fromEntries(
    Object.entries(rawOptions ?? {}).filter(([, value]) => value !== undefined),
  );
  return { ...defaults, ...defined };
}
function runDependencies() {
  return {
    here,
    setupCLI,
    setupCommand,
    setupGit,
    captureSetup,
    agentVersion,
    capturedAgent,
    protectedRuntime,
    parseCalls,
    validationDiagnostics,
    selectedDiff,
    fileAt,
    evaluateTask,
    judgePacket,
    runHooks,
    getStoppingSignal: () => stoppingSignal,
  };
}
export async function runOne(rawOptions) {
  const options = normalizeRunOptions(rawOptions);
  // Before any setup or evidence: Windows cannot confine post-run reads.
  assert(confinedPlatform, windowsUnavailable);
  const runIdentity = harnessIdentity({ tasksDir: options.tasksRoot });
  if (options.expectedIdentity)
    assert.deepEqual(
      runIdentity,
      options.expectedIdentity,
      "Harness/checker changed during checkpoint invocation",
    );
  const configuration = agentConfiguration({
      agent: options.agent,
      model: options.model,
      effort: options.effort,
    }),
    identity = buildRunIdentity(options, configuration, runIdentity);
  mkdirSync(options.evidence, { recursive: true });
  const work = ownTemp("thermite-agent-eval-"),
    runtime = join(work, "runtime"),
    project = join(work, "project"),
    // The run directory is the agent's TMPDIR and under /tmp, so a sandboxed
    // agent or a process it leaves behind can write it. Live evidence stays
    // in the harness home, outside the sandbox's writable roots.
    live = realpathSync(
      mkdtempSync(join(homedir(), ".thermite-agent-evidence-")),
    ),
    audit = join(work, "audit");
  initAudit(audit);
  const state = { rootRefused: false, secretList: [] },
    runStarted = Date.now();
  const save = (file, value) =>
    write(
      join(live, file),
      JSON.parse(redactSecrets(JSON.stringify(value), state.secretList)),
    );
  const run = {
    options,
    state,
    identity,
    configuration,
    runIdentity,
    work,
    runtime,
    project,
    live,
    audit,
    runStarted,
    save,
    deps: runDependencies(),
  };
  try {
    return await executeRunBody(run);
  } catch (error) {
    state.manifest = handleRunFailure(run, error);
    return state.manifest;
  } finally {
    cleanupRunResources(run);
  }
}
// `prepared` is the checkpoint's prepared context, read from the trusted
// archive; nothing the agent's run directory holds selects what runs here.
export async function recheckRun({ evidence, forceRecheck = false, prepared }) {
  assert(confinedPlatform, windowsUnavailable);
  assert(prepared?.path, "Recheck needs the checkpoint's prepared context");
  const original = read(join(evidence, "manifest.json"));
  assert(
    original.status === "checker-error",
    "Only a checker error can be rechecked",
  );
  assert(
    original.workspace && existsSync(original.workspace),
    "Kept checker workspace is missing; never rerun the agent automatically",
  );
  const stored = read(join(evidence, "recheck.json")),
    task = read(join(stored.taskDir, "task.json"));
  assert(
    stored.projectRoot &&
      stored.workspaceRoot &&
      Array.isArray(stored.projectRefusals) &&
      Number.isInteger(stored.guideBytes),
    "Recheck needs a confined project snapshot recorded since E2 1.20.5",
  );
  // Refuses a project root other than the one pinned before the agent started.
  const source = projectReader(stored.project, stored.projectRoot);
  let scratch;
  try {
    const checkerTaskTreeHash = snapshot(stored.taskDir, {
      documents: false,
    }).hash;
    assert(
      forceRecheck ||
        checkerTaskTreeHash ===
          (original.checkerTaskTreeHash ?? original.taskTreeHash),
      "Task directory changed; use --force-recheck to authorize and record the new checker inputs",
    );
    const revision = (original.checkerRechecks ?? 0) + 1,
      work = original.workspace;
    scratch = protectedScratch(".thermite-agent-recheck-");
    const stagedProject = join(scratch, "project");
    const refusals = copyConfinedTree(source, stagedProject);
    const current = snapshot(stagedProject);
    assert(
      current.hash === stored.final.hash &&
        JSON.stringify(refusals) === JSON.stringify(stored.projectRefusals),
      "Kept agent sources changed; refusing recheck",
    );
    assertConfinedProjectPaths(stagedProject, current.documents["system.json"]);
    const transcript = readFileSync(join(evidence, "transcript.jsonl"), "utf8");
    const promptVersion =
      original.taskVersion ??
      (original.taskHash ===
      sha256(readFileSync(join(stored.taskDir, "task.json")))
        ? task.version
        : null);
    // The checker's receipts, its configuration and the CLI it runs are staged
    // in protected scratch, never in the kept run directory, which a process
    // the agent left behind can still write.
    const live = join(scratch, "evidence");
    mkdirSync(live);
    const trusted = await protectedRuntime(prepared.path, scratch, task);
    const checker = harnessIdentity({ tasksDir: stored.tasksRoot });
    const calls = stored.deliveryTiming
      ? phaseConveyorCalls(
          stored.calls,
          stored.deliveryTiming.started,
          stored.deliveryTiming.ended,
        )
      : stored.calls;
    const ctx = {
      ...stored,
      calls,
      task,
      project: task.contributor ? stored.project : stagedProject,
      originalProject: stored.project,
      promptVersion,
      ...(task.contributor && { pinnedTypeScript: prepared.pinnedTypeScript }),
      evidence: live,
      captureEvidence: evidence,
      env: {
        ...freshEnvironment(join(scratch, "isolated"), {}, {}),
        THERMITE_EVAL_BUN_CONFIG: trusted.config,
      },
      thermite: join(trusted.runtime, "thermite.real.mjs"),
      metrics: score({
        calls,
        transcript,
        context: stored.context,
        engineRoots: stored.engineRoots,
        allowedLibraryPaths: task.allowedLibraryPaths,
      }),
    };
    const outcome = await evaluateTask(stored.taskDir, ctx);
    assert.equal(
      harnessIdentity({ tasksDir: stored.tasksRoot }).checkerHash,
      checker.checkerHash,
      "Harness changed during recheck; result cannot be scored",
    );
    const metrics = score({
      calls,
      initial: stored.initial,
      final: stored.final,
      runtimeBefore: original.runtimeHash.before,
      runtimeAfter: original.runtimeHash.after,
      transcript,
      context: stored.context,
      engineRoots: stored.engineRoots,
      guideBytes: stored.guideBytes,
      guideFiles: [
        join(stored.project, "AGENTS.md"),
        join(stored.runtime, "README.md"),
      ],
      expectedWarnings: outcome.expectedWarnings ?? task.expectedWarnings,
      actualWarnings:
        outcome.actualWarnings ??
        stored.validationDiagnostics.filter((d) => d.severity === "warning"),
      requiredTopics: task.requiredTopics,
      taskOutcome: outcome,
      allowedUnused: task.allowedUnused,
      allowedLibraryPaths: task.allowedLibraryPaths,
      guideCopy: task.guideCopy,
      preserveSource: task.preserveSource,
      undocumentedShapes: task.undocumentedShapes,
      wallTimeMs: original.timings.wallTimeMs,
    });
    if (original.agent === "reference") metrics.usage.partial = false;
    const independentlyChecked = outcome.pass;
    if (original.agentFailure) {
      outcome.pass = false;
      outcome.agentFailure = original.agentFailure;
    }
    if (stored.deliveryTiming)
      metrics.delivery = conveyorMetrics({
        ...stored.deliveryTiming,
        ctx,
        outcome,
        independentlyChecked,
        status:
          original.shimErrors?.length || outcome.error
            ? original.status
            : "complete",
        violations: metrics.violations,
        postAgentWallTimeMs: original.metrics.delivery?.postAgentWallTimeMs,
      });
    const result = {
      ...original,
      outcome,
      metrics,
      status:
        outcome.error?.kind === "checker-error"
          ? "checker-error"
          : original.shimErrors?.length
            ? "infrastructure-failure"
            : "complete",
      checkerRechecks: revision,
      checkerHarnessHash: checker.checkerHarnessHash,
      checkerHash: checker.checkerHash,
      checkerTaskTreeHash,
      forceRecheck: forceRecheck || original.forceRecheck || false,
      checkerRecheckHistory: [
        ...(original.checkerRecheckHistory ?? []),
        {
          revision,
          forced: forceRecheck,
          taskTreeHash: checkerTaskTreeHash,
          harnessHash: checker.checkerHarnessHash,
        },
      ],
    };
    write(
      join(
        evidence,
        `checker-history-${String(revision).padStart(3, "0")}.json`,
      ),
      original,
    );
    cpSync(live, evidence, { recursive: true });
    if (task.rubric)
      write(
        join(evidence, "judge-packet.json"),
        judgePacket({
          finalMessage: metrics.finalMessage,
          sourceDiff: ctx.sourceDiff,
          project: stored.project,
          runtime: stored.runtime,
          task,
          source,
        }),
      );
    write(join(evidence, "check.json"), outcome);
    write(join(evidence, "score.json"), metrics);
    if (result.status !== "checker-error" && !stored.keep) {
      result.workspace = null;
      let workspace;
      try {
        workspace = projectReader(work, stored.workspaceRoot);
        workspace.removeRoot();
      } catch (error) {
        result.workspace = work;
        result.cleanupError = error.message;
      } finally {
        workspace?.close();
      }
    }
    write(join(evidence, "manifest.json"), result);
    return result;
  } finally {
    try {
      source?.close();
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }
}
async function retryWait(ms, control) {
  const until = Date.now() + ms;
  while (!control.stopped && !stoppingSignal && Date.now() < until)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000, until - Date.now())),
    );
}
export async function runAttempts({
  prior = [],
  runAttempt,
  control = { stopped: false },
  forceRerun = false,
  retryDelayMs = 5000,
  reopenInfra = null,
  now = Date.now,
  wait = (ms) => retryWait(ms, control),
}) {
  const history = [...prior];
  let reopen = reopenInfra;
  for (;;) {
    const action = planAttempt(history, forceRerun, { reopenInfra: reopen });
    if (action.kind !== "run") {
      if (action.run?.status === "needs-adjudication") {
        control.stopped = true;
        control.reason = "needs-adjudication";
      }
      return {
        ...action.run,
        replayed: true,
        ...(action.kind === "exhausted" ? { retryExhausted: true } : {}),
      };
    }
    if (control.stopped || stoppingSignal) return history.at(-1);
    let automaticRetry = !reopen && automaticInfra(history.at(-1) ?? {});
    let delay = automaticRetry
      ? Math.max(
          retryDelayMs * 2 ** Math.max(0, automaticFailures(history) - 1),
          (history.at(-1).retryAt ?? now()) - now(),
        )
      : 0;
    // A historical quota-sized reset reopens instead of re-halting from disk.
    if (delay > 15 * 60000) {
      delay = 0;
      automaticRetry = false;
    }
    if (delay > 0) await wait(delay);
    if (control.stopped || stoppingSignal) return history.at(-1);
    const result = await runAttempt({
      attempt: action.attempt,
      forceRerun: action.forceRerun,
      automaticRetry,
      reopenInfra: action.reopenInfra,
      reopenedHalt: action.reopenedHalt,
      infraRetryDelayMs: delay,
    });
    reopen = null;
    history.push(result);
    if (batchHaltReason(result)) {
      if (haltingInfra(result)) result.status = "halted-infra";
      control.stopped = true;
      control.reason = batchHaltReason(result);
      return result;
    }
    if (!automaticInfra(result)) return result;
  }
}
export async function runBatch(tasks, { runTask, concurrency = 1 } = {}) {
  assert([1, 2].includes(concurrency));
  let cursor = 0;
  const results = [],
    control = { stopped: false, reason: null };
  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (cursor < tasks.length && !stoppingSignal && !control.stopped) {
        const task = tasks[cursor++];
        try {
          const result = await runTask(task, control);
          if (!result) continue;
          if (
            result.status === "needs-adjudication" ||
            (!result.replayed && haltingInfra(result))
          ) {
            if (haltingInfra(result)) result.status = "halted-infra";
            control.stopped = true;
            control.reason = batchHaltReason(result);
          }
          results.push(result);
        } catch (error) {
          process.stderr.write(`${task}: checker-error: ${error.message}\n`);
          results.push({
            task,
            status: "checker-error",
            outcome: {
              pass: false,
              error: { kind: "checker-error", message: error.message },
            },
            metrics: { violations: [] },
          });
        }
      }
    }),
  );
  return results;
}
async function authOnly(values, timeoutMs) {
  assert(
    ["claude", "codex"].includes(values.agent),
    "--check-auth requires --agent claude|codex",
  );
  const work = ownTemp("thermite-auth-check-"),
    project = join(work, "project");
  mkdirSync(project);
  const env = freshEnvironment(join(work, "isolated"), process.env, {
    engineRoots: [root],
  });
  let seed;
  try {
    if (values.agent === "codex") {
      seed = seedCodexAuth(env, values["codex-auth"], { timeoutMs });
      if (values["codex-auth"]) {
        delete env.CODEX_API_KEY;
        delete env.OPENAI_API_KEY;
      }
    }
    assertIsolation(project, env, { codexAuth: !!seed });
    const status = await preflightAuth(values.agent, env, {
      capture: captureSetup,
    });
    console.log(JSON.stringify(status));
    if (!status.ok) process.exitCode = 1;
  } catch (error) {
    if (error.stage !== "authentication") throw error;
    console.error(error.message);
    console.log(
      JSON.stringify({
        ok: false,
        agent: values.agent,
        billing: "chatgpt-login",
        reason: "refresh-required",
      }),
    );
    process.exitCode = 1;
  } finally {
    if (!values.keep) rmSync(work, { recursive: true, force: true });
  }
}
function listEngineWorktreeRoots(engine) {
  return git(resolve(engine), "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9));
}
async function main() {
  const started = Date.now();
  const { values, timeoutMs } = parseMainArgs(here, root);
  if (values["check-auth"]) {
    await authOnly(values, timeoutMs);
    return;
  }
  assert(confinedPlatform, windowsUnavailable);
  const selection = validateRunSelection(values);
  const requested = join(root, "evals/out/agent", values.checkpoint);
  mkdirSync(requested, { recursive: true });
  // Only the Codex sandbox has a write boundary; Claude runs as the harness
  // user and the reference agent launches nothing. Either way, archive to the
  // canonical path resolved now, never back through a link.
  const destination =
    values.agent === "codex"
      ? assertArchiveOutsideSandbox(requested)
      : realpathSync(requested);
  const ctxState = await prepareCheckpointContext({
    destination,
    values,
    tasksDir: selection.tasksDir,
    git,
    prepareContext,
  });
  const versionState = await detectBatchCliVersion({
    agent: values.agent,
    root,
    ownTemp,
    agentVersion,
  });
  const adjudication = resolveUnresolvedAdjudications({
    destination,
    tasks: selection.tasks,
    selectedKey: selection.selectedKey,
    reopenInfra: values["reopen-infra"],
  });
  if (adjudication.blocked) {
    process.exitCode = 1;
    return;
  }
  const taskParams = {
    destination,
    values,
    ...selection,
    ...ctxState,
    engineRoots: listEngineWorktreeRoots(values.engine),
    timeoutMs,
    recheckRun,
    runAttempts,
    runOne,
  };
  const results = await runBatch(adjudication.tasks, {
    concurrency: selection.concurrency,
    runTask: (task, control) =>
      executeCheckpointTask({ ...taskParams, task, control }),
  });
  writeCheckpointSummary({
    destination,
    ...ctxState,
    ...versionState,
    values,
    configuration: selection.configuration,
    started,
    results,
    unresolved: adjudication.unresolved,
    stoppingSignal,
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      stoppingSignal = signal;
      for (const child of children) killChild(child, signal);
      process.exitCode = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal];
    });
  await main();
}
