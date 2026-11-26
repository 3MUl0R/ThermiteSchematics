import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, normalize, parse, resolve, sep } from "node:path";

export const RECEIPT_FILENAME = "contract-receipt.json";
export const CLEANUP_GRACE_MS = 2000;
const SIGKILL_ESCALATION_MS = 500;
const GIT_SHA_HEX = /^[0-9a-f]{40}$/;

export function deadlineError(label) {
  return Object.assign(
    new Error(`Contract receipt deadline exceeded: ${label}`),
    {
      code: "DEADLINE_EXCEEDED",
    },
  );
}

function normalizePathForCompare(targetPath) {
  const normalized = normalize(targetPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameStatIdentity(statA, statB) {
  if (process.platform === "win32" && (statA.ino === 0n || statB.ino === 0n)) {
    return null;
  }
  return statA.dev === statB.dev && statA.ino === statB.ino;
}

export async function sameDirectoryIdentity(pathA, pathB) {
  const [statA, statB] = await Promise.all([
    lstat(pathA, { bigint: true }),
    lstat(pathB, { bigint: true }),
  ]);
  if (
    statA.isSymbolicLink() ||
    !statA.isDirectory() ||
    statB.isSymbolicLink() ||
    !statB.isDirectory()
  ) {
    return false;
  }
  const byIdentity = sameStatIdentity(statA, statB);
  if (byIdentity !== null) return byIdentity;
  const [realA, realB] = await Promise.all([realpath(pathA), realpath(pathB)]);
  return normalizePathForCompare(realA) === normalizePathForCompare(realB);
}

function signalProcessAndGroup(child, detachedProcessGroup, sig) {
  const pid = child?.pid;
  if (typeof pid !== "number" || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, sig);
  } catch {
    // Child already exited.
  }
  if (detachedProcessGroup && process.platform !== "win32") {
    try {
      process.kill(-pid, sig);
    } catch {
      // Process group already exited.
    }
  }
}

function forceKillWindowsTree(pid) {
  if (process.platform !== "win32" || typeof pid !== "number" || pid <= 0) {
    return;
  }
  try {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref?.();
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // Ignore taskkill cleanup error.
      }
    }, 1000);
    timer.unref?.();
    killer.on("close", () => clearTimeout(timer));
    killer.on("error", () => clearTimeout(timer));
  } catch {
    // Ignore if taskkill is unavailable.
  }
}

function detachChildHandles(child) {
  try {
    if (child.connected) child.disconnect();
  } catch {
    // Ignore already disconnected IPC channel.
  }
  child.stdin?.destroy?.();
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
  child.unref?.();
}

