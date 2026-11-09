import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  exampleFences,
  exampleFindings,
  exampleKey,
  fenceHash,
} from "../../../scripts/docs-examples-lib.mjs";
import { parseDocument, sha256 } from "../../../scripts/docs-lib.mjs";
import { classify } from "../../../scripts/docs-examples.mjs";
import { context } from "../../../scripts/docs-example-context.mjs";
import { recipes } from "../../../scripts/docs-example-recipes.mjs";

import { closeExampleProcesses } from "../../../scripts/docs-example-process.mjs";

const roots: string[] = [];
afterEach(async () => {
  await closeExampleProcesses();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(
  text = "# Test\n\n```sh\nbun -e 'console.log(123)'\n```\n",
) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "thermite-example-inventory-"),
  );
  roots.push(root);
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "README.md"), text);
  await writeFile(join(root, "docs/topics.json"), "[]");
  await writeFile(
    join(root, "scripts/docs-policy.json"),
    JSON.stringify({
      exclude: { directoryNames: [], prefixes: [], files: [], patterns: [] },
    }),
  );
  const corpus = {
    root,
    documents: new Map([["README.md", parseDocument(text)]]),
  };
  return { root, corpus };
}
async function inventory(root: string, entries: any[], bindings = {}) {
  await writeFile(
    join(root, "scripts/docs-examples.json"),
    JSON.stringify({ version: 1, entries, bindings }),
  );
}
it("fails first for an unclassified fence, then passes only with a classification", async () => {
  const { root, corpus } = await fixture();
  expect(await exampleFindings(corpus)).toEqual([
    expect.objectContaining({
      file: "README.md",
      line: 3,
      target: expect.stringContaining("fence #1"),
      reason: expect.stringContaining(
        "bun scripts/docs-examples.mjs --classify README.md#1",
      ),
    }),
  ]);
  const [fence] = exampleFences(corpus);
  await inventory(root, [
    {
      file: fence.file,
      hash: fence.hash,
      kind: "illustrative",
      reason: "Synthetic classification fixture.",
    },
  ]);
  expect(await exampleFindings(corpus)).toEqual([]);
  corpus.documents.set(
    "README.md",
    parseDocument("# Test\n\n```sh\nbun -e 'console.log(456)'\n```\n"),
  );
  expect((await exampleFindings(corpus)).map((f) => f.reason)).toEqual([
    expect.stringContaining("stale example"),
    expect.stringContaining("unclassified or changed"),
  ]);
});
it("uses indexed live documents, includes unknown languages and indented code, and excludes archives and other guides", async () => {
  const { corpus } = await fixture();
  for (const file of [
    "docs/new.md",
    "docs/legacy/old.md",
    "packages/cli/assets/THERMITE_AGENTS.md",
    "evals/draw/README.md",
  ])
    corpus.documents.set(
      file,
      parseDocument(
        "# Doc\n\n~~~new-language\nnew instruction\n~~~\n\n    indented program\n",
      ),
    );
  expect(exampleFences(corpus).map((f) => `${f.file}:${f.lang}`)).toEqual([
    "README.md:sh",
    "docs/new.md:new-language",
    "docs/new.md:",
  ]);
});
it("hashes language and exact body but tolerates line shifts and CRLF", async () => {
  const { corpus } = await fixture();
  const original = exampleFences(corpus)[0];
  corpus.documents.set(
    "README.md",
    parseDocument("\n\n" + corpus.documents.get("README.md").text),
  );
  expect(exampleFences(corpus)[0].hash).toBe(original.hash);
  expect(fenceHash("json", original.body)).not.toBe(original.hash);
  expect(fenceHash(original.lang, original.body, "changed-file.sh")).not.toBe(
    original.hash,
  );
  corpus.documents.set(
    "README.md",
    parseDocument(
      corpus.documents.get("README.md").text.replaceAll("\n", "\r\n"),
    ),
  );
  expect(exampleFences(corpus)[0].hash).toBe(original.hash);
});
it("refuses a broken executed classification without changing the inventory", async () => {
  const { root } = await fixture(
    "# Test\n\n```sh\nbun -e 'process.exit(7)'\n```\n",
  );
  await inventory(root, []);
  const before = await readFile(join(root, "scripts/docs-examples.json"));
  await expect(
    classify(root, "README.md#1", {
      kind: "executed",
      recipe: "cabinets-shell",
    }),
  ).rejects.toThrow();
  expect(await readFile(join(root, "scripts/docs-examples.json"))).toEqual(
    before,
  );
});
it("running a fence forcibly marked executed exposes its failure", async () => {
  const { root, corpus } = await fixture(
    "# Test\n\n```sh\nbun -e 'process.exit(7)'\n```\n",
  );
  const fence = exampleFences(corpus)[0];
  await inventory(root, [
    {
      file: fence.file,
      hash: fence.hash,
      kind: "executed",
      recipe: "cabinets-shell",
    },
  ]);
  expect(await exampleFindings(corpus)).toEqual([]); // Freshness deliberately does not execute.
  const c = await context(root);
  try {
    await expect(recipes["cabinets-shell"](c, fence)).rejects.toThrow();
  } finally {
    await c.cleanup();
  }
});
it("fails when an executed binding is deleted or its actual test source changes", async () => {
  const { root, corpus } = await fixture();
  const fence = exampleFences(corpus)[0];
  const source = "// Synthetic bound test source\n";
  await writeFile(join(root, "bound.test.ts"), source);
  const binding = {
    file: fence.file,
    testFile: "bound.test.ts",
    testName: "fixture",
    testHash: sha256(source),
    consumedHashes: [fence.hash],
  };
  const entry = {
    file: fence.file,
    hash: fence.hash,
    kind: "executed",
    recipe: "fixture-binding",
  };
  await inventory(root, [entry], { "fixture-binding": binding });
  expect(await exampleFindings(corpus)).toEqual([]);
  await inventory(root, [entry]);
  expect(await exampleFindings(corpus)).toContainEqual(
    expect.objectContaining({ reason: "missing executed recipe binding" }),
  );
  await inventory(root, [entry], { "fixture-binding": binding });
  await writeFile(join(root, "bound.test.ts"), "// binding deleted\n");
  expect(await exampleFindings(corpus)).toContainEqual(
    expect.objectContaining({
      reason: expect.stringContaining("test binding changed or was deleted"),
    }),
  );
});
it("requires reviewed reasons and named setups, and rejects duplicate inventory entries", async () => {
  const { root, corpus } = await fixture();
  const fence = exampleFences(corpus)[0];
  const entry = {
    file: fence.file,
    hash: fence.hash,
    kind: "platform-only",
    reason: "Requires Docker.",
  };
  await inventory(root, [entry]);
  expect(await exampleFindings(corpus)).toContainEqual(
    expect.objectContaining({
      reason: expect.stringContaining("named OS or setup"),
    }),
  );
  await inventory(root, [
    { ...entry, setup: "Docker Engine" },
    { ...entry, setup: "Docker Engine" },
  ]);
  expect(await exampleFindings(corpus)).toContainEqual(
    expect.objectContaining({ reason: "duplicate example classification" }),
  );
});
it("runs an executed update before recording the current content and removes its stale predecessor", async () => {
  const { root, corpus } = await fixture();
  await inventory(root, [
    {
      file: "README.md",
      hash: "a".repeat(64),
      kind: "executed",
      recipe: "cabinets-shell",
    },
  ]);
  await classify(root, "README.md#1", {
    kind: "executed",
    recipe: "cabinets-shell",
  });
  expect(await exampleFindings(corpus)).toEqual([]);
  const saved = JSON.parse(
    await readFile(join(root, "scripts/docs-examples.json"), "utf8"),
  );
  expect(saved.entries).toHaveLength(1);
  expect(exampleKey(saved.entries[0])).toBe(
    exampleKey(exampleFences(corpus)[0]),
  );
});

