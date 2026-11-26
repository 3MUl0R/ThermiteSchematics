import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { release as osRelease, type as osType } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CI_CONFLICT_PAIRS,
  CONFLICT_BARRIER_PREFIX,
  expectedConflictRowIds,
} from "../evals/engine/contract-barrier-spec.mjs";

export const REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
export const RECEIPT_FORMAT = "thermite-contract-receipt/1.0";
export const RECEIPT_FILENAME = "contract-receipt.json";
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
  "evals/engine/contract-barrier-spec.mjs",
  "evals/engine/contracts.mjs",
  "evals/engine/engine.mjs",
  "evals/engine/patch-worker.mjs",
  "evals/engine/support.mjs",
  "scripts/contract-receipts.mjs",
]);
const VALID_WRITERS = new Set(["A", "B"]);
const VALID_LOSER_CODES = new Set(["A004", "A005"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

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

function validateEvidenceFields(id, evidence) {
  const errors = [];
  if (!evidence || typeof evidence !== "object") {
    return [`Row "${id}" is missing conflict evidence.`];
  }
  if (evidence.overlapped !== true) {
    errors.push(`Row "${id}" did not observe barrier overlap.`);
  }
  const winner = evidence.winner;
  if (
    !winner ||
    !VALID_WRITERS.has(winner.writer) ||
    winner.exitCode !== 0 ||
    winner.finalDescription !== winner.writer
  ) {
    errors.push(`Row "${id}" is missing a valid single winner.`);
  }
  const loser = evidence.loser;
  if (
    !loser ||
    !VALID_WRITERS.has(loser.writer) ||
    (winner && loser.writer === winner.writer) ||
    ![1, 2].includes(loser.exitCode) ||
    !VALID_LOSER_CODES.has(loser.errorCode)
  ) {
    errors.push(`Row "${id}" is missing a valid contending loser.`);
  }
  const sentinel = evidence.sentinel;
  if (
    !sentinel ||
    typeof sentinel.path !== "string" ||
    sentinel.path.length === 0 ||
    sentinel.untouched !== true ||
    typeof sentinel.sha256 !== "string" ||
    !SHA256_HEX.test(sentinel.sha256)
  ) {
    errors.push(`Row "${id}" did not prove the outside sentinel untouched.`);
  }
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
  expectedIds = expectedConflictRowIds(CI_CONFLICT_PAIRS),
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

function readGitMetadata(root, env = process.env) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const head = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const dirty =
    git(
      "status",
      "--porcelain",
      "--",
      "packages",
      "libraries",
      "scripts",
      "evals",
      "thermite.mjs",
      "package.json",
      "bun.lock",
    ).length > 0;
  return {
    head,
    tree,
    ref: env.GITHUB_REF || branch,
    baseRef: env.GITHUB_BASE_REF || null,
    headRef: env.GITHUB_HEAD_REF || null,
    githubSha: env.GITHUB_SHA || null,
    dirty,
  };
}

async function readVersions(root, checkerVersion) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const checkers = await Promise.all(
    CHECKER_FILES.map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex"),
    })),
  );
  return {
    enginePackage: pkg.version,
    checker: checkerVersion,
    checkers,
  };
}

export function buildContractReceipt({
  validation,
  git,
  versions,
  elapsedMs,
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
      conflicts: { type: "string", default: String(CI_CONFLICT_PAIRS) },
    },
  });
  if (!values.output || !values.output.trim()) {
    throw new Error("Missing required --output <directory> argument.");
  }
  const conflicts = Number(values.conflicts);
  const expectedIds = expectedConflictRowIds(conflicts);
  return {
    outputDir: resolve(values.output),
    conflicts,
    expectedIds,
  };
}

export async function runContractReceipts({
  outputDir,
  conflicts = CI_CONFLICT_PAIRS,
  root = REPOSITORY_ROOT,
  env = process.env,
  runBarrier,
  checkerVersion,
} = {}) {
  if (!outputDir) {
    throw new Error("Missing required outputDir.");
  }
  assertDistBuilt(root);
  const expectedIds = expectedConflictRowIds(conflicts);
  let barrierRunner = runBarrier;
  let evalsVersion = checkerVersion;
  if (!barrierRunner || !evalsVersion) {
    const [contractsMod, supportMod] = await Promise.all([
      import("../evals/engine/contracts.mjs"),
      import("../evals/engine/support.mjs"),
    ]);
    barrierRunner ??= contractsMod.contractConflictBarrier;
    evalsVersion ??= supportMod.version;
  }
  const startedAt = performance.now();
  const rows = await barrierRunner({ conflicts });
  const elapsedMs = performance.now() - startedAt;
  const validation = validateConflictRows(rows, expectedIds);
  const receipt = buildContractReceipt({
    validation,
    git: readGitMetadata(root, env),
    versions: await readVersions(root, evalsVersion),
    elapsedMs,
    env,
  });
  await mkdir(outputDir, { recursive: true });
  const receiptPath = join(outputDir, RECEIPT_FILENAME);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
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
