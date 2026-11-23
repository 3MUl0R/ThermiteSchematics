import { describe, expect, it } from "vitest";
import {
  INSTALL_BUDGET,
  installCiBrowser,
  worstCaseSeconds,
} from "./install-ci-browser.mjs";

describe("CI browser installer", () => {
  it("keeps worst-case retries, kill-after, and backoff inside the 15-minute step timeout", () => {
    const worst = worstCaseSeconds(INSTALL_BUDGET);
    expect(worst).toBe(825);
    expect(worst).toBeLessThan(INSTALL_BUDGET.stepTimeoutSeconds);
    expect(INSTALL_BUDGET.stepTimeoutSeconds - worst).toBeGreaterThanOrEqual(
      60,
    );
  });

  it("configures apt timeouts, wraps Linux installs with GNU timeout, and rewrites mirrors after attempt 1", async () => {
    const calls = [];
    const logs = [];
    const waits = [];
    let installs = 0;
    await installCiBrowser({
      platform: "linux",
      execPath: "bun",
      hasFile: (file) => file === "/etc/apt/sources.list.d/ubuntu.sources",
      run: (command, args, options) => {
        calls.push({ command, args, options });
        if (command === "timeout") {
          installs++;
          return installs === 1 ? { status: 124 } : { status: 0 };
        }
        return { status: 0 };
      },
      pause: async (ms) => {
        waits.push(ms);
      },
      log: (message) => logs.push(message),
    });
    expect(installs).toBe(2);
    expect(calls[0].command).toBe("sudo");
    expect(calls[0].args).toEqual([
      "tee",
      "/etc/apt/apt.conf.d/99thermite-timeouts",
    ]);
    expect(calls[0].options.input).toContain('Acquire::http::Timeout "30";');
    expect(calls[0].options.input).toContain('Acquire::https::Timeout "30";');
    expect(calls[0].options.input).toContain('Acquire::Retries "3";');
    expect(calls[0].options.input).toContain('DPkg::Lock::Timeout "120";');

    const timeoutCall = calls.find((call) => call.command === "timeout");
    expect(timeoutCall.args).toEqual([
      "--kill-after=30s",
      "240s",
      "bun",
      "node_modules/playwright-core/cli.js",
      "install",
      "--with-deps",
      "--no-shell",
      "chromium",
    ]);

    const sedCall = calls.find(
      (call) => call.command === "sudo" && call.args[0] === "sed",
    );
    expect(sedCall).toBeDefined();
    expect(sedCall.args[3]).toContain("\\1://archive.ubuntu.com/ubuntu");
    expect(calls.some((call) => call.args.includes("kill"))).toBe(false);
    expect(waits).toEqual([5_000]);
  });

  it.each(["darwin", "win32"])(
    "runs plain install with bounded retries and no custom kill logic on %s",
    async (platform) => {
      const calls = [];
      const waits = [];
      await expect(
        installCiBrowser({
          platform,
          execPath: "bun",
          run: (command, args) => {
            calls.push({ command, args });
            return { status: 1 };
          },
          pause: async (ms) => {
            waits.push(ms);
          },
          log: () => {},
        }),
      ).rejects.toThrow(/Pinned Chromium install failed after 3 attempts/);
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call.command).toBe("bun");
        expect(call.args).toEqual([
          "node_modules/playwright-core/cli.js",
          "install",
          "--with-deps",
          "--no-shell",
          "chromium",
        ]);
      }
      expect(waits).toEqual([5_000, 10_000]);
    },
  );
});
