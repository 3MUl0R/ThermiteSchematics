import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compileProject,
  computeFileIntegrity,
  loadProjectForSourcePatch,
  loadProject,
} from "@thermite/compiler";
import { parseJson } from "@thermite/schema";
import { expect, it } from "vitest";
import {
  createInternalApplySourcePatchTool,
  defaultApplySourcePatchDependencies as defaults,
} from "../src/apply-source-patch.js";
import type { ApplySourcePatchRequest } from "../src/source-patch-request.js";
import {
  createPatchProjectFixture,
  type PatchProjectFixture,
} from "./patch-project-fixture.js";

const sourceFile = "sources/objects.json";
async function validFixture() {
  const fixture = await createPatchProjectFixture("repair");
  const path = join(fixture.projectRoot, sourceFile);
  const value = JSON.parse(await readFile(path, "utf8"));
  value.objects.pop();
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
  return fixture;
}
async function request(
  fixture: PatchProjectFixture,
): Promise<ApplySourcePatchRequest> {
  const bytes = await readFile(join(fixture.projectRoot, sourceFile));
  return {
    format: "agent-tool-request/0.1",
    project: fixture.projectRoot,
    patchFormat: "json-patch/0.1",
    dryRun: false,
    files: [
      {
        path: sourceFile,
        expectedIntegrity: computeFileIntegrity(bytes),
        operations: [
          {
            op: "test",
            path: "/objects/0/uid",
            value: JSON.parse(bytes.toString("utf8")).objects[0].uid,
          },
          { op: "add", path: "/objects/0/description", value: "guarded edit" },
        ],
      },
    ],
  };
}

it.each([
  sourceFile,
  "presentation.json",
  "system.json",
  "../library/library.json",
  "../library/types/connectivity.json",
  "electrical-system.lock.json",
])("A006 gives the right remedy for %s", async (file) => {
  const fixture = await validFixture();
  try {
    const manifestPath = join(fixture.projectRoot, "system.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, presentation: "presentation.json" }),
    );
    await writeFile(
      join(fixture.projectRoot, "presentation.json"),
      JSON.stringify({
        format: "project-presentation/0.1",
        revision: "A",
        backgroundColor: "#ffffff",
      }),
    );
    const input = await request(fixture);
    await writeFile(join(fixture.projectRoot, file), "{");
    if (file === sourceFile)
      input.files[0]!.expectedIntegrity = computeFileIntegrity(
        Buffer.from("{"),
      );
    const outcome = await createInternalApplySourcePatchTool().applySourcePatch(
      { ...input, dryRun: true },
    );
    const parserError = parseJson("{", file).diagnostics[0]!;
    expect(outcome).toMatchObject({
      ok: false,
      failureClass: "expected",
      error: {
        code: "A006",
        file,
        line: parserError.line,
        column: parserError.column,
      },
    });
    if (outcome.ok) throw new Error("Expected refusal");
    expect(outcome.error?.message).toContain("thermite guide agent-requests");
    if (file === "electrical-system.lock.json") {
      expect(outcome.error?.message).toContain("run thermite lock .");
      expect(outcome.error?.message).not.toContain("ordinary edit");
    } else
      expect(outcome.error?.message).toContain("ordinary edit, then validate");
  } finally {
    await fixture.cleanup();
  }
});

it.each([sourceFile, "sources/other.json"])(
  "valid-to-schema-invalid concurrent writes report A004 for %s",
  async (file) => {
    const fixture = await validFixture();
    try {
      await writeFile(
        join(fixture.projectRoot, "sources/other.json"),
        '{"objects":[]}',
      );
      expect(await compileProject(fixture.projectRoot)).toMatchObject({
        ok: true,
      });
      const input = await request(fixture);
      const path = join(fixture.projectRoot, file);
      const changed = JSON.stringify({
        ...JSON.parse(await readFile(path, "utf8")),
        unexpected: true,
      });
      const tool = createInternalApplySourcePatchTool(
        {},
        {
          ...defaults,
          async compileProject(project, cwd) {
            const compiled = await compileProject(project, cwd);
            await writeFile(path, changed);
            return compiled;
          },
        },
      );
      expect(await tool.applySourcePatch(input)).toMatchObject({
        ok: false,
        diagnostics: [],
        error: { code: "A004", file },
        failureClass: "expected",
      });
      expect(await readFile(path, "utf8")).toBe(changed);
    } finally {
      await fixture.cleanup();
    }
  },
);

it.each([false, true])(
  "custom loaders explicitly refuse or support schema repair (patch-capable=%s)",
  async (capable) => {
    const fixture = await validFixture();
    try {
      const path = join(fixture.projectRoot, sourceFile);
      const doc = JSON.parse(await readFile(path, "utf8"));
      doc.objects[0].unexpected = true;
      await writeFile(path, JSON.stringify(doc));
      const input = await request(fixture);
      input.files[0]!.operations.push({
        op: "remove",
        path: "/objects/0/unexpected",
      });
      let calls = 0;
      const tool = createInternalApplySourcePatchTool(
        {},
        {
          ...defaults,
          async loadProject(project, cwd) {
            calls++;
            return (capable ? loadProjectForSourcePatch : loadProject)(
              project,
              cwd,
            );
          },
        },
      );
      const result = await tool.applySourcePatch(input);
      expect(result.ok).toBe(capable);
      expect(calls).toBe(capable ? 2 : 1);
      if (!capable)
        expect(
          result.diagnostics.some(
            (d) =>
              d.message.includes("injected loadProject") &&
              d.message.includes("loadProjectForSourcePatch"),
          ),
        ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  },
);
