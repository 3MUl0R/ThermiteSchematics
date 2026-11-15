import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import ts from "typescript";

const matchesCode = (text) => /^R00[1-6]$/u.test(text);
const slash = (path) => path.replaceAll("\\", "/");
function owner(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isFunctionLike(parent)) continue;
    if (parent.name) return parent.name.getText();
    if (ts.isVariableDeclaration(parent.parent))
      return parent.parent.name.getText();
  }
  return "<module>";
}
function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}
function scanLiteralSites(file, path) {
  const sites = [];
  visit(file, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === "code" &&
      ts.isStringLiteral(node.initializer) &&
      matchesCode(node.initializer.text)
    )
      sites.push({
        node,
        path,
        owner: owner(node),
        kind: "constructor",
        codes: [node.initializer.text],
      });
    if (ts.isCallExpression(node)) {
      const codes = node.arguments
        .filter((arg) => ts.isStringLiteral(arg) && matchesCode(arg.text))
        .map((arg) => arg.text);
      if (codes.length)
        sites.push({
          node,
          path,
          owner: owner(node),
          kind: "code-argument",
          codes,
        });
    }
  });
  return sites;
}
function factoryKey(path, name) {
  return `${path}:${name}`;
}
function messageWrappers(file, path) {
  const wrappers = new Set();
  visit(file, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const spreadsError = node.properties.some(
      (prop) =>
        ts.isSpreadAssignment(prop) &&
        /\b(error|e)\b/u.test(prop.expression.getText(file)),
    );
    if (
      spreadsError &&
      node.properties.some(
        (prop) =>
          ts.isPropertyAssignment(prop) &&
          ["message", "details"].includes(prop.name.getText(file)),
      )
    )
      wrappers.add(owner(node));
  });
  return [...wrappers].map((name) => ({ path, owner: name }));
}

/** Compiler-resolved calls include imported aliases; interfaces are not constructors. */
export function diagnosticInventory(root = resolve(".")) {
  const tracked = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const paths = tracked.filter(
    (path) =>
      path.endsWith(".ts") &&
      (path.startsWith("packages/render/src/") ||
        path === "packages/cli/src/alpha.ts"),
  );
  const program = ts.createProgram(
    paths.map((path) => resolve(root, path)),
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
    },
  );
  const checker = program.getTypeChecker(),
    files = paths.map((path) => ({
      path,
      file: program.getSourceFile(resolve(root, path)),
    }));
  const sites = files.flatMap(({ path, file }) => scanLiteralSites(file, path));
  const factories = new Map();
  for (const site of sites.filter((site) => site.kind === "constructor")) {
    const key = factoryKey(site.path, site.owner),
      codes = factories.get(key) ?? new Set();
    for (const code of site.codes) codes.add(code);
    factories.set(key, codes);
  }
  sites.push(...factoryCalls(root, checker, files, factories));
  return {
    sites: identifySites(sites),
    wrappers: files
      .flatMap(({ path, file }) => messageWrappers(file, path))
      .sort((a, b) =>
        factoryKey(a.path, a.owner).localeCompare(factoryKey(b.path, b.owner)),
      ),
  };
}

function factoryCalls(root, checker, files, factories) {
  const sites = [];
  for (const { path, file } of files)
    visit(file, (node) => {
      if (!ts.isCallExpression(node)) return;
      let symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol?.flags & ts.SymbolFlags.Alias)
        symbol = checker.getAliasedSymbol(symbol);
      const decl = symbol?.valueDeclaration;
      if (!decl) return;
      const key = factoryKey(
        slash(relative(root, decl.getSourceFile().fileName)),
        decl.name?.getText() ?? "",
      );
      const codes = factories.get(key);
      if (codes)
        sites.push({
          node,
          path,
          owner: owner(node),
          kind: "factory-call",
          factory: key,
          codes: [...codes].sort(),
        });
    });
  return sites;
}

function identifySites(sites) {
  const ordinals = new Map();
  return sites
    .map(({ node, ...site }) => {
      const key = `${site.path}:${site.owner}:${site.kind}`,
        ordinal = (ordinals.get(key) ?? 0) + 1;
      ordinals.set(key, ordinal);
      return {
        id: `${key}:${ordinal}`,
        ...site,
        line:
          node.getSourceFile().getLineAndCharacterOfPosition(node.getStart())
            .line + 1,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
