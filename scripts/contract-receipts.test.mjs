import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CI_CONFLICT_PAIRS,
  OUTSIDE_SENTINEL_CONTENT,
  OUTSIDE_SENTINEL_RELATIVE_PATH,
  expectedConflictRowIds,
} from "../evals/engine/contract-barrier-spec.mjs";
import {
  RECEIPT_FILENAME,
  RECEIPT_FORMAT,
  REQUIRED_DIST_FILES,
  assertDistBuilt,
  parseCliArgs,
  runContractReceipts,
  validateConflictRows,
} from "./contract-receipts.mjs";

const SENTINEL_SHA256 = createHash("sha256")
  .update(OUTSIDE_SENTINEL_CONTENT)
  .digest("hex");

function makePassRow(id, winnerWriter = "A") {
  const loserWriter = winnerWriter === "A" ? "B" : "A";
  return {
    id,
    status: "pass",
    evidence: {
      releasedBy: "reservation-contention",
      overlapped: true,
      exits: winnerWriter === "A" ? [0, 1] : [1, 0],
      winner: {
        writer: winnerWriter,
        exitCode: 0,
        finalDescription: winnerWriter,
      },
      loser: {
        writer: loserWriter,
        exitCode: 1,
        errorCode: "A005",
      },
      loserCode: "A005",
      finalDescription: winnerWriter,
      sentinel: {
        path: OUTSIDE_SENTINEL_RELATIVE_PATH,
        untouched: true,
        sha256: SENTINEL_SHA256,
      },
    },
  };
}

function makeCompleteRows(conflicts = CI_CONFLICT_PAIRS) {
  return expectedConflictRowIds(conflicts).map((id, index) =>
    makePassRow(id, index % 2 === 0 ? "A" : "B"),
  );
}

