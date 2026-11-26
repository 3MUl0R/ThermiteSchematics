import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, rename, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  prepareConflictSentinel,
  verifyConflictSentinel,
} from "./conflict-sentinel.mjs";
import {
  CI_CONFLICT_PAIRS,
  expectedConflictRowIds,
} from "./contract-barrier-spec.mjs";
import { patchEngine, writeFileAtomically } from "./engine.mjs";
const {
  createInternalApplySourcePatchTool,
  defaultApplySourcePatchDependencies,
} = await patchEngine();
import {
  cli,
  streams,
  request,
  patchRequest,
  filePatch,
  temporary,
  probe,
  root,
  json,
  edit,
  required,
  observed,
  terminateSpawnedChild,
} from "./support.mjs";

const deviceFile = "devices/equipment.json";
const wireFile = "connections/wires.json";
const operation = (value = "Synthetic guarded edit") => ({
  op: "replace",
  path: "/objects/0/description",
  value,
});

async function snapshot(project) {
  return Promise.all(
    [deviceFile, wireFile, "presentation.json"].map((file) =>
      readFile(join(project, file), "utf8"),
    ),
  );
}

function send(worker, message) {
  if (!worker.child.connected) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    worker.child.send(message, (error) => {
      if (error && !["ERR_IPC_CHANNEL_CLOSED", "EPIPE"].includes(error.code))
        reject(error);
      else resolve(!error);
    });
  });
}
function remainingBeforeDeadline(deadlineAt, fallbackMs) {
  if (deadlineAt == null) return fallbackMs;
  const remaining = deadlineAt - performance.now();
  if (remaining <= 0) {
    return 0;
  }
  return Math.min(fallbackMs, remaining);
}
function deadlineError(label) {
  return Object.assign(new Error(`Barrier deadline exceeded: ${label}`), {
    code: "DEADLINE_EXCEEDED",
  });
}
function awaitWorkerCompletion(child, state, options) {
  const { deadlineAt, signal, hasDeadline, detachedProcessGroup, unregister } =
    options;
  return new Promise((resolve, reject) => {
    const timeoutMs = remainingBeforeDeadline(deadlineAt, 30000);
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      unregister?.();
      if (err) reject(err);
      else resolve(value);
    };
    const killWorker = () => {
      if (hasDeadline) {
        terminateSpawnedChild(child, detachedProcessGroup);
        try {
          if (child.connected) child.disconnect();
        } catch {
          // Ignore disconnected IPC channel.
        }
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        child.unref?.();
      } else {
        child.kill();
      }
    };
    const onAbort = () => {
      killWorker();
      finish(deadlineError("patch worker"));
    };
    const deadline = setTimeout(
      () => {
        killWorker();
        finish(
          deadlineAt != null && timeoutMs < 30000
            ? deadlineError("patch worker")
            : new Error("Patch worker deadline exceeded"),
        );
      },
      Math.max(1, Math.ceil(timeoutMs)),
    );
    if (hasDeadline) deadline.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      state.done = true;
      finish(null, { code, stdout: state.stdout, stderr: state.stderr });
    });
  });
}
function worker(input, deadlineAt = null, deadlineOptions = null) {
  const signal = deadlineOptions?.signal ?? null;
  const registerChild = deadlineOptions?.registerChild ?? null;
  const hasDeadline =
    deadlineAt != null || signal != null || typeof registerChild === "function";
  if (
    hasDeadline &&
    (signal?.aborted || (deadlineAt != null && performance.now() >= deadlineAt))
  ) {
    throw deadlineError("patch worker");
  }
  const detachedProcessGroup = hasDeadline && process.platform !== "win32";
  const child = spawn(
    process.execPath,
    [join(root, "evals/engine/patch-worker.mjs"), input],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      ...(detachedProcessGroup ? { detached: true } : {}),
    },
  );
  const unregister = registerChild?.(child, { detachedProcessGroup });
  const state = { stdout: "", stderr: "", done: false };
  const events = new Set();
  child.stdout.on("data", (data) => {
    state.stdout += data;
  });
  child.stderr.on("data", (data) => {
    state.stderr += data;
  });
  child.on("message", (message) => events.add(message));
  const completion = awaitWorkerCompletion(child, state, {
    deadlineAt,
    signal,
    hasDeadline,
    detachedProcessGroup,
    unregister,
  });
  completion.catch(() => {}); // errors are consumed by the round, not unhandled
  return {
    child,
    detachedProcessGroup,
    events,
    completion,
    get done() {
      return state.done;
    },
  };
}
async function until(predicate, label, deadlineAt = null, signal = null) {
  const localDeadline = performance.now() + 10000;
  const effectiveDeadline =
    deadlineAt != null ? Math.min(localDeadline, deadlineAt) : localDeadline;
  while (!predicate()) {
    if (signal?.aborted) throw deadlineError(label);
    if (performance.now() > effectiveDeadline) {
      if (deadlineAt != null && performance.now() >= deadlineAt) {
        throw deadlineError(label);
      }
      throw new Error(`Barrier timeout: ${label}`);
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, 5);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal) {
        timer.unref?.();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}
async function stop(workers, bounded = false) {
  for (const w of workers) {
    if (!w.done) {
      if (bounded) terminateSpawnedChild(w.child, w.detachedProcessGroup);
      else w.child.kill();
    }
  }
  const wait = Promise.allSettled(workers.map((w) => w.completion));
  if (!bounded) {
    await wait;
    return;
  }
  let timer;
  try {
    await Promise.race([
      wait,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1500);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function summarizeConflictEvidence(
  outcomes,
  releasedBy,
  finalDescription,
  sentinel,
) {
  const exits = outcomes.map((o) => o.code);
  const loserIndex = outcomes.findIndex((o) => o.code !== 0);
  const loser = loserIndex >= 0 ? outcomes[loserIndex] : null;
  const loserCode = loser
    ? (JSON.parse(loser.stderr).error?.code ?? null)
    : null;
  const base = {
    releasedBy,
    overlapped: releasedBy !== "peer-finished-without-overlap",
    exits,
    loserCode,
    finalDescription,
  };
  if (!sentinel) return base;
  const winners = exits
    .map((code, index) => (code === 0 ? (index === 0 ? "A" : "B") : null))
    .filter(Boolean);
  const winnerWriter = winners.length === 1 ? winners[0] : null;
  const loserWriter = loserIndex === 0 ? "A" : loserIndex === 1 ? "B" : null;
  return {
    ...base,
    winner: winnerWriter
      ? { writer: winnerWriter, exitCode: 0, finalDescription }
      : null,
    loser: loser
      ? { writer: loserWriter, exitCode: loser.code, errorCode: loserCode }
      : null,
    sentinel,
  };
}
function assertConflictEvidence(outcomes, evidence, strictSentinel = false) {
  assert.equal(
    outcomes.filter((o) => o.code === 0).length,
    1,
    `Exactly one writer must win; observed exits ${evidence.exits}`,
  );
  const loser = outcomes.find((o) => o.code !== 0);
  assert([1, 2].includes(loser.code));
  assert(
    ["A004", "A005"].includes(evidence.loserCode),
    "Loser must report stale integrity or lock contention",
  );
  assert.equal(
    JSON.parse(outcomes.find((o) => o.code === 0).stdout).value.applied,
    true,
  );
  assert.equal(evidence.finalDescription, outcomes[0].code === 0 ? "A" : "B");
  if (strictSentinel) {
    assert.equal(
      evidence.sentinel?.untouched,
      true,
      `Conflict barrier compromised outside sentinel ${evidence.sentinel?.path ?? "<missing>"}${evidence.sentinel?.reasons?.length ? `: ${evidence.sentinel.reasons.join(" ")}` : ""}`,
    );
  }
}
async function prepareConflictInputs(
  project,
  directory,
  deadlineAt,
  deadlineOptions = null,
) {
  const files = [];
  const cliOptions =
    deadlineAt != null || deadlineOptions
      ? {
          deadlineAt,
          signal: deadlineOptions?.signal ?? null,
          registerChild: deadlineOptions?.registerChild ?? null,
        }
      : undefined;
  for (const name of ["A", "B"]) {
    if (
      deadlineOptions?.signal?.aborted ||
      (deadlineAt != null && performance.now() >= deadlineAt)
    ) {
      throw deadlineError(`prepare writer ${name}`);
    }
    const input = join(directory, `${name}.json`);
    const file = await filePatch(project, deviceFile, [
      {
        op: "test",
        path: "/objects/0/description",
        value: "Synthetic control source",
      },
      operation(name),
    ]);
    const req = patchRequest(project, [file], false);
    streams(
      await cli(
        "apply-source-patch",
        { ...req, dryRun: true },
        ["--input", "-"],
        cliOptions,
      ),
      "apply-source-patch",
      0,
    );
    await writeFile(input, json(req));
    files.push(input);
  }
  return files;
}
async function conflict(project, directory, options = {}) {
  const {
    strictSentinel = false,
    deadlineAt = null,
    afterConflict = null,
    signal = null,
    registerChild = null,
  } = options;
  const deadlineOptions =
    deadlineAt != null || signal || registerChild
      ? { signal, registerChild }
      : null;
  const preparedSentinel = strictSentinel
    ? await prepareConflictSentinel(directory)
    : null;
  const files = await prepareConflictInputs(
    project,
    directory,
    deadlineAt,
    deadlineOptions,
  );
  const workers = files.map((input) =>
    worker(input, deadlineAt, deadlineOptions),
  );
  try {
    await until(
      () => workers.every((w) => w.events.has("ready") || w.done),
      "both processes ready",
      deadlineAt,
      signal,
    );
    if (!workers.every((w) => w.events.has("ready")))
      throw new Error("Worker exited before ready");
    // Hold A at precommit BEFORE B starts. On WS-C, B must actually attempt
    // reservation while A holds it; on historical engines both captured
    // snapshots must overlap. There is no elapsed-time fallback release.
    await send(workers[0], "start");
    await until(
      () => workers[0].events.has("barrier") || workers[0].done,
      "owner precommit snapshot",
      deadlineAt,
      signal,
    );
    if (!workers[0].events.has("barrier"))
      throw new Error("Owner exited before snapshot barrier");
    await send(workers[1], "start");
    await until(
      () =>
        workers[1].events.has("barrier") ||
        workers[1].events.has("contended") ||
        workers[1].done,
      "peer captured snapshot or reservation contention",
      deadlineAt,
      signal,
    );
    const releasedBy = workers[1].events.has("barrier")
      ? "both-precommit-barriers"
      : workers[1].events.has("contended")
        ? "reservation-contention"
        : "peer-finished-without-overlap";
    // Exactly one release per worker barrier; callbacks handle disconnect races.
    await send(workers[0], "release");
    if (workers[1].events.has("barrier")) await send(workers[1], "release");
    const outcomes = await Promise.all(workers.map((w) => w.completion));
    for (const outcome of outcomes) {
      assert([0, 1, 2].includes(outcome.code));
      streams(outcome, "apply-source-patch", outcome.code);
    }
    const actual = JSON.parse(
      await readFile(join(project, deviceFile), "utf8"),
    );
    if (preparedSentinel && typeof afterConflict === "function") {
      await afterConflict({
        project,
        directory,
        sentinelPath: preparedSentinel.sentinelPath,
      });
    }
    const sentinel = preparedSentinel
      ? await verifyConflictSentinel(
          directory,
          preparedSentinel.sentinelPath,
          preparedSentinel.before,
        )
      : null;
    const evidence = summarizeConflictEvidence(
      outcomes,
      releasedBy,
      actual.objects[0].description,
      sentinel,
    );
    if (!evidence.overlapped)
      return {
        assessment: true,
        status: "not-overlapped",
        evidence,
        failure:
          "No observed competing reservation or snapshot; cannot count as a pass",
      };
    return await observed(evidence, () =>
      assertConflictEvidence(outcomes, evidence, strictSentinel),
    );
  } finally {
    await stop(workers, Boolean(deadlineOptions));
  }
}

async function rollbackSentinel(project, directory) {
  const outside = join(directory, "outside");
  await mkdir(outside);
  const sentinel = "SYNTHETIC OUTSIDE SENTINEL\n";
  for (const file of ["equipment.json", "wires.json"])
    await writeFile(join(outside, file), sentinel);
  const files = await Promise.all(
    [wireFile, deviceFile].map((file) =>
      filePatch(project, file, [
        {
          op: "add",
          path: "/objects/0/description",
          value: "Synthetic rollback edit",
        },
      ]),
    ),
  );
  const req = patchRequest(project, files);
  const dryRun =
    await createInternalApplySourcePatchTool().applySourcePatch(req);
  required(() =>
    assert(dryRun.ok, "Dry run must succeed before fault injection"),
  );
  let injected = false;
  const tool = createInternalApplySourcePatchTool(
    {},
    {
      ...defaultApplySourcePatchDependencies,
      async writeFileAtomically(path, bytes) {
        await writeFileAtomically(path, bytes);
        if (!injected) {
          injected = true;
          for (const name of ["connections", "devices"]) {
            await rename(join(project, name), join(project, `${name}-saved`));
            await symlink(
              outside,
              join(project, name),
              process.platform === "win32" ? "junction" : "dir",
            );
          }
        }
      },
    },
  );
  const result = await tool.applySourcePatch({ ...req, dryRun: false });
  required(() => assert(injected, "Fault injection must execute"));
  const outsideUnchanged = Object.fromEntries(
    await Promise.all(
      ["equipment.json", "wires.json"].map(async (file) => [
        file,
        (await readFile(join(outside, file), "utf8")) === sentinel,
      ]),
    ),
  );
  return observed({ injected, outsideUnchanged, outcome: result }, () => {
    required(() => assert(!result.ok, "Ancestor swap must reject the patch"));
    for (const [file, unchanged] of Object.entries(outsideUnchanged))
      assert(unchanged, `Rollback overwrote outside sentinel ${file}`);
    assert.equal(
      result.failureClass,
      "tool",
      "Incomplete rollback must classify as infrastructure failure (exit 2)",
    );
  });
}

async function lockControl(project, directory, abandoned) {
  const input = join(directory, "owner.json");
  const patch = await filePatch(project, deviceFile, [operation("Owner")]);
  await writeFile(input, json(patchRequest(project, [patch], false)));
  const owner = worker(input);
  try {
    await until(() => owner.events.has("ready"), "lock owner ready");
    await send(owner, "start");
    await until(
      () => owner.events.has("barrier"),
      "owner paused with snapshot",
    );
    const before = await snapshot(project);
    if (abandoned) {
      owner.child.kill("SIGKILL");
      await owner.completion;
    }
    const result = await cli(
      "apply-source-patch",
      patchRequest(project, [patch], false),
    );
    const { report } = required(() => {
      assert([0, 1, 2].includes(result.code));
      return streams(result, "apply-source-patch", result.code);
    });
    const unchanged =
      JSON.stringify(await snapshot(project)) === JSON.stringify(before);
    return await observed(
      { exit: result.code, error: report.error, unchanged },
      () => {
        assert.notEqual(
          result.code,
          0,
          "Held/abandoned reservation must refuse a competing writer",
        );
        assert.equal(
          report.error?.code,
          "A005",
          "Lock owner/abandonment must be reported distinctly",
        );
        assert.equal(
          report.error.ownerState,
          abandoned ? "not-running" : "alive",
        );
        assert(unchanged, "Contending writer changed project source");
      },
    );
  } finally {
    await stop([owner]);
  }
}

export async function contracts({ conflicts = 100 } = {}) {
  const rows = [];
  const requests = {
    validate: {},
    resolve: { target: { by: "designation", value: "PS1" } },
    inspect: { selector: { by: "designation", value: "PS1" } },
    query: {
      query: {
        operation: "net",
        selector: { by: "parts", deviceDesignation: "PS1", terminalKey: "+" },
      },
    },
    "create-view": {
      spec: {
        format: "schematic-view-request/0.2",
        root: { by: "designation", value: "C1" },
        intent: { kind: "conductors" },
        flow: "left-to-right",
      },
    },
    "apply-source-patch": null,
  };
  for (const [tool, fields] of Object.entries(requests)) {
    for (const mode of [
      "success",
      "request-error",
      "compile-error",
      "infrastructure-error",
    ])
      rows.push(
        await probe(`contract/${tool}/${mode}`, () =>
          temporary(async (project) => {
            let input =
              fields === null
                ? patchRequest(project, [
                    await filePatch(project, deviceFile, [operation()]),
                  ])
                : request(project, fields);
            let exit = 0;
            if (mode === "request-error") {
              input = { ...input, extra: true };
              exit = 1;
            }
            if (mode === "compile-error") {
              await edit(project, deviceFile, (value) => {
                value.objects[0].type = "core:missing";
              });
              exit = 1;
              if (tool === "apply-source-patch")
                input = patchRequest(project, [
                  await filePatch(project, deviceFile, [operation()]),
                ]);
            }
            if (mode === "infrastructure-error") {
              input = { ...input, project: join(project, "absent") };
              exit = 2;
            }
            const { report, result } = streams(
              await cli(tool, input),
              tool,
              exit,
            );
            if (mode === "request-error")
              assert.equal(report.error?.code, "A001");
            if (mode === "compile-error")
              assert(report.diagnostics.some((d) => d.code === "E103"));
            if (mode === "success" && tool === "inspect") assert(result.value);
            return {
              exit,
              diagnostics: report.diagnostics,
              error: report.error,
            };
          }),
        ),
      );
  }
  for (const [id, modify, expectedCode] of [
    [
      "stale",
      (file) => ({
        ...file,
        expectedIntegrity: "sha256-" + "A".repeat(43) + "=",
      }),
      "A004",
    ],
    ["escape", (file) => ({ ...file, path: "../outside.json" }), "A003"],
    ["absolute", (file) => ({ ...file, path: "/outside.json" }), "A003"],
    ["manifest", (file) => ({ ...file, path: "system.json" }), "A003"],
    [
      "lock",
      (file) => ({ ...file, path: "electrical-system.lock.json" }),
      "A003",
    ],
    [
      "library",
      (file) => ({ ...file, path: "library/types/node.json" }),
      "A003",
    ],
    ["guide", (file) => ({ ...file, path: "AGENTS.md" }), "A003"],
    [
      "pointer",
      (file) => ({
        ...file,
        operations: [{ ...operation(), path: "/objects/~2" }],
      }),
      "A002",
    ],
    [
      "test",
      (file) => ({
        ...file,
        operations: [
          { op: "test", path: "/objects/0/designation", value: "ABSENT" },
        ],
      }),
      "A002",
    ],
  ])
    rows.push(
      await probe(`guard/${id}`, () =>
        temporary(async (project) => {
          const before = await snapshot(project);
          const file = modify(
            await filePatch(project, deviceFile, [operation()]),
          );
          const { report } = streams(
            await cli(
              "apply-source-patch",
              patchRequest(project, [file], false),
            ),
            "apply-source-patch",
            1,
          );
          assert.equal(report.error?.code, expectedCode);
          assert.deepEqual(await snapshot(project), before);
          return { exit: 1, error: report.error, unchanged: true };
        }),
      ),
    );
  rows.push(
    await probe("guard/dry-run-apply-stale-noop-presentation", () =>
      temporary(async (project) => {
        const before = await snapshot(project);
        const files = await Promise.all([
          filePatch(project, deviceFile, [operation()]),
          filePatch(project, "presentation.json", [
            { op: "replace", path: "/revision", value: "EVAL-2" },
          ]),
        ]);
        const dry = streams(
          await cli("apply-source-patch", patchRequest(project, files)),
          "apply-source-patch",
          0,
        );
        assert.equal(dry.result.value.dryRun, true);
        assert.deepEqual(await snapshot(project), before);
        const apply = streams(
          await cli("apply-source-patch", patchRequest(project, files, false)),
          "apply-source-patch",
          0,
        );
        assert.equal(apply.result.value.applied, true);
        assert.deepEqual(dry.result.value.files, apply.result.value.files);
        assert.notDeepEqual(await snapshot(project), before);
        const after = await snapshot(project);
        streams(await cli("validate", request(project)), "validate", 0);
        const stale = streams(
          await cli("apply-source-patch", patchRequest(project, files, false)),
          "apply-source-patch",
          1,
        );
        assert.equal(stale.report.error?.code, "A004");
        const noop = await filePatch(project, deviceFile, [operation()]);
        streams(
          await cli("apply-source-patch", patchRequest(project, [noop], false)),
          "apply-source-patch",
          0,
        );
        assert.deepEqual(await snapshot(project), after);
        return {
          dryRunUnchanged: true,
          applied: true,
          staleUnchanged: true,
          noopUnchanged: true,
        };
      }),
    ),
  );
  rows.push(
    await probe("guard/staged-invalid-second-file", () =>
      temporary(async (project) => {
        const before = await snapshot(project);
        const files = await Promise.all([
          filePatch(project, deviceFile, [operation()]),
          filePatch(project, wireFile, [
            {
              op: "replace",
              path: "/objects/0/endpoints/0/device",
              value: "ABSENT",
            },
          ]),
        ]);
        const { report } = streams(
          await cli("apply-source-patch", patchRequest(project, files, false)),
          "apply-source-patch",
          1,
        );
        assert(report.diagnostics.some((d) => d.code === "E101"));
        assert.deepEqual(await snapshot(project), before);
        return { unchanged: true };
      }),
    ),
  );
  rows.push(
    await probe("guard/rollback-outside-sentinel", () =>
      temporary(rollbackSentinel),
    ),
  );
  rows.push(
    await probe("guard/held-lock", () =>
      temporary((p, d) => lockControl(p, d, false)),
    ),
  );
  rows.push(
    await probe("guard/abandoned-lock", () =>
      temporary((p, d) => lockControl(p, d, true)),
    ),
  );
  rows.push(...(await contractConflictBarrier({ conflicts })));
  return rows;
}

export async function contractConflictBarrier({
  conflicts = CI_CONFLICT_PAIRS,
  strictSentinel = false,
  deadlineAt = null,
  afterConflict = null,
  signal = null,
  registerChild = null,
} = {}) {
  const rows = [];
  for (const id of expectedConflictRowIds(conflicts)) {
    if (
      signal?.aborted ||
      (deadlineAt != null && performance.now() >= deadlineAt)
    ) {
      throw deadlineError(`before ${id}`);
    }
    rows.push(
      await probe(id, () =>
        temporary((project, directory) =>
          conflict(project, directory, {
            strictSentinel,
            deadlineAt,
            afterConflict,
            signal,
            registerChild,
          }),
        ),
      ),
    );
    if (
      signal?.aborted ||
      (deadlineAt != null &&
        rows[rows.length - 1]?.failure?.startsWith(
          "Barrier deadline exceeded:",
        ))
    ) {
      throw deadlineError(`during ${id}`);
    }
  }
  return rows;
}
