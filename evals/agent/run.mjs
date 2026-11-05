#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { fileState, auditErrors } from "./audit.mjs";
import {
  preflightAuth,
  seedCodexAuth,
  refreshCodexAuth,
  secretValues,
  redactSecrets,
  credentialKeys,
} from "./auth.mjs";
import {
  classifyAgent,
  isComplete,
  planAttempt,
  automaticInfra,
  runKey,
  runDirectoryName,
} from "./attempts.mjs";
import { evaluateChecker, CheckerInfrastructureError } from "./checker.mjs";
import { estimateCost } from "./cost.mjs";
import { snapshot, sha256 } from "./snapshot.mjs";
import { score } from "./score-log.mjs";
import { normalizeTranscript } from "./transcript.mjs";
import {
  agents,
  agentConfiguration,
  launchCommand,
  shellCommand,
  freshEnvironment,
  assertIsolation,
} from "./launch.mjs";
import { cli, ok, read, write, documents, uid } from "./task-support.mjs";
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
export async function prepareContext({
  engine = root,
  commit = "HEAD",
  context,
  destination,
}) {
  const pinned = git(engine, "rev-parse", `${commit}^{commit}`),
    build = join(destination, "build");
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
      await extractSafeZipArchive(
        readFileSync(candidates[0]),
        join(destination, "engine"),
      );
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
      cpSync(build, join(destination, "engine"), {
        recursive: true,
        dereference: true,
        filter: (p) => basename(p) !== ".git",
      });
    }
    return { path: join(destination, "engine"), commit: pinned };
  } finally {
    git(engine, "worktree", "remove", "--force", build);
  }
}
export function installShim(runtime) {
  renameSync(join(runtime, "thermite.mjs"), join(runtime, "thermite.real.mjs"));
  cpSync(join(here, "shim/thermite.mjs"), join(runtime, "thermite.mjs"));
  cpSync(join(here, "shim/observe.mjs"), join(runtime, "eval-observe.mjs"));
  cpSync(join(here, "snapshot.mjs"), join(runtime, "eval-snapshot.mjs"));
  for (const [from, to] of [
    ["audit.mjs", "eval-audit.mjs"],
    ["auth.mjs", "eval-auth.mjs"],
  ])
    writeFileSync(
      join(runtime, to),
      readFileSync(join(here, from), "utf8").replaceAll(
        '"./snapshot.mjs"',
        '"./eval-snapshot.mjs"',
      ),
    );
}
const children = new Set();
let stoppingSignal = null;
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
}) {
  const outputs = {},
    binaryOutputs = [];
  for (const name of [
    "drawings",
    "issue.md",
    "review-notes.md",
    "requirement-matrix.json",
    "friction.md",
  ]) {
    const path = join(project, name);
    if (!existsSync(path)) continue;
    if (name === "drawings")
      for (const file of readdirSync(path).sort()) {
        if (!/\.(json|csv|html|svg|pdf)$/.test(file)) continue;
        if (file.endsWith(".pdf")) {
          outputs[`drawings/${file}`] = readFileSync(join(path, file)).toString(
            "base64",
          );
          binaryOutputs.push(`drawings/${file}`);
        } else
          outputs[`drawings/${file}`] = readFileSync(join(path, file), "utf8");
      }
    else outputs[name] = readFileSync(path, "utf8");
  }
  const blindText = (text) =>
    text
      .replaceAll(project, "<project>")
      .replaceAll(runtime ?? project, "<runtime>")
      .replace(/(\bmodel[\s:="\']+)o[134]\b/gi, "$1<identity>")
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
    format: "thermite-blinded-judge/1.1",
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
function ownTemp(prefix) {
  return realpathSync(
    mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", prefix)),
  );
}
export async function runOne({
  taskDir,
  prepared,
  evidence,
  agent = "reference",
  model,
  effort,
  arm = "A",
  context = "source",
  seed = 1,
  attempt = 1,
  guide,
  printAgentCommand = false,
  engineRoots = [root],
  codexAuth,
  keep = false,
  forceRerun = false,
  automaticRetry = false,
  timeoutMs = 900000,
}) {
  const configuration = agentConfiguration({ agent, model, effort }),
    identity = {
      arm,
      context,
      task: basename(taskDir),
      agent,
      seed,
      ...configuration,
    };
  identity.runKey = runKey(identity);
  mkdirSync(evidence, { recursive: true });
  const work = ownTemp("thermite-agent-eval-"),
    runtime = join(work, "runtime"),
    project = join(work, "project"),
    live = join(work, "evidence"),
    audit = join(work, "audit");
  mkdirSync(live);
  mkdirSync(audit);
  let authSeed,
    env,
    manifest,
    task,
    initial,
    runtimeBefore,
    secretList = [];
  const runStarted = Date.now();
  const save = (file, value) =>
    write(
      join(live, file),
      JSON.parse(redactSecrets(JSON.stringify(value), secretList)),
    );
  try {
    cpSync(prepared.path, runtime, { recursive: true, dereference: true });
    installShim(runtime);
    task = read(join(taskDir, "task.json"));
    identity.task = task.id;
    identity.runKey = runKey(identity);
    env = {
      ...freshEnvironment(join(work, "isolated"), process.env, { engineRoots }),
      THERMITE_EVAL_PROJECT: project,
      THERMITE_EVAL_LOG: join(audit, "shim.jsonl"),
      THERMITE_EVAL_ERRORS: join(audit, "shim-errors.jsonl"),
      THERMITE_EVAL_PHASE: "setup",
    };
    for (const [key, value] of Object.entries(env))
      if (!credentialKeys.includes(key))
        assert(
          !engineRoots.some((p) => value.includes(p)),
          `Checkout path leaked through ${key}`,
        );
    if (agent === "codex") {
      authSeed = seedCodexAuth(env, codexAuth);
      if (codexAuth) {
        delete env.CODEX_API_KEY;
        delete env.OPENAI_API_KEY;
      }
    }
    secretList = secretValues(env);
    const ctx = {
      task,
      project,
      runtime,
      thermite: join(runtime, "thermite.mjs"),
      env,
      evidence: live,
    };
    if (["starter", "cabinets"].includes(task.template))
      ok(
        { ...ctx, project: work },
        "init",
        project,
        ...(task.template === "cabinets" ? ["--template", "cabinets"] : []),
      );
    else {
      cpSync(join(prepared.examples, task.template), project, {
        recursive: true,
      });
      const starter = join(work, "starter");
      ok(ctx, "init", starter);
      cpSync(join(starter, "libraries"), join(project, "libraries"), {
        recursive: true,
      });
      cpSync(join(starter, "AGENTS.md"), join(project, "AGENTS.md"));
      ok(ctx, "lock", project);
    }
    mkdirSync(join(project, "drawings"), { recursive: true });
    if (task.setup) await (await loadModule(taskDir, task.setup))(ctx);
    if (task.template === "cabinets") {
      const docs = documents(project),
        ids = new Map(
          docs.flatMap((doc) =>
            doc.objects.map((o) => [
              o.uid,
              uid(`${task.id}/${seed}/${o.designation}`),
            ]),
          ),
        );
      const rewrite = (value) =>
        typeof value === "string"
          ? (ids.get(value) ?? value)
          : Array.isArray(value)
            ? value.map(rewrite)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value).map(([k, v]) => [k, rewrite(v)]),
                )
              : value;
      for (const doc of docs)
        write(join(project, doc.path), rewrite({ objects: doc.objects }));
    }
    if (guide) cpSync(guide, join(project, "AGENTS.md"));
    if (agent === "claude") {
      assert(!existsSync(join(project, "CLAUDE.md")));
      writeFileSync(join(project, "CLAUDE.md"), "@AGENTS.md\n");
    }
    git(project, "init", "--quiet");
    git(project, "add", ".");
    git(
      project,
      "-c",
      "user.name=Eval",
      "-c",
      "user.email=eval@invalid",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "Task start",
    );
    const isolation = assertIsolation(project, env, {
      claudeLoader: agent === "claude",
      codexAuth: !!authSeed,
    });
    const authentication =
      agent === "reference"
        ? { ok: true, agent, billing: "none" }
        : preflightAuth(agent, env);
    secretList = secretValues(env);
    save("auth-status.json", authentication);
    initial = fileState(project, join(runtime, "thermite.real.mjs"), env);
    initial.sourceFiles = documents(project).map((doc) => doc.path);
    runtimeBefore = snapshot(runtime, { documents: false }).hash;
    save("initial.json", initial);
    writeFileSync(env.THERMITE_EVAL_LOG, "");
    write(env.THERMITE_EVAL_LOG + ".state.json", {
      snapshot: initial,
      lastHash: null,
    });
    if (existsSync(env.THERMITE_EVAL_ERRORS)) rmSync(env.THERMITE_EVAL_ERRORS);
    env.THERMITE_EVAL_PHASE = "agent";
    const prompt = `Thermite is at ${ctx.thermite}.\n\n${task.prompt.replaceAll("{{THERMITE}}", ctx.thermite)}`;
    const command =
      agent === "reference"
        ? null
        : launchCommand({ agent, project, runtime, prompt, model, effort });
    const cliVersion =
      agent === "reference"
        ? null
        : (spawnSync(agents[agent].binary, ["--version"], {
            env,
            encoding: "utf8",
          }).stdout?.trim() ?? null);
    if (printAgentCommand) {
      assert(command, "--print-agent-command requires an agent CLI");
      const environment = Object.fromEntries(
          Object.entries(env).filter(([key]) => !credentialKeys.includes(key)),
        ),
        keys = credentialKeys.filter((key) => env[key]);
      console.log(
        `cd ${shellCommand([project])} && ${shellCommand(["env", "-i", ...Object.entries(environment).map(([key, value]) => `${key}=${value}`)])} ${keys.map((key) => `${key}="$${key}"`).join(" ")} ${shellCommand(command)}`,
      );
      save("command.json", {
        ...configuration,
        environment,
        credentialKeys: keys,
        argv: command,
        cwd: project,
        isolation,
        authentication,
      });
      manifest = {
        ...identity,
        format: "thermite-agent-run/1.1",
        status: "command-only",
        task: task.id,
        arm,
        agent,
        seed,
        attempt,
        authentication,
        workspace: keep ? work : null,
      };
      save("manifest.json", manifest);
      return manifest;
    }
    if (!authentication.ok)
      throw Object.assign(new Error("Authentication pre-flight failed"), {
        stage: "authentication",
      });
    const started = Date.now();
    let execution = { exit: 0, stdout: "", stderr: "" };
    if (agent === "reference") {
      const workerContext = join(work, "reference-context.json");
      const { env: ignored, ...publicContext } = ctx;
      write(workerContext, {
        module: join(taskDir, task.reference ?? "reference.mjs"),
        context: publicContext,
      });
      execution = await capturedAgent(
        [process.execPath, join(here, "reference-worker.mjs"), workerContext],
        ctx,
        timeoutMs,
      );
    } else execution = await capturedAgent(command, ctx, timeoutMs);
    secretList = [...new Set([...secretList, ...secretValues(env)])];
    execution.stdout = redactSecrets(execution.stdout, secretList);
    execution.stderr = redactSecrets(execution.stderr, secretList);
    writeFileSync(join(live, "transcript.jsonl"), execution.stdout);
    writeFileSync(join(live, "agent.stderr"), execution.stderr);
    const normalized = normalizeTranscript(execution.stdout),
      classification = classifyAgent(execution, normalized),
      ended = Date.now(),
      beforeFlush = snapshot(project);
    env.THERMITE_EVAL_PHASE = "flush";
    const validation = cli(ctx, "validate", ".", "--json");
    writeFileSync(
      join(live, "validate.stdout"),
      redactSecrets(validation.stdout, secretList),
    );
    writeFileSync(
      join(live, "validate.stderr"),
      redactSecrets(validation.stderr, secretList),
    );
    const final = fileState(project, join(runtime, "thermite.real.mjs"), env),
      calls = parseCalls(env.THERMITE_EVAL_LOG);
    final.sourceFiles = documents(project).map((doc) => doc.path);
    const shimErrors = existsSync(env.THERMITE_EVAL_ERRORS)
      ? parseCalls(env.THERMITE_EVAL_ERRORS)
      : [];
    let head;
    try {
      head = read(env.THERMITE_EVAL_LOG + ".state.json").lastHash;
    } catch {
      shimErrors.push({ kind: "shim-error", stage: "missing-head" });
    }
    shimErrors.push(...auditErrors(calls, head));
    if (!calls.some((call) => call.phase === "flush"))
      shimErrors.push({ kind: "shim-error", stage: "missing-flush" });
    ctx.initial = initial;
    ctx.final = final;
    ctx.calls = calls;
    ctx.validationDiagnostics = validationDiagnostics(validation);
    ctx.thermite = join(runtime, "thermite.real.mjs");
    const paths = [
      ...new Set([
        ...documents(project).map((d) => d.path),
        ...(initial.sourceFiles ?? []),
        "system.json",
        "presentation.json",
        ...Object.keys(final.documents).filter((p) =>
          p.startsWith("libraries/"),
        ),
      ]),
    ];
    git(project, "add", "--intent-to-add", ".");
    ctx.sourceDiff = git(project, "diff", "--no-ext-diff", "--", ...paths);
    ctx.metrics = score({
      calls,
      initial,
      final,
      transcript: execution.stdout,
      context,
      engineRoots,
    });
    let outcome =
      stoppingSignal || classification.status === "infrastructure-failure"
        ? {
            pass: false,
            agentFailure: stoppingSignal
              ? "operator-interruption"
              : classification.reason,
          }
        : await evaluateTask(taskDir, ctx);
    outcome = JSON.parse(redactSecrets(JSON.stringify(outcome), secretList));
    if (classification.taskFailure)
      outcome = {
        ...outcome,
        pass: false,
        agentFailure: classification.reason,
      };
    const runtimeAfter = snapshot(runtime, { documents: false }).hash;
    const metrics = score({
      calls,
      initial,
      final,
      runtimeBefore,
      runtimeAfter,
      transcript: execution.stdout,
      context,
      engineRoots,
      guideBytes: readFileSync(join(project, "AGENTS.md")).length,
      guideFiles: [join(project, "AGENTS.md"), join(runtime, "README.md")],
      expectedWarnings: outcome.expectedWarnings ?? task.expectedWarnings,
      actualWarnings:
        outcome.actualWarnings ??
        ctx.validationDiagnostics.filter((d) => d.severity === "warning"),
      requiredTopics: task.requiredTopics,
      allowedUnused: task.allowedUnused,
      preserveSource: task.preserveSource,
      undocumentedShapes: task.undocumentedShapes,
      wallTimeMs: ended - started,
    });
    if (execution.signal || execution.timedOut) metrics.usage.partial = true;
    if (agent === "reference") metrics.usage.partial = false;
    const prices = read(join(here, "prices.json")),
      u = metrics.usage;
    const status =
      classification.status === "infrastructure-failure"
        ? classification.status
        : outcome.error?.kind === "checker-error"
          ? "checker-error"
          : shimErrors.length
            ? "infrastructure-failure"
            : classification.status;
    manifest = {
      ...identity,
      format: "thermite-agent-run/1.1",
      evalVersion: "1.4.0",
      commit: prepared.commit,
      arm,
      context,
      task: task.id,
      agent,
      seed,
      attempt,
      forceRerun,
      automaticRetry,
      status,
      promptHash: sha256(
        prompt.replaceAll(join(runtime, "thermite.mjs"), "{{THERMITE}}"),
      ),
      guideHash: initial.files["AGENTS.md"],
      runtimeHash: { before: runtimeBefore, after: runtimeAfter },
      timings: {
        started,
        ended,
        wallTimeMs: ended - started,
        totalWallTimeMs: Date.now() - runStarted,
      },
      usage: u,
      costEstimate: estimateCost(
        { ...normalized, usage: u },
        configuration.model,
        prices,
      ),
      cliVersions: { bun: Bun.version, agent: cliVersion },
      authentication,
      isolation,
      agentExit: execution.exit,
      agentSignal: execution.signal ?? null,
      agentFailure: classification.reason,
      infrastructureKind:
        status === "infrastructure-failure"
          ? shimErrors.length
            ? "shim"
            : (classification.infrastructureKind ?? "harness")
          : null,
      retryCount: normalized.retryCount,
      retryEvents: normalized.retryEvents,
      completion: { successful: normalized.successfulCompletion },
      shimErrors,
      outcome,
      metrics,
      judgement: task.rubric ? "pending-two-judges" : "not-required",
      taskHash: sha256(readFileSync(join(taskDir, "task.json"))),
      taskTreeHash: snapshot(taskDir, { documents: false }).hash,
      harnessHash: snapshot(here, { documents: false }).hash,
      checkerHarnessHash: snapshot(here, { documents: false }).hash,
      checkerTaskTreeHash: snapshot(taskDir, { documents: false }).hash,
      initialProjectHash: initial.hash,
      logHash: sha256(readFileSync(env.THERMITE_EVAL_LOG)),
      auditHead: head,
      workspace: keep || status === "checker-error" ? work : null,
    };
    if (status === "checker-error")
      save("recheck.json", {
        taskDir,
        project,
        runtime,
        initial,
        final,
        calls,
        sourceDiff: ctx.sourceDiff,
        validationDiagnostics: ctx.validationDiagnostics,
        context,
        engineRoots,
        keep,
      });
    save("before-flush.json", beforeFlush);
    save("final.json", final);
    save("score.json", metrics);
    save("check.json", outcome);
    save("shim-errors.json", shimErrors);
    cpSync(env.THERMITE_EVAL_LOG, join(live, "shim.jsonl"));
    if (task.rubric)
      save(
        "judge-packet.json",
        judgePacket({
          finalMessage: normalized.finalMessage,
          sourceDiff: ctx.sourceDiff,
          project,
          runtime,
          task,
        }),
      );
    cpSync(project, join(live, "project"), { recursive: true });
    save("manifest.json", manifest);
    return manifest;
  } catch (error) {
    manifest = {
      ...identity,
      format: "thermite-agent-run/1.1",
      evalVersion: "1.4.0",
      commit: prepared.commit,
      arm,
      context,
      task: task?.id ?? basename(taskDir),
      agent,
      seed,
      attempt,
      status: "infrastructure-failure",
      outcome: { pass: false },
      metrics: {
        violations: [],
        guideBytes: null,
        failedCalls: null,
        usage: { inputTokens: null },
      },
      timings: {
        started: runStarted,
        ended: Date.now(),
        wallTimeMs: Date.now() - runStarted,
      },
      infrastructureError: redactSecrets(error.message, secretList),
      stage: error.stage ?? "harness",
      infrastructureKind:
        error.stage === "authentication" ? "authentication" : "harness",
      workspace: keep ? work : null,
    };
    save("infrastructure-failure.json", {
      status: manifest.status,
      message: manifest.infrastructureError,
    });
    save("manifest.json", manifest);
    if (existsSync(project))
      cpSync(project, join(live, "project"), { recursive: true });
    return manifest;
  } finally {
    if (authSeed)
      try {
        const refresh = refreshCodexAuth(authSeed, env);
        if (manifest) {
          manifest.authRefresh = refresh;
          save("manifest.json", manifest);
        }
      } catch (error) {
        if (manifest) {
          manifest.status = "infrastructure-failure";
          manifest.infrastructureKind = "authentication";
          manifest.infrastructureError = redactSecrets(
            error.message,
            secretList,
          );
          save("manifest.json", manifest);
        }
      }
    if (manifest?.status === "checker-error" && !keep)
      rmSync(join(work, "isolated"), { recursive: true, force: true });
    if (existsSync(live)) cpSync(live, evidence, { recursive: true });
    if (!keep && manifest?.status !== "checker-error")
      rmSync(work, { recursive: true, force: true });
  }
}
export async function recheckRun({ evidence, forceRecheck = false }) {
  const original = read(join(evidence, "manifest.json"));
  assert(
    original.status === "checker-error",
    "Only a checker error can be rechecked",
  );
  assert(
    original.workspace && existsSync(original.workspace),
    "Kept checker workspace is missing; never rerun the agent automatically",
  );
  const pending = read(join(evidence, "recheck.json"));
  const checkerTaskTreeHash = snapshot(pending.taskDir, {
    documents: false,
  }).hash;
  assert(
    forceRecheck ||
      checkerTaskTreeHash ===
        (original.checkerTaskTreeHash ?? original.taskTreeHash),
    "Task directory changed; use --force-recheck to authorize and record the new checker inputs",
  );
  const stored = read(join(evidence, "recheck.json")),
    task = read(join(stored.taskDir, "task.json")),
    revision = (original.checkerRechecks ?? 0) + 1,
    work = original.workspace,
    live = join(work, `recheck-${revision}`);
  mkdirSync(live);
  assert(
    snapshot(stored.project).hash === stored.final.hash,
    "Kept agent sources changed; refusing recheck",
  );
  const ctx = {
    ...stored,
    task,
    evidence: live,
    env: freshEnvironment(join(work, `recheck-config-${revision}`), {}, {}),
    thermite: join(stored.runtime, "thermite.real.mjs"),
    metrics: original.metrics,
  };
  const outcome = await evaluateTask(stored.taskDir, ctx);
  const metrics = score({
    calls: stored.calls,
    initial: stored.initial,
    final: stored.final,
    runtimeBefore: original.runtimeHash.before,
    runtimeAfter: snapshot(stored.runtime, { documents: false }).hash,
    transcript: readFileSync(join(evidence, "transcript.jsonl"), "utf8"),
    context: stored.context,
    engineRoots: stored.engineRoots,
    guideBytes: readFileSync(join(stored.project, "AGENTS.md")).length,
    guideFiles: [
      join(stored.project, "AGENTS.md"),
      join(stored.runtime, "README.md"),
    ],
    expectedWarnings: outcome.expectedWarnings ?? task.expectedWarnings,
    actualWarnings:
      outcome.actualWarnings ??
      stored.validationDiagnostics.filter((d) => d.severity === "warning"),
    requiredTopics: task.requiredTopics,
    allowedUnused: task.allowedUnused,
    preserveSource: task.preserveSource,
    undocumentedShapes: task.undocumentedShapes,
    wallTimeMs: original.timings.wallTimeMs,
  });
  if (original.agent === "reference") metrics.usage.partial = false;
  if (original.agentFailure) {
    outcome.pass = false;
    outcome.agentFailure = original.agentFailure;
  }
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
    checkerHarnessHash: snapshot(here, { documents: false }).hash,
    checkerTaskTreeHash,
    forceRecheck: forceRecheck || original.forceRecheck || false,
    checkerRecheckHistory: [
      ...(original.checkerRecheckHistory ?? []),
      {
        revision,
        forced: forceRecheck,
        taskTreeHash: checkerTaskTreeHash,
        harnessHash: snapshot(here, { documents: false }).hash,
      },
    ],
  };
  write(
    join(evidence, `checker-history-${String(revision).padStart(3, "0")}.json`),
    original,
  );
  cpSync(live, evidence, { recursive: true });
  if (task.rubric)
    write(
      join(evidence, "judge-packet.json"),
      judgePacket({
        finalMessage: metrics.finalMessage,
        sourceDiff: ctx.sourceDiff,
        project: ctx.project,
        runtime: ctx.runtime,
        task,
      }),
    );
  write(join(evidence, "check.json"), outcome);
  write(join(evidence, "score.json"), metrics);
  if (result.status !== "checker-error" && !stored.keep) {
    result.workspace = null;
    rmSync(work, { recursive: true, force: true });
  }
  write(join(evidence, "manifest.json"), result);
  return result;
}
export async function runAttempts({
  prior = [],
  runAttempt,
  control = { stopped: false },
  forceRerun = false,
  retryDelayMs = 1000,
}) {
  const history = [...prior];
  for (;;) {
    const action = planAttempt(history, forceRerun);
    if (action.kind !== "run")
      return {
        ...action.run,
        ...(action.kind === "exhausted" ? { retryExhausted: true } : {}),
      };
    if (control.stopped || stoppingSignal) return history.at(-1);
    const automaticRetry = automaticInfra(history.at(-1) ?? {});
    if (automaticRetry && retryDelayMs)
      await new Promise((r) => setTimeout(r, retryDelayMs));
    if (control.stopped || stoppingSignal) return history.at(-1);
    const result = await runAttempt({
      attempt: action.attempt,
      forceRerun: action.forceRerun,
      automaticRetry,
    });
    history.push(result);
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
          results.push(result);
          if (result.infrastructureKind === "billing") {
            control.stopped = true;
            control.reason = "billing";
            for (const child of children) killChild(child);
          }
        } catch (error) {
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
async function authOnly(values) {
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
      seed = seedCodexAuth(env, values["codex-auth"]);
      if (values["codex-auth"]) {
        delete env.CODEX_API_KEY;
        delete env.OPENAI_API_KEY;
      }
    }
    assertIsolation(project, env, { codexAuth: !!seed });
    const status = preflightAuth(values.agent, env);
    console.log(JSON.stringify(status));
    if (!status.ok) process.exitCode = 1;
  } finally {
    if (seed) refreshCodexAuth(seed, env);
    if (!values.keep) rmSync(work, { recursive: true, force: true });
  }
}
async function main() {
  const started = Date.now();
  const { values } = parseArgs({
    options: {
      checkpoint: { type: "string" },
      task: { type: "string" },
      all: { type: "boolean" },
      agent: { type: "string", default: "reference" },
      model: { type: "string" },
      effort: { type: "string" },
      arm: { type: "string", default: "A" },
      guide: { type: "string" },
      context: { type: "string", default: "runtime" },
      engine: { type: "string", default: root },
      commit: { type: "string", default: "HEAD" },
      seed: { type: "string", default: "1" },
      concurrency: { type: "string", default: "1" },
      "tasks-dir": { type: "string", default: join(here, "tasks") },
      "print-agent-command": { type: "boolean", default: false },
      "check-auth": { type: "boolean", default: false },
      "codex-auth": { type: "string" },
      keep: { type: "boolean", default: false },
      "force-rerun": { type: "boolean", default: false },
      "force-recheck": { type: "boolean", default: false },
      timeout: { type: "string", default: "900" },
    },
  });
  if (values["check-auth"]) {
    await authOnly(values);
    return;
  }
  assert(
    values.checkpoint &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(values.checkpoint),
    "Use --checkpoint <portable-name>",
  );
  assert(["runtime", "source"].includes(values.context));
  assert(["reference", "claude", "codex"].includes(values.agent));
  const configuration = agentConfiguration({
    agent: values.agent,
    model: values.model,
    effort: values.effort,
  });
  assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(values.arm));
  assert(values.arm === "A" || values.guide, "Alternate arm requires --guide");
  const seed = Number(values.seed),
    concurrency = Number(values.concurrency),
    timeoutMs = Number(values.timeout) * 1000;
  assert(Number.isSafeInteger(seed) && seed > 0);
  assert([1, 2].includes(concurrency));
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0);
  const tasksDir = resolve(values["tasks-dir"]),
    tasks = values.all
      ? readdirSync(tasksDir)
          .filter((t) => existsSync(join(tasksDir, t, "task.json")))
          .sort()
      : [values.task];
  assert(
    tasks.length &&
      tasks.every(
        (t) =>
          t && basename(t) === t && existsSync(join(tasksDir, t, "task.json")),
      ),
    "Use a known task or --all",
  );
  const destination = join(root, "evals/out/agent", values.checkpoint);
  mkdirSync(destination, { recursive: true });
  const preparation = join(destination, "context"),
    contextFile = join(preparation, "context.json"),
    commit = git(
      resolve(values.engine),
      "rev-parse",
      `${values.commit}^{commit}`,
    );
  let prepared;
  if (existsSync(contextFile)) {
    const prior = read(contextFile);
    assert(
      prior.commit === commit && prior.context === values.context,
      "Checkpoint context/commit mismatch",
    );
    prepared = prior.prepared;
  } else {
    mkdirSync(preparation, { recursive: true });
    prepared = await prepareContext({
      engine: resolve(values.engine),
      commit,
      context: values.context,
      destination: preparation,
    });
    const { extractSafeZipArchive } =
      await import("../../scripts/safe-zip-reader.mjs");
    await extractSafeZipArchive(
      execFileSync("git", ["archive", "--format=zip", commit, "examples"], {
        cwd: values.engine,
        maxBuffer: 64 << 20,
      }),
      join(preparation, "fixtures"),
    );
    prepared.examples = join(preparation, "fixtures/examples");
    write(contextFile, { commit, context: values.context, prepared });
  }
  const engineRoots = git(
    resolve(values.engine),
    "worktree",
    "list",
    "--porcelain",
  )
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9));
  const results = await runBatch(tasks, {
    concurrency,
    runTask: async (task, control) => {
      const base = join(
        destination,
        runDirectoryName({
          task,
          agent: values.agent,
          arm: values.arm,
          seed,
          ...configuration,
        }),
      );
      mkdirSync(base, { recursive: true });
      const prior = readdirSync(base)
        .filter((d) => /^attempt-\d+$/.test(d))
        .flatMap((d) => {
          try {
            return [read(join(base, d, "manifest.json"))];
          } catch {
            return [];
          }
        })
        .sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
      const action = planAttempt(prior, values["force-rerun"]);
      const complete = action.run;
      if (["skip", "stopped", "exhausted"].includes(action.kind)) {
        process.stdout.write(
          `${task}: attempt ${complete.attempt}, ${action.kind}${action.reason ? " (" + action.reason + ")" : ""}\n`,
        );
        return {
          ...complete,
          ...(action.kind === "exhausted" ? { retryExhausted: true } : {}),
        };
      }
      if (action.kind === "recheck")
        return recheckRun({
          forceRecheck: values["force-recheck"],
          evidence: join(
            base,
            `attempt-${String(prior.at(-1).attempt).padStart(3, "0")}`,
          ),
        });
      const attempt = action.attempt;
      process.stdout.write(`${task} (attempt ${attempt})…\n`);
      return runAttempts({
        prior,
        control,
        runAttempt: ({ attempt, forceRerun, automaticRetry }) =>
          runOne({
            taskDir: join(tasksDir, task),
            prepared,
            evidence: join(base, `attempt-${String(attempt).padStart(3, "0")}`),
            agent: values.agent,
            model: values.model,
            effort: values.effort,
            arm: values.arm,
            context: values.context,
            seed,
            attempt,
            guide: values.guide && resolve(values.guide),
            printAgentCommand: values["print-agent-command"],
            engineRoots,
            codexAuth: values["codex-auth"],
            keep: values.keep,
            forceRerun,
            automaticRetry,
            timeoutMs,
          }),
        forceRerun: action.forceRerun,
      });
    },
  });
  write(join(destination, "checkpoint.json"), {
    format: "thermite-agent-checkpoint/1.1",
    commit,
    agent: values.agent,
    ...configuration,
    timings: { started, ended: Date.now(), wallTimeMs: Date.now() - started },
    stopped: results.some((r) => r.infrastructureKind === "billing")
      ? "billing"
      : stoppingSignal,
    results: results.map((r) => ({
      runKey: r.runKey,
      model: r.model,
      effort: r.effort,
      modelPin: r.modelPin,
      modelOverrides: r.modelOverrides,
      task: r.task,
      attempt: r.attempt,
      status: r.status,
      forceRerun: r.forceRerun ?? false,
      infrastructureKind: r.infrastructureKind ?? null,
      retryCount: r.retryCount ?? 0,
      retryExhausted: r.retryExhausted ?? false,
      pass: r.outcome?.pass,
      violations: r.metrics?.violations.length,
    })),
  });
  if (
    !stoppingSignal &&
    results.some((r) =>
      r.status === "command-only"
        ? !r.authentication?.ok
        : !isComplete(r) || !r.outcome?.pass || r.metrics.violations.length,
    )
  )
    process.exitCode = 1;
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
