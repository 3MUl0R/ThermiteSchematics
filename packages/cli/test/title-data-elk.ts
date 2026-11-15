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
    : ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node) && node.argumentExpression
        ? text(node.argumentExpression)
        : null;
  const constructorReference =
    name === "constructor" &&
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node));
  return (
    name === "eval" ||
    ((name === "Function" || constructorReference) && !inside(node, loader))
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
function loaderSpecifier(node: ts.Node, factories: ReadonlySet<string>) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  const factory = (expression: ts.Node) =>
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    factories.has(expression.expression.text);
  const direct =
    ts.isIdentifier(callee) &&
    (callee.text === "require" || factories.has(callee.text));
  const resolve =
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "resolve" &&
    ((ts.isIdentifier(callee.expression) &&
      callee.expression.text === "require") ||
      factory(callee.expression));
  return callee.kind === ts.SyntaxKind.ImportKeyword ||
    direct ||
    factory(callee) ||
    resolve
    ? node.arguments[0]
    : null;
}
function auditElkBindings(node: ts.Node, issues: string[]) {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "fauxWorker" &&
    node.initializer &&
    !(
      ts.isIdentifier(node.initializer) && node.initializer.text === "undefined"
    )
  )
    issues.push(ELK_RUNTIME_FILE + ": loader cache must start undefined");
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
      ELK_RUNTIME_FILE + ": worker specifier must remain a closed ELK resource",
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
export function auditElkCapabilities(
  tree: ts.SourceFile,
  loader: ts.FunctionDeclaration | null,
  issues: string[],
  text: (node: ts.Expression | undefined) => string | undefined,
  factories: ReadonlySet<string>,
) {
  function visit(node: ts.Node) {
    if (!inside(node, loader)) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      ) {
        const value = text(node.moduleSpecifier);
        if (
          (value === undefined || dangerousModule(value)) &&
          !(ts.isImportDeclaration(node) && permittedImport(node))
        )
          issues.push(
            ELK_RUNTIME_FILE +
              (value === undefined
                ? ": unresolved ELK capability specifier"
                : ": forbidden ELK capability import/export " + value),
          );
      }
      const specifier = loaderSpecifier(node, factories);
      if (specifier !== null) {
        const value = text(specifier);
        if (value === undefined || dangerousModule(value))
          issues.push(
            ELK_RUNTIME_FILE +
              (value === undefined
                ? ": unresolved ELK capability specifier"
                : ": forbidden ELK capability loader " + value),
          );
      }
      if (ts.isIdentifier(node) && sensitive.has(node.text) && !inImport(node))
        issues.push(
          ELK_RUNTIME_FILE + ": forbidden ELK capability " + node.text,
        );
      auditElkBindings(node, issues);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
