import { defineConfig, configDefaults } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

function relativeSpec(root, moduleId) {
  return relative(root, moduleId).split(sep).join("/");
}

const shardHelpers = new Map();
async function loadTestShards(root, { required = false } = {}) {
  const file = resolve(root, "scripts/test-shards.mjs");
  if (!existsSync(file)) {
    if (required) {
      throw new Error(`Sharded Vitest run requires ${file}, which is missing.`);
    }
    // Minimal contributor/mutation scratch fixtures copy vitest.config.mjs alone.
    return null;
  }
  if (!shardHelpers.has(file)) {
    shardHelpers.set(
      file,
      import(/* @vite-ignore */ pathToFileURL(file).href)
        .then((mod) => {
          if (
            typeof mod?.partitionShard !== "function" ||
            typeof mod?.shardWeight !== "function" ||
            typeof mod?.sortDuration !== "function"
          ) {
            throw new Error("missing required shard helper exports");
          }
          return mod;
        })
        .catch((error) => {
          shardHelpers.delete(file);
          throw new Error(
            `Failed to load Vitest shard helper ${file}: ${error.message}`,
            { cause: error },
          );
        }),
    );
  }
  return shardHelpers.get(file);
}

class CiSequencer extends BaseSequencer {
  async shard(files) {
    const root = this.ctx.config.root;
    const shards = await loadTestShards(root, { required: true });
    const { index, count } = this.ctx.config.shard;
    return shards.partitionShard(files, index, count, {
      key: ({ moduleId }) => relativeSpec(root, moduleId),
      weight: ({ moduleId }) =>
        shards.shardWeight(relativeSpec(root, moduleId)),
      group: ({ project }) => project.name,
    });
  }

  async sort(files) {
    const ordered = await super.sort(files);
    const root = this.ctx.config.root;
    const shards = await loadTestShards(root, {
      required: Boolean(this.ctx.config.shard),
    });
    if (!shards) return ordered;
    return ordered.sort(
      (a, b) =>
        shards.sortDuration(relativeSpec(root, b.moduleId)) -
        shards.sortDuration(relativeSpec(root, a.moduleId)),
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
const shardRequested = process.argv.some(
  (arg) => arg === "--shard" || arg.startsWith("--shard="),
);

export default defineConfig({
  test: {
    ...testDefaults,
    ...(process.env.CI || shardRequested
      ? { sequence: { sequencer: CiSequencer } }
      : {}),
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
