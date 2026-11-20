import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { ctx, ok, repositoryRoot, type Fact } from "./harness.js";
import { guideModel, type Fence, type GuideModel } from "./guide-model.js";
import { topicExecution } from "../../../../scripts/docs-example-evidence.mjs";
import { PROJECT_GUIDE_BYTE_LIMIT } from "../../src/project-guide-budget.js";
import { compileProject } from "@thermite/compiler";
import { buildDocumentation, relationPrintIdentity } from "@thermite/query";
import { circuitCaptionFixture } from "./wiring-circuits.js";

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

export const workflowFacts: readonly Fact[] = [
  {
    claim: "Use a short group `lineReference` for circuit captions.",
    async check() {
      const { text } = await circuitCaptionFixture();
      expect(text.some((t) => t.endsWith(": 300"))).toBe(true);
      expect(text.some((t) => t.endsWith(": Output channels"))).toBe(true);
    },
  },
  {
    claim:
      "Network and assembly reports use the authored designation, then the printed endpoint pair, then the authored description. A blank reference needs source review.",
    async check() {
      const result = await compileProject(
        join(repositoryRoot, "examples/report-filtering"),
      );
      if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
      for (const [kind, designation, endpoints] of [
        ["network", "NET1", "PLC1: ETH ↔ DOC1: IN"],
        ["assemblies", "ASM1", "PLC1.X1 ↔ S1.P"],
      ] as const) {
        const { ir } = result;
        const relation = ir.relations.find(
          (r) => r.designation === designation,
        )!;
        const cell = () =>
          buildDocumentation(ir, {
            format: "documentation-view-request/0.1",
            kind,
          }).rows.find((r) => r.key === relation.uid)?.cells[0];
        expect(cell()).toBe(designation);
        delete relation.designation;
        expect(cell()).toBe(endpoints);
        const unavailable = new Map();
        expect(
          relationPrintIdentity(
            { ...relation, description: "Authored description" },
            unavailable,
          ).text,
        ).toBe("Authored description");
        expect(
          relationPrintIdentity({ ...relation, description: "" }, unavailable)
            .text,
        ).toBe("");
      }
    },
  },
  {
    claim:
      "The packet JSON's `html` is byte-identical to the standalone `.html` export, including print fonts.",
    async check() {
      const packetRequest = workflows.fences.find(
        (fence) =>
          fence.lang === "json" &&
          fence.body.includes('"schematic-packet-request/0.1"'),
      );
      if (!packetRequest) throw Error("Missing the guide's packet request");
      const args = ["packet", "--input", "-"];
      const project = ctx.pristine.starter;
      const standalone = await ok(args, project, packetRequest.body);
      const packet = await ok([...args, "--json"], project, packetRequest.body);
      const { html } = JSON.parse(packet.stdout);
      expect(html.match(/<style data-thermite-font=/gu)).toHaveLength(1);
      expect(html === standalone.stdout, "packet HTML bytes").toBe(true);
    },
  },
];

export async function verifyGuideBudgets() {
  expect(projectGuide.bytes).toBeLessThanOrEqual(PROJECT_GUIDE_BYTE_LIMIT);
  expect(
    (await stat(join(repositoryRoot, "AGENTS.md"))).size,
  ).toBeLessThanOrEqual(4_500);
  expect(projectGuide.text).toContain("follow **Extend a starter**");
  const delivered = await ok(["guide", "project-workflows"], ctx.work);
  expect(delivered.stdout).toBe(workflows.text);
}

const coreAdvice: [string, string][] = [
  [
    "Invent no pins, ratings, spares or title/revision data.",
    "Safety rule for authored facts.",
  ],
  [
    "Mark terminals unused or deferred only with explicit user intent.",
    "Authoring policy for connection dispositions.",
  ],
  [
    "After library edits, run `thermite lock .` before validation.",
    "The guard recipe tests the required order.",
  ],
  [
    "Snapshot before edits with `thermite snapshot -o drawings/before.json`.",
    "The command runs separately and the workflow facts test snapshots.",
  ],
  [
    "To undo registration of a new file, remove it from `sources` in `system.json`, confirm no source glob still matches it, then delete the unregistered file.",
    "The guarded starter recipe exercises removal in that order.",
  ],
];

export function verifyCoreAuthoringRules() {
  expect(projectGuide.sentences).toEqual(
    expect.arrayContaining([
      ...coreAdvice.map(([sentence]) => sentence),
      "For R006, narrow selection or use larger paper.",
      "Never change connectivity or shrink text to fit.",
      "Write new files completely before listing them in `sources` in `system.json`.",
      "Once listed, use guarded patches for every edit, including E011 repairs, except for JSON syntax repair.",
    ]),
  );
}

export const workflowAdvice: [string, string][] = [
  ...coreAdvice,
  [
    "Before extending a starter, run `thermite guide agent-requests` and follow **Extend a starter**.",
    "The CLI guide suite executes this topic's starter recipe.",
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
    "Run `thermite guide project-workflows` for printing, reports, review, libraries/lock, connection completeness, wiring records, cables, communication, field hookups and circuits.",
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
