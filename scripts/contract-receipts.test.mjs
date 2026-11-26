import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  prepareConflictSentinel,
  verifyConflictSentinel,
} from "../evals/engine/conflict-sentinel.mjs";
import {
  CI_CONFLICT_PAIRS,
  OUTSIDE_SENTINEL_CONTENT,
  expectedConflictRowIds,
} from "../evals/engine/contract-barrier-spec.mjs";
import { CLEANUP_GRACE_MS } from "./contract-receipts-guards.mjs";
import {
  DEFAULT_DEADLINE_MS,
  EXPECTED_SENTINEL_PATH,
  EXPECTED_SENTINEL_SHA256,
  EXPECTED_SENTINEL_SIZE,
  RECEIPT_FILENAME,
  RECEIPT_FORMAT,
  REQUIRED_CI_CONFLICT_ROW_IDS,
  REQUIRED_DIST_FILES,
  assertDistBuilt,
  parseCliArgs,
  runContractReceipts,
  validateConflictRows,
} from "./contract-receipts.mjs";

const PINNED_20_CONFLICT_ROW_IDS = Object.freeze([
  "guard/two-process-barrier/1",
  "guard/two-process-barrier/2",
  "guard/two-process-barrier/3",
  "guard/two-process-barrier/4",
  "guard/two-process-barrier/5",
  "guard/two-process-barrier/6",
  "guard/two-process-barrier/7",
  "guard/two-process-barrier/8",
  "guard/two-process-barrier/9",
  "guard/two-process-barrier/10",
  "guard/two-process-barrier/11",
  "guard/two-process-barrier/12",
  "guard/two-process-barrier/13",
  "guard/two-process-barrier/14",
  "guard/two-process-barrier/15",
  "guard/two-process-barrier/16",
  "guard/two-process-barrier/17",
  "guard/two-process-barrier/18",
  "guard/two-process-barrier/19",
  "guard/two-process-barrier/20",
]);

const CHECKER_STUB_PATHS = [
  "evals/engine/conflict-sentinel.mjs",
  "evals/engine/contract-barrier-spec.mjs",
  "evals/engine/contracts.mjs",
  "evals/engine/engine.mjs",
  "evals/engine/patch-worker.mjs",
  "evals/engine/support.mjs",
  "scripts/contract-receipts-guards.mjs",
  "scripts/contract-receipts.mjs",
];

function makeSentinelSnapshot() {
  return {
    exists: true,
    isRegularFile: true,
    isSymbolicLink: false,
    parentIsRegularDir: true,
    locationVerified: true,
    nlink: 1,
    dev: "1001",
    ino: "2002",
    size: EXPECTED_SENTINEL_SIZE,
    mode: 33188,
    mtimeNs: "1700000000000000000",
    ctimeNs: "1700000000000000000",
    sha256: EXPECTED_SENTINEL_SHA256,
  };
}

function makePassRow(id, winnerWriter = "A") {
  const loserWriter = winnerWriter === "A" ? "B" : "A";
  const before = makeSentinelSnapshot();
  const after = { ...before };
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
        path: EXPECTED_SENTINEL_PATH,
        untouched: true,
        sha256: EXPECTED_SENTINEL_SHA256,
        expectedSha256: EXPECTED_SENTINEL_SHA256,
        locationVerified: true,
        identityMatched: true,
        metadataMatched: true,
        digestMatched: true,
        before,
        after,
      },
    },
  };
}

function makeCompleteRows(ids = PINNED_20_CONFLICT_ROW_IDS) {
  return ids.map((id, index) => makePassRow(id, index % 2 === 0 ? "A" : "B"));
}

async function createCleanCheckoutFixture() {
  const root = await mkdtemp(join(tmpdir(), "thermite-clean-checkout-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.2.0" }) + "\n",
    "utf8",
  );
  await writeFile(join(root, ".gitignore"), "packages/*/dist/\n", "utf8");
  for (const rel of CHECKER_STUB_PATHS) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, `// stub ${rel}\n`, "utf8");
  }
  for (const rel of REQUIRED_DIST_FILES) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, "// dist stub\n", "utf8");
  }
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-q",
    "-m",
    "initial",
  );
  const head = git("rev-parse", "HEAD");
  return { root, head };
}

