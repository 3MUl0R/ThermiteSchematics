import assert from "node:assert/strict";
import { cp as copyAsync } from "node:fs/promises";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { contributorCommandEnvironment } from "./contributor-commands.mjs";
import { fileStateAsync } from "./audit.mjs";
import {
  preflightAuth,
  seedCodexAuth,
  secretValues,
  redactAgentOutput,
  credentialKeys,
} from "./auth.mjs";
import { classifyAgent, batchHaltReason, runKey } from "./attempts.mjs";
import { snapshot } from "./snapshot.mjs";
import { normalizeTranscript } from "./transcript.mjs";
import { visualBroker } from "./visual-capture.mjs";
import {
  agents,
  launchCommand,
  shellCommand,
  freshEnvironment,
  assertIsolation,
} from "./launch.mjs";
import { write, documents, uid } from "./task-support.mjs";

export function buildRunIdentity(options, configuration, runIdentity) {
  const identity = {
    arm: options.arm,
    context: options.context,
    task: basename(options.taskDir),
    agent: options.agent,
    seed: options.seed,
    ...configuration,
    reopenInfra: options.reopenInfra,
    reopenedHalt: options.reopenedHalt,
    infraRetryDelayMs: options.infraRetryDelayMs,
    checkpointOverride: options.checkpointOverride,
    ...runIdentity,
  };
  identity.runKey = runKey(identity);
  return identity;
}
export function createIsolatedEnv(run) {
  const { work, project, audit, state, options } = run;
  const env = {
    ...freshEnvironment(join(work, "isolated"), process.env, {
      engineRoots: options.engineRoots,
    }),
    THERMITE_EVAL_PROJECT: project,
    THERMITE_EVAL_LOG: join(audit, "shim.jsonl"),
    THERMITE_EVAL_ERRORS: join(audit, "shim-errors.jsonl"),
    THERMITE_EVAL_PHASE: "setup",
    THERMITE_EVAL_AUDIT_ROOT: JSON.stringify(state.auditSource.identity),
  };
  for (const [key, value] of Object.entries(env))
    if (!credentialKeys.includes(key))
      assert(
        !options.engineRoots.some((p) => value.includes(p)),
        `Checkout path leaked through ${key}`,
      );
  if (options.agent === "codex" && options.codexAuth) {
    delete env.CODEX_API_KEY;
    delete env.OPENAI_API_KEY;
  }
  return env;
}
function rewriteCabinetUids(project, taskId, seed) {
  const docs = documents(project),
    ids = new Map(
      docs.flatMap((doc) =>
        doc.objects.map((o) => [
          o.uid,
          uid(`${taskId}/${seed}/${o.designation}`),
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
export async function populateTaskProject(run, ctx, env) {
  const { task } = run.state;
  const { taskDir, prepared, seed, guide, agent } = run.options;
  const { work, project, deps } = run;
  if (["starter", "cabinets"].includes(task.template))
    await deps.setupCLI(
      { ...ctx, project: work },
      "init",
      project,
      ...(task.template === "cabinets" ? ["--template", "cabinets"] : []),
    );
  else {
    await copyAsync(join(prepared.examples, task.template), project, {
      recursive: true,
    });
    const starter = join(work, "starter");
    await deps.setupCLI(ctx, "init", starter);
    await copyAsync(join(starter, "libraries"), join(project, "libraries"), {
      recursive: true,
    });
    cpSync(join(starter, "AGENTS.md"), join(project, "AGENTS.md"));
    await deps.setupCLI(ctx, "lock", project);
  }
  mkdirSync(join(project, "drawings"), { recursive: true });
  if (task.setup) {
    // A scorer-supplied setup hook can itself use synchronous CLI helpers.
    // Run it out of process so its work cannot block sibling exit handling.
    const setupContext = join(work, "setup-context.json");
    const { env: ignored, ...publicContext } = ctx;
    write(setupContext, {
      module: join(taskDir, task.setup),
      context: publicContext,
    });
    await deps.setupCommand(
      process.execPath,
      [join(deps.here, "reference-worker.mjs"), setupContext],
      { cwd: project, env },
    );
  }
  if (task.template === "cabinets") rewriteCabinetUids(project, task.id, seed);
  if (guide) cpSync(guide, join(project, "AGENTS.md"));
  if (agent === "claude") {
    assert(!existsSync(join(project, "CLAUDE.md")));
    writeFileSync(join(project, "CLAUDE.md"), "@AGENTS.md\n");
  }
  await deps.setupGit(project, "init", "--quiet");
  await deps.setupGit(project, "add", ".");
  await deps.setupGit(
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
}
export async function prepareAuthAndLaunch(run, ctx, env) {
  const { state, work, project, runtime, save, deps } = run;
  const { agent, model, effort, codexAuth, timeoutMs } = run.options;
  const authSeeded =
    agent === "codex"
      ? seedCodexAuth(env, codexAuth, { timeoutMs })
      : undefined;
  const isolation = assertIsolation(project, env, {
    claudeLoader: agent === "claude",
    codexAuth: !!authSeeded,
  });
  const authentication =
    agent === "reference"
      ? { ok: true, agent, billing: "none" }
      : await preflightAuth(agent, env, { capture: deps.captureSetup });
  state.secretList = secretValues(env);
  save("auth-status.json", authentication);
  const initial = await fileStateAsync(
    project,
    join(runtime, "thermite.real.mjs"),
    env,
    undefined,
    deps.captureSetup,
  );
  initial.sourceFiles = documents(project).map((doc) => doc.path);
  const runtimeBefore = snapshot(runtime, { documents: false }).hash;
  save("initial.json", initial);
  writeFileSync(env.THERMITE_EVAL_LOG, "");
  write(env.THERMITE_EVAL_LOG + ".state.json", {
    snapshot: initial,
    lastHash: null,
  });
  writeFileSync(env.THERMITE_EVAL_ERRORS, "");
  env.THERMITE_EVAL_PHASE = "agent";
  if (state.task.contributor)
    Object.assign(env, contributorCommandEnvironment(ctx, join(work, "bin")));
  const prompt = `Thermite is at ${ctx.thermite}.\n\n${state.task.prompt.replaceAll("{{THERMITE}}", ctx.thermite)}`;
  const command =
    agent === "reference"
      ? null
      : launchCommand({ agent, project, runtime, prompt, model, effort });
  const cliVersion =
    agent === "reference"
      ? null
      : await deps.agentVersion(agents[agent].binary, {
          env,
          encoding: "utf8",
        });
  return {
    isolation,
    authentication,
    initial,
    runtimeBefore,
    prompt,
    command,
    cliVersion,
  };
}
export function handlePrintAgentCommand(run, env, launched) {
  const { options, configuration, identity, state, work, project, save } = run;
  assert(launched.command, "--print-agent-command requires an agent CLI");
  const environment = Object.fromEntries(
      Object.entries(env).filter(([key]) => !credentialKeys.includes(key)),
    ),
    keys = credentialKeys.filter((key) => env[key]);
  console.log(
    `cd ${shellCommand([project])} && ${shellCommand(["env", "-i", ...Object.entries(environment).map(([key, value]) => `${key}=${value}`)])} ${keys.map((key) => `${key}="$${key}"`).join(" ")} ${shellCommand(launched.command)}`,
  );
  const manifest = {
    ...identity,
    format: "thermite-agent-run/1.1",
    status: "command-only",
    task: state.task.id,
    arm: options.arm,
    agent: options.agent,
    seed: options.seed,
    attempt: options.attempt,
    authentication: launched.authentication,
    workspace: options.keep ? work : null,
  };
  state.manifest = manifest;
  save("command.json", {
    ...configuration,
    environment,
    credentialKeys: keys,
    argv: launched.command,
    cwd: project,
    isolation: launched.isolation,
    authentication: launched.authentication,
  });
  save("manifest.json", manifest);
  return manifest;
}
async function invokeAgentProcess(run, ctx, launched, delivery) {
  const { options, state, work, project, live, deps } = run;
  const stoppingSignal = deps.getStoppingSignal();
  if (stoppingSignal || options.batchControl?.stopped)
    return {
      started: Date.now(),
      agentEnded: undefined,
      captureRetries: 0,
      execution: {
        exit: null,
        signal: stoppingSignal,
        stdout: "",
        stderr: "",
        notStarted: !stoppingSignal,
      },
    };
  if (options.agent === "reference") {
    const workerContext = join(work, "reference-context.json");
    const { env: ignored, ...publicContext } = ctx;
    write(workerContext, {
      module: join(options.taskDir, state.task.reference ?? "reference.mjs"),
      context: publicContext,
    });
    const started = Date.now();
    const execution = await deps.capturedAgent(
      [
        process.execPath,
        join(deps.here, "reference-worker.mjs"),
        workerContext,
      ],
      ctx,
      options.timeoutMs,
    );
    return { started, agentEnded: Date.now(), captureRetries: 0, execution };
  }
  const stopCapture = await visualBroker(
    state.task,
    project,
    live,
    delivery?.observe,
    { workspace: state.workSource, project: state.source },
  );
  let started = Date.now(),
    execution = { exit: 0, stdout: "", stderr: "" },
    agentEnded,
    captureRetries = 0;
  try {
    started = Date.now();
    execution = await deps.capturedAgent(
      launched.command,
      ctx,
      options.timeoutMs,
    );
  } finally {
    agentEnded = Date.now();
    captureRetries = (await stopCapture())?.retries ?? 0;
  }
  return { started, agentEnded, captureRetries, execution };
}
export async function executeAgentRun(run, ctx, launched, delivery) {
  const { options, state, live, deps } = run;
  const { started, agentEnded, captureRetries, execution } =
    await invokeAgentProcess(run, ctx, launched, delivery);
  execution.stdout = redactAgentOutput(execution.stdout, state.secretList);
  execution.stderr = redactAgentOutput(execution.stderr, state.secretList);
  writeFileSync(join(live, "transcript.jsonl"), execution.stdout);
  writeFileSync(join(live, "agent.stderr"), execution.stderr);
  const normalized = normalizeTranscript(execution.stdout, {
      agent: options.agent,
      cliVersion: launched.cliVersion,
    }),
    classification = classifyAgent(
      { ...execution, operatorSignal: deps.getStoppingSignal() },
      normalized,
    ),
    ended = agentEnded ?? Date.now();
  if (options.batchControl && batchHaltReason(classification)) {
    options.batchControl.stopped = true;
    options.batchControl.reason = batchHaltReason(classification);
  }
  return {
    started,
    ended,
    execution,
    captureRetries,
    normalized,
    classification,
  };
}
