import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

function yamlBlock(text, key, spaces) {
  const prefix = `${" ".repeat(spaces)}${key}:`;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line === prefix || line.startsWith(`${prefix} `),
  );
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== "" && !line.startsWith(" ".repeat(spaces + 1))) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function parseInlineList(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""));
}

function parseMatrixEntries(jobBlock) {
  const matrixBlock = yamlBlock(jobBlock, "matrix", 6);
  if (!matrixBlock) return [];
  const entries = [];
  for (const line of matrixBlock.split(/\r?\n/).slice(1)) {
    const match = /^ {8}([A-Za-z_][A-Za-z0-9_-]*):\s*(\[.*\])$/.exec(line);
    if (!match) continue;
    const values = parseInlineList(match[2]);
    if (values) entries.push([match[1], values]);
  }
  return entries;
}

function cartesian(lists) {
  return lists.reduce(
    (acc, values) => acc.flatMap((row) => values.map((v) => [...row, v])),
    [[]],
  );
}

export function expectedJobNames(workflowText) {
  const jobsBlock = yamlBlock(workflowText, "jobs", 0);
  if (!jobsBlock) throw new Error("Workflow is missing top-level jobs block.");
  const resultBlock = yamlBlock(jobsBlock, "ci-result", 2);
  if (!resultBlock) throw new Error("Workflow is missing ci-result job.");
  const needsLine = resultBlock
    .split(/\r?\n/)
    .find((line) => /^ {4}needs:\s*/.test(line));
  const needed = needsLine
    ? parseInlineList(needsLine.replace(/^ {4}needs:\s*/, ""))
    : null;
  if (!needed?.length) {
    throw new Error("ci-result job must declare a non-empty needs list.");
  }
  const names = [];
  for (const jobId of needed) {
    const jobBlock = yamlBlock(jobsBlock, jobId, 2);
    if (!jobBlock) {
      throw new Error(`ci-result depends on unknown job "${jobId}".`);
    }
    const matrix = parseMatrixEntries(jobBlock);
    if (!matrix.length) {
      names.push(jobId);
      continue;
    }
    for (const combo of cartesian(matrix.map(([, values]) => values))) {
      names.push(`${jobId} (${combo.join(", ")})`);
    }
  }
  return names;
}

export function selectLatestJobs(jobs, maxAttempt) {
  const latest = new Map();
  for (const job of jobs) {
    if (!job || typeof job.name !== "string") continue;
    const attempt = Number(job.run_attempt ?? 1);
    if (maxAttempt != null && attempt > maxAttempt) continue;
    const prev = latest.get(job.name);
    if (!prev) {
      latest.set(job.name, job);
      continue;
    }
    const prevAttempt = Number(prev.run_attempt ?? 1);
    const id = Number(job.id ?? 0);
    const prevId = Number(prev.id ?? 0);
    if (attempt > prevAttempt || (attempt === prevAttempt && id > prevId)) {
      latest.set(job.name, job);
    }
  }
  return latest;
}

export function evaluateCiResult({
  expectedNames,
  jobs,
  needsResults = {},
  maxAttempt = null,
}) {
  const failures = [];
  const summary = [];
  for (const [group, result] of Object.entries(needsResults)) {
    summary.push(`needs.${group}.result=${result ?? "<missing>"}`);
    if (result !== "success") {
      failures.push(
        `needs.${group}.result is "${result ?? "<missing>"}" (expected "success")`,
      );
    }
  }
  if (!expectedNames.length) {
    failures.push("Expected job list is empty.");
  }
  const latest = selectLatestJobs(jobs, maxAttempt);
  for (const name of expectedNames) {
    const job = latest.get(name);
    if (!job) {
      summary.push(`${name}: MISSING`);
      failures.push(`Expected job "${name}" is missing from the workflow run.`);
      continue;
    }
    const attempt = job.run_attempt ?? "?";
    const status = job.status ?? "<missing>";
    const conclusion = job.conclusion ?? "<null>";
    summary.push(
      `${name}: attempt=${attempt} status=${status} conclusion=${conclusion}`,
    );
    if (status !== "completed" || conclusion !== "success") {
      failures.push(
        `Job "${name}" (attempt ${attempt}) did not succeed: status=${status}, conclusion=${conclusion}.`,
      );
    }
  }
  return { ok: failures.length === 0, failures, summary };
}

