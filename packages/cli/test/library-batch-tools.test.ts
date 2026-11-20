import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../..", import.meta.url));

describe("component research batch tools", () => {
  it.each(["prepare", "run", "run-limits", "verify", "promote"])(
    "checks the %s script",
    (stage) => {
      const result = spawnSync(
        process.execPath,
        [
          "test",
          "--timeout=120000",
          `./scripts/library-batch/${stage}.check.mjs`,
        ],
        { cwd: repository, encoding: "utf8", timeout: 120_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
    125_000,
  );
});
