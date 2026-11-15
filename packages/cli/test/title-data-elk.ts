import { createHash } from "node:crypto";
import ts from "typescript";
export const ELK_RUNTIME_FILE = "packages/render/src/layout/elk-runtime.ts";
// Hash only loadFauxWorker's text, with universal line endings normalized.
const LOADER_SHA256 =
  "4909b790a7f4f25d642309eed295b73956f5574bf14603900331b45cc74b8e15";
export function elkLoaderException(
  file: string,
  tree: ts.SourceFile,
  issues: string[],
) {
  if (file !== ELK_RUNTIME_FILE) return null;
  const loaders = tree.statements
    .filter(ts.isFunctionDeclaration)
    .filter((fn) => fn.name?.text === "loadFauxWorker");
  const loader = loaders[0];
  if (
    loaders.length !== 1 ||
    !loader ||
    createHash("sha256")
      .update(loader.getText(tree).replace(/\r\n?|[\u2028\u2029]/g, "\n"))
      .digest("hex") !== LOADER_SHA256
  ) {
    issues.push(file + ": ELK dynamic loader pin mismatch");
    return null;
  }
  return loader;
}
function inside(node: ts.Node, loader: ts.FunctionDeclaration | null) {
  return (
    loader !== null &&
    node.getStart() >= loader.getStart() &&
    node.end <= loader.end
  );
}
export function forbiddenDynamicCode(
  node: ts.Node,
  loader: ts.FunctionDeclaration | null,
  text: (node: ts.Expression) => string | undefined,
) {
  const name = ts.isIdentifier(node)
    ? node.text
    : ts.isElementAccessExpression(node) && node.argumentExpression
      ? text(node.argumentExpression)
      : null;
  return (
    (name === "eval" || name === "Function") &&
    !(name === "Function" && inside(node, loader))
  );
}
const dangerousModule = (name: string) =>
  /^(?:node:)?(?:fs(?:\/promises)?|os|child_process|https?|net|tls|dns|dgram|worker_threads|module)$|^(?:simple-git|isomorphic-git|git)(?:\/|$)/.test(
    name,
  );
function permittedImport(node: ts.ImportDeclaration) {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return false;
  const expected =
    node.moduleSpecifier.text === "node:fs"
      ? "readFileSync"
      : node.moduleSpecifier.text === "node:module"
        ? "createRequire"
        : null;
  const bindings = node.importClause?.namedBindings;
  const element =
    bindings && ts.isNamedImports(bindings) ? bindings.elements[0] : undefined;
  return (
    !!expected &&
    !node.importClause?.name &&
    !!bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length === 1 &&
    element !== undefined &&
    element.name.text === expected &&
    (element.propertyName?.text ?? expected) === expected
  );
}
function inImport(node: ts.Node): boolean {
  return (
    ts.isImportDeclaration(node) || (!!node.parent && inImport(node.parent))
  );
}
const sensitive = new Set([
  "process",
  "Bun",
  "Deno",
  "globalThis",
  "window",
  "self",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "require",
  "createRequire",
  "readFileSync",
]);
export function auditElkCapabilities(
  tree: ts.SourceFile,
  loader: ts.FunctionDeclaration | null,
  issues: string[],
) {
  function visit(node: ts.Node) {
    if (!inside(node, loader)) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        dangerousModule(node.moduleSpecifier.text) &&
        !permittedImport(node)
      )
        issues.push(
          ELK_RUNTIME_FILE +
            ": forbidden ELK capability import " +
            node.moduleSpecifier.text,
        );
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        dangerousModule(node.arguments[0].text)
      )
        issues.push(
          ELK_RUNTIME_FILE + ": forbidden ELK capability dynamic import",
        );
      if (ts.isIdentifier(node) && sensitive.has(node.text) && !inImport(node))
        issues.push(
          ELK_RUNTIME_FILE + ": forbidden ELK capability " + node.text,
        );
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "WORKER_SPECIFIER" &&
        (!node.initializer ||
          !ts.isStringLiteral(node.initializer) ||
          node.initializer.text !== "elkjs/lib/elk-worker.min.js" ||
          !ts.isVariableDeclarationList(node.parent) ||
          !(node.parent.flags & ts.NodeFlags.Const))
      )
        issues.push(
          ELK_RUNTIME_FILE +
            ": worker specifier must remain a closed ELK resource",
        );
      if (
        ts.isBinaryExpression(node) &&
        ts.isIdentifier(node.left) &&
        ["fauxWorker", "WORKER_SPECIFIER"].includes(node.left.text) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        issues.push(
          ELK_RUNTIME_FILE + ": loader binding mutated outside pinned function",
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
