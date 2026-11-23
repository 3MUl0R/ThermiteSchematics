import { defineConfig, configDefaults } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import { relative, sep } from "node:path";
import {
  partitionShard,
  shardWeight,
  sortDuration,
} from "./scripts/test-shards.mjs";

function relativeSpec(root, moduleId) {
  return relative(root, moduleId).split(sep).join("/");
}

class CiSequencer extends BaseSequencer {
  async shard(files) {
    const { index, count } = this.ctx.config.shard;
    const root = this.ctx.config.root;
    return partitionShard(files, index, count, {
      key: ({ moduleId }) => relativeSpec(root, moduleId),
      weight: ({ moduleId }) => shardWeight(relativeSpec(root, moduleId)),
      group: ({ project }) => project.name,
    });
  }

  async sort(files) {
    const ordered = await super.sort(files);
    if (!process.env.CI) return ordered;
    const root = this.ctx.config.root;
    return ordered.sort(
      (a, b) =>
        sortDuration(relativeSpec(root, b.moduleId)) -
        sortDuration(relativeSpec(root, a.moduleId)),
    );
  }
}

const include = [...configDefaults.include, "evals/**/*.test.mjs"];
// Inline projects don't inherit the root options. Release and review archives
// contain independent checkouts whose copied tests must stay excluded.
const testDefaults = {
  testTimeout: 120_000,
  hookTimeout: 120_000,
  exclude: [
    ...configDefaults.exclude,
    "evals/out/**",
    "projects/**",
    "alpha-out/**",
    "release-out/**",
  ],
};
// Keep the short-deadline fit and artifact checks and the nested reference
// pipeline within a two-worker phase. Include other large Chromium and
// nested test workloads in that phase on the smaller macOS runners.
const limitedFiles = [
  "evals/agent/artifacts.test.mjs",
  "evals/agent/runner.test.mjs",
  "packages/cli/test/docs-examples-agent.test.ts",
  "packages/render/test/off-view-fit.test.ts",
];
const macosLimitedFiles = [
  "evals/draw/peer-owner-browser.test.mjs",
  "evals/draw/peer-owner-conveyor.test.mjs",
  "evals/draw/peer-owner-machine.test.mjs",
  "packages/cli/test/docs-example-review.test.ts",
  "packages/cli/test/docs-examples-workspace.test.ts",
  "packages/render/test/caption-placement.test.ts",
  "packages/render/test/context-reference-layout.test.ts",
  "packages/render/test/device-legend-browser.test.ts",
  "packages/render/test/device-legend-pagination.test.ts",
];
if (process.platform === "darwin") limitedFiles.push(...macosLimitedFiles);

const ciWorkers =
  process.env.CI && !process.env.VITEST_MAX_WORKERS
    ? Number(process.env.THERMITE_CI_MAX_WORKERS) || undefined
    : undefined;
// ELK work and browser or nested processes contend with Vitest on the
// three-vCPU macOS runners. Keep the two phases with a two-worker ceiling.
const ciMainWorkers =
  ciWorkers === 3 && process.platform === "darwin" ? 2 : ciWorkers;

export default defineConfig({
  test: {
    ...testDefaults,
    sequence: { sequencer: CiSequencer },
    maxWorkers: ciMainWorkers,
    include,
    ...(ciWorkers === 3
      ? {
          projects: [
            {
              test: {
                ...testDefaults,
                name: "limited",
                include: limitedFiles,
                maxWorkers: 2,
                sequence: { groupOrder: 0 },
              },
            },
            {
              test: {
                ...testDefaults,
                name: "main",
                include,
                exclude: [...testDefaults.exclude, ...limitedFiles],
                maxWorkers: ciMainWorkers,
                sequence: { groupOrder: 1 },
              },
            },
          ],
        }
      : {}),
  },
});
