import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_INSTALL_BUDGET,
  installCiBrowser,
  runProcess,
  worstCaseBudgetMs,
} from "./install-ci-browser.mjs";

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

describe("CI browser installer", () => {
  it("keeps worst-case retries, cleanup, and fallback inside the step timeout with margin", () => {
    const linuxMax = worstCaseBudgetMs(BROWSER_INSTALL_BUDGET, {
      platform: "linux",
    });
    const posixMax = worstCaseBudgetMs(BROWSER_INSTALL_BUDGET, {
      platform: "darwin",
    });
    const winMax = worstCaseBudgetMs(BROWSER_INSTALL_BUDGET, {
      platform: "win32",
    });
    expect(linuxMax).toBeLessThanOrEqual(
      BROWSER_INSTALL_BUDGET.overallDeadlineMs,
    );
    expect(posixMax).toBeLessThan(linuxMax);
    expect(winMax).toBe(posixMax);
    expect(
      BROWSER_INSTALL_BUDGET.stepTimeoutMs -
        BROWSER_INSTALL_BUDGET.overallDeadlineMs,
    ).toBeGreaterThanOrEqual(120_000);
    expect(
      BROWSER_INSTALL_BUDGET.stepTimeoutMs - linuxMax,
    ).toBeGreaterThanOrEqual(150_000);
  });

  it("succeeds on the first attempt without fallback or backoff", async () => {
    const calls = [];
    const waits = [];
    await installCiBrowser({
      platform: "darwin",
      execPath: "bun",
      run: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
      pause: async (ms) => {
        waits.push(ms);
      },
      log: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("bun");
    expect(calls[0].args).toContain("install");
    expect(calls[0].args).toContain("--with-deps");
    expect(calls[0].args).toContain("chromium");
    expect(waits).toEqual([]);
  });

  it("configures apt timeouts, rewrites mirrors preserving scheme, skips duplicate apt-get update, and logs warnings", async () => {
    const calls = [];
    const logs = [];
    const waits = [];
    let installs = 0;
    await installCiBrowser({
      platform: "linux",
      execPath: "bun",
      hasFile: (file) => file === "/etc/apt/sources.list.d/ubuntu.sources",
      run: (command, args) => {
        calls.push({ command, args });
        if (command === "bun") {
          installs++;
          return installs === 1
            ? { error: new Error("ETIMEDOUT") }
            : { status: 0 };
        }
        if (args[0] === "tee") return { status: 1 };
        return { status: 0 };
      },
      pause: async (ms) => {
        waits.push(ms);
      },
      log: (message) => logs.push(message),
    });
    expect(installs).toBe(2);
    expect(calls[0].args.join(" ")).toContain("99thermite-timeouts");
    expect(logs.some((line) => line.includes("failed to configure apt"))).toBe(
      true,
    );
    const sedCall = calls.find((call) => call.args[0] === "sed");
    expect(sedCall).toBeDefined();
    expect(sedCall.args[3]).toContain("(https?)://");
    expect(sedCall.args[3]).toContain("\\1://archive.ubuntu.com/ubuntu");
    expect(calls.some((call) => call.args.includes("apt-get"))).toBe(false);
    expect(waits).toEqual([5_000]);
  });

  it("fails after bounded retries and stops early when the overall deadline is exhausted", async () => {
    let clock = 0;
    const timeouts = [];
    const waits = [];
    await expect(
      installCiBrowser({
        attempts: 3,
        attemptTimeoutMs: 210_000,
        overallDeadlineMs: 250_000,
        backoffMs: 5_000,
        platform: "win32",
        execPath: "bun",
        now: () => clock,
        run: (_cmd, _args, options) => {
          timeouts.push(options.timeout);
          clock += options.timeout;
          return { error: new Error("ETIMEDOUT") };
        },
        pause: async (ms) => {
          waits.push(ms);
          clock += ms;
        },
        log: () => {},
      }),
    ).rejects.toThrow(/Pinned Chromium install failed after 2 attempts/);
    expect(timeouts).toEqual([210_000, 35_000]);
    expect(waits).toEqual([5_000]);
  });

  it("terminates timed-out child process trees including grandchildren", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "thermite-kill-tree-"));
    const pidFile = join(dir, "grandchild.pid");
    try {
      const script = [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        `writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const result = await runProcess(process.execPath, ["-e", script], {
        timeout: 400,
        killGraceMs: 200,
        cleanupTimeoutMs: 1_000,
        stdio: "ignore",
        log: () => {},
      });
      expect(result.error?.code).toBe("ETIMEDOUT");
      const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(grandchildPid).toBeGreaterThan(0);
      expect(isPidAlive(grandchildPid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
