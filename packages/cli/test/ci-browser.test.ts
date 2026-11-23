import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  INSTALL_BUDGET,
  worstCaseSeconds,
} from "../../../scripts/install-ci-browser.mjs";

it("provisions the pinned browser for both sharded test jobs on every OS", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const jobs = workflow.split(/^  (?:check-test|worktree):$/m).slice(1);
  const stepMinutes = INSTALL_BUDGET.stepTimeoutSeconds / 60;
  expect(worstCaseSeconds(INSTALL_BUDGET)).toBeLessThan(
    INSTALL_BUDGET.stepTimeoutSeconds,
  );
  expect(jobs).toHaveLength(2);
  for (const job of jobs) {
    const header = job.slice(0, job.indexOf("    steps:"));
    expect(header).not.toMatch(/\$\{\{\s*runner\./);
    expect(header).toContain(
      "PLAYWRIGHT_BROWSERS_PATH: ${{ github.workspace }}/../thermite-playwright",
    );
    expect(job).toContain("os: [macos-15, ubuntu-24.04, windows-2022]");
    expect(job).toContain('THERMITE_REQUIRE_BROWSER: "1"');
    expect(job).toContain(`timeout-minutes: ${stepMinutes}`);
    expect(job).toContain("bun scripts/install-ci-browser.mjs");
    expect(job).toContain("chromium.executablePath()");
    expect(job).toContain('"THERMITE_DRAW_CHROMIUM=" + executable');
    expect(job).toContain('"THERMITE_TEST_BROWSER=" + executable');
    expect(job.indexOf("Install pinned Chromium")).toBeLessThan(
      job.indexOf("THERMITE_RESEARCH_PYTHON: python"),
    );
  }
});
