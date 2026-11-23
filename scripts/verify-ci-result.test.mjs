import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateCiResult,
  expectedJobNames,
  fetchWorkflowRunJobs,
} from "./verify-ci-result.mjs";

const workflowText = readFileSync(".github/workflows/ci.yml", "utf8");

function allSucceededJobs(names, attempt = 1) {
  return names.map((name, idx) => ({
    id: attempt * 1000 + idx,
    name,
    run_attempt: attempt,
    status: "completed",
    conclusion: "success",
  }));
}

const allNeedsOk = {
  "check-static": "success",
  "check-test": "success",
  worktree: "success",
};

describe("ci-result Jobs API verifier", () => {
  it("derives all 15 expected OS x shard job names directly from ci.yml", () => {
    const expected = expectedJobNames(workflowText);
    expect(expected).toEqual([
      "check-static (macos-15)",
      "check-static (ubuntu-24.04)",
      "check-static (windows-2022)",
      "check-test (macos-15, 1)",
      "check-test (macos-15, 2)",
      "check-test (ubuntu-24.04, 1)",
      "check-test (ubuntu-24.04, 2)",
      "check-test (windows-2022, 1)",
      "check-test (windows-2022, 2)",
      "worktree (macos-15, 1)",
      "worktree (macos-15, 2)",
      "worktree (ubuntu-24.04, 1)",
      "worktree (ubuntu-24.04, 2)",
      "worktree (windows-2022, 1)",
      "worktree (windows-2022, 2)",
    ]);
  });

  it("passes only when every expected job completed with conclusion success", () => {
    const expected = expectedJobNames(workflowText);
    const verdict = evaluateCiResult({
      expectedNames: expected,
      jobs: allSucceededJobs(expected),
      needsResults: allNeedsOk,
      maxAttempt: 1,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it("fails closed when a matrix leg is cancelled before runner assignment even if needs says success", () => {
    const expected = expectedJobNames(workflowText);
    const jobs = allSucceededJobs(expected);
    jobs[4] = {
      ...jobs[4],
      status: "completed",
      conclusion: "cancelled",
    };
    const verdict = evaluateCiResult({
      expectedNames: expected,
      jobs,
      needsResults: allNeedsOk,
      maxAttempt: 1,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual([
      expect.stringContaining(
        'Job "check-test (macos-15, 2)" (attempt 1) did not succeed: status=completed, conclusion=cancelled.',
      ),
    ]);
  });

  it("fails closed on missing, skipped, failed, in-progress, or null-conclusion jobs", () => {
    const expected = expectedJobNames(workflowText);
    const missing = allSucceededJobs(expected).slice(1);
    expect(
      evaluateCiResult({
        expectedNames: expected,
        jobs: missing,
        needsResults: allNeedsOk,
      }).ok,
    ).toBe(false);

    for (const [status, conclusion] of [
      ["completed", "skipped"],
      ["completed", "failure"],
      ["completed", null],
      ["in_progress", null],
      ["queued", null],
    ]) {
      const jobs = allSucceededJobs(expected);
      jobs[0] = { ...jobs[0], status, conclusion };
      const verdict = evaluateCiResult({
        expectedNames: expected,
        jobs,
        needsResults: allNeedsOk,
      });
      expect(verdict.ok, `${status}/${conclusion}`).toBe(false);
    }
  });

  it("handles partial reruns accurately and rejects rerun regressions", () => {
    const expected = expectedJobNames(workflowText);
    const attempt1 = allSucceededJobs(expected, 1);
    attempt1[10] = { ...attempt1[10], conclusion: "failure" };
    const partialRerun = [
      ...attempt1,
      {
        id: 2010,
        name: expected[10],
        run_attempt: 2,
        status: "completed",
        conclusion: "success",
      },
    ];
    expect(
      evaluateCiResult({
        expectedNames: expected,
        jobs: partialRerun,
        needsResults: allNeedsOk,
        maxAttempt: 2,
      }).ok,
    ).toBe(true);

    const regression = [
      ...allSucceededJobs(expected, 1),
      {
        id: 2001,
        name: expected[1],
        run_attempt: 2,
        status: "completed",
        conclusion: "cancelled",
      },
    ];
    const verdict = evaluateCiResult({
      expectedNames: expected,
      jobs: regression,
      needsResults: allNeedsOk,
      maxAttempt: 2,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toContain("attempt 2");
  });

  it("paginates Jobs API responses and retries transient 5xx failures", async () => {
    const calls = [];
    const waits = [];
    let page1Tries = 0;
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `job-${i + 1}`,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
    }));
    const page2 = [
      {
        id: 101,
        name: "job-101",
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
      },
    ];
    const jobs = await fetchWorkflowRunJobs({
      repository: "owner/repo",
      runId: "42",
      token: "test-token",
      pause: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async (url) => {
        calls.push(url);
        if (new URL(url).searchParams.get("page") === "1") {
          page1Tries++;
          if (page1Tries === 1) {
            return {
              ok: false,
              status: 502,
              text: async () => "bad gateway",
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ total_count: 101, jobs: page1 }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ total_count: 101, jobs: page2 }),
        };
      },
    });
    expect(jobs).toHaveLength(101);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("filter=all&per_page=100&page=1");
    expect(waits).toEqual([2_000]);
  });
});
