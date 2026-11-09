import { afterEach, expect, it } from "vitest";
import { loadCorpus } from "../../../scripts/docs-lib.mjs";
import {
  exampleFences,
  exampleFindings,
  exampleKey,
  readInventory,
} from "../../../scripts/docs-examples-lib.mjs";
import { recipes } from "../../../scripts/docs-example-recipes.mjs";
import { context } from "../../../scripts/docs-example-context.mjs";
import { repositoryRoot } from "./project-guide/harness.js";

const active = new Set<Awaited<ReturnType<typeof context>>>();
afterEach(async () => {
  await Promise.all([...active].map((c) => c.cleanup()));
  active.clear();
});
const corpus = await loadCorpus(repositoryRoot);
const fences = exampleFences(corpus);
const inventory = await readInventory(repositoryRoot);
const groups = new Map<string, typeof inventory.entries>();
for (const entry of inventory.entries) {
  if (entry.kind !== "executed" || inventory.bindings?.[entry.recipe]) continue;
  const key = `${entry.file} [${entry.recipe}]`;
  groups.set(key, [...(groups.get(key) ?? []), entry]);
}
it("has a fresh, exhaustive runnable-example inventory and real test bindings", async () => {
  expect(await exampleFindings(corpus)).toEqual([]);
});
// Sequential groups: at most one CLI child per worker, with independent trees.
// Existing topic recipes are executed by their specifically named guide tests,
// not recursively launched from here. Their source hashes are checked above.
for (const entries of groups.values()) {
  it(
    recipes[entries[0].recipe].testName(entries[0].file, entries[0].recipe),
    async () => {
      const c = await context(repositoryRoot);
      active.add(c);
      c.fences = fences;
      try {
        for (const entry of entries) {
          const fence = fences.find((f) => exampleKey(f) === exampleKey(entry));
          expect(fence, `missing ${entry.file}:${entry.hash}`).toBeDefined();
          await recipes[entry.recipe](c, fence);
        }
      } finally {
        await c.cleanup();
        active.delete(c);
      }
    },
  );
}
