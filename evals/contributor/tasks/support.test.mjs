import { expect, it } from "vitest";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  dependencyOverlay,
  ignoreFixtureDependencies,
  mutation,
  setup,
} from "./support.mjs";
it("the seeded alias-ordering mutation reverses the existing comparison contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thermite-k-seed-"));
  try {
    const original = readFileSync(
      new URL("../../../packages/query/src/ordering.ts", import.meta.url),
      "utf8",
    );
    expect(original).toContain(mutation.before);
    for (const [name, source] of [
      ["original", original],
      ["mutant", original.replace(mutation.before, mutation.after)],
    ])
      writeFileSync(join(directory, name + ".ts"), source);
    const normal = await import(
      pathToFileURL(join(directory, "original.ts")).href
    );
    const mutant = await import(
      pathToFileURL(join(directory, "mutant.ts")).href
    );
    expect(normal.compareAlias("A", "B")).toBeLessThan(0);
    expect(mutant.compareAlias("A", "B")).toBeGreaterThan(0);
    expect(mutant.compareAlias("A", "A")).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it("runtime archives cannot masquerade as source contributor contexts", () => {
  const directory = mkdtempSync(join(tmpdir(), "thermite-k-runtime-"));
  try {
    expect(() => setup({ runtime: directory })).toThrow("--context source");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("fixture cache writes stay local and tsc resolves its real package", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thermite-k-deps-"));
  try {
    const runtime = join(directory, "runtime"),
      repository = join(directory, "repository");
    mkdirSync(join(runtime, "node_modules/typescript/bin"), {
      recursive: true,
    });
    writeFileSync(
      join(runtime, "node_modules/typescript/package.json"),
      JSON.stringify({ bin: { tsc: "./bin/tsc" } }),
    );
    writeFileSync(
      join(runtime, "node_modules/typescript/bin/tsc"),
      "globalThis.__k_tsc_test=true;",
    );
    dependencyOverlay(runtime, repository);
    mkdirSync(join(repository, "node_modules/.vite"));
    writeFileSync(join(repository, "node_modules/.vite/cache.json"), "{}");
    expect(existsSync(join(runtime, "node_modules/.vite"))).toBe(false);
    await import(pathToFileURL(join(repository, "node_modules/.bin/tsc")).href);
    expect(globalThis.__k_tsc_test).toBe(true);
    delete globalThis.__k_tsc_test;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function dependencyIgnoreFixture(directory) {
  const repository = join(directory, "engine"),
    worktree = join(directory, "worktree");
  mkdirSync(repository);
  const excludes = join(directory, "global-excludes");
  writeFileSync(excludes, "");
  const args = (cwd, ...rest) => [
    "-c",
    `core.excludesFile=${excludes}`,
    "-C",
    cwd,
    ...rest,
  ];
  const git = (cwd, ...rest) =>
    execFileSync("git", args(cwd, ...rest), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const ignored = (cwd, path) => {
    const result = spawnSync(
      "git",
      args(cwd, "check-ignore", "--no-index", "--", path),
    );
    expect(result.error).toBeUndefined();
    expect([0, 1]).toContain(result.status);
    return result.status === 0;
  };
  git(repository, "init", "--quiet");
  return { repository, worktree, git, ignored };
}

it("fixture-only exclusions keep linked dependencies clean without hiding ordinary node_modules files", () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "thermite-k-ignore-")),
  );
  try {
    const { repository, worktree, git, ignored } =
      dependencyIgnoreFixture(directory);
    const policy = readFileSync(
      new URL("../../../.gitignore", import.meta.url),
      "utf8",
    );
    expect(policy.split("\n")).toContain("node_modules/");
    expect(policy.split("\n")).not.toContain("node_modules");
    writeFileSync(join(repository, ".gitignore"), policy);
    writeFileSync(join(repository, "node_modules"), "ordinary source file");
    expect(ignored(repository, "node_modules")).toBe(false);
    rmSync(join(repository, "node_modules"));
    mkdirSync(join(repository, "node_modules"));
    expect(ignored(repository, "node_modules")).toBe(true);
    const probe = join(directory, "dependency-target");
    mkdirSync(probe);
    rmSync(join(repository, "node_modules"), { recursive: true });
    symlinkSync(
      probe,
      join(repository, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(ignored(repository, "node_modules")).toBe(false);
    rmSync(join(repository, "node_modules"), { recursive: true });
    mkdirSync(join(repository, "node_modules"));
    ignoreFixtureDependencies(repository);
    git(repository, "add", ".gitignore");
    git(
      repository,
      "-c",
      "user.name=Eval",
      "-c",
      "user.email=eval@invalid",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "Dependency ignore fixture",
    );
    git(repository, "worktree", "add", "--detach", worktree);
    symlinkSync(
      join(repository, "node_modules"),
      join(worktree, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(ignored(worktree, "node_modules")).toBe(true);
    expect(realpathSync(join(worktree, "node_modules"))).toBe(
      realpathSync(join(repository, "node_modules")),
    );
    expect(git(worktree, "status", "--porcelain")).toBe("");
    mkdirSync(join(worktree, "nested"));
    writeFileSync(
      join(worktree, "nested/node_modules"),
      "ordinary nested source file",
    );
    expect(ignored(worktree, "nested/node_modules")).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
