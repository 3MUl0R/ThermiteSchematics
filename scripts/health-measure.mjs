import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const testFile = (path) =>
  /(?:^|\/)(?:test|tests|__tests__)\//.test(path) ||
  /\.(?:test|spec|check)\.[cm]?[jt]sx?$/.test(path);
// Generator inventory: packages/schema/scripts/generate-types.mjs owns src/generated;
// scripts/update-text-metrics.mjs owns the standalone render metrics data file.
function generated(path) {
  return (
    /^packages\/schema\/src\/generated\//.test(path) ||
    path === "packages/render/src/text-metrics-data.ts"
  );
}
export function inScope(path) {
  if (
    generated(path) ||
    /(?:^|\/)(?:node_modules|dist|out|goldens|snapshots)\//.test(path)
  )
    return false;
  if (!/\.(?:[cm]?[jt]sx?|py|sh|ps1)$/.test(path)) return false;
  // E2's agent harness remains frozen: only its existing test-suppression scan.
  if (path.startsWith("evals/agent/")) return testFile(path);
  return (
    /^packages\/[^/]+\/(?:src|test)\//.test(path) ||
    path.startsWith("evals/") ||
    path.startsWith("scripts/") ||
    testFile(path)
  );
}
function sizeScope(path) {
  return (
    !path.startsWith("evals/agent/") &&
    (/^packages\/[^/]+\/(?:src|test)\//.test(path) ||
      path.startsWith("evals/") ||
      path.startsWith("scripts/"))
  );
}
function suiteCallback(node) {
  if (
    !ts.isCallExpression(node.parent) ||
    !node.parent.arguments.includes(node)
  )
    return false;
  let callee = node.parent.expression;
  while (
    ts.isCallExpression(callee) ||
    ts.isPropertyAccessExpression(callee) ||
    ts.isElementAccessExpression(callee)
  ) {
    if (
      (ts.isPropertyAccessExpression(callee) ||
        ts.isElementAccessExpression(callee)) &&
      ["describe", "suite"].includes(propertyName(callee))
    )
      return true;
    callee = callee.expression;
  }
  return ts.isIdentifier(callee) && ["describe", "suite"].includes(callee.text);
}
function pureData(node) {
  if (!node) return false;
  if (
    ts.isLiteralExpression(node) ||
    [
      ts.SyntaxKind.TrueKeyword,
      ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.NullKeyword,
    ].includes(node.kind)
  )
    return true;
  if (ts.isPrefixUnaryExpression(node)) return pureData(node.operand);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(pureData);
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every(
      (p) => ts.isPropertyAssignment(p) && pureData(p.initializer),
    );
  return false;
}
function dataFixture(path, source) {
  return (
    /(?:^|\/)fixtures\//.test(path) &&
    source &&
    source.statements.every((s) =>
      ts.isExportAssignment(s)
        ? pureData(s.expression)
        : ts.isVariableStatement(s) &&
          s.declarationList.declarations.every((d) => pureData(d.initializer)),
    )
  );
}
export function trackedSourcePaths(root) {
  return trackedPaths(root);
}
function trackedPaths(root) {
  const prefix = spawnSync("git", ["-C", root, "rev-parse", "--show-prefix"], {
    encoding: "utf8",
  });
  if (prefix.error || prefix.status !== 0)
    throw new Error(
      "Health ratchet requires a git checkout; run it from the checkout root.",
    );
  if (prefix.stdout.trim() !== "")
    throw new Error("Health ratchet must run from the git checkout root.");
  const untracked = spawnSync(
    "git",
    ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  );
  if (untracked.error || untracked.status !== 0)
    throw new Error("Cannot list untracked files for the health ratchet.");
  const omitted = untracked.stdout.split("\0").filter(inScope).sort(compare);
  if (omitted.length)
    console.warn(
      `Health ratchet warning: ${omitted.length} untracked in-scope files were not scanned:\n${omitted.map((path) => `  ${path}`).join("\n")}\nUse git add -N <file> to include them.`,
    );
  const result = spawnSync("git", ["-C", root, "ls-files", "--cached", "-z"], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0)
    throw new Error("Cannot list git-tracked files for the health ratchet.");
  return [...new Set(result.stdout.split("\0").filter(Boolean))]
    .filter((path) => inScope(path) && existsSync(join(root, path)))
    .sort(compare);
}
function lineCount(text) {
  // CRLF and LF checkouts have the same budget; a final newline adds no line.
  return text === "" ? 0 : text.replace(/\r?\n$/, "").split(/\r?\n/).length;
}
function functionName(node, source) {
  if (node.name) return node.name.getText(source);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent))
    return parent.name.getText(source);
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression;
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : "call";
    return `${name} callback`;
  }
  return "anonymous";
}
function normalizedBody(body, source) {
  const tokens = [];
  function visit(node) {
    // AST leaves preserve regex/template/string contents while removing trivia.
    // A plain scanner cannot rescan template tails or regular expressions.
    if (ts.isJSDoc(node)) return;
    const children = node.getChildren(source);
    if (!children.length) {
      if (node.kind !== ts.SyntaxKind.JSDocComment)
        tokens.push(node.getText(source));
    } else for (const child of children) visit(child);
  }
  visit(body);
  return {
    hash: createHash("sha256").update(JSON.stringify(tokens)).digest("hex"),
    tokens: tokens.filter(Boolean).length,
  };
}
function propertyName(node) {
  return ts.isPropertyAccessExpression(node)
    ? node.name.text
    : node.argumentExpression?.text;
}
function testRoot(node) {
  while (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node)
  )
    node = node.expression;
  return (
    ts.isIdentifier(node) &&
    ["it", "test", "describe", "suite"].includes(node.text)
  );
}
function suppressionOption(node) {
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.some(
      (property) =>
        (ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)) &&
        ["skip", "todo", "only"].includes(
          property.name.getText().replace(/["']/g, ""),
        ) &&
        (ts.isShorthandPropertyAssignment(property) ||
          property.initializer.kind !== ts.SyntaxKind.FalseKeyword),
    )
  );
}
function destructuredSkip(node) {
  if (!ts.isIdentifier(node.expression)) return false;
  const name = node.expression.text;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isFunctionLike(parent)) continue;
    if (
      parent.parameters.some(
        (parameter) =>
          ts.isObjectBindingPattern(parameter.name) &&
          parameter.name.elements.some(
            (binding) =>
              (binding.propertyName?.getText() ?? binding.name.getText()) ===
                "skip" && binding.name.getText() === name,
          ),
      )
    )
      return true;
    if (
      parent.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) && parameter.name.text === name,
      )
    )
      return false;
  }
  return false;
}
function isSuppression(node, inTest) {
  if (ts.isCallExpression(node)) {
    if (
      ts.isIdentifier(node.expression) &&
      testRoot(node.expression) &&
      node.arguments.some(suppressionOption)
    )
      return true;
    const callee = node.expression;
    if (
      inTest &&
      (ts.isPropertyAccessExpression(callee) ||
        ts.isElementAccessExpression(callee)) &&
      propertyName(callee) === "skip" &&
      !testRoot(callee)
    )
      return true;
    if (inTest && destructuredSkip(node)) return true;
  }
  return (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    ["skip", "todo", "only", "skipIf", "runIf"].includes(propertyName(node)) &&
    testRoot(node)
  );
}

