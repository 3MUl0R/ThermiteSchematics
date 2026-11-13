import { createHash } from "node:crypto";
import { execFile as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditTitleDataSurface } from "./title-data-surface.js";
import * as schemaApi from "@thermite/schema";
import * as renderApi from "@thermite/render";
import { compileProject } from "@thermite/compiler";
import { createAgentTools } from "@thermite/agent-tools";
import { packetPdf } from "../src/alpha-pdf.js";
import { initializeAlphaProject } from "../src/alpha-init.js";
const execFile = promisify(execCallback);
const cli = resolve("packages/cli/dist/thermite-bin.js");
let root: string, project: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "thermite-tb1-"));
  project = join(root, "synthetic-project");
  await initializeAlphaProject(project);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
async function run(args: string[]) {
  try {
    const result = await execFile(process.execPath, [cli, ...args]);
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as { stdout: string; stderr: string; code: number };
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  }
}
describe("TB1 S5 public release gate", () => {
  it("keeps the project guide byte-identical at 19,637", async () => {
    const guide = await readFile("packages/cli/assets/THERMITE_AGENTS.md");
    expect(guide.byteLength).toBe(19637);
    expect(sha(guide)).toBe(
      "45a85b42a2804522fabfd59787aab0b825ac0c7e5c9feb0f3aeb575ebb676c49",
    );
  });
  it("keeps internal entry points out of all runtime exports and imports", async () => {
    for (const api of [schemaApi, renderApi])
      expect(
        Object.keys(api).filter((k) =>
          /InternalPresentation|InternalPacket|parsePresentationStructure|presentationSchema|resolveTitles|sheetKey|titleDataSchema|presentationSettings/.test(
            k,
          ),
        ),
      ).toEqual([]);
    const files = new Map<string, string>();
    await Promise.all(
      ["schema", "render", "compiler", "query", "cli", "agent-tools"].map(
        async (pkg) => {
          const base = `packages/${pkg}/src`;
          const paths = (await readdir(base, { recursive: true })).filter(
            (path) => path.endsWith(".ts"),
          );
          await Promise.all(
            paths.map(async (path) =>
              files.set(
                schemaApi.normalizeDiagnosticFile(join(base, path)),
                await readFile(join(base, path), "utf8"),
              ),
            ),
          );
        },
      ),
    );
    expect(auditTitleDataSurface(files)).toEqual([]);
  });
  it("rejects 0.3 in the public registry with the legacy E014 diagnostic", () => {
    const registry = schemaApi.createInMemoryCanonicalSchemaRegistry();
    const parsed = schemaApi.parseJson(
      '{"format":"project-presentation/0.3","revision":"A","backgroundColor":"#ffffff"}',
      "presentation.json",
    );
    expect(
      registry.validateEntity("project-presentation", parsed.value!, {
        file: "presentation.json",
        nodes: parsed.nodes,
      }),
    ).toEqual([
      {
        code: "E014",
        severity: "error",
        message:
          'Value is not one of the allowed values: ["project-presentation/0.1", "project-presentation/0.2"].',
        file: "presentation.json",
        line: 1,
        column: 11,
        jsonPointer: "/format",
        allowed: ["project-presentation/0.1", "project-presentation/0.2"],
        allowedCount: 2,
      },
    ]);
  });
  it("does not advertise unreleased formats in CLI help, schemas or topics", async () => {
    for (const args of [
      ["--help"],
      ["packet", "--help"],
      ["guide", "--json"],
      ["guide", "schema", "project-presentation"],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toMatch(
        /project-presentation\/0\.3|schematic-packet-request\/0\.2|drawing-frames|titleData/,
      );
    }
    const directory = (await run(["guide", "--path"])).stdout.trim();
    for (const file of (await readdir(directory)).filter((f) =>
      f.endsWith(".md"),
    ))
      expect(await readFile(join(directory, file), "utf8")).not.toMatch(
        /project-presentation\/0\.3|schematic-packet-request\/0\.2|titleData/,
      );
  });
  it("preserves 0.1 rejection and refuses the internal packet format through the public CLI", async () => {
    const good = await readFile(join(project, "presentation.json"));
    const compiled = await compileProject(project);
    expect(compiled.ok).toBe(true);
    const input = join(root, "packet.json");
    for (const format of [
      "schematic-packet-request/0.1",
      "schematic-packet-request/0.2",
    ]) {
      await writeFile(
        input,
        JSON.stringify({
          format,
          views: [{ format: "documentation-view-request/0.1", kind: "bom" }],
          titleData: { defaults: { revision: "X" } },
        }),
      );
      const result = await run([
        "packet",
        "--project",
        project,
        "--input",
        input,
        "--output",
        join(root, "never.svg"),
      ]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: {
          code: "R006",
          reason: "invalid-packet",
          message:
            "A packet requires format schematic-packet-request/0.1 and 1–40 views, with an optional shared page.",
        },
      });
    }
    expect(await readFile(join(project, "presentation.json"))).toEqual(good);
  });
  it("preserves legacy PDF Author metadata", async () => {
    const compiled = await compileProject(project);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const packet = await renderApi.renderSchematicPacket(
      compiled.ir,
      {
        format: "schematic-packet-request/0.1",
        views: [{ format: "documentation-view-request/0.1", kind: "bom" }],
      },
      compiled.presentation,
    );
    expect(packet.ok).toBe(true);
    if (!packet.ok) return;
    const pdf = await packetPdf(packet.value, "Synthetic legacy packet");
    const bytes = pdf.toString("latin1");
    expect(bytes).toMatch(/\/Author \d+ 0 R/);
    expect(bytes).toMatch(/\/Creator \d+ 0 R/);
  });
  it("keeps CLI/agent/compiler rejection of 0.3 presentation identical", async () => {
    const file = join(project, "presentation.json"),
      original = await readFile(file);
    try {
      const value = JSON.parse(original.toString());
      value.format = "project-presentation/0.3";
      await writeFile(file, JSON.stringify(value));
      const compiled = await compileProject(project);
      expect(compiled.ok).toBe(false);
      const diagnostics = compiled.diagnostics.filter(
        (d) => d.jsonPointer === "/format" && d.code === "E014",
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "E014",
        allowed: ["project-presentation/0.1", "project-presentation/0.2"],
      });
      const outcome = await createAgentTools().validate({
        format: "agent-tool-request/0.1",
        project,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.diagnostics).toEqual(compiled.diagnostics);
      const result = await run(["validate", project, "--json"]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual(compiled.diagnostics);
      expect(result.stderr).toBe("");
    } finally {
      await writeFile(file, original);
    }
  });
});
