import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { ctx, ok, repositoryRoot } from "./harness.js";
import { guideModel, type Fence, type GuideModel } from "./guide-model.js";
import { topicExecution } from "../../../../scripts/docs-example-evidence.mjs";
import { PROJECT_GUIDE_BYTE_LIMIT } from "../../src/project-guide-budget.js";

const guidePath = join(
  repositoryRoot,
  "packages/cli/assets/THERMITE_AGENTS.md",
);
export const guideBytes = readFileSync(guidePath);
export const projectGuide = guideModel(guideBytes.toString("utf8"));
const workflowsFile = "docs/project-workflows.md";
const workflows = guideModel(
  readFileSync(join(repositoryRoot, workflowsFile), "utf8"),
);
export const live = guideModel(projectGuide.text + "\n" + workflows.text);
export async function verifyGuideBudgets() {
  expect(projectGuide.bytes).toBeLessThanOrEqual(PROJECT_GUIDE_BYTE_LIMIT);
  expect(
    (await stat(join(repositoryRoot, "AGENTS.md"))).size,
  ).toBeLessThanOrEqual(4_500);
  expect(projectGuide.text).toContain("follow **Extend a starter**");
  const delivered = await ok(["guide", "project-workflows"], ctx.work);
  expect(delivered.stdout).toBe(workflows.text);
}

export const workflowAdvice: [string, string][] = [
  [
    "Before extending a starter, run `thermite guide agent-requests` and follow **Extend a starter**.",
    "The CLI guide suite executes this topic's starter recipe.",
  ],
  [
    "Create and register new files.",
    "Authoring rule exercised in the starter recipe.",
  ],
  [
    "Guard existing files from inspection through dry-run and apply, including any undo.",
    "The guarded workflow and repair claims exercise both paths.",
  ],
  [
    "Never use git checkout or rm to undo an edit to a registered source.",
    "Authoring prohibition shared with the starter recipe.",
  ],
  [
    "Run `thermite guide project-workflows` for tested printing, reports, review, cabling, communication, field hookups and circuit recipes.",
    "This topic is run by the project workflow fences and existing fact checks.",
  ],
  [
    "For exact shapes use `thermite guide schema`.",
    "The CLI guide suite compares exact schemas.",
  ],
  [
    "Use `thermite guide drawing-frames` before changing paper frames or title data.",
    "Read-before policy; the topic is resolved offline.",
  ],
];

export async function verifyWorkflowExamples(
  runFence: (fence: Fence, model: GuideModel) => Promise<number>,
  executedFences: Set<number>,
) {
  const execution = topicExecution(workflowsFile, workflows.text, [
    "sh",
    "json",
  ]);
  execution.checkLanguages(workflows.fences);
  for (const [index, fence] of workflows.fences.entries()) {
    const combined = live.fences[index + projectGuide.fences.length]!;
    await execution.run(fence, async () => {
      expect(await runFence(combined, live)).toBeGreaterThan(0);
      executedFences.add(combined.index);
    });
  }
  execution.finish(workflows.fences);
}
