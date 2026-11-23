import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const INSTALL_ARGS = [
  "node_modules/playwright-core/cli.js",
  "install",
  "--with-deps",
  "--no-shell",
  "chromium",
];
const APT_TIMEOUT_CONFIG =
  [
    'Acquire::http::Timeout "30";',
    'Acquire::https::Timeout "30";',
    'Acquire::Retries "2";',
  ].join("\n") + "\n";
const UBUNTU_SOURCES = [
  "/etc/apt/sources.list.d/ubuntu.sources",
  "/etc/apt/sources.list",
];
const MIRROR_REWRITE_EXPR =
  "s#(https?)://[a-z0-9.-]+\\.archive\\.ubuntu\\.com/ubuntu#\\1://archive.ubuntu.com/ubuntu#g";

export const BROWSER_INSTALL_BUDGET = Object.freeze({
  stepTimeoutMs: 15 * 60_000,
  overallDeadlineMs: 13 * 60_000,
  attempts: 3,
  attemptTimeoutMs: 210_000,
  backoffMs: 5_000,
  aptConfigTimeoutMs: 15_000,
  mirrorRewriteTimeoutMs: 15_000,
  mirrorSourceFiles: UBUNTU_SOURCES.length,
  killGraceMs: 2_000,
  cleanupTimeoutMs: 10_000,
});

export function worstCaseBudgetMs(
  budget = BROWSER_INSTALL_BUDGET,
  { platform = "linux" } = {},
) {
  const {
    attempts,
    attemptTimeoutMs,
    backoffMs,
    aptConfigTimeoutMs,
    mirrorRewriteTimeoutMs,
    mirrorSourceFiles,
    killGraceMs,
    cleanupTimeoutMs,
  } = { ...BROWSER_INSTALL_BUDGET, ...budget };
  const attemptTotal =
    attempts * (attemptTimeoutMs + killGraceMs + cleanupTimeoutMs);
  const backoffTotal = (backoffMs * attempts * (attempts - 1)) / 2;
  const linuxExtras =
    platform === "linux"
      ? aptConfigTimeoutMs +
        (attempts > 1 ? mirrorSourceFiles * mirrorRewriteTimeoutMs : 0)
      : 0;
  return attemptTotal + backoffTotal + linuxExtras;
}

function formatOutcome(result) {
  if (result.error) return result.error.message;
  return `exit ${result.status ?? result.signal}`;
}

function listDescendantPids(rootPid) {
  const probe = spawnSync("ps", ["-eo", "pid=,ppid=,pgid="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (probe.error || probe.status !== 0 || !probe.stdout) return [];
  const children = new Map();
  const inGroup = [];
  for (const line of probe.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, ppid, pgid] = parts.map(Number);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
    if (pgid === rootPid) inGroup.push(pid);
  }
  const seen = new Set(inGroup);
  const queue = [rootPid, ...inGroup];
  while (queue.length) {
    const parent = queue.shift();
    for (const childPid of children.get(parent) ?? []) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      queue.push(childPid);
    }
  }
  seen.delete(rootPid);
  return [...seen].reverse();
}

function signalLinuxPids(pids, signal, timeoutMs, log) {
  if (!pids.length) return;
  const privileged = [];
  for (const pid of pids) {
    try {
      process.kill(pid, `SIG${signal}`);
    } catch (error) {
      if (error.code === "EPERM") privileged.push(pid);
    }
  }
  if (!privileged.length) return;
  const result = spawnSync(
    "sudo",
    ["-n", "kill", `-${signal}`, ...privileged.map(String)],
    { stdio: "ignore", timeout: Math.max(1_000, timeoutMs) },
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    log(
      `Privileged cleanup (sudo kill -${signal}) warning: ${formatOutcome(result)}`,
    );
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
  }
}

async function terminateProcessTree(
  child,
  closed,
  { platform, killGraceMs, cleanupTimeoutMs, log },
) {
  if (!child.pid) return;
  if (platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) {
      const killer = spawnSync(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", timeout: cleanupTimeoutMs },
      );
      if (killer.error || killer.status !== 0) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Child already exited between status check and kill.
        }
      }
    }
    await Promise.race([closed, delay(killGraceMs)]);
    return;
  }
  const descendants = platform === "linux" ? listDescendantPids(child.pid) : [];
  const halfCleanup = Math.max(1_000, Math.floor(cleanupTimeoutMs / 2));
  signalGroup(child.pid, "SIGTERM");
  if (platform === "linux")
    signalLinuxPids(descendants, "TERM", halfCleanup, log);
  await Promise.race([closed, delay(killGraceMs)]);
  signalGroup(child.pid, "SIGKILL");
  if (platform === "linux") {
    const remaining = new Set([
      ...descendants,
      ...listDescendantPids(child.pid),
    ]);
    signalLinuxPids([...remaining], "KILL", halfCleanup, log);
  }
  await Promise.race([closed, delay(killGraceMs)]);
}

