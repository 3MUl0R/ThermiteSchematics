import { canonical } from "./source-files.mjs";
import { sha256 } from "./snapshot.mjs";
export const configurationKey = (r) => [
  r.model ?? null,
  r.effort ?? null,
  {
    model: r.modelOverrides?.model ?? null,
    effort: r.modelOverrides?.effort ?? null,
  },
];
export const runKey = (r) =>
  `${r.context}/${r.task}/${r.agent}/${r.seed}/${encodeURIComponent(canonical(configurationKey(r)))}`;
export const runDirectoryName = (r) =>
  `${r.task}-${r.agent}-${r.arm}-${r.seed}${r.agent === "reference" ? "" : "-" + sha256(canonical(configurationKey(r))).slice(0, 16)}`;
export const isComplete = (r) =>
  r.status === "complete" || r.status === "task-failure";
export const automaticInfra = (r) =>
  r.status === "infrastructure-failure" &&
  ["rate-limit", "unstructured-exit"].includes(r.infrastructureKind);
export function planAttempt(prior, forceRerun = false) {
  const ordered = [...prior].sort(
      (a, b) => (a.attempt ?? 1) - (b.attempt ?? 1),
    ),
    first = ordered.find(isComplete),
    last = ordered.at(-1);
  if (last?.infrastructureKind === "billing")
    return {
      kind: "stopped",
      run: last,
      attempt: last.attempt,
      reason: "billing",
    };
  if (last?.status === "checker-error")
    return { kind: "recheck", run: last, attempt: last.attempt };
  if (first && !forceRerun)
    return { kind: "skip", run: first, attempt: first.attempt };
  if (automaticInfra(last ?? {}) && ordered.filter(automaticInfra).length >= 3)
    return {
      kind: "exhausted",
      run: last,
      attempt: last.attempt,
      reason: "infra-retry-limit",
    };
  return {
    kind: "run",
    attempt: (last?.attempt ?? 0) + 1,
    forceRerun: !!first && forceRerun,
  };
}
export function selectAttempts(runs) {
  const groups = new Map(),
    errors = [],
    history = [];
  for (const run of runs) {
    const key = `${run.arm}/${runKey(run)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const selected = [];
  for (const [key, rows] of groups) {
    const attempts = new Map();
    for (const run of rows) {
      const attempt = run.attempt ?? 1;
      if (!attempts.has(attempt)) attempts.set(attempt, []);
      attempts.get(attempt).push(run);
    }
    const resolved = [];
    for (const [attempt, copies] of attempts) {
      const originals = copies.filter((r) => !r.adjudication),
        judged = copies.filter((r) => r.adjudication);
      if (originals.length > 1)
        errors.push(`Duplicate ${key} attempt ${attempt}`);
      const strip = (r) => {
        const { judges, judgement, adjudication, ...base } = r;
        return canonical(base);
      };
      if (judged.some((r) => originals[0] && strip(r) !== strip(originals[0])))
        errors.push(
          `Adjudication changes original facts ${key} attempt ${attempt}`,
        );
      const revisions = judged.map((r) => r.adjudication.revision ?? 1);
      if (new Set(revisions).size !== revisions.length)
        errors.push(`Duplicate adjudication ${key} attempt ${attempt}`);
      resolved.push(
        [...copies].sort(
          (a, b) =>
            (b.adjudication?.revision ?? 0) - (a.adjudication?.revision ?? 0),
        )[0],
      );
    }
    const ordered = resolved.sort(
        (a, b) => (a.attempt ?? 1) - (b.attempt ?? 1),
      ),
      complete = ordered.filter(isComplete),
      chosen = complete[0] ?? ordered.at(-1);
    if (chosen) selected.push(chosen);
    history.push({
      key,
      arm: chosen?.arm,
      selectedAttempt: chosen?.attempt ?? 1,
      attempts: ordered.map((r) => ({
        attempt: r.attempt ?? 1,
        status: r.status,
        outcome: r.outcome?.pass ?? false,
        infrastructureKind:
          r.infrastructureKind ??
          (r.status === "checker-error" ? "checker" : "other"),
      })),
      forcedReruns: ordered
        .filter((r) => r.forceRerun)
        .map((r) => r.attempt ?? 1),
      multipleCompleteAttempts: complete.length > 1,
      unresolvedInfrastructure: complete.length === 0,
    });
  }
  return { selected, errors, history };
}
export function classifyAgent(result, normalized) {
  if (result.timedOut)
    return { status: "complete", taskFailure: true, reason: "timeout" };
  if (result.exit === 0 && normalized.successfulCompletion)
    return { status: "complete", taskFailure: false, reason: null };
  if (result.spawnError || result.signal || normalized.infrastructureError)
    return {
      status: "infrastructure-failure",
      taskFailure: false,
      infrastructureKind:
        normalized.infrastructureKind ??
        (result.spawnError || result.signal ? "cli-crash" : "provider"),
      reason:
        normalized.infrastructureError ?? result.spawnError ?? result.signal,
    };
  if (
    normalized.agentError &&
    (normalized.terminalError !== false || result.exit === 0)
  )
    return {
      status: "complete",
      taskFailure: true,
      reason: "agent-error-result",
    };
  if (result.exit !== 0)
    return {
      status: "infrastructure-failure",
      taskFailure: false,
      infrastructureKind: "unstructured-exit",
      reason: "cli-crash-or-unstructured-exit",
    };
  return normalized.successfulCompletion
    ? { status: "complete", taskFailure: false, reason: null }
    : { status: "complete", taskFailure: true, reason: "missing-completion" };
}
