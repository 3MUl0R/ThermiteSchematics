import { expect, it } from "vitest";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dependencyOverlay, mutation, setup } from "./support.mjs";
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