async function waitForEntriesOrGrace(entries, graceMs) {
  const pending = entries.filter((entry) => !entry.exited);
  if (pending.length === 0 || graceMs <= 0) return;
  let timer;
  try {
    await Promise.race([
      Promise.allSettled(pending.map((entry) => entry.closed)),
      new Promise((resolveWait) => {
        timer = setTimeout(resolveWait, graceMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateActiveEntries(snapshot, graceMs) {
  if (snapshot.length === 0) return;
  for (const entry of snapshot) {
    if (!entry.exited) {
      signalProcessAndGroup(entry.child, entry.detachedProcessGroup, "SIGTERM");
    }
  }
  const firstWait = Math.min(SIGKILL_ESCALATION_MS, graceMs);
  await waitForEntriesOrGrace(snapshot, firstWait);
  const stubborn = snapshot.filter((entry) => !entry.exited);
  if (stubborn.length > 0) {
    for (const entry of stubborn) {
      if (process.platform === "win32") {
        forceKillWindowsTree(entry.child.pid);
      } else {
        signalProcessAndGroup(
          entry.child,
          entry.detachedProcessGroup,
          "SIGKILL",
        );
      }
    }
    await waitForEntriesOrGrace(stubborn, Math.max(0, graceMs - firstWait));
  }
  for (const entry of snapshot) {
    if (!entry.exited) detachChildHandles(entry.child);
  }
}

function trackActiveChild(active, child, detachedProcessGroup, isExpired) {
  if (!child) return () => {};
  let resolveClosed;
  const closed = new Promise((resolveWait) => {
    resolveClosed = resolveWait;
  });
  const entry = {
    child,
    detachedProcessGroup,
    exited: child.exitCode !== null || child.signalCode !== null,
    closed,
  };
  const markDone = () => {
    if (entry.exited) return;
    entry.exited = true;
    active.delete(entry);
    resolveClosed();
  };
  if (entry.exited) {
    resolveClosed();
    return () => {};
  }
  active.add(entry);
  child.once("exit", markDone);
  child.once("close", markDone);
  child.once("error", markDone);
  if (isExpired()) {
    signalProcessAndGroup(child, detachedProcessGroup, "SIGTERM");
  }
  return () => {
    if (child.exitCode !== null || child.signalCode !== null) markDone();
  };
}

export function createDeadlineController(
  deadlineMs,
  startedAt = performance.now(),
) {
  const deadlineAt = startedAt + deadlineMs;
  const abortController = new AbortController();
  const active = new Set();
  let expired = false;
  let cancelPromise = null;
  const remainingMs = () => Math.max(0, deadlineAt - performance.now());
  const elapsedMs = () => performance.now() - startedAt;
  const isExpired = () => expired || performance.now() >= deadlineAt;

  const cancelAll = (graceMs = CLEANUP_GRACE_MS) => {
    if (cancelPromise) return cancelPromise;
    expired = true;
    if (!abortController.signal.aborted) {
      abortController.abort(deadlineError("hard deadline reached"));
    }
    cancelPromise = terminateActiveEntries([...active], graceMs);
    return cancelPromise;
  };
  const triggerExpiry = () => {
    if (!expired) {
      expired = true;
      void cancelAll(CLEANUP_GRACE_MS);
    }
  };
  const initialRemaining = remainingMs();
  let masterTimer = null;
  if (initialRemaining <= 0) triggerExpiry();
  else {
    masterTimer = setTimeout(
      triggerExpiry,
      Math.max(1, Math.ceil(initialRemaining)),
    );
    masterTimer.unref?.();
  }
  return {
    startedAt,
    deadlineMs,
    deadlineAt,
    signal: abortController.signal,
    remainingMs,
    elapsedMs,
    isExpired,
    hasActiveChildren: () => active.size > 0,
    assertNotExpired(phase) {
      if (isExpired()) {
        triggerExpiry();
        throw deadlineError(phase);
      }
    },
    registerChild: (child, { detachedProcessGroup = false } = {}) =>
      trackActiveChild(active, child, detachedProcessGroup, isExpired),
    cancelAll,
    dispose() {
      if (masterTimer) {
        clearTimeout(masterTimer);
        masterTimer = null;
      }
    },
  };
}

export async function raceWithDeadline(promise, deadline, phase) {
  deadline.assertNotExpired(phase);
  const remaining = deadline.remainingMs();
  if (remaining <= 0) {
    throw deadlineError(phase);
  }
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        const fail = () => reject(deadlineError(phase));
        if (deadline.signal.aborted) {
          fail();
          return;
        }
        onAbort = fail;
        deadline.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(fail, Math.max(1, Math.ceil(remaining)));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) deadline.signal.removeEventListener("abort", onAbort);
  }
}

export function execGit(checkoutRoot, args, deadline) {
  if (deadline) deadline.assertNotExpired(`git ${args[0] ?? ""}`);
  return new Promise((resolveGit, rejectGit) => {
    const detachedProcessGroup = process.platform !== "win32";
    const child = spawn("git", args, {
      cwd: checkoutRoot,
      stdio: ["ignore", "pipe", "pipe"],
      detached: detachedProcessGroup,
      windowsHide: true,
    });
    const unregister = deadline?.registerChild(child, { detachedProcessGroup });
    const chunks = [];
    const stderrChunks = [];
    let settled = false;
    let timer = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (deadline) deadline.signal.removeEventListener("abort", onAbort);
      unregister?.();
      if (err) rejectGit(err);
      else resolveGit(value);
    };
    const onAbort = () => {
      signalProcessAndGroup(child, detachedProcessGroup, "SIGTERM");
      finish(deadlineError(`git ${args[0] ?? ""}`));
    };
    if (deadline) {
      const remaining = deadline.remainingMs();
      if (remaining <= 0 || deadline.signal.aborted) {
        onAbort();
        return;
      }
      deadline.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(onAbort, Math.max(1, Math.ceil(remaining)));
      timer.unref?.();
    }
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
        finish(
          new Error(
            `git ${args.join(" ")} failed with exit ${code}${stderrText ? `: ${stderrText}` : ""}`,
          ),
        );
        return;
      }
      finish(null, Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export async function verifyEngineEnvBinding(checkoutRoot, env) {
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
  if (!(await sameDirectoryIdentity(resolvedEngine, checkoutRoot))) {
    throw new Error(
      "THERMITE_EVAL_ENGINE points to a different checkout than the receipt driver.",
    );
  }
}

export async function readAndVerifyGitMetadata(
  checkoutRoot,
  env = process.env,
  deadline = null,
) {
  const git = async (...args) =>
    (await execGit(checkoutRoot, args, deadline)).trim();
  let topLevel;
  try {
    topLevel = await realpath(await git("rev-parse", "--show-toplevel"));
  } catch (error) {
    if (error?.code === "DEADLINE_EXCEEDED") throw error;
    throw new Error(
      "Receipt checkout must be a valid Git checkout with its own identity.",
    );
  }
  if (!(await sameDirectoryIdentity(topLevel, checkoutRoot))) {
    throw new Error(
      "Receipt checkout root does not match its Git toplevel directory.",
    );
  }
  const [head, tree, branch, dirtyStatus] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("rev-parse", "HEAD^{tree}"),
    git("rev-parse", "--abbrev-ref", "HEAD"),
    git("status", "--porcelain", "--untracked-files=normal"),
  ]);
  if (!GIT_SHA_HEX.test(head) || !GIT_SHA_HEX.test(tree)) {
    throw new Error("Receipt checkout returned invalid Git commit/tree SHA.");
  }
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

function parseLsTreeZ(output) {
  const entries = new Map();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tabIndex = record.indexOf("\t");
    if (tabIndex < 0) continue;
    const [mode, type, oid] = record.slice(0, tabIndex).split(" ");
    const filePath = record.slice(tabIndex + 1);
    entries.set(filePath, { mode, type, oid });
  }
  return entries;
}

export async function captureAndVerifyCheckers(
  checkoutRoot,
  treeSha,
  checkerFiles,
  deadline = null,
) {
  const rawTree = await execGit(
    checkoutRoot,
    ["ls-tree", "-r", "-z", treeSha, "--", ...checkerFiles],
    deadline,
  );
  const committedBlobs = parseLsTreeZ(rawTree);
  const results = [];
  for (const filePath of checkerFiles) {
    if (deadline) deadline.assertNotExpired(`verify checker ${filePath}`);
    const committed = committedBlobs.get(filePath);
    if (
      !committed ||
      committed.type !== "blob" ||
      (committed.mode !== "100644" && committed.mode !== "100755")
    ) {
      throw new Error(
        `Checker file "${filePath}" is not a regular committed blob in tree ${treeSha}.`,
      );
    }
    const fullPath = join(checkoutRoot, filePath);
    const stats = await lstat(fullPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(
        `Checker file "${filePath}" is not an ordinary regular file.`,
      );
    }
    const bytes = await readFile(fullPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const blobAlg = committed.oid.length === 64 ? "sha256" : "sha1";
    const gitBlobHash = createHash(blobAlg)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (gitBlobHash !== committed.oid) {
      throw new Error(
        `Checker file "${filePath}" hash (${gitBlobHash}) does not match committed blob (${committed.oid}).`,
      );
    }
    results.push({ path: filePath, sha256, gitBlobHash });
  }
  return results;
}

export async function reverifyPostRunProvenance(
  checkoutRoot,
  env,
  gitBefore,
  checkersBefore,
  checkerFiles,
  deadline = null,
) {
  const gitAfter = await readAndVerifyGitMetadata(checkoutRoot, env, deadline);
  if (gitAfter.head !== gitBefore.head) {
    throw new Error(
      `Checkout HEAD changed during receipt execution (${gitBefore.head} -> ${gitAfter.head}).`,
    );
  }
  if (gitAfter.tree !== gitBefore.tree) {
    throw new Error(
      `Checkout tree changed during receipt execution (${gitBefore.tree} -> ${gitAfter.tree}).`,
    );
  }
  const checkersAfter = await captureAndVerifyCheckers(
    checkoutRoot,
    gitBefore.tree,
    checkerFiles,
    deadline,
  );
  if (checkersAfter.length !== checkersBefore.length) {
    throw new Error("Checker inventory changed during receipt execution.");
  }
  for (let i = 0; i < checkersBefore.length; i += 1) {
    const before = checkersBefore[i];
    const after = checkersAfter[i];
    if (
      before.path !== after.path ||
      before.sha256 !== after.sha256 ||
      before.gitBlobHash !== after.gitBlobHash
    ) {
      throw new Error(
        `Checker file "${before.path}" changed during receipt execution.`,
      );
    }
  }
  return { gitAfter, checkersAfter };
}

export function pathPrefixes(resolvedTarget) {
  const { root: fsRoot } = parse(resolvedTarget);
  const tail = resolvedTarget.slice(fsRoot.length);
  const segments = (
    process.platform === "win32" ? tail.split(/[\\/]+/) : tail.split(sep)
  ).filter(Boolean);
  const prefixes = [];
  let current = fsRoot;
  for (const segment of segments) {
    current = join(current, segment);
    prefixes.push(current);
  }
  return { fsRoot, prefixes };
}

async function resolveVerifiedDirPath(targetPath) {
  try {
    return await realpath(targetPath);
  } catch (error) {
    // Bun on POSIX normalizes backslashes inside fs.realpath; fall back to
    // lstat/stat dev/ino verification only after prefix lstat proved no links.
    if (
      error?.code === "ENOENT" &&
      process.platform !== "win32" &&
      targetPath.includes("\\")
    ) {
      const [ls, st] = await Promise.all([
        lstat(targetPath, { bigint: true }),
        stat(targetPath, { bigint: true }),
      ]);
      if (
        !ls.isSymbolicLink() &&
        ls.isDirectory() &&
        st.isDirectory() &&
        sameStatIdentity(ls, st) === true
      ) {
        return targetPath;
      }
    }
    throw error;
  }
}

export async function assertSafeReceiptDestination(receiptPath, realDir) {
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
  let realReceipt;
  try {
    realReceipt = await realpath(receiptPath);
  } catch (error) {
    if (
      error?.code === "ENOENT" &&
      process.platform !== "win32" &&
      receiptPath.includes("\\")
    ) {
      const followed = await stat(receiptPath, { bigint: true });
      const parentOk = await sameDirectoryIdentity(
        dirname(receiptPath),
        realDir,
      );
      if (
        !followed.isFile() ||
        sameStatIdentity(existing, followed) !== true ||
        !parentOk
      ) {
        throw new Error(
          "Receipt destination resolves outside the verified directory.",
        );
      }
      return;
    }
    throw error;
  }
  const realReceiptStat = await lstat(realReceipt, { bigint: true });
  const sameFile = sameStatIdentity(existing, realReceiptStat);
  const fileMatches =
    sameFile !== null
      ? sameFile
      : normalizePathForCompare(realReceipt) ===
        normalizePathForCompare(join(realDir, RECEIPT_FILENAME));
  const parentMatches = await sameDirectoryIdentity(
    dirname(realReceipt),
    realDir,
  );
  if (!fileMatches || !parentMatches) {
    throw new Error(
      "Receipt destination resolves outside the verified directory.",
    );
  }
}

async function inspectExistingPrefixes(resolvedTarget) {
  const { fsRoot, prefixes } = pathPrefixes(resolvedTarget);
  let firstMissingIndex = -1;
  for (let i = 0; i < prefixes.length; i += 1) {
    const prefix = prefixes[i];
    let stats;
    try {
      stats = await lstat(prefix, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        firstMissingIndex = i;
        break;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error("Refusing symlinked output directory path.");
    }
    if (!stats.isDirectory()) {
      throw new Error("Output path exists and is not an ordinary directory.");
    }
  }
  const existingTarget =
    firstMissingIndex === -1
      ? prefixes.length > 0
        ? prefixes[prefixes.length - 1]
        : fsRoot
      : firstMissingIndex === 0
        ? fsRoot
        : prefixes[firstMissingIndex - 1];
  const existingReal = await resolveVerifiedDirPath(existingTarget);
  if (!(await sameDirectoryIdentity(existingTarget, existingReal))) {
    throw new Error("Output directory path traverses a symbolic link.");
  }
  if (firstMissingIndex === -1) {
    await assertSafeReceiptDestination(
      join(existingReal, RECEIPT_FILENAME),
      existingReal,
    );
  }
  return { prefixes, firstMissingIndex, existingReal };
}

export async function validateOutputDir(outputDir) {
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new Error("Missing required outputDir.");
  }
  const resolvedTarget = resolve(outputDir);
  return { resolvedTarget, ...(await inspectExistingPrefixes(resolvedTarget)) };
}

export async function verifyAndEnsureOutputDir(outputDir) {
  const { resolvedTarget, prefixes, firstMissingIndex } =
    await validateOutputDir(outputDir);
  if (firstMissingIndex !== -1) {
    for (let i = firstMissingIndex; i < prefixes.length; i += 1) {
      const prefix = prefixes[i];
      try {
        await mkdir(prefix, { recursive: false, mode: 0o755 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const stats = await lstat(prefix, { bigint: true });
      if (stats.isSymbolicLink()) {
        throw new Error("Refusing symlinked output directory path.");
      }
      if (!stats.isDirectory()) {
        throw new Error("Output path exists and is not an ordinary directory.");
      }
    }
  }
  for (const prefix of prefixes) {
    const stats = await lstat(prefix, { bigint: true });
    if (stats.isSymbolicLink()) {
      throw new Error("Refusing symlinked output directory path.");
    }
    if (!stats.isDirectory()) {
      throw new Error("Output path exists and is not an ordinary directory.");
    }
  }
  const realDir = await resolveVerifiedDirPath(resolvedTarget);
  if (!(await sameDirectoryIdentity(resolvedTarget, realDir))) {
    throw new Error("Output directory path traverses a symbolic link.");
  }
  const receiptPath = join(realDir, RECEIPT_FILENAME);
  await assertSafeReceiptDestination(receiptPath, realDir);
  return { realDir, receiptPath };
}

export async function writeReceiptSafely(outputDir, receipt, deadline = null) {
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
    if (receipt.ok && deadline?.isExpired()) {
      throw deadlineError("before receipt publish");
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
