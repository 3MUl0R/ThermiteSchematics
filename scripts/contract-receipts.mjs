import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { release as osRelease, type as osType } from "node:os";
import { join, normalize, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
export const RECEIPT_FORMAT = "thermite-contract-receipt/1.0";
export const RECEIPT_FILENAME = "contract-receipt.json";
export const DEFAULT_DEADLINE_MS = 3 * 60 * 1000;
export const CONFLICT_BARRIER_PREFIX = "guard/two-process-barrier/";
export const REQUIRED_CI_CONFLICT_ROW_IDS = Object.freeze([
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
export const EXPECTED_SENTINEL_PATH = "outside/sentinel.txt";
export const EXPECTED_SENTINEL_CONTENT = "SYNTHETIC OUTSIDE SENTINEL\n";
const EXPECTED_SENTINEL_BYTES = Buffer.from(EXPECTED_SENTINEL_CONTENT, "utf8");
export const EXPECTED_SENTINEL_SIZE = EXPECTED_SENTINEL_BYTES.length;
export const EXPECTED_SENTINEL_SHA256 = createHash("sha256")
  .update(EXPECTED_SENTINEL_BYTES)
  .digest("hex");
export const REQUIRED_DIST_FILES = Object.freeze([
  "packages/cli/dist/alpha.js",
  "packages/cli/dist/index.js",
  "packages/compiler/dist/index.js",
  "packages/agent-tools/dist/index.js",
  "packages/agent-tools/dist/apply-source-patch.js",
  "packages/agent-tools/dist/patch-filesystem.js",
  "packages/agent-tools/dist/project-write-lock.js",
]);
const CHECKER_FILES = Object.freeze([
  "evals/engine/conflict-sentinel.mjs",
  "evals/engine/contract-barrier-spec.mjs",
  "evals/engine/contracts.mjs",
  "evals/engine/engine.mjs",
  "evals/engine/patch-worker.mjs",
  "evals/engine/support.mjs",
  "scripts/contract-receipts.mjs",
]);
const PERMITTED_OVERLAP_EVENTS = new Set([
  "reservation-contention",
  "both-precommit-barriers",
]);
const VALID_WRITERS = new Set(["A", "B"]);
const VALID_LOSER_CODES = new Set(["A004", "A005"]);
const GIT_SHA_HEX = /^[0-9a-f]{40}$/;

function normalizePathForCompare(targetPath) {
  const normalized = normalize(targetPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function canonicalConflictRowIds(conflicts) {
  if (!Number.isInteger(conflicts) || conflicts < 1 || conflicts > 1000) {
    throw new RangeError(
      `Expected integer conflict pair count between 1 and 1000, got ${conflicts}`,
    );
  }
  if (conflicts === REQUIRED_CI_CONFLICT_ROW_IDS.length) {
    return REQUIRED_CI_CONFLICT_ROW_IDS;
  }
  return Array.from(
    { length: conflicts },
    (_, index) => `${CONFLICT_BARRIER_PREFIX}${index + 1}`,
  );
}

export function assertDistBuilt(root = REPOSITORY_ROOT) {
  const missing = REQUIRED_DIST_FILES.filter(
    (relativePath) => !existsSync(join(root, relativePath)),
  );
  if (missing.length > 0) {
    throw new Error(
      `Required built dist outputs are missing (${missing.join(", ")}). Run \`bun run build\` first.`,
    );
  }
}

function parsePairIndex(id) {
  if (typeof id !== "string" || !id.startsWith(CONFLICT_BARRIER_PREFIX))
    return null;
  const parsed = Number(id.slice(CONFLICT_BARRIER_PREFIX.length));
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function isValidSentinelSnapshot(snapshot) {
  return (
    Boolean(snapshot) &&
    typeof snapshot === "object" &&
    snapshot.exists === true &&
    snapshot.isRegularFile === true &&
    snapshot.isSymbolicLink === false &&
    snapshot.parentIsRegularDir === true &&
    snapshot.locationVerified === true &&
    snapshot.nlink === 1 &&
    typeof snapshot.dev === "string" &&
    snapshot.dev.length > 0 &&
    typeof snapshot.ino === "string" &&
    snapshot.ino.length > 0 &&
    snapshot.size === EXPECTED_SENTINEL_SIZE &&
    Number.isInteger(snapshot.mode) &&
    typeof snapshot.mtimeNs === "string" &&
    snapshot.mtimeNs.length > 0 &&
    typeof snapshot.ctimeNs === "string" &&
    snapshot.ctimeNs.length > 0 &&
    snapshot.sha256 === EXPECTED_SENTINEL_SHA256
  );
}

function validateSentinelEvidence(id, sentinel) {
  if (!sentinel || typeof sentinel !== "object") {
    return [`Row "${id}" did not prove the outside sentinel untouched.`];
  }
  const errors = [];
  if (sentinel.path !== EXPECTED_SENTINEL_PATH) {
    errors.push(
      `Row "${id}" sentinel path "${String(sentinel.path)}" does not match "${EXPECTED_SENTINEL_PATH}".`,
    );
  }
  if (sentinel.untouched !== true) {
    errors.push(`Row "${id}" did not prove the outside sentinel untouched.`);
  }
  if (
    sentinel.sha256 !== EXPECTED_SENTINEL_SHA256 ||
    sentinel.expectedSha256 !== EXPECTED_SENTINEL_SHA256 ||
    sentinel.digestMatched !== true
  ) {
    errors.push(
      `Row "${id}" sentinel raw-byte digest does not match expected SHA-256.`,
    );
  }
  if (
    sentinel.locationVerified !== true ||
    sentinel.identityMatched !== true ||
    sentinel.metadataMatched !== true
  ) {
    errors.push(
      `Row "${id}" sentinel location, identity, or metadata verification failed.`,
    );
  }
  const { before, after } = sentinel;
  if (
    !isValidSentinelSnapshot(before) ||
    !isValidSentinelSnapshot(after) ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mode !== before.mode ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs ||
    after.sha256 !== before.sha256
  ) {
    errors.push(
      `Row "${id}" sentinel before/after identity or metadata snapshots do not reconcile.`,
    );
  }
  return errors;
}

function validateExitsAndActors(id, evidence) {
  const errors = [];
  const exits = evidence.exits;
  const validExits =
    Array.isArray(exits) &&
    exits.length === 2 &&
    exits.every((code) => Number.isInteger(code)) &&
    exits.filter((code) => code === 0).length === 1;
  if (!validExits) {
    return [
      `Row "${id}" raw worker exits (${JSON.stringify(exits)}) do not show exactly one winner.`,
    ];
  }
  const observedWinner = exits[0] === 0 ? "A" : "B";
  const observedLoser = observedWinner === "A" ? "B" : "A";
  const observedLoserExit = exits[observedWinner === "A" ? 1 : 0];
  if (![1, 2].includes(observedLoserExit)) {
    errors.push(
      `Row "${id}" loser exit code (${observedLoserExit}) is not a valid refusal/error exit.`,
    );
  }
  const { winner, loser } = evidence;
  if (
    !winner ||
    !VALID_WRITERS.has(winner.writer) ||
    winner.writer !== observedWinner ||
    winner.exitCode !== 0 ||
    winner.finalDescription !== observedWinner
  ) {
    errors.push(
      `Row "${id}" winner summary does not reconcile with raw exits.`,
    );
  }
  if (
    !loser ||
    !VALID_WRITERS.has(loser.writer) ||
    loser.writer !== observedLoser ||
    loser.exitCode !== observedLoserExit ||
    !VALID_LOSER_CODES.has(loser.errorCode)
  ) {
    errors.push(`Row "${id}" loser summary does not reconcile with raw exits.`);
  }
  if (
    !VALID_LOSER_CODES.has(evidence.loserCode) ||
    (loser && evidence.loserCode !== loser.errorCode)
  ) {
    errors.push(
      `Row "${id}" raw loserCode (${String(evidence.loserCode)}) is invalid or contradicts loser.errorCode.`,
    );
  }
  if (evidence.finalDescription !== observedWinner) {
    errors.push(
      `Row "${id}" raw finalDescription (${String(evidence.finalDescription)}) contradicts winner "${observedWinner}".`,
    );
  }
  return errors;
}

function validateEvidenceFields(id, evidence) {
  if (!evidence || typeof evidence !== "object") {
    return [`Row "${id}" is missing conflict evidence.`];
  }
  const errors = [];
  if (
    evidence.overlapped !== true ||
    typeof evidence.releasedBy !== "string" ||
    !PERMITTED_OVERLAP_EVENTS.has(evidence.releasedBy)
  ) {
    errors.push(
      `Row "${id}" did not observe a permitted barrier overlap event (overlapped=${String(evidence.overlapped)}, releasedBy=${String(evidence.releasedBy)}).`,
    );
  }
  errors.push(...validateExitsAndActors(id, evidence));
  errors.push(...validateSentinelEvidence(id, evidence.sentinel));
  return errors;
}

function normalizeConflictRow(id, row) {
  const evidence = row?.evidence;
  return {
    id,
    pair: parsePairIndex(id),
    status: row?.status ?? "missing",
    overlapped: evidence?.overlapped ?? false,
    releasedBy: evidence?.releasedBy ?? null,
    exits: Array.isArray(evidence?.exits) ? [...evidence.exits] : null,
    loserCode: evidence?.loserCode ?? null,
    finalDescription: evidence?.finalDescription ?? null,
    winner: evidence?.winner ?? null,
    loser: evidence?.loser ?? null,
    sentinel: evidence?.sentinel ?? null,
    ...(row?.failure ? { failure: row.failure } : {}),
  };
}

function indexConflictRows(rows, expectedSet) {
  const byId = new Map();
  const failures = [];
  let extra = 0;
  for (const row of rows) {
    const id = row?.id;
    if (typeof id !== "string" || !expectedSet.has(id)) {
      extra += 1;
      failures.push(`Unexpected conflict row "${String(id)}".`);
      continue;
    }
    if (byId.has(id)) {
      extra += 1;
      failures.push(`Duplicate conflict row "${id}".`);
      continue;
    }
    byId.set(id, row);
  }
  return { byId, failures, extra };
}

export function validateConflictRows(
  rows,
  expectedIds = REQUIRED_CI_CONFLICT_ROW_IDS,
) {
  if (!Array.isArray(rows)) {
    throw new TypeError("Conflict barrier rows must be an array.");
  }
  const { byId, failures, extra } = indexConflictRows(
    rows,
    new Set(expectedIds),
  );
  const conflicts = [];
  let passed = 0;
  let failed = 0;
  let missing = 0;
  let hasInfrastructureError = false;
  for (const id of expectedIds) {
    const row = byId.get(id);
    if (!row) {
      missing += 1;
      failures.push(`Missing expected conflict row "${id}".`);
      conflicts.push(normalizeConflictRow(id, null));
      continue;
    }
    if (row.status === "infrastructure-error") hasInfrastructureError = true;
    const rowErrors =
      row.status !== "pass"
        ? [
            `Row "${id}" status is "${row.status ?? "<missing>"}"${row.failure ? `: ${row.failure}` : ""}.`,
          ]
        : validateEvidenceFields(id, row.evidence);
    if (rowErrors.length > 0) {
      failed += 1;
      failures.push(...rowErrors);
    } else {
      passed += 1;
    }
    conflicts.push(normalizeConflictRow(id, row));
  }
  return {
    ok: failures.length === 0,
    hasInfrastructureError,
    failures,
    conflicts,
    summary: {
      expected: expectedIds.length,
      observed: rows.length,
      passed,
      failed,
      missing,
      extra,
    },
  };
}

async function verifyEngineEnvBinding(checkoutRoot, env) {
  const configured = env.THERMITE_EVAL_ENGINE;
  if (configured === undefined || configured === "") return;
  let resolvedEngine;
  try {
    resolvedEngine = await realpath(resolve(configured));
  } catch {
    throw new Error(
      `THERMITE_EVAL_ENGINE does not resolve to an accessible checkout: "${configured}".`,
    );
  }
  if (
    normalizePathForCompare(resolvedEngine) !==
    normalizePathForCompare(checkoutRoot)
  ) {
    throw new Error(
      "THERMITE_EVAL_ENGINE points to a different checkout than the receipt driver.",
    );
  }
}

async function readAndVerifyGitMetadata(checkoutRoot, env = process.env) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: checkoutRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  let topLevel;
  try {
    topLevel = await realpath(git("rev-parse", "--show-toplevel"));
  } catch {
    throw new Error(
      "Receipt checkout must be a valid Git checkout with its own identity.",
    );
  }
  if (
    normalizePathForCompare(topLevel) !== normalizePathForCompare(checkoutRoot)
  ) {
    throw new Error(
      "Receipt checkout root does not match its Git toplevel directory.",
    );
  }
  const head = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (!GIT_SHA_HEX.test(head) || !GIT_SHA_HEX.test(tree)) {
    throw new Error("Receipt checkout returned invalid Git commit/tree SHA.");
  }
  const dirtyStatus = git("status", "--porcelain", "--untracked-files=normal");
  if (dirtyStatus.length > 0) {
    throw new Error(
      "Refusing to generate a contract receipt from a dirty Git checkout.",
    );
  }
  if (env.GITHUB_ACTIONS === "true") {
    if (!env.GITHUB_SHA || !GIT_SHA_HEX.test(env.GITHUB_SHA)) {
      throw new Error(
        `CI receipt requires a valid 40-character GITHUB_SHA (got "${env.GITHUB_SHA ?? ""}").`,
      );
    }
    if (head !== env.GITHUB_SHA) {
      throw new Error(
        `CI receipt provenance mismatch: HEAD (${head}) !== GITHUB_SHA (${env.GITHUB_SHA}).`,
      );
    }
  }
  return {
    head,
    tree,
    ref: env.GITHUB_REF || branch,
    baseRef: env.GITHUB_BASE_REF || null,
    headRef: env.GITHUB_HEAD_REF || null,
    githubSha: env.GITHUB_SHA || null,
    dirty: false,
    engineBoundToCheckout: true,
  };
}

async function readVersions(checkoutRoot, checkerVersion) {
  const pkg = JSON.parse(
    await readFile(join(checkoutRoot, "package.json"), "utf8"),
  );
  const checkers = await Promise.all(
    CHECKER_FILES.map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(join(checkoutRoot, path)))
        .digest("hex"),
    })),
  );
  return {
    enginePackage: pkg.version,
    checker: checkerVersion,
    checkers,
  };
}

function pathPrefixes(resolvedTarget) {
  const { root: fsRoot } = parse(resolvedTarget);
  const tail = resolvedTarget.slice(fsRoot.length);
  const segments = tail.split(/[\\/]+/).filter(Boolean);
  const prefixes = [];
  let current = fsRoot;
  for (const segment of segments) {
    current =
      current.endsWith(sep) || current.endsWith("/")
        ? `${current}${segment}`
        : `${current}${sep}${segment}`;
    prefixes.push(current);
  }
  return prefixes;
}

async function assertSafeReceiptDestination(receiptPath, realDir) {
  let existing;
  try {
    existing = await lstat(receiptPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (
    existing.isSymbolicLink() ||
    !existing.isFile() ||
    existing.nlink !== 1n
  ) {
    throw new Error(
      `Refusing symlinked, hard-linked, or non-regular receipt destination: ${RECEIPT_FILENAME}.`,
    );
  }
  const realReceipt = await realpath(receiptPath);
  if (
    normalizePathForCompare(realReceipt) !==
    normalizePathForCompare(join(realDir, RECEIPT_FILENAME))
  ) {
    throw new Error(
      "Receipt destination resolves outside the verified directory.",
    );
  }
}

export async function verifyAndEnsureOutputDir(outputDir) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("Missing required outputDir.");
  }
  const resolvedTarget = resolve(outputDir);
  for (const prefix of pathPrefixes(resolvedTarget)) {
    let stats;
    try {
      stats = await lstat(prefix);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(prefix, { recursive: false, mode: 0o755 });
      stats = await lstat(prefix);
    }
    if (stats.isSymbolicLink()) {
      throw new Error("Refusing symlinked output directory path.");
    }
    if (!stats.isDirectory()) {
      throw new Error("Output path exists and is not an ordinary directory.");
    }
  }
  const realDir = await realpath(resolvedTarget);
  const realDirStat = await lstat(realDir);
  if (realDirStat.isSymbolicLink() || !realDirStat.isDirectory()) {
    throw new Error("Resolved output path is not an ordinary directory.");
  }
  if (
    process.platform !== "win32" &&
    normalizePathForCompare(realDir) !== normalizePathForCompare(resolvedTarget)
  ) {
    throw new Error("Output directory path traverses a symbolic link.");
  }
  const receiptPath = join(realDir, RECEIPT_FILENAME);
  await assertSafeReceiptDestination(receiptPath, realDir);
  return { realDir, receiptPath };
}

async function writeReceiptSafely(outputDir, receipt) {
  const { realDir, receiptPath } = await verifyAndEnsureOutputDir(outputDir);
  const payload = `${JSON.stringify(receipt, null, 2)}\n`;
  const tempPath = join(
    realDir,
    `.${RECEIPT_FILENAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o644);
    await handle.writeFile(payload, "utf8");
    await handle.close();
    handle = undefined;
    const tempStat = await lstat(tempPath, { bigint: true });
    if (
      tempStat.isSymbolicLink() ||
      !tempStat.isFile() ||
      tempStat.nlink !== 1n
    ) {
      throw new Error(
        "Temporary receipt file is not an ordinary regular file.",
      );
    }
    await assertSafeReceiptDestination(receiptPath, realDir);
    await rename(tempPath, receiptPath);
    await assertSafeReceiptDestination(receiptPath, realDir);
    return receiptPath;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function buildContractReceipt({
  validation,
  git,
  versions,
  elapsedMs,
  deadlineMs = DEFAULT_DEADLINE_MS,
  deadlineExceeded = false,
  env = process.env,
}) {
  return {
    format: RECEIPT_FORMAT,
    ok: validation.ok,
    platform: `${process.platform}-${process.arch}`,
    os: {
      platform: process.platform,
      arch: process.arch,
      type: osType(),
      release: osRelease(),
      runnerOs: env.RUNNER_OS || null,
    },
    runtime: {
      engine: typeof Bun !== "undefined" ? "bun" : "node",
      bunVersion: typeof Bun !== "undefined" ? Bun.version : null,
      nodeVersion: process.version,
    },
    git,
    versions,
    timing: {
      elapsedMs: Math.round(elapsedMs),
      deadlineMs,
      deadlineExceeded,
    },
    summary: validation.summary,
    failures: validation.failures,
    conflicts: validation.conflicts,
  };
}

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      output: { type: "string" },
      conflicts: { type: "string" },
    },
  });
  if (!values.output || !values.output.trim()) {
    throw new Error("Missing required --output <directory> argument.");
  }
  const conflicts =
    values.conflicts === undefined ? undefined : Number(values.conflicts);
  const expectedIds =
    conflicts === undefined
      ? REQUIRED_CI_CONFLICT_ROW_IDS
      : canonicalConflictRowIds(conflicts);
  return {
    outputDir: resolve(values.output),
    conflicts,
    expectedIds,
  };
}

async function loadPinnedBarrier(checkoutRoot, conflicts) {
  const driverRoot = await realpath(REPOSITORY_ROOT);
  if (
    normalizePathForCompare(driverRoot) !==
    normalizePathForCompare(checkoutRoot)
  ) {
    throw new Error(
      "Receipt driver must run from the same checkout root as the pinned engine.",
    );
  }
  process.env.THERMITE_EVAL_ENGINE = checkoutRoot;
  const [engineMod, contractsMod, supportMod, specMod] = await Promise.all([
    import("../evals/engine/engine.mjs"),
    import("../evals/engine/contracts.mjs"),
    import("../evals/engine/support.mjs"),
    import("../evals/engine/contract-barrier-spec.mjs"),
  ]);
  if (
    normalizePathForCompare(engineMod.engineRoot) !==
    normalizePathForCompare(checkoutRoot)
  ) {
    throw new Error(
      "Loaded evaluation engine does not match the pinned receipt checkout.",
    );
  }
  if (conflicts === REQUIRED_CI_CONFLICT_ROW_IDS.length) {
    const specIds = specMod.expectedConflictRowIds();
    const matchesPinned =
      specIds.length === REQUIRED_CI_CONFLICT_ROW_IDS.length &&
      specIds.every((id, index) => id === REQUIRED_CI_CONFLICT_ROW_IDS[index]);
    if (!matchesPinned) {
      throw new Error(
        `Producer barrier spec drifted from required ${REQUIRED_CI_CONFLICT_ROW_IDS.length} canonical rows (spec has ${specIds.length}).`,
      );
    }
  }
  return {
    barrierRunner: contractsMod.contractConflictBarrier,
    evalsVersion: supportMod.version,
  };
}

async function runBarrierWithinDeadline(barrierRunner, conflicts, deadlineMs) {
  const startedAt = performance.now();
  const deadlineAt = startedAt + deadlineMs;
  const runnerOptions =
    conflicts === undefined
      ? { strictSentinel: true, deadlineAt }
      : { conflicts, strictSentinel: true, deadlineAt };
  let timer;
  let timedOut = false;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(
        Object.assign(
          new Error("Contract conflict barrier deadline exceeded"),
          {
            code: "DEADLINE_EXCEEDED",
          },
        ),
      );
    }, deadlineMs);
    timer.unref?.();
  });
  try {
    const rows = await Promise.race([
      Promise.resolve().then(() => barrierRunner(runnerOptions)),
      timeoutPromise,
    ]);
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs > deadlineMs) {
      return { timedOut: true, elapsedMs, rows: [] };
    }
    return { timedOut: false, elapsedMs, rows };
  } catch (error) {
    const elapsedMs = performance.now() - startedAt;
    if (timedOut || error?.code === "DEADLINE_EXCEEDED") {
      return { timedOut: true, elapsedMs, rows: [] };
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildDeadlineValidation(expectedIds, elapsedMs, deadlineMs) {
  const seconds = Math.round(deadlineMs / 1000);
  return {
    ok: false,
    hasInfrastructureError: true,
    failures: [
      `Contract conflict barrier exceeded the hard ${seconds}-second deadline (${Math.round(elapsedMs)} ms > ${deadlineMs} ms).`,
    ],
    conflicts: expectedIds.map((id) => normalizeConflictRow(id, null)),
    summary: {
      expected: expectedIds.length,
      observed: 0,
      passed: 0,
      failed: 0,
      missing: expectedIds.length,
      extra: 0,
    },
  };
}

export async function runContractReceipts({
  outputDir,
  conflicts,
  root = REPOSITORY_ROOT,
  env = process.env,
  deadlineMs = DEFAULT_DEADLINE_MS,
  runBarrier,
  checkerVersion,
} = {}) {
  if (!outputDir) {
    throw new Error("Missing required outputDir.");
  }
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError(`Invalid deadlineMs: ${deadlineMs}`);
  }
  const expectedIds =
    conflicts === undefined
      ? REQUIRED_CI_CONFLICT_ROW_IDS
      : canonicalConflictRowIds(conflicts);
  if (env.GITHUB_ACTIONS === "true") {
    if (expectedIds !== REQUIRED_CI_CONFLICT_ROW_IDS) {
      throw new Error(
        `CI contract receipts require exactly ${REQUIRED_CI_CONFLICT_ROW_IDS.length} canonical conflict pairs.`,
      );
    }
    if (deadlineMs > DEFAULT_DEADLINE_MS) {
      throw new Error(
        `CI contract receipts cannot exceed the ${DEFAULT_DEADLINE_MS} ms deadline.`,
      );
    }
  }
  const checkoutRoot = await realpath(resolve(root));
  await verifyEngineEnvBinding(checkoutRoot, env);
  assertDistBuilt(checkoutRoot);
  const git = await readAndVerifyGitMetadata(checkoutRoot, env);
  await verifyAndEnsureOutputDir(outputDir);

  let barrierRunner = runBarrier;
  let evalsVersion = checkerVersion;
  if (!barrierRunner || !evalsVersion) {
    const pinned = await loadPinnedBarrier(checkoutRoot, conflicts);
    barrierRunner ??= pinned.barrierRunner;
    evalsVersion ??= pinned.evalsVersion;
  }

  const run = await runBarrierWithinDeadline(
    barrierRunner,
    conflicts,
    deadlineMs,
  );
  const validation = run.timedOut
    ? buildDeadlineValidation(expectedIds, run.elapsedMs, deadlineMs)
    : validateConflictRows(run.rows, expectedIds);
  const receipt = buildContractReceipt({
    validation,
    git,
    versions: await readVersions(checkoutRoot, evalsVersion),
    elapsedMs: run.elapsedMs,
    deadlineMs,
    deadlineExceeded: run.timedOut,
    env,
  });
  const receiptPath = await writeReceiptSafely(outputDir, receipt);
  const exitCode = receipt.ok ? 0 : validation.hasInfrastructureError ? 2 : 1;
  return { receipt, receiptPath, exitCode };
}

async function main() {
  const { outputDir, conflicts } = parseCliArgs(process.argv.slice(2));
  const { receipt, exitCode } = await runContractReceipts({
    outputDir,
    conflicts,
  });
  process.stdout.write(
    `${JSON.stringify({ ok: receipt.ok, summary: receipt.summary, timing: receipt.timing, tree: receipt.git.tree })}\n`,
  );
  if (!receipt.ok) {
    for (const failure of receipt.failures) {
      process.stderr.write(`FAIL: ${failure}\n`);
    }
  }
  process.exitCode = exitCode;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`contract-receipts: ${error.message}\n`);
    process.exitCode = 2;
  }
}