describe("contract-receipts driver validation", () => {
  it("derives the expected 20-pair conflict row set from the barrier spec", () => {
    const ids = expectedConflictRowIds();
    expect(ids).toHaveLength(CI_CONFLICT_PAIRS);
    expect(ids[0]).toBe("guard/two-process-barrier/1");
    expect(ids[ids.length - 1]).toBe(
      `guard/two-process-barrier/${CI_CONFLICT_PAIRS}`,
    );
  });

  it("passes when the complete expected set passes with winner, loser, and untouched sentinel", () => {
    const rows = makeCompleteRows();
    const validation = validateConflictRows(rows);
    expect(validation.ok).toBe(true);
    expect(validation.failures).toEqual([]);
    expect(validation.summary).toEqual({
      expected: CI_CONFLICT_PAIRS,
      observed: CI_CONFLICT_PAIRS,
      passed: CI_CONFLICT_PAIRS,
      failed: 0,
      missing: 0,
      extra: 0,
    });
    expect(validation.conflicts[0]).toMatchObject({
      id: "guard/two-process-barrier/1",
      pair: 1,
      status: "pass",
      winner: { writer: "A", exitCode: 0, finalDescription: "A" },
      loser: { writer: "B", exitCode: 1, errorCode: "A005" },
      sentinel: {
        path: OUTSIDE_SENTINEL_RELATIVE_PATH,
        untouched: true,
        sha256: SENTINEL_SHA256,
      },
    });
  });

  it("fails when any expected conflict row is missing", () => {
    const rows = makeCompleteRows().filter(
      (row) => row.id !== "guard/two-process-barrier/13",
    );
    const validation = validateConflictRows(rows);
    expect(validation.ok).toBe(false);
    expect(validation.summary.missing).toBe(1);
    expect(validation.summary.passed).toBe(CI_CONFLICT_PAIRS - 1);
    expect(validation.failures).toEqual([
      'Missing expected conflict row "guard/two-process-barrier/13".',
    ]);
  });

  it("fails when any conflict row fails, lacks overlap, or has a touched sentinel", () => {
    const failedRows = makeCompleteRows();
    failedRows[3] = {
      ...failedRows[3],
      status: "fail",
      failure: "Exactly one writer must win",
    };
    const failedValidation = validateConflictRows(failedRows);
    expect(failedValidation.ok).toBe(false);
    expect(failedValidation.summary.failed).toBe(1);
    expect(failedValidation.failures[0]).toContain(
      "guard/two-process-barrier/4",
    );

    const noOverlapRows = makeCompleteRows();
    noOverlapRows[5] = {
      ...noOverlapRows[5],
      status: "not-overlapped",
      failure: "No observed competing reservation",
    };
    expect(validateConflictRows(noOverlapRows).ok).toBe(false);

    const touchedSentinelRows = makeCompleteRows();
    touchedSentinelRows[7] = {
      ...touchedSentinelRows[7],
      evidence: {
        ...touchedSentinelRows[7].evidence,
        sentinel: {
          path: OUTSIDE_SENTINEL_RELATIVE_PATH,
          untouched: false,
          sha256: SENTINEL_SHA256,
        },
      },
    };
    const sentinelValidation = validateConflictRows(touchedSentinelRows);
    expect(sentinelValidation.ok).toBe(false);
    expect(sentinelValidation.failures[0]).toContain("outside sentinel");
  });

  it("rejects duplicate or unexpected extra rows", () => {
    const duplicateRows = [
      ...makeCompleteRows(),
      makePassRow("guard/two-process-barrier/1"),
    ];
    const dupValidation = validateConflictRows(duplicateRows);
    expect(dupValidation.ok).toBe(false);
    expect(dupValidation.summary.extra).toBe(1);
    expect(dupValidation.failures[0]).toContain("Duplicate conflict row");

    const extraRows = [...makeCompleteRows(), makePassRow("guard/unrelated")];
    const extraValidation = validateConflictRows(extraRows);
    expect(extraValidation.ok).toBe(false);
    expect(extraValidation.summary.extra).toBe(1);
    expect(extraValidation.failures[0]).toContain("Unexpected conflict row");
  });

  it("fails clearly when dist outputs are missing and when --output is omitted", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "thermite-no-dist-"));
    try {
      expect(() => assertDistBuilt(emptyRoot)).toThrow(
        new RegExp(REQUIRED_DIST_FILES[0].replaceAll("/", "\\/")),
      );
      expect(() => assertDistBuilt(emptyRoot)).toThrow(/bun run build/);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
    expect(() => parseCliArgs([])).toThrow(/--output/);
  });

  it("writes a complete receipt under the caller-supplied output dir and exits nonzero on failure", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "thermite-contract-receipt-"));
    try {
      const passing = await runContractReceipts({
        outputDir: outDir,
        runBarrier: async ({ conflicts }) => makeCompleteRows(conflicts),
        checkerVersion: "1.1",
        env: {
          GITHUB_REF: "refs/pull/999/merge",
          GITHUB_BASE_REF: "release",
          GITHUB_HEAD_REF: "dev",
          GITHUB_SHA: "0".repeat(40),
          RUNNER_OS: "Linux",
        },
      });
      expect(passing.exitCode).toBe(0);
      expect(passing.receiptPath).toBe(join(outDir, RECEIPT_FILENAME));
      const written = JSON.parse(await readFile(passing.receiptPath, "utf8"));
      expect(written.format).toBe(RECEIPT_FORMAT);
      expect(written.ok).toBe(true);
      expect(written.git.head).toMatch(/^[0-9a-f]{40}$/);
      expect(written.git.tree).toMatch(/^[0-9a-f]{40}$/);
      expect(written.git.ref).toBe("refs/pull/999/merge");
      expect(written.os.runnerOs).toBe("Linux");
      expect(written.versions.checker).toBe("1.1");
      expect(written.conflicts).toHaveLength(CI_CONFLICT_PAIRS);

      const failing = await runContractReceipts({
        outputDir: outDir,
        runBarrier: async ({ conflicts }) =>
          makeCompleteRows(conflicts).slice(0, conflicts - 1),
        checkerVersion: "1.1",
      });
      expect(failing.exitCode).toBe(1);
      expect(failing.receipt.ok).toBe(false);
      expect(failing.receipt.summary.missing).toBe(1);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
