import { defineConfig, configDefaults } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import { relative, sep } from "node:path";

// Clean CI runners lack Vitest's timing cache and otherwise sort by source
// size. These expensive files can leave one worker idle at the end of a run.
const longestSuites = [
  "packages/render/test/semantic-ordering.test.ts",
  "packages/cli/test/docs-examples.test.ts",
  "packages/cli/test/project-guide.test.ts",
  "packages/render/test/composed-corpus-references.test.ts",
  "packages/cli/test/docs-example-review.test.ts",
  "packages/render/test/device-legend-browser.test.ts",
  "evals/draw/peer-owner-machine.test.mjs",
];
const priority = new Map(longestSuites.map((file, index) => [file, index]));

class CiSequencer extends BaseSequencer {
  async sort(files) {
    const ordered = await super.sort(files);
    const rank = ({ moduleId }) =>
      priority.get(
        relative(this.ctx.config.root, moduleId).split(sep).join("/"),
      ) ?? priority.size;
    return ordered.sort((a, b) => rank(a) - rank(b));
  }
}

export default defineConfig({
  test: {
    ...(process.env.CI ? { sequence: { sequencer: CiSequencer } } : {}),
    include: [...configDefaults.include, "evals/**/*.test.mjs"],
    exclude: [...configDefaults.exclude, "evals/out/**", "projects/**"],
  },
});
