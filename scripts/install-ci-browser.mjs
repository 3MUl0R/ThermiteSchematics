import { spawnSync } from "node:child_process";
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

function runProcess(command, args, options = {}) {
  return spawnSync(command, args, { stdio: "inherit", ...options });
}

function configureLinuxAptTimeouts(run) {
  run("sudo", ["tee", "/etc/apt/apt.conf.d/99thermite-timeouts"], {
    input: APT_TIMEOUT_CONFIG,
    stdio: ["pipe", "ignore", "inherit"],
    timeout: 30_000,
  });
}

function fallbackUbuntuMirrors(run, hasFile) {
  const targets = [
    "/etc/apt/sources.list.d/ubuntu.sources",
    "/etc/apt/sources.list",
  ].filter((file) => hasFile(file));
  for (const file of targets) {
    run(
      "sudo",
      [
        "sed",
        "-i",
        "-E",
        "s#https?://[a-z0-9.-]+\\.archive\\.ubuntu\\.com/ubuntu#http://archive.ubuntu.com/ubuntu#g",
        file,
      ],
      { timeout: 30_000 },
    );
  }
  if (targets.length) run("sudo", ["apt-get", "update"], { timeout: 120_000 });
}

export async function installCiBrowser({
  attempts = 3,
  attemptTimeoutMs = 4 * 60_000,
  backoffMs = 5_000,
  platform = process.platform,
  execPath = process.execPath,
  run = runProcess,
  pause = delay,
  hasFile = existsSync,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  if (platform === "linux") configureLinuxAptTimeouts(run);
  let lastError = "Browser installation failed";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = run(execPath, INSTALL_ARGS, { timeout: attemptTimeoutMs });
    if (!result.error && result.status === 0) return;
    lastError = result.error
      ? result.error.message
      : `exit ${result.status ?? result.signal}`;
    log(`Browser install attempt ${attempt}/${attempts} failed: ${lastError}`);
    if (attempt < attempts) {
      if (platform === "linux" && attempt === 1) {
        log("Switching Ubuntu apt sources to archive.ubuntu.com before retry.");
        fallbackUbuntuMirrors(run, hasFile);
      }
      await pause(backoffMs * attempt);
    }
  }
  throw new Error(
    `Pinned Chromium install failed after ${attempts} attempts: ${lastError}`,
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