it("does not hide an early command failure behind a successful final command", async () => {
  const { root, corpus } = await fixture(
    "# Test\n\n```sh\nbun -e 'process.exit(7)'\nbun -e 'console.log(123)'\n```\n",
  );
  const c = await context(root);
  try {
    await expect(
      recipes["cabinets-shell"](c, exampleFences(corpus)[0]),
    ).rejects.toThrow();
  } finally {
    await c.cleanup();
  }
});

it("does not approve an executed binding when its named test matches zero tests", async () => {
  const { root } = await fixture();
  const vitestURL = new URL(
    "../../../node_modules/vitest/dist/index.js",
    import.meta.url,
  ).href;
  const source = `import {it} from ${JSON.stringify(vitestURL)}; it("different name", () => {});\n`;
  await writeFile(join(root, "bound.test.ts"), source);
  await inventory(root, [], {
    fixture: {
      file: "README.md",
      testFile: "bound.test.ts",
      testName: "missing name",
      testHash: sha256(source),
    },
  });
  const before = await readFile(join(root, "scripts/docs-examples.json"));
  await expect(
    classify(root, "README.md#1", { kind: "executed", recipe: "fixture" }),
  ).rejects.toThrow("did not execute exactly once");
  expect(await readFile(join(root, "scripts/docs-examples.json"))).toEqual(
    before,
  );
});

it("rejects inherited object properties as executable recipes", async () => {
  const { root } = await fixture();
  await inventory(root, []);
  await expect(
    classify(root, "README.md#1", { kind: "executed", recipe: "constructor" }),
  ).rejects.toThrow("missing executed recipe binding");
});
