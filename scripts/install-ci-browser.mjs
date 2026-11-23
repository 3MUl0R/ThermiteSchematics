import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const CLI = "node_modules/playwright-core/cli.js";
const ARGS = [CLI, "install", "--with-deps", "--no-shell", "chromium"];
const APT_FILE = "/etc/apt/apt.conf.d/99thermite-timeouts";
// DPkg::Lock::Timeout lets a retry wait for a just-killed apt/dpkg process to
// release its lock instead of failing immediately (#562 review).
const APT_CONF =
  'Acquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAcquire::Retries "3";\nDPkg::Lock::Timeout "120";\n';
const SOURCES = [
  "/etc/apt/sources.list.d/ubuntu.sources",
  "/etc/apt/sources.list",
];
const REWRITE =
  "s#(https?)://[a-z0-9.-]+\\.archive\\.ubuntu\\.com/ubuntu#\\1://archive.ubuntu.com/ubuntu#g";
const APT_LOCKS = [
  "/var/lib/dpkg/lock-frontend",
  "/var/lib/dpkg/lock",
  "/var/cache/apt/archives/lock",
  "/var/lib/apt/lists/lock",
];
// Worst case: 3 * (240s + 30s) + (5s + 10s) + 2 * 120s = 1065s < 1200s (20 min).
export const INSTALL_BUDGET = Object.freeze({
  stepTimeoutSeconds: 20 * 60,
  attempts: 3,
  attemptTimeoutSeconds: 240,
  killAfterSeconds: 30,
  backoffBaseSeconds: 5,
  lockWaitSeconds: 120,
  lockPollSeconds: 5,
});

export function worstCaseSeconds(b = INSTALL_BUDGET) {
  const retries = b.attempts - 1;
  const backoff = (b.backoffBaseSeconds * b.attempts * retries) / 2;
  const lockWait = retries * (b.lockWaitSeconds ?? 0);
  return (
    b.attempts * (b.attemptTimeoutSeconds + b.killAfterSeconds) +
    backoff +
    lockWait
  );
}

const fmt = (r) => (r.error ? r.error.message : `exit ${r.status ?? r.signal}`);

async function waitForAptLocks(run, pause, hasFile, log, b) {
  const locks = APT_LOCKS.filter((f) => hasFile(f));
  if (!locks.length) return;
  let waited = 0;
  while (true) {
    const res = run("sudo", ["fuser", "-s", ...locks], { stdio: "ignore" });
    if (res.error || (res.status !== 0 && res.status !== 1)) {
      log(`Warning: apt lock check failed (${fmt(res)}); continuing.`);
      return;
    }
    if (res.status === 1) {
      if (waited > 0) log(`apt/dpkg locks released after ${waited}s.`);
      return;
    }
    if (waited >= b.lockWaitSeconds) {
      log(
        `Warning: apt/dpkg locks still held after ${waited}s; proceeding with retry.`,
      );
      return;
    }
    if (waited === 0)
      log(`Waiting up to ${b.lockWaitSeconds}s for apt/dpkg locks to clear...`);
    const step = Math.min(b.lockPollSeconds, b.lockWaitSeconds - waited);
    await pause(step * 1_000);
    waited += step;
  }
}

export async function installCiBrowser(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const execPath = opts.execPath ?? process.execPath;
  const run = opts.run ?? spawnSync;
  const pause = opts.pause ?? delay;
  const hasFile = opts.hasFile ?? existsSync;
  const log = opts.log ?? ((msg) => process.stderr.write(`${msg}\n`));
  const b = INSTALL_BUDGET;
  const linux = platform === "linux";
  const inherit = { stdio: "inherit" };
  if (linux) {
    const io = { input: APT_CONF, stdio: ["pipe", "ignore", "inherit"] };
    const cfg = run("sudo", ["tee", APT_FILE], io);
    if (cfg.error || cfg.status !== 0)
      log(`Warning: apt timeout config failed (${fmt(cfg)}); continuing.`);
  }
  const cmd = linux ? "timeout" : execPath;
  const kill = `--kill-after=${b.killAfterSeconds}s`;
  const dur = `${b.attemptTimeoutSeconds}s`;
  const args = linux ? [kill, dur, execPath, ...ARGS] : ARGS;
  let last = "unknown error";
  for (let i = 1; i <= b.attempts; i++) {
    const res = run(cmd, args, inherit);
    if (!res.error && res.status === 0) return;
    last = fmt(res);
    log(`Browser install attempt ${i}/${b.attempts} failed: ${last}`);
    if (i < b.attempts) {
      if (linux && i === 1)
        for (const f of SOURCES)
          if (hasFile(f)) run("sudo", ["sed", "-i", "-E", REWRITE, f], inherit);
      await pause(b.backoffBaseSeconds * i * 1_000);
      if (linux) await waitForAptLocks(run, pause, hasFile, log, b);
    }
  }
  throw new Error(
    `Pinned Chromium install failed after ${b.attempts} attempts: ${last}`,
  );
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  await installCiBrowser().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}
