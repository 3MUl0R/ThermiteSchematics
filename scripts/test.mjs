import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Production loading rejects links. macOS /var and /tmp aliases must be
// canonicalized before creating test fixtures beneath the temporary directory.
const temporary = realpathSync(tmpdir());
const selected = process.argv.slice(2);
// Opt in for focused runs or the full check. coverage/ is already ignored.
const timings = process.env.THERMITE_TEST_TIMINGS === "1";
if (timings) mkdirSync("coverage", { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
    ),
    "run",
    // Keep each test worker in a separate process, using the same Bun runtime
    // for Vitest and the child CLIs exercised by integration tests.
    "--pool=forks",
    "--testTimeout=120000",
    "--hookTimeout=120000",
    // Release and review archives contain independent source checkouts. Their
    // copied tests are not tests of the active checkout.
    "--exclude=alpha-out/**",
    "--exclude=release-out/**",
    ...(timings
      ? [
          "--reporter=default",
          "--reporter=json",
          "--outputFile.json=coverage/test-timings.json",
        ]
      : []),
    ...selected,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
