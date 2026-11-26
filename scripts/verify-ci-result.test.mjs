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
  "contract-receipts": "success",
};

describe("ci-result Jobs API verifier", () => {
  it("derives all 18 expected OS x shard and contract job names directly from ci.yml", () => {
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
      "contract-receipts (macos-15)",
      "contract-receipts (ubuntu-24.04)",
      "contract-receipts (windows-2022)",
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

  it("paginates via gh api, retries transient 5xx, and catches a cancelled job on a later page", async () => {
    const expected = expectedJobNames(workflowText);
    const page1 = allSucceededJobs(expected, 1);
    const page2 = [
      {
        id: 2004,
        name: expected[4],
        run_attempt: 2,
        status: "completed",
        conclusion: "cancelled",
      },
    ];
    const calls = [];
    const waits = [];
    const jobs = await fetchWorkflowRunJobs({
      repository: "owner/repo",
      runId: "42",
      token: "test-token",
      env: {},
      pause: async (ms) => {
        waits.push(ms);
      },
      spawnSyncImpl: (cmd, args, options) => {
        calls.push({ cmd, args, env: options.env });
        if (calls.length === 1) {
          return {
            status: 1,
            stdout: "",
            stderr: "gh: Bad Gateway (HTTP 502)",
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify([
            { total_count: 19, jobs: page1 },
            { total_count: 19, jobs: page2 },
          ]),
          stderr: "",
        };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe("gh");
    expect(calls[0].args).toEqual([
      "api",
      "--paginate",
      "--slurp",
      "repos/owner/repo/actions/runs/42/jobs?filter=all&per_page=100",
    ]);
    expect(calls[0].env.GH_TOKEN).toBe("test-token");
    expect(waits).toEqual([2_000]);
    expect(jobs).toHaveLength(19);

    const verdict = evaluateCiResult({
      expectedNames: expected,
      jobs,
      needsResults: allNeedsOk,
      maxAttempt: 2,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toContain("attempt 2");
    expect(verdict.failures[0]).toContain("cancelled");
  });

  it("fails closed when collected jobs differ from total_count", async () => {
    const expected = expectedJobNames(workflowText);
    await expect(
      fetchWorkflowRunJobs({
        repository: "owner/repo",
        runId: "42",
        token: "test-token",
        spawnSyncImpl: () => ({
          status: 0,
          stdout: JSON.stringify([
            { total_count: 19, jobs: allSucceededJobs(expected, 1) },
          ]),
          stderr: "",
        }),
      }),
    ).rejects.toThrow(
      /Incomplete Jobs API response: collected 18 jobs, expected total_count=19/,
    );
  });

  it("never echoes raw API error bodies, headers, or token-like strings", async () => {
    const fakeToken = "ghs_FAKE1234567890SECRETTOKEN";
    let calls = 0;
    let caught;
    try {
      await fetchWorkflowRunJobs({
        repository: "owner/repo",
        runId: "42",
        token: fakeToken,
        spawnSyncImpl: () => {
          calls++;
          return {
            status: 1,
            stdout: `{"message":"echo Authorization: Bearer ${fakeToken}"}`,
            stderr: `gh: Bad credentials Authorization: Bearer ${fakeToken} (HTTP 401)`,
          };
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(calls).toBe(1);
    expect(caught?.message).toBe("GitHub Jobs API request failed (HTTP 401).");
    expect(caught?.message).not.toContain(fakeToken);
    expect(caught?.message).not.toContain("Authorization");

    let jsonCaught;
    try {
      await fetchWorkflowRunJobs({
        repository: "owner/repo",
        runId: "42",
        token: fakeToken,
        spawnSyncImpl: () => ({
          status: 0,
          stdout: `not-json-${fakeToken}`,
          stderr: "",
        }),
      });
    } catch (error) {
      jsonCaught = error;
    }
    expect(jsonCaught?.message).toBe("GitHub Jobs API returned invalid JSON.");
    expect(jsonCaught?.message).not.toContain(fakeToken);
  });
});
