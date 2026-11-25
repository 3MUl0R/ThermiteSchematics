import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { evalVersion, harnessIdentity } from "./checkpoint.mjs";
import { fileState, auditErrors } from "./audit.mjs";
import { initAudit } from "./audit-files.mjs";
import { redactSecrets } from "./auth.mjs";
import { batchHaltReason } from "./attempts.mjs";
import { estimateCost } from "./cost.mjs";
import { snapshot, sha256 } from "./snapshot.mjs";
import { score } from "./score-log.mjs";
import {
  conveyorMetrics,
  phaseConveyorCalls,
} from "./conveyor-measurement.mjs";
import { copyConfinedTree, projectReader } from "./capture-files.mjs";
import { freshEnvironment } from "./launch.mjs";
import { cli, read, documents } from "./task-support.mjs";
import { snapshotScopeError } from "./source-files.mjs";

function copyFlushAuditFiles(auditSource, flushAudit) {
  const auditInputErrors = [];
  initAudit(flushAudit);
  const flushSource = projectReader(flushAudit);
  const flushIdentity = flushSource.identity;
  flushSource.close();
  for (const file of [
    "shim.jsonl",
    "shim-errors.jsonl",
    "shim.jsonl.state.json",
  ])
    try {
      writeFileSync(join(flushAudit, file), auditSource.read(file));
    } catch {
      auditInputErrors.push({
        kind: "shim-error",
        stage: "audit-input",
        file,
      });
    }
  return { flushIdentity, auditInputErrors };
}
function collectShimAuditErrors(
  ctx,
  auditInputErrors,
  rawCalls,
  trusted,
  flushStarted,
  parseCalls,
) {
  const shimErrors = [
    ...auditInputErrors,
    ...parseCalls(ctx.env.THERMITE_EVAL_ERRORS),
  ];
  let head;
  try {
    head = read(ctx.env.THERMITE_EVAL_LOG + ".state.json").lastHash;
  } catch {
    shimErrors.push({ kind: "shim-error", stage: "missing-head" });
  }
  shimErrors.push(...auditErrors(rawCalls, head));
  if (
    trusted &&
    !rawCalls.some(
      (call) =>
        call.started >= flushStarted &&
        call.phase === "flush" &&
        JSON.stringify(call.argv) ===
          JSON.stringify(["validate", ".", "--json"]),
    )
  )
    shimErrors.push({ kind: "shim-error", stage: "missing-flush" });
  return { shimErrors, head };
}
function stagePostAgentProject(run) {
  const { state, project, live, deps } = run;
  // Every project-dependent step below needs a directory at the root's
  // path; without one the run cannot be scored, though its judge packet
  // still records the refusal.
  let projectDirectory = false;
  try {
    projectDirectory = state.workSource.inspect("project").isDirectory();
  } catch {}
  if (!projectDirectory) {
    state.rootRefused = true;
    deps.runHooks.afterRootLoss?.(project);
    throw new Error(
      "Project root is missing or no longer a directory after the agent exited; the run cannot be scored",
    );
  }
  const rootIntact = state.source.intact();
  state.rootRefused = !rootIntact;
  const stagedProject = rootIntact
    ? join(live, "project")
    : join(state.scratch, "empty-project");
  let projectRefusals = ["."];
  if (rootIntact) {
    state.archiveProject = stagedProject;
    projectRefusals = copyConfinedTree(state.source, stagedProject);
  } else mkdirSync(stagedProject);
  return { rootIntact, stagedProject, projectRefusals };
}
function runTrustedFlushValidation(
  run,
  ctx,
  stagedProject,
  beforeFlush,
  trusted,
) {
  const { state, live, deps } = run;
  let final = { ...beforeFlush, schemaInvalidFiles: [] };
  ctx.validationDiagnostics = [];
  const flushStarted = Date.now();
  if (trusted) {
    ctx.thermite = join(trusted.runtime, "thermite.mjs");
    const validation = cli(ctx, "validate", ".", "--json");
    writeFileSync(
      join(live, "validate.stdout"),
      redactSecrets(validation.stdout, state.secretList),
    );
    writeFileSync(
      join(live, "validate.stderr"),
      redactSecrets(validation.stderr, state.secretList),
    );
    ctx.thermite = join(trusted.runtime, "thermite.real.mjs");
    ctx.validationDiagnostics = deps.validationDiagnostics(validation);
    final = fileState(stagedProject, ctx.thermite, ctx.env);
  }
  return { final, flushStarted };
}
function buildFlushEnv(run, stagedProject, flushAudit, flushIdentity, trusted) {
  return {
    ...freshEnvironment(
      join(run.state.scratch, "isolated"),
      { PATH: process.env.PATH, TERM: process.env.TERM },
      { engineRoots: run.options.engineRoots },
    ),
    THERMITE_EVAL_PROJECT: stagedProject,
    THERMITE_EVAL_LOG: join(flushAudit, "shim.jsonl"),
    THERMITE_EVAL_ERRORS: join(flushAudit, "shim-errors.jsonl"),
    THERMITE_EVAL_PHASE: "flush",
    THERMITE_EVAL_AUDIT_ROOT: JSON.stringify(flushIdentity),
    ...(trusted && { THERMITE_EVAL_BUN_CONFIG: trusted.config }),
  };
}
export async function stageAndFlushProject(run, ctx, runResult, conveyor) {
  const { state, options, project, deps } = run;
  const { rootIntact, stagedProject, projectRefusals } =
    stagePostAgentProject(run);
  const beforeFlush = snapshot(stagedProject);
  const scopeError = snapshotScopeError(
    stagedProject,
    beforeFlush.documents["system.json"],
  );
  const scopeFailure =
    scopeError &&
    !batchHaltReason(runResult.classification) &&
    !runResult.execution.notStarted;
  const flushAudit = join(state.scratch, "audit");
  const { flushIdentity, auditInputErrors } = copyFlushAuditFiles(
    state.auditSource,
    flushAudit,
  );
  // From here on, CLI calls run with harness privileges: never from the
  // agent-writable runtime, never with the project's Bun config or .env
  // files, and only with environment values the harness selects.
  const trusted = scopeError
    ? null
    : await deps.protectedRuntime(
        options.prepared.path,
        state.scratch,
        state.task,
      );
  ctx.env = buildFlushEnv(
    run,
    stagedProject,
    flushAudit,
    flushIdentity,
    trusted,
  );
  ctx.originalProject = project;
  ctx.project = stagedProject;
  const { final, flushStarted } = runTrustedFlushValidation(
    run,
    ctx,
    stagedProject,
    beforeFlush,
    trusted,
  );
  const rawCalls = deps.parseCalls(ctx.env.THERMITE_EVAL_LOG);
  const calls = conveyor
    ? phaseConveyorCalls(rawCalls, runResult.started, runResult.ended)
    : rawCalls;
  final.sourceFiles = documents(stagedProject).map((doc) => doc.path);
  const { shimErrors, head } = collectShimAuditErrors(
    ctx,
    auditInputErrors,
    rawCalls,
    trusted,
    flushStarted,
    deps.parseCalls,
  );
  return {
    rootIntact,
    stagedProject,
    projectRefusals,
    beforeFlush,
    scopeError,
    scopeFailure,
    final,
    calls,
    shimErrors,
    head,
  };
}
export function buildRunSourceDiff(run, before, initial, flushed) {
  const { state, deps } = run;
  const { rootIntact, projectRefusals, stagedProject, final } = flushed;
  const paths = [
    ...new Set([
      ...final.sourceFiles,
      ...(initial.sourceFiles ?? []),
      "system.json",
      "presentation.json",
      ...[initial, final].flatMap((s) =>
        Object.keys(s.documents).filter((p) => p.startsWith("libraries/")),
      ),
    ]),
  ];
  return deps.selectedDiff({
    before,
    scratch: state.scratch,
    paths,
    read(path) {
      if (
        !rootIntact ||
        projectRefusals.some(
          (refused) => path === refused || path.startsWith(refused + "/"),
        )
      )
        throw new Error("Project snapshot refused the selected path");
      const staged = join(stagedProject, path);
      return deps.fileAt(staged) ? readFileSync(staged) : null;
    },
  });
}
async function evaluateRunOutcome(run, ctx, runResult, flushed, agentStopped) {
  const { options, state, deps } = run;
  const { classification } = runResult;
  const stoppingSignal = deps.getStoppingSignal();
  let outcome =
    stoppingSignal || (agentStopped && !flushed.scopeFailure)
      ? {
          pass: false,
          agentFailure: stoppingSignal
            ? "operator-interruption"
            : classification.reason,
        }
      : flushed.scopeFailure
        ? {
            pass: false,
            agentFailure: "snapshot-scope",
            message: flushed.scopeError,
          }
        : await deps.evaluateTask(options.taskDir, ctx);
  outcome = JSON.parse(
    redactSecrets(JSON.stringify(outcome), state.secretList),
  );
  const independentlyChecked = outcome.pass;
  if (classification.taskFailure && !flushed.scopeFailure)
    outcome = {
      ...outcome,
      pass: false,
      agentFailure: classification.reason,
      warnings: classification.warnings ?? [],
      exitAfterCompletion: classification.exitAfterCompletion ?? false,
      retryAt: classification.retryAt ?? null,
    };
  assert.equal(
    harnessIdentity({ tasksDir: options.tasksRoot }).checkerHash,
    run.runIdentity.checkerHash,
    "Harness changed during run; result cannot be scored",
  );
  return { outcome, independentlyChecked };
}
function resolveRunStatus(deps, flushed, agentStopped, runResult, outcome) {
  if (deps.getStoppingSignal()) return "interrupted";
  if (flushed.scopeFailure) return "task-failure";
  if (agentStopped) return runResult.classification.status;
  if (outcome.error?.kind === "checker-error") return "checker-error";
  if (flushed.shimErrors.length) return "infrastructure-failure";
  return runResult.classification.status;
}
function readRuntimeAfterHash(runtime, runtimeSource) {
  let runtimeAfter = null;
  try {
    runtimeAfter = snapshot(runtime, {
      documents: false,
      reader: runtimeSource,
    }).hash;
  } catch {}
  // An unreadable or replaced runtime is a change for V5.
  return runtimeAfter ?? "refused";
}
export async function evaluateAndScoreRun(
  run,
  ctx,
  launched,
  runResult,
  flushed,
  guideBytes,
) {
  const { options, state, project, runtime, deps } = run;
  // Let queued operator signals run after synchronous CLI flush work.
  await new Promise((resolve) => setImmediate(resolve));
  const agentStopped = [
    "infrastructure-failure",
    "halted-infra",
    "needs-adjudication",
    "interrupted",
    "not-started",
  ].includes(runResult.classification.status);
  const { outcome, independentlyChecked } = await evaluateRunOutcome(
    run,
    ctx,
    runResult,
    flushed,
    agentStopped,
  );
  const runtimeAfter = readRuntimeAfterHash(runtime, state.runtimeSource);
  const metrics = score({
    calls: flushed.calls,
    initial: launched.initial,
    final: flushed.final,
    runtimeBefore: launched.runtimeBefore,
    runtimeAfter,
    transcript: runResult.execution.stdout,
    context: options.context,
    engineRoots: options.engineRoots,
    guideBytes,
    guideFiles: [join(project, "AGENTS.md"), join(runtime, "README.md")],
    expectedWarnings: outcome.expectedWarnings ?? state.task.expectedWarnings,
    actualWarnings:
      outcome.actualWarnings ??
      ctx.validationDiagnostics.filter((d) => d.severity === "warning"),
    requiredTopics: state.task.requiredTopics,
    taskOutcome: outcome,
    allowedUnused: state.task.allowedUnused,
    allowedLibraryPaths: state.task.allowedLibraryPaths,
    guideCopy: state.task.guideCopy,
    preserveSource: state.task.preserveSource,
    undocumentedShapes: state.task.undocumentedShapes,
    wallTimeMs: runResult.ended - runResult.started,
  });
  if (runResult.execution.signal || runResult.execution.timedOut)
    metrics.usage.partial = true;
  if (
    options.agent === "reference" &&
    !runResult.execution.notStarted &&
    !deps.getStoppingSignal()
  )
    metrics.usage.partial = false;
  await new Promise((resolve) => setImmediate(resolve));
  const status = resolveRunStatus(
    deps,
    flushed,
    agentStopped,
    runResult,
    outcome,
  );
  return { outcome, independentlyChecked, runtimeAfter, metrics, status };
}
function buildManifestHeader(run, launched, runResult, scored) {
  const { options, state, identity, configuration, runtime, runStarted, deps } =
    run;
  const { normalized, started, ended } = runResult;
  const { status, metrics, runtimeAfter } = scored;
  const prices = read(join(deps.here, "prices.json")),
    u = metrics.usage;
  return {
    ...identity,
    format: "thermite-agent-run/1.1",
    evalVersion,
    commit: options.prepared.commit,
    arm: options.arm,
    context: options.context,
    task: state.task.id,
    agent: options.agent,
    seed: options.seed,
    attempt: options.attempt,
    forceRerun: options.forceRerun,
    automaticRetry: options.automaticRetry,
    status,
    promptHash: sha256(
      launched.prompt.replaceAll(join(runtime, "thermite.mjs"), "{{THERMITE}}"),
    ),
    guideHash: launched.initial.files["AGENTS.md"],
    runtimeHash: { before: launched.runtimeBefore, after: runtimeAfter },
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
    cliVersions: { bun: Bun.version, agent: launched.cliVersion },
    authentication: launched.authentication,
    isolation: launched.isolation,
  };
}
export function buildCompleteManifest(
  run,
  ctx,
  launched,
  runResult,
  flushed,
  scored,
) {
  const { options, state, runIdentity, work } = run;
  const { classification, execution, normalized } = runResult;
  const { status, outcome, metrics } = scored;
  return {
    ...buildManifestHeader(run, launched, runResult, scored),
    agentExit: execution.exit,
    agentSignal: execution.signal ?? null,
    agentFailure:
      status === "task-failure" ? "snapshot-scope" : classification.reason,
    warnings: classification.warnings ?? [],
    exitAfterCompletion: classification.exitAfterCompletion ?? false,
    retryAt: classification.retryAt ?? null,
    haltBatch: classification.haltBatch ?? false,
    terminalTemplate: normalized.terminalTemplate,
    infrastructureKind: ["infrastructure-failure", "halted-infra"].includes(
      status,
    )
      ? flushed.shimErrors.length
        ? "shim"
        : (classification.infrastructureKind ?? "harness")
      : null,
    retryCount: normalized.retryCount,
    retryEvents: normalized.retryEvents,
    completion: { successful: normalized.successfulCompletion },
    shimErrors: flushed.shimErrors,
    outcome,
    metrics,
    judgement: state.task.rubric ? "pending-two-judges" : "not-required",
    taskVersion: state.task.version,
    taskHash: sha256(readFileSync(join(options.taskDir, "task.json"))),
    taskTreeHash: snapshot(options.taskDir, { documents: false }).hash,
    ...runIdentity,
    checkerTaskTreeHash: snapshot(options.taskDir, { documents: false }).hash,
    initialProjectHash: launched.initial.hash,
    logHash: sha256(readFileSync(ctx.env.THERMITE_EVAL_LOG)),
    auditHead: flushed.head,
    projectRefusals: flushed.projectRefusals,
    workspace: options.keep || status === "checker-error" ? work : null,
  };
}
function buildRecheckPayload(
  run,
  ctx,
  launched,
  runResult,
  flushed,
  delivery,
  guideBytes,
) {
  const { options, state, project, runtime, runStarted } = run;
  return {
    taskDir: options.taskDir,
    tasksRoot: options.tasksRoot,
    project,
    runtime,
    projectRoot: state.source.identity,
    workspaceRoot: state.workSource.identity,
    projectRefusals: flushed.projectRefusals,
    guideBytes,
    initial: launched.initial,
    final: flushed.final,
    calls: flushed.calls,
    sourceDiff: ctx.sourceDiff,
    validationDiagnostics: ctx.validationDiagnostics,
    context: options.context,
    engineRoots: options.engineRoots,
    keep: options.keep,
    ...(delivery && {
      deliveryTiming: {
        candidates: delivery.candidates,
        captureRetries: runResult.captureRetries,
        started: runResult.started,
        ended: runResult.ended,
        runStarted,
        timeoutMs: options.timeoutMs,
        timedOut: runResult.execution.timedOut ?? false,
      },
    }),
  };
}
export function writeRunReceipts(
  run,
  ctx,
  launched,
  runResult,
  flushed,
  scored,
  delivery,
  guideBytes,
) {
  const { options, state, project, runtime, live, runStarted, save, deps } =
    run;
  const { status, metrics, outcome, independentlyChecked } = scored;
  if (delivery) {
    metrics.delivery = conveyorMetrics({
      ctx,
      outcome,
      independentlyChecked,
      candidates: delivery.candidates,
      captureRetries: runResult.captureRetries,
      started: runResult.started,
      ended: runResult.ended,
      runStarted,
      status,
      timeoutMs: options.timeoutMs,
      timedOut: runResult.execution.timedOut ?? false,
      violations: metrics.violations,
    });
    save("delivery-candidates.json", delivery.candidates);
  }
  if (status === "checker-error")
    save(
      "recheck.json",
      buildRecheckPayload(
        run,
        ctx,
        launched,
        runResult,
        flushed,
        delivery,
        guideBytes,
      ),
    );
  save("before-flush.json", flushed.beforeFlush);
  save("final.json", flushed.final);
  save("score.json", metrics);
  save("check.json", outcome);
  save("shim-errors.json", flushed.shimErrors);
  cpSync(ctx.env.THERMITE_EVAL_LOG, join(live, "shim.jsonl"));
  if (state.task.rubric)
    save(
      "judge-packet.json",
      deps.judgePacket({
        finalMessage: runResult.normalized.finalMessage,
        sourceDiff: ctx.sourceDiff,
        project,
        runtime,
        task: state.task,
        source: state.source,
        rootRefused: !flushed.rootIntact,
      }),
    );
  save("manifest.json", state.manifest);
}
export function handleRunFailure(run, error) {
  const { options, state, identity, work, project, runtime, live } = run;
  const { runStarted, save, deps } = run;
  const manifest = {
    ...identity,
    format: "thermite-agent-run/1.1",
    evalVersion,
    commit: options.prepared.commit,
    arm: options.arm,
    context: options.context,
    task: state.task?.id ?? basename(options.taskDir),
    agent: options.agent,
    seed: options.seed,
    attempt: options.attempt,
    status: deps.getStoppingSignal() ? "interrupted" : "infrastructure-failure",
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
    infrastructureError: redactSecrets(error.message, state.secretList),
    stage: error.stage ?? "harness",
    infrastructureKind:
      error.stage === "authentication" ? "authentication" : "harness",
    ...(state.rootRefused && { projectRefusals: ["."] }),
    workspace: options.keep ? work : null,
  };
  // A rubric run whose agent finished but whose project root was lost or
  // replaced still publishes the whole-root refusal.
  if (state.task?.rubric && state.source && state.finalMessage !== undefined)
    try {
      // A detected loss stands even if the directory comes back later.
      if (state.rootRefused || !state.source.intact())
        save(
          "judge-packet.json",
          deps.judgePacket({
            finalMessage: state.finalMessage,
            sourceDiff: null,
            project,
            runtime,
            task: state.task,
            source: state.source,
            rootRefused: true,
          }),
        );
    } catch {}
  save("infrastructure-failure.json", {
    status: manifest.status,
    message: manifest.infrastructureError,
  });
  save("manifest.json", manifest);
  if (!state.rootRefused && !state.archiveProject)
    try {
      // If setup failed before the project was pinned, no agent ran.
      state.source ??= projectReader(project);
      if (state.source.intact())
        copyConfinedTree(state.source, join(live, "project"));
    } catch {}
  return manifest;
}
export function cleanupRunResources(run) {
  const { state, options, work, live, save } = run;
  try {
    state.auditSource?.close();
    state.source?.close();
    state.runtimeSource?.close();
  } finally {
    if (state.scratch) rmSync(state.scratch, { recursive: true, force: true });
  }
  try {
    if (!options.keep && state.manifest?.status === "checker-error")
      state.workSource?.remove("isolated");
    else if (!options.keep) state.workSource?.removeRoot();
  } catch (error) {
    if (state.manifest) {
      state.manifest.workspace = work;
      state.manifest.cleanupError = error.message;
      save("manifest.json", state.manifest);
    }
  } finally {
    state.workSource?.close();
    try {
      cpSync(live, options.evidence, { recursive: true });
    } finally {
      rmSync(live, { recursive: true, force: true });
    }
  }
}