function parseJobsPages(stdout) {
  let pages;
  try {
    pages = JSON.parse(stdout || "");
  } catch {
    throw new Error("GitHub Jobs API returned invalid JSON.");
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error(
      "Unexpected Jobs API response: expected non-empty page array.",
    );
  }
  const totalCount = pages[0]?.total_count;
  if (!Number.isInteger(totalCount) || totalCount < 0) {
    throw new Error(
      "Unexpected Jobs API response: missing integer total_count.",
    );
  }
  const jobs = [];
  for (let i = 0; i < pages.length; i++) {
    if (!Array.isArray(pages[i]?.jobs)) {
      throw new Error(`Unexpected Jobs API response on page ${i + 1}.`);
    }
    jobs.push(...pages[i].jobs);
  }
  if (jobs.length !== totalCount) {
    throw new Error(
      `Incomplete Jobs API response: collected ${jobs.length} jobs, expected total_count=${totalCount}.`,
    );
  }
  return jobs;
}

function ghFailure(result) {
  if (result.error) {
    const code =
      typeof result.error.code === "string" ? result.error.code : "unknown";
    return {
      retryable: false,
      message: `gh api execution failed (code ${code}).`,
    };
  }
  const httpMatch = /\bHTTP (\d{3})\b/.exec(result.stderr ?? "");
  const httpCode = httpMatch ? Number(httpMatch[1]) : null;
  if (httpCode !== null) {
    return {
      retryable: httpCode >= 500,
      message: `GitHub Jobs API request failed (HTTP ${httpCode}).`,
    };
  }
  return {
    retryable: true,
    message: `GitHub Jobs API request failed (exit ${result.status ?? "null"}).`,
  };
}

// Query the full run job history (filter=all) rather than attempts/N/jobs:
// on "Re-run failed jobs", attempts/N/jobs returns only the re-run subset,
// omitting earlier-attempt successes that selectLatestJobs needs to keep
// every expected job accountable across partial reruns.
export async function fetchWorkflowRunJobs({
  repository,
  runId,
  token,
  env = process.env,
  spawnSyncImpl = spawnSync,
  pause = delay,
}) {
  if (!repository || !runId || !token) {
    throw new Error(
      "Missing GITHUB_REPOSITORY, GITHUB_RUN_ID, or GH_TOKEN/GITHUB_TOKEN.",
    );
  }
  const endpoint = `repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`;
  const args = ["api", "--paginate", "--slurp", endpoint];
  const options = {
    encoding: "utf8",
    env: { ...env, GH_TOKEN: token },
    maxBuffer: 32 * 1024 * 1024,
  };
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = spawnSyncImpl("gh", args, options);
    if (!result.error && result.status === 0) {
      return parseJobsPages(result.stdout);
    }
    const { retryable, message } = ghFailure(result);
    lastError = new Error(message);
    if (!retryable) throw lastError;
    if (attempt < 3) await pause(2_000 * attempt);
  }
  throw lastError;
}

async function main() {
  const workflowPath = resolve(".github/workflows/ci.yml");
  const expectedNames = expectedJobNames(readFileSync(workflowPath, "utf8"));
  const maxAttempt = process.env.GITHUB_RUN_ATTEMPT
    ? Number(process.env.GITHUB_RUN_ATTEMPT)
    : null;
  const jobs = await fetchWorkflowRunJobs({
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  });
  const verdict = evaluateCiResult({
    expectedNames,
    jobs,
    maxAttempt,
    needsResults: {
      "check-static": process.env.CHECK_STATIC_RESULT,
      "check-test": process.env.CHECK_TEST_RESULT,
      worktree: process.env.WORKTREE_RESULT,
      "contract-receipts": process.env.CONTRACT_RECEIPTS_RESULT,
    },
  });
  for (const line of verdict.summary) process.stdout.write(`${line}\n`);
  if (!verdict.ok) {
    for (const failure of verdict.failures) {
      process.stderr.write(`FAIL: ${failure}\n`);
    }
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
