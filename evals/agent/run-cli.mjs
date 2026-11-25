import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { harnessIdentity, pinCheckpoint } from "./checkpoint.mjs";
import { readRun } from "./records.mjs";
import { pinnedCliVersion } from "./cli-protocol.mjs";
import {
  isComplete,
  planAttempt,
  haltingInfra,
  batchHaltReason,
  runKey,
  runDirectoryName,
} from "./attempts.mjs";
import { agents, agentConfiguration, freshEnvironment } from "./launch.mjs";
import { read, write } from "./task-support.mjs";

export function parseMainArgs(here, root) {
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
      "reopen-infra": { type: "string" },
      "allow-harness-mismatch": { type: "boolean", default: false },
      timeout: { type: "string", default: "900" },
    },
  });
  const timeoutMs = Number(values.timeout) * 1000;
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0);
  return { values, timeoutMs };
}
export function validateRunSelection(values) {
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
    concurrency = Number(values.concurrency);
  assert(Number.isSafeInteger(seed) && seed > 0);
  assert([1, 2].includes(concurrency));
  const tasksDir = resolve(values["tasks-dir"]);
  const tasks = values.all
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
  const selectedKey = (task) =>
    runKey({
      context: values.context,
      task: read(join(tasksDir, task, "task.json")).id ?? task,
      agent: values.agent,
      seed,
      ...configuration,
    });
  if (values["reopen-infra"] && values["reopen-infra"] !== "all")
    assert(
      tasks.some((task) => selectedKey(task) === values["reopen-infra"]),
      "--reopen-infra must match a selected run key or all",
    );
  return { configuration, seed, concurrency, tasksDir, tasks, selectedKey };
}
export async function prepareCheckpointContext({
  destination,
  values,
  tasksDir,
  git,
  prepareContext,
}) {
  const preparation = join(destination, "context"),
    contextFile = join(preparation, "context.json"),
    commit = git(
      resolve(values.engine),
      "rev-parse",
      `${values.commit}^{commit}`,
    );
  let prepared,
    checkpointPin,
    checkpointOverride = null;
  const currentIdentity = harnessIdentity({ tasksDir });
  if (existsSync(contextFile)) {
    const prior = read(contextFile);
    assert(
      prior.commit === commit && prior.context === values.context,
      "Checkpoint context/commit mismatch",
    );
    checkpointPin = pinCheckpoint(prior, currentIdentity, {
      allowMismatch: values["allow-harness-mismatch"],
    });
    if (
      checkpointPin.identityOverrides.length >
      (prior.identityOverrides?.length ?? 0)
    )
      checkpointOverride = checkpointPin.identityOverrides.at(-1);
    prepared = prior.prepared;
    write(contextFile, { ...prior, ...checkpointPin });
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
    checkpointPin = pinCheckpoint(null, currentIdentity);
    write(contextFile, {
      commit,
      context: values.context,
      prepared,
      ...checkpointPin,
    });
  }
  return {
    commit,
    prepared,
    checkpointPin,
    checkpointOverride,
    currentIdentity,
  };
}
export async function detectBatchCliVersion({
  agent,
  root,
  ownTemp,
  agentVersion,
}) {
  let batchCliVersion = null;
  const protocolWarnings = [];
  if (agent === "reference") return { batchCliVersion, protocolWarnings };
  const versionWork = ownTemp("thermite-cli-version-");
  try {
    const env = freshEnvironment(
      join(versionWork, "isolated"),
      { PATH: process.env.PATH },
      { engineRoots: [root] },
    );
    batchCliVersion = await agentVersion(agents[agent].binary, {
      env,
      cwd: versionWork,
    });
    if (!pinnedCliVersion(agent, batchCliVersion)) {
      protocolWarnings.push({
        code: "unpinned-cli-version",
        agent,
        cliVersion: batchCliVersion,
      });
      process.stderr.write(
        `Warning: unpinned ${agent} CLI version ${batchCliVersion ?? "unknown"}; unknown terminal errors halt for adjudication.\n`,
      );
    }
  } finally {
    rmSync(versionWork, { recursive: true, force: true });
  }
  return { batchCliVersion, protocolWarnings };
}
export function resolveUnresolvedAdjudications({
  destination,
  tasks,
  selectedKey,
  reopenInfra,
}) {
  // An unresolved record blocks every ordinary resume, including a different
  // task selection. Explicit reopen can probe those keys only; it is not an
  // adjudication and cannot authorize unrelated keys to spend more model time.
  const unresolved = readdirSync(destination, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "context")
    .flatMap((d) =>
      readdirSync(join(destination, d.name))
        .filter((name) => /^attempt-\d+$/.test(name))
        .map((name) => join(destination, d.name, name, "manifest.json"))
        .filter(existsSync)
        .map((path) => ({ path, run: readRun(path) })),
    )
    .filter(({ run }) => run.status === "needs-adjudication");
  if (!unresolved.length) return { unresolved, tasks, blocked: false };
  process.stderr.write(
    `Unresolved adjudication blocks this checkpoint: ${unresolved.map(({ path }) => path).join(", ")}\n`,
  );
  if (!reopenInfra) return { unresolved, tasks, blocked: true };
  const filtered = tasks.filter(
    (task) =>
      unresolved.some(({ run }) => runKey(run) === selectedKey(task)) &&
      (reopenInfra === "all" || reopenInfra === selectedKey(task)),
  );
  assert(
    filtered.length,
    "--reopen-infra must target an unresolved key until adjudication",
  );
  return { unresolved, tasks: filtered, blocked: false };
}
function loadPriorAttempts(base) {
  return readdirSync(base)
    .filter((d) => /^attempt-\d+$/.test(d))
    .flatMap((d) => {
      const file = join(base, d, "manifest.json");
      return existsSync(file) ? [readRun(file)] : [];
    })
    .sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
}
function invokeAttempt(params, base, control, attemptArgs) {
  const { task, values, seed, prepared, tasksDir, engineRoots } = params;
  const { checkpointOverride, currentIdentity, timeoutMs, runOne } = params;
  return runOne({
    taskDir: join(tasksDir, task),
    prepared,
    evidence: join(
      base,
      `attempt-${String(attemptArgs.attempt).padStart(3, "0")}`,
    ),
    agent: values.agent,
    model: values.model,
    effort: values.effort,
    arm: values.arm,
    context: values.context,
    seed,
    ...attemptArgs,
    guide: values.guide && resolve(values.guide),
    printAgentCommand: values["print-agent-command"],
    engineRoots,
    codexAuth: values["codex-auth"],
    keep: values.keep,
    batchControl: control,
    checkpointOverride,
    expectedIdentity: currentIdentity,
    tasksRoot: tasksDir,
    timeoutMs,
  });
}
export async function executeCheckpointTask(params) {
  const { task, control, destination, values, seed, configuration } = params;
  const { selectedKey, prepared, recheckRun, runAttempts } = params;
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
  const prior = loadPriorAttempts(base);
  const requestedReopen = values["reopen-infra"];
  const reopenInfra =
    requestedReopen === "all" || requestedReopen === selectedKey(task)
      ? requestedReopen
      : null;
  const action = planAttempt(prior, values["force-rerun"], { reopenInfra });
  if (["skip", "exhausted", "adjudicate"].includes(action.kind)) {
    process.stdout.write(
      `${task}: attempt ${action.run.attempt}, ${action.kind}${action.reason ? " (" + action.reason + ")" : ""}\n`,
    );
    return {
      ...action.run,
      replayed: true,
      ...(action.kind === "exhausted" ? { retryExhausted: true } : {}),
    };
  }
  if (action.kind === "recheck")
    return recheckRun({
      forceRecheck: values["force-recheck"],
      prepared,
      evidence: join(
        base,
        `attempt-${String(prior.at(-1).attempt).padStart(3, "0")}`,
      ),
    });
  process.stdout.write(`${task} (attempt ${action.attempt})…\n`);
  const result = await runAttempts({
    prior,
    control,
    reopenInfra,
    runAttempt: (attemptArgs) =>
      invokeAttempt(params, base, control, attemptArgs),
    forceRerun: action.forceRerun,
  });
  if (result?.stage === "authentication" && !result.replayed)
    process.stderr.write(`${task}: ${result.infrastructureError}\n`);
  return result;
}
export function writeCheckpointSummary({
  destination,
  checkpointPin,
  commit,
  values,
  configuration,
  batchCliVersion,
  protocolWarnings,
  started,
  results,
  unresolved,
  stoppingSignal,
}) {
  write(join(destination, "checkpoint.json"), {
    format: "thermite-agent-checkpoint/1.1",
    ...checkpointPin,
    commit,
    agent: values.agent,
    ...configuration,
    batchCliVersion,
    protocolWarnings,
    timings: { started, ended: Date.now(), wallTimeMs: Date.now() - started },
    reopenInfra: values["reopen-infra"] ?? null,
    stopped:
      batchHaltReason(
        results.find(
          (r) =>
            r.status === "needs-adjudication" ||
            (!r.replayed && haltingInfra(r)),
        ),
      ) ?? stoppingSignal,
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
      reopenInfra: r.reopenInfra ?? null,
      reopenedHalt: r.reopenedHalt ?? false,
      warnings: r.warnings ?? [],
      checkpointOverride: r.checkpointOverride ?? null,
      pass: r.outcome?.pass,
      violations: r.metrics?.violations.length,
      attemptedWrites: r.metrics?.attemptedWrites?.length ?? 0,
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
  if (
    !stoppingSignal &&
    unresolved.some(({ path }) => readRun(path).status === "needs-adjudication")
  )
    process.exitCode = 1;
}