export async function runProcess(command, args, options = {}) {
  const {
    timeout = 0,
    input,
    stdio = "inherit",
    platform = process.platform,
    killGraceMs = BROWSER_INSTALL_BUDGET.killGraceMs,
    cleanupTimeoutMs = BROWSER_INSTALL_BUDGET.cleanupTimeoutMs,
    log = (message) => process.stderr.write(`${message}\n`),
  } = options;
  const child = spawn(command, args, {
    stdio,
    detached: platform !== "win32",
  });
  let spawnError = null;
  let timedOut = false;
  let stopping = null;
  const closed = new Promise((resolveClose) => {
    child.once("error", (error) => {
      spawnError = error;
      resolveClose({ status: null, signal: null });
    });
    child.once("close", (status, signal) => resolveClose({ status, signal }));
  });
  if (input !== undefined && child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  }
  const timer =
    timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          stopping = terminateProcessTree(child, closed, {
            platform,
            killGraceMs,
            cleanupTimeoutMs,
            log,
          });
        }, timeout)
      : null;
  const exit = await closed;
  if (timer) clearTimeout(timer);
  if (stopping) await stopping;
  if (timedOut) {
    const error = new Error(`ETIMEDOUT after ${timeout} ms`);
    error.code = "ETIMEDOUT";
    return { status: exit.status, signal: exit.signal, error };
  }
  return spawnError ? { status: null, signal: null, error: spawnError } : exit;
}

async function configureLinuxAptTimeouts(run, timeoutMs, log) {
  if (timeoutMs <= 0) return;
  const result = await run(
    "sudo",
    ["tee", "/etc/apt/apt.conf.d/99thermite-timeouts"],
    {
      input: APT_TIMEOUT_CONFIG,
      stdio: ["pipe", "ignore", "inherit"],
      timeout: timeoutMs,
      log,
    },
  );
  if (result.error || result.status !== 0) {
    log(
      `Warning: failed to configure apt timeouts (${formatOutcome(result)}); continuing.`,
    );
  }
}

async function fallbackUbuntuMirrors(run, hasFile, remainingMs, log) {
  const targets = UBUNTU_SOURCES.filter((file) => hasFile(file));
  for (const file of targets) {
    const timeout = Math.min(
      BROWSER_INSTALL_BUDGET.mirrorRewriteTimeoutMs,
      remainingMs(),
    );
    if (timeout <= 0) break;
    const result = await run(
      "sudo",
      ["sed", "-i", "-E", MIRROR_REWRITE_EXPR, file],
      { timeout, log },
    );
    if (result.error || result.status !== 0) {
      log(
        `Warning: failed to rewrite Ubuntu mirror in ${file} (${formatOutcome(result)}).`,
      );
    }
  }
}

export async function installCiBrowser({
  attempts = BROWSER_INSTALL_BUDGET.attempts,
  attemptTimeoutMs = BROWSER_INSTALL_BUDGET.attemptTimeoutMs,
  overallDeadlineMs = BROWSER_INSTALL_BUDGET.overallDeadlineMs,
  backoffMs = BROWSER_INSTALL_BUDGET.backoffMs,
  killGraceMs = BROWSER_INSTALL_BUDGET.killGraceMs,
  cleanupTimeoutMs = BROWSER_INSTALL_BUDGET.cleanupTimeoutMs,
  platform = process.platform,
  execPath = process.execPath,
  run = runProcess,
  pause = delay,
  now = Date.now,
  hasFile = existsSync,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const deadline = now() + overallDeadlineMs;
  const remainingMs = () => Math.max(0, deadline - now());
  if (platform === "linux") {
    await configureLinuxAptTimeouts(
      run,
      Math.min(BROWSER_INSTALL_BUDGET.aptConfigTimeoutMs, remainingMs()),
      log,
    );
  }
  let lastError = "Browser installation failed";
  let completedAttempts = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const budget = Math.min(attemptTimeoutMs, remainingMs());
    if (budget <= 0) {
      lastError = `overall deadline (${overallDeadlineMs} ms) exhausted before attempt ${attempt}/${attempts}`;
      log(lastError);
      break;
    }
    completedAttempts = attempt;
    const result = await run(execPath, INSTALL_ARGS, {
      timeout: budget,
      killGraceMs,
      cleanupTimeoutMs,
      platform,
      log,
    });
    if (!result.error && result.status === 0) return;
    lastError = formatOutcome(result);
    log(`Browser install attempt ${attempt}/${attempts} failed: ${lastError}`);
    if (attempt < attempts) {
      if (platform === "linux" && attempt === 1) {
        log("Switching Ubuntu apt sources to archive.ubuntu.com before retry.");
        await fallbackUbuntuMirrors(run, hasFile, remainingMs, log);
      }
      const waitMs = Math.min(backoffMs * attempt, remainingMs());
      if (waitMs <= 0) {
        lastError = `overall deadline (${overallDeadlineMs} ms) exhausted after attempt ${attempt}/${attempts}`;
        log(lastError);
        break;
      }
      await pause(waitMs);
    }
  }
  throw new Error(
    `Pinned Chromium install failed after ${completedAttempts} attempts: ${lastError}`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await installCiBrowser();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