/** AST metrics, with stable lexical function names rather than source-line IDs. */
export function measure(root = resolve(".")) {
  return measureSources(trackedPaths(root), (path) =>
    readFileSync(join(root, path), "utf8"),
  );
}
export function measureSources(paths, read) {
  const files = {},
    functions = {},
    bodies = new Map(),
    bodyTokens = {},
    bodyHashes = {},
    fileHashes = {};
  for (const path of paths) {
    const text = read(path).replace(/\r\n/g, "\n");
    const source = /\.[cm]?[jt]sx?$/.test(path)
      ? ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
      : undefined;
    if (source?.parseDiagnostics.length)
      throw new Error(`Cannot parse health source: ${path}`);
    if (dataFixture(path, source)) continue;
    const onlySkips = testFile(path),
      sizes = sizeScope(path);
    const metrics = !sizes
      ? { skippedTests: 0 }
      : { lines: lineCount(text), nonNullAssertions: 0, skippedTests: 0 };
    const occurrences = new Map();
    function visit(node, scope = "") {
      if (isSuppression(node, onlySkips)) metrics.skippedTests++;
      if (!onlySkips && ts.isNonNullExpression(node))
        metrics.nonNullAssertions++;
      let nestedScope = scope;
      if (sizes && ts.isFunctionLike(node) && node.body) {
        const name = `${scope}${functionName(node, source)}`;
        const count = (occurrences.get(name) ?? 0) + 1;
        occurrences.set(name, count);
        const identity = `${path}#${name}${count === 1 ? "" : `~${count}`}`;
        const start = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        ).line;
        const end = source.getLineAndCharacterOfPosition(node.end).line;
        nestedScope = `${name}/`;
        if (suiteCallback(node)) {
          ts.forEachChild(node, (child) => visit(child, nestedScope));
          return;
        }
        functions[identity] = end - start + 1;
        const { hash, tokens } = normalizedBody(node.body, source);
        bodyTokens[identity] = tokens;
        bodyHashes[identity] = hash;
        if (onlySkips) {
          ts.forEachChild(node, (child) => visit(child, nestedScope));
          return;
        }
        const group = bodies.get(hash) ?? { tokens, members: [] };
        group.members.push(identity);
        bodies.set(hash, group);
      }
      ts.forEachChild(node, (child) => visit(child, nestedScope));
    }
    if (source) visit(source);
    files[path] = metrics;
    if (sizes)
      fileHashes[path] = createHash("sha256").update(text).digest("hex");
  }
  const duplicates = duplicateGroups(bodies);
  return {
    version: 3,
    files,
    functions,
    duplicates,
    bodyTokens,
    bodyHashes,
    fileHashes,
  };
}

function duplicateGroups(bodies) {
  return Object.fromEntries(
    [...bodies]
      .filter(([, group]) => group.members.length > 1)
      .sort(([a], [b]) => compare(a, b))
      .map(([hash, group]) => [
        hash,
        { ...group, members: group.members.sort(compare) },
      ]),
  );
}
