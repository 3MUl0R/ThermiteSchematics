import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));

function pathnameUses(text: string) {
  const source = ts.createSourceFile(
    "source.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const uses: string[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "pathname") ||
      (ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "pathname")
    )
      uses.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  return uses;
}

function sourceFiles(): string[] {
  // Include new source files without scanning ignored projects, dependencies,
  // generated output or copied checkouts. Git emits portable relative paths in
  // both clones and linked worktrees; NUL delimiters preserve spaces in names.
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return [...new Set(result.stdout.split("\0"))].filter((path) =>
    /\.[cm]?[jt]sx?$/.test(path),
  );
}

it("uses fileURLToPath for filesystem paths; pathname is reserved for HTTP URLs", () => {
  // These three expressions inspect HTTP request paths or canonical HTTPS
  // schema IDs. File URLs must be passed to fs directly or decoded by node:url.
  const httpUses = [
    'evals/agent/capture-cli.mjs: new URL(req.url, "http://localhost").pathname',
    "packages/schema/scripts/generate-types.mjs: url.pathname",
    "packages/schema/scripts/generate-types.mjs: new URL(id).pathname",
  ];
  const actual = sourceFiles().flatMap((path) =>
    pathnameUses(readFileSync(join(root, path), "utf8")).map(
      (use) => `${path}: ${use}`,
    ),
  );
  expect(
    actual.sort(),
    "Use fileURLToPath(url) instead of url.pathname for filesystem paths",
  ).toEqual(httpUses.sort());
});

it("catches multiline and bracket pathname access without matching comments or strings", () => {
  expect(
    pathnameUses(`
    const first = new URL("./fixture/", import.meta.url)
      .pathname;
    const second = url["pathname"];
    // url.pathname
    const message = "url.pathname";
    const portable = fileURLToPath(new URL("./fixture/", import.meta.url));
  `),
  ).toEqual([
    'new URL("./fixture/", import.meta.url)\n      .pathname',
    'url["pathname"]',
  ]);
});