function killIfAlive(pid) {
  if (!(pid > 0)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

describe("contract-receipts driver validation", () => {
  let cleanCheckout;

  const runFixture = (overrides) =>
    runContractReceipts({
      root: cleanCheckout.root,
      runBarrier: async () => makeCompleteRows(),
      checkerVersion: "1.1",
      env: {},
      ...overrides,
    });

  beforeAll(async () => {
    cleanCheckout = await createCleanCheckoutFixture();
  });

  afterAll(async () => {
    if (cleanCheckout?.root) {
      await rm(cleanCheckout.root, { recursive: true, force: true });
    }
  });

  it("independently pins all 20 canonical conflict row IDs against count drift", () => {
    expect(CI_CONFLICT_PAIRS).toBe(20);
    expect(expectedConflictRowIds()).toEqual(PINNED_20_CONFLICT_ROW_IDS);
    expect(REQUIRED_CI_CONFLICT_ROW_IDS).toEqual(PINNED_20_CONFLICT_ROW_IDS);
    const nineteen = makeCompleteRows(PINNED_20_CONFLICT_ROW_IDS.slice(0, 19));
    const validation = validateConflictRows(nineteen);
    expect(validation.ok).toBe(false);
    expect(validation.summary).toEqual({
      expected: 20,
      observed: 19,
      passed: 19,
      failed: 0,
      missing: 1,
      extra: 0,
    });
    expect(validation.failures).toEqual([
      'Missing expected conflict row "guard/two-process-barrier/20".',
    ]);
  });

  it("passes on complete reconciled rows and retains raw observations in receipt rows", () => {
    const rows = makeCompleteRows();
    const validation = validateConflictRows(rows);
    expect(validation.ok).toBe(true);
    expect(validation.failures).toEqual([]);
    expect(validation.summary).toEqual({
      expected: 20,
      observed: 20,
      passed: 20,
      failed: 0,
      missing: 0,
      extra: 0,
    });
    expect(validation.conflicts[0]).toMatchObject({
      id: "guard/two-process-barrier/1",
      pair: 1,
      status: "pass",
      overlapped: true,
      releasedBy: "reservation-contention",
      exits: [0, 1],
      loserCode: "A005",
      finalDescription: "A",
      winner: { writer: "A", exitCode: 0, finalDescription: "A" },
      loser: { writer: "B", exitCode: 1, errorCode: "A005" },
      sentinel: {
        path: EXPECTED_SENTINEL_PATH,
        untouched: true,
        sha256: EXPECTED_SENTINEL_SHA256,
      },
    });
  });

  it("rejects every row mutation from review1 mutations.jsonl", () => {
    const mutations = [
      ["missing", (a) => a.slice(1), false],
      [
        "extra",
        (a) => [...a, { ...a[0], id: "guard/two-process-barrier/21" }],
        false,
      ],
      ["duplicate", (a) => [...a, structuredClone(a[0])], false],
      ["failed", (a) => ((a[0].status = "fail"), a), false],
      ["noOverlap", (a) => ((a[0].status = "not-overlapped"), a), false],
      [
        "infrastructure",
        (a) => ((a[0].status = "infrastructure-error"), a),
        true,
      ],
      [
        "touched",
        (a) => ((a[0].evidence.sentinel.untouched = false), a),
        false,
      ],
      [
        "wrongDigest",
        (a) => ((a[0].evidence.sentinel.sha256 = "0".repeat(64)), a),
        false,
      ],
      [
        "wrongPath",
        (a) => ((a[0].evidence.sentinel.path = "unrelated.txt"), a),
        false,
      ],
      [
        "inconsistentOverlap",
        (a) => (
          (a[0].evidence.releasedBy = "peer-finished-without-overlap"),
          a
        ),
        false,
      ],
      ["inconsistentExits", (a) => ((a[0].evidence.exits = [0, 0]), a), false],
      [
        "inconsistentFinal",
        (a) => (
          (a[0].evidence.finalDescription =
            a[0].evidence.winner.writer === "A" ? "B" : "A"),
          a
        ),
        false,
      ],
    ];
    for (const [name, mutate, expectInfra] of mutations) {
      const result = validateConflictRows(mutate(makeCompleteRows()));
      expect(result.ok, name).toBe(false);
      expect(result.hasInfrastructureError, name).toBe(expectInfra);
      expect(result.failures.length, name).toBeGreaterThan(0);
    }
  });

  it("rejects actor-observation contradictions and sentinel identity tampering", () => {
    const tamperings = [
      ["loserCodeMismatch", (a) => ((a[0].evidence.loserCode = "A004"), a)],
      ["winnerContradictsExits", (a) => ((a[0].evidence.exits = [1, 0]), a)],
      [
        "sentinelInodeChanged",
        (a) => ((a[0].evidence.sentinel.after.ino = "999999"), a),
      ],
      [
        "sentinelLinkBitSet",
        (a) => ((a[0].evidence.sentinel.after.isSymbolicLink = true), a),
      ],
      [
        "sentinelHardLinkCount",
        (a) => ((a[0].evidence.sentinel.after.nlink = 2), a),
      ],
      [
        "sentinelMtimeChanged",
        (a) => (
          (a[0].evidence.sentinel.after.mtimeNs = "1700000000000000001"),
          a
        ),
      ],
    ];
    for (const [name, mutate] of tamperings) {
      const result = validateConflictRows(mutate(makeCompleteRows()));
      expect(result.ok, name).toBe(false);
      expect(result.failures.length, name).toBeGreaterThan(0);
    }
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
    const parsed = parseCliArgs(["--output", "out"]);
    expect(parsed.conflicts).toBeUndefined();
    expect(parsed.expectedIds).toEqual(PINNED_20_CONFLICT_ROW_IDS);
  });

  it("writes a verified receipt on a clean checkout and enforces provenance", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "thermite-prov-"));
    const outDir = join(scratch, "out");
    const otherEngine = join(scratch, "other-engine");
    await mkdir(otherEngine, { recursive: true });
    try {
      const passing = await runFixture({
        outputDir: outDir,
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/pull/999/merge",
          GITHUB_BASE_REF: "release",
          GITHUB_HEAD_REF: "dev",
          GITHUB_SHA: cleanCheckout.head,
          RUNNER_OS: "Linux",
          THERMITE_EVAL_ENGINE: cleanCheckout.root,
        },
      });
      expect(passing.exitCode).toBe(0);
      const written = JSON.parse(await readFile(passing.receiptPath, "utf8"));
      expect(written.format).toBe(RECEIPT_FORMAT);
      expect(written.ok).toBe(true);
      expect(written.git.head).toBe(cleanCheckout.head);
      expect(written.git.dirty).toBe(false);
      expect(written.git.engineBoundToCheckout).toBe(true);
      expect(written.timing.deadlineMs).toBe(DEFAULT_DEADLINE_MS);
      expect(written.timing.deadlineExceeded).toBe(false);
      expect(written.conflicts).toHaveLength(20);
      expect(written.conflicts[0].exits).toEqual([0, 1]);

      await expect(
        runFixture({
          outputDir: outDir,
          env: { THERMITE_EVAL_ENGINE: otherEngine },
        }),
      ).rejects.toThrow(/THERMITE_EVAL_ENGINE/);

      await expect(
        runFixture({
          outputDir: outDir,
          env: { GITHUB_ACTIONS: "true", GITHUB_SHA: "0".repeat(40) },
        }),
      ).rejects.toThrow(/GITHUB_SHA/);

      await expect(
        runFixture({
          outputDir: outDir,
          conflicts: 19,
          env: { GITHUB_ACTIONS: "true", GITHUB_SHA: cleanCheckout.head },
        }),
      ).rejects.toThrow(/20 canonical conflict pairs/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("rejects dirty and non-git checkouts", async () => {
    const dirtyFixture = await createCleanCheckoutFixture();
    const nonGit = await mkdtemp(join(tmpdir(), "thermite-non-git-"));
    const outDir = await mkdtemp(join(tmpdir(), "thermite-dirty-out-"));
    try {
      await writeFile(join(dirtyFixture.root, "dirty.txt"), "uncommitted\n");
      await expect(
        runContractReceipts({
          outputDir: outDir,
          root: dirtyFixture.root,
          runBarrier: async () => makeCompleteRows(),
          checkerVersion: "1.1",
          env: {},
        }),
      ).rejects.toThrow(/dirty Git checkout/);

      for (const rel of REQUIRED_DIST_FILES) {
        const full = join(nonGit, rel);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, "// dist\n");
      }
      await expect(
        runContractReceipts({
          outputDir: outDir,
          root: nonGit,
          runBarrier: async () => makeCompleteRows(),
          checkerVersion: "1.1",
          env: {},
        }),
      ).rejects.toThrow(/Git/);
    } finally {
      await rm(dirtyFixture.root, { recursive: true, force: true });
      await rm(nonGit, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects symlinked, hard-linked, and non-regular receipt files", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "thermite-contain-file-"));
    const runWith = (outputDir) => runFixture({ outputDir });
    try {
      const sibling = join(scratch, "sibling.txt");
      await writeFile(sibling, "PROTECTED\n");

      const symFileDir = join(scratch, "sym-file-dir");
      await mkdir(symFileDir);
      await symlink(sibling, join(symFileDir, RECEIPT_FILENAME));
      await expect(runWith(symFileDir)).rejects.toThrow(/receipt destination/);
      expect(await readFile(sibling, "utf8")).toBe("PROTECTED\n");

      const hardLinkDir = join(scratch, "hard-link-dir");
      await mkdir(hardLinkDir);
      await link(sibling, join(hardLinkDir, RECEIPT_FILENAME));
      await expect(runWith(hardLinkDir)).rejects.toThrow(/receipt destination/);
      expect(await readFile(sibling, "utf8")).toBe("PROTECTED\n");

      const dirAsReceipt = join(scratch, "dir-as-receipt");
      await mkdir(join(dirAsReceipt, RECEIPT_FILENAME), { recursive: true });
      await expect(runWith(dirAsReceipt)).rejects.toThrow(
        /receipt destination/,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("rejects symlinked output directories and non-directory output paths", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "thermite-contain-dir-"));
    const runWith = (outputDir) => runFixture({ outputDir });
    try {
      const sibling = join(scratch, "sibling.txt");
      await writeFile(sibling, "PROTECTED\n");
      const realTargetDir = join(scratch, "real-outside-dir");
      await mkdir(realTargetDir);
      const linkedDir = join(scratch, "linked-dir");
      await symlink(
        realTargetDir,
        linkedDir,
        process.platform === "win32" ? "junction" : "dir",
      );
      for (const candidate of [linkedDir, join(linkedDir, "nested")]) {
        await expect(runWith(candidate)).rejects.toThrow(
          /symlinked output directory/,
        );
      }
      await expect(runWith(sibling)).rejects.toThrow(
        /not an ordinary directory/,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("enforces the hard driver deadline, kills spawned children, and bounds cleanup", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "thermite-deadline-"));
    const deadlineMs = 5_000;
    const childSleepMs = 60_000;
    const state = {
      barrierEntered: false,
      abortedBeforeSpawn: null,
      abortedInBarrier: false,
      childExited: false,
      childExitedBeforeAbort: null,
      spawnedPid: null,
    };
    try {
      const started = performance.now();
      const timedOut = await runFixture({
        outputDir: outDir,
        deadlineMs,
        runBarrier: ({ registerChild, signal }) =>
          new Promise((resolve) => {
            state.barrierEntered = true;
            state.abortedBeforeSpawn = signal.aborted;
            const detached = process.platform !== "win32";
            const child = spawn(
              process.execPath,
              ["-e", `setTimeout(() => {}, ${childSleepMs});`],
              { stdio: "ignore", detached },
            );
            state.spawnedPid = child.pid;
            child.once("exit", () => {
              state.childExited = true;
            });
            signal.addEventListener(
              "abort",
              () => {
                state.abortedInBarrier = true;
                state.childExitedBeforeAbort = state.childExited;
              },
              { once: true },
            );
            registerChild(child, { detachedProcessGroup: detached });
            child.once("close", () => resolve([]));
          }),
      });
      const wallMs = performance.now() - started;
      expect(state.barrierEntered).toBe(true);
      expect(state.abortedBeforeSpawn).toBe(false);
      expect(state.abortedInBarrier).toBe(true);
      expect(state.childExitedBeforeAbort).toBe(false);
      expect(timedOut.exitCode).toBe(2);
      expect(timedOut.receipt.ok).toBe(false);
      expect(timedOut.receipt.timing.deadlineMs).toBe(deadlineMs);
      expect(timedOut.receipt.timing.deadlineExceeded).toBe(true);
      expect(timedOut.receipt.failures[0]).toMatch(/barrier.*deadline/i);
      expect(wallMs).toBeLessThan(deadlineMs + CLEANUP_GRACE_MS + 5_000);
      expect(state.spawnedPid).toBeGreaterThan(0);
      expect(state.childExited).toBe(true);
      expect(() => process.kill(state.spawnedPid, 0)).toThrow();
    } finally {
      killIfAlive(state.spawnedPid);
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("fails cleanly without running the barrier when the deadline expires during provenance", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "thermite-prov-deadline-"));
    let barrierCalled = false;
    try {
      const started = performance.now();
      let caught = null;
      try {
        await runFixture({
          outputDir: outDir,
          deadlineMs: 1,
          runBarrier: async () => {
            barrierCalled = true;
            return makeCompleteRows();
          },
        });
      } catch (error) {
        caught = error;
      }
      const wallMs = performance.now() - started;
      expect(caught).toBeInstanceOf(Error);
      expect(caught?.code).toBe("DEADLINE_EXCEEDED");
      expect(caught?.message).toMatch(/Contract receipt deadline exceeded/i);
      expect(barrierCalled).toBe(false);
      expect(existsSync(join(outDir, RECEIPT_FILENAME))).toBe(false);
      expect(wallMs).toBeLessThan(CLEANUP_GRACE_MS + 5_000);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects concurrent checker edits and HEAD moves without an ok receipt", async () => {
    const fixture = await createCleanCheckoutFixture();
    const outEdit = await mkdtemp(join(tmpdir(), "thermite-race-edit-"));
    const outHead = await mkdtemp(join(tmpdir(), "thermite-race-head-"));
    const checkerFile = join(
      fixture.root,
      "evals/engine/contract-barrier-spec.mjs",
    );
    const original = await readFile(checkerFile, "utf8");
    try {
      await expect(
        runContractReceipts({
          outputDir: outEdit,
          root: fixture.root,
          checkerVersion: "1.1",
          env: { GITHUB_ACTIONS: "true", GITHUB_SHA: fixture.head },
          runBarrier: async () => {
            await writeFile(checkerFile, `${original}// concurrent edit\n`);
            return makeCompleteRows();
          },
        }),
      ).rejects.toThrow(/dirty|changed/i);
      expect(existsSync(join(outEdit, RECEIPT_FILENAME))).toBe(false);
      await writeFile(checkerFile, original, "utf8");

      await expect(
        runContractReceipts({
          outputDir: outHead,
          root: fixture.root,
          checkerVersion: "1.1",
          env: {},
          runBarrier: async () => {
            await writeFile(join(fixture.root, "extra.txt"), "moved\n");
            execFileSync("git", ["add", "extra.txt"], { cwd: fixture.root });
            execFileSync(
              "git",
              [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-qm",
                "move head",
              ],
              { cwd: fixture.root },
            );
            return makeCompleteRows();
          },
        }),
      ).rejects.toThrow(/HEAD changed/i);
      expect(existsSync(join(outHead, RECEIPT_FILENAME))).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(outEdit, { recursive: true, force: true });
      await rm(outHead, { recursive: true, force: true });
    }
  });

  it("verifies checker file hashes against committed git blobs before execution", async () => {
    const fixture = await createCleanCheckoutFixture();
    const outBlob = await mkdtemp(join(tmpdir(), "thermite-blob-"));
    try {
      execFileSync(
        "git",
        ["update-index", "--assume-unchanged", "evals/engine/contracts.mjs"],
        { cwd: fixture.root },
      );
      await writeFile(
        join(fixture.root, "evals/engine/contracts.mjs"),
        "// tampered under assume-unchanged\n",
      );
      await expect(
        runContractReceipts({
          outputDir: outBlob,
          root: fixture.root,
          checkerVersion: "1.1",
          env: {},
          runBarrier: async () => makeCompleteRows(),
        }),
      ).rejects.toThrow(/committed blob/i);
      expect(existsSync(join(outBlob, RECEIPT_FILENAME))).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(outBlob, { recursive: true, force: true });
    }
  });

  it("handles case-insensitive aliases, literal backslashes on POSIX, and creates no dirs on failure", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "thermite-path-native-"));
    try {
      const titled = join(scratch, "CaseAliasDir");
      const lower = join(scratch, "casealiasdir");
      await mkdir(titled);
      let isCaseInsensitive = false;
      try {
        const [a, b] = await Promise.all([
          lstat(titled, { bigint: true }),
          lstat(lower, { bigint: true }),
        ]);
        isCaseInsensitive = a.dev === b.dev && a.ino === b.ino;
      } catch {
        isCaseInsensitive = false;
      }
      if (isCaseInsensitive) {
        const aliasResult = await runFixture({ outputDir: lower });
        expect(aliasResult.exitCode).toBe(0);
        expect(existsSync(join(titled, RECEIPT_FILENAME))).toBe(true);
      }
      if (process.platform !== "win32") {
        const backslashDir = join(scratch, "legitimate\\directory");
        const bsResult = await runFixture({ outputDir: backslashDir });
        expect(bsResult.exitCode).toBe(0);
        expect(existsSync(join(backslashDir, RECEIPT_FILENAME))).toBe(true);
        expect(existsSync(join(scratch, "legitimate"))).toBe(false);
      }
      const realOutside = join(scratch, "real-out");
      const linked = join(scratch, "linked-out");
      await mkdir(realOutside);
      await symlink(
        realOutside,
        linked,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        runFixture({ outputDir: join(linked, "never-created", "deep") }),
      ).rejects.toThrow(/symlinked output directory/);
      expect(existsSync(join(realOutside, "never-created"))).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("verifies untouched sentinel and rejects byte, metadata, and deletion tampering", async () => {
    const cases = [
      ["untouched", async () => {}, true],
      [
        "byte-change",
        async ({ sentinelPath }) =>
          writeFile(sentinelPath, "MUTATED SENTINEL\n", "utf8"),
        false,
      ],
      [
        "metadata-mtime-change",
        async ({ sentinelPath }) => {
          const later = new Date(Date.now() + 60_000);
          await utimes(sentinelPath, later, later);
        },
        false,
      ],
      ["deleted", async ({ sentinelPath }) => rm(sentinelPath), false],
    ];
    for (const [name, tamper, expectUntouched] of cases) {
      const directory = await mkdtemp(join(tmpdir(), `thermite-sent-${name}-`));
      try {
        const { sentinelPath, before } =
          await prepareConflictSentinel(directory);
        await tamper({ directory, sentinelPath });
        const report = await verifyConflictSentinel(
          directory,
          sentinelPath,
          before,
        );
        expect(report.untouched, name).toBe(expectUntouched);
        if (expectUntouched) {
          expect(report.locationVerified).toBe(true);
          expect(report.identityMatched).toBe(true);
          expect(report.metadataMatched).toBe(true);
          expect(report.digestMatched).toBe(true);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("rejects sentinel identical-content replacement, symlinks, hard links, and parent-dir swap", async () => {
    const cases = [
      [
        "identical-content-replacement",
        async ({ sentinelPath }) => {
          await rename(sentinelPath, `${sentinelPath}.old`);
          await writeFile(sentinelPath, OUTSIDE_SENTINEL_CONTENT, "utf8");
        },
      ],
      [
        "symlink-replacement",
        async ({ directory, sentinelPath }) => {
          const clone = join(directory, "clone-sentinel.txt");
          await writeFile(clone, OUTSIDE_SENTINEL_CONTENT, "utf8");
          await rm(sentinelPath);
          await symlink(clone, sentinelPath);
        },
      ],
      [
        "hardlink-replacement",
        async ({ directory, sentinelPath }) => {
          const clone = join(directory, "hardlink-sentinel.txt");
          await writeFile(clone, OUTSIDE_SENTINEL_CONTENT, "utf8");
          await rm(sentinelPath);
          await link(clone, sentinelPath);
        },
      ],
      [
        "parent-dir-symlink-swap",
        async ({ directory, sentinelPath }) => {
          const altDir = join(directory, "alt-outside");
          await mkdir(altDir);
          await writeFile(
            join(altDir, "sentinel.txt"),
            OUTSIDE_SENTINEL_CONTENT,
            "utf8",
          );
          const parent = dirname(sentinelPath);
          await rename(parent, `${parent}-saved`);
          await symlink(
            altDir,
            parent,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      ],
    ];
    for (const [name, tamper] of cases) {
      const directory = await mkdtemp(join(tmpdir(), `thermite-sent-${name}-`));
      try {
        const { sentinelPath, before } =
          await prepareConflictSentinel(directory);
        await tamper({ directory, sentinelPath });
        const report = await verifyConflictSentinel(
          directory,
          sentinelPath,
          before,
        );
        expect(report.untouched, name).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});
