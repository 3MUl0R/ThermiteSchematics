import { describe, expect, it } from "vitest";
import { installCiBrowser } from "./install-ci-browser.mjs";

describe("CI browser installer", () => {
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

  it("configures apt timeouts, falls back to archive.ubuntu.com, and retries on Linux", async () => {
    const calls = [];
    const waits = [];
    let installs = 0;
    await installCiBrowser({
      platform: "linux",
      execPath: "bun",
      hasFile: (file) => file === "/etc/apt/sources.list.d/ubuntu.sources",
      run: (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "bun") {
          installs++;
          return installs === 1
            ? { error: new Error("ETIMEDOUT") }
            : { status: 0 };
        }
        return { status: 0 };
      },
      pause: async (ms) => {
        waits.push(ms);
      },
      log: () => {},
    });
    expect(installs).toBe(2);
    expect(calls[0]).toContain("99thermite-timeouts");
    expect(calls.some((line) => line.includes("archive.ubuntu.com"))).toBe(
      true,
    );
    expect(calls.some((line) => line === "sudo apt-get update")).toBe(true);
    expect(waits).toEqual([5_000]);
  });

  it("fails after bounded retries when every attempt fails", async () => {
    let installs = 0;
    const waits = [];
    await expect(
      installCiBrowser({
        attempts: 3,
        platform: "win32",
        execPath: "bun",
        run: () => {
          installs++;
          return { status: 1 };
        },
        pause: async (ms) => {
          waits.push(ms);
        },
        log: () => {},
      }),
    ).rejects.toThrow(/after 3 attempts: exit 1/);
    expect(installs).toBe(3);
    expect(waits).toEqual([5_000, 10_000]);
  });
});
