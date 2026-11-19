import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cases,
  prepare,
  sourceFiles,
  createSeal,
  verifyCorpus,
} from "./corpus.mjs";
import { command, json } from "./support.mjs";
it("seals tracked drawing inputs, ignores output, and reports tracked drift without failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "draw-seal-")),
    selection = { roots: ["fixture"], requests: [] };
  try {
    await command(root, "git", ["init", "-q"]);
    await command(root, "git", [
      "config",
      "user.email",
      "fixture@example.invalid",
    ]);
    await command(root, "git", ["config", "user.name", "Synthetic fixture"]);
    await mkdir(join(root, "fixture/out"), { recursive: true });
    await mkdir(join(root, "corpus"));
    await writeFile(join(root, ".gitignore"), "out/\n");
    await writeFile(join(root, "fixture/source.json"), "{}\n");
    await writeFile(join(root, "fixture/package.json"), "{}\n");
    await command(root, "git", ["add", "."]);
    await command(root, "git", [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "synthetic seal input",
    ]);
    const before = await createSeal(root, selection);
    await writeFile(join(root, "corpus/manifest.json"), json(before));
    await writeFile(join(root, "fixture/out/view.json"), "{}\n");
    expect(await sourceFiles(root, selection)).toEqual(before.files);
    expect(Object.keys(before.files)).toEqual(["fixture/source.json"]);
    await writeFile(join(root, "fixture/source.json"), '{"changed":true}\n');
    const drift = await verifyCorpus(root, root, selection);
    expect(drift.changedFiles).toEqual(["fixture/source.json"]);
    expect(drift.actual.base).toMatch(/^[a-f0-9]{40}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("adds 16 compact-frame cases to the full corpus only", () => {
  const full = cases();
  const compact = full.filter((spec) => spec.recipe === "compact-frame");
  expect(full).toHaveLength(124);
  expect(compact).toHaveLength(16);
  expect(new Set(full.map((spec) => spec.id)).size).toBe(full.length);
  expect(cases(true).some((spec) => spec.recipe === "compact-frame")).toBe(
    false,
  );
  for (const project of ["examples/conveyor-line", "examples/machine-demo"])
    for (const flow of ["left-to-right", "top-to-bottom"])
      expect(
        compact
          .filter((spec) => spec.project === project && spec.flow === flow)
          .map(({ frameRequest }) => [
            frameRequest.page.size,
            frameRequest.layout,
          ]),
      ).toEqual([
        ["tabloid", "standard"],
        ["tabloid", "compact"],
        ["letter", "standard"],
        ["letter", "compact"],
      ]);
});

it("upgrades the cloned presentation and keeps the source project intact", async () => {
  const root = process.cwd();
  const spec = cases().find(
    (c) => c.id === "p03-conveyor-line-letter-portrait-standard-top-to-bottom",
  );
  const dest = await mkdtemp(join(tmpdir(), "draw-compact-frame-"));
  try {
    const source = join(root, spec.project, "presentation.json");
    const original = await readFile(source, "utf8");
    const prepared = await prepare(spec, root, dest, async (args) => {
      expect(args).toEqual(["lock", join(dest, "project")]);
      return { code: 0 };
    });
    expect(await readFile(source, "utf8")).toBe(original);
    const { $schema, ...authored } = JSON.parse(original);
    expect(
      JSON.parse(
        await readFile(join(prepared.project, "presentation.json"), "utf8"),
      ),
    ).toEqual({
      ...authored,
      format: "project-presentation/0.3",
    });
    expect(prepared.request.page).toEqual({
      size: "letter",
      orientation: "portrait",
      marginMm: 5,
    });
    expect(prepared.request.layout).toBe("standard");
    expect(
      prepared.request.views
        .filter((v) => v.flow)
        .every((v) => v.flow === "top-to-bottom"),
    ).toBe(true);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});
