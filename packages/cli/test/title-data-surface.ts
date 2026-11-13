import ts from "typescript";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
const normal = (path: string) => posix.normalize(path.replaceAll("\\", "/"));
const hidden = (path: string) =>
  /^packages\/(?:schema|render)\/src\/internal\/title-data\//u.test(path);
const envAccess =
  /\b(?:process|Bun)\s*(?:\.\s*env|\[\s*["']env["']\s*\])|import\.meta\.env/u;

function constantText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return constantText(node.expression);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const a = constantText(node.left),
      b = constantText(node.right);
    if (a !== undefined && b !== undefined) return a + b;
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
      const value = constantText(span.expression);
      if (value === undefined) return;
      result += value + span.literal.text;
    }
    return result;
  }
}
function targetPath(
  file: string,
  specifier: string,
  files: Map<string, string>,
): string | undefined {
  let literal = specifier.replaceAll("\\", "/");
  if (/^file:/iu.test(literal)) {
    try {
      const url = new URL(literal);
      literal = fileURLToPath(url, {
        windows: !!url.hostname && url.hostname !== "localhost",
      }).replaceAll("\\", "/");
    } catch {
      return;
    }
  }
  const absoluteHidden =
    /(?:^|\/)(packages\/(?:schema|render)\/(?:src|dist)\/internal\/title-data\/.+)$/u.exec(
      literal,
    );
  const scoped = /^@thermite\/([^/]+)(?:\/(.*))?$/u.exec(specifier);
  let path = absoluteHidden
    ? absoluteHidden[1]
    : scoped
      ? `packages/${scoped[1]}/src/${scoped[2] ?? "index"}`
      : specifier.startsWith(".")
        ? posix.join(posix.dirname(file), specifier)
        : undefined;
  if (!path) return;
  path = normal(path)
    .replace("/dist/", "/src/")
    .replace(/\.[cm]?js$/u, ".ts");
  return (
    [path, `${path}.ts`, `${path}/index.ts`].find((p) => files.has(p)) ?? path
  );
}
/** Audit all production modules, including internal barrels outside the two
 * exact hidden title-data directories. Unknown dynamic loaders fail closed. */
export function auditTitleDataSurface(
  input: ReadonlyMap<string, string>,
): string[] {
  const files = new Map([...input].map(([path, text]) => [normal(path), text]));
  const issues: string[] = [],
    edges = new Map<string, string[]>(),
    env = new Set<string>();
  for (const [file, text] of files) {
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const factories = new Set(["createRequire"]);
    const constants = new Map<string, ts.Expression>();
    const declarations = new Map<string, number>();
    for (const statement of tree.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        ["node:module", "module"].includes(statement.moduleSpecifier.text)
      ) {
        const binding = statement.importClause?.namedBindings;
        if (binding && ts.isNamedImports(binding))
          for (const item of binding.elements)
            if ((item.propertyName?.text ?? item.name.text) === "createRequire")
              factories.add(item.name.text);
      }
      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.flags & ts.NodeFlags.Const
      )
        for (const item of statement.declarationList.declarations)
          if (ts.isIdentifier(item.name) && item.initializer)
            constants.set(item.name.text, item.initializer);
    }
    const count = (node: ts.Node) => {
      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
        ts.isIdentifier(node.name)
      )
        declarations.set(
          node.name.text,
          (declarations.get(node.name.text) ?? 0) + 1,
        );
      ts.forEachChild(node, count);
    };
    count(tree);
    const closedText = (node: ts.Expression | undefined) =>
      node &&
      ts.isIdentifier(node) &&
      declarations.get(node.text) === 1 &&
      constants.has(node.text)
        ? constantText(constants.get(node.text) as ts.Expression)
        : node
          ? constantText(node)
          : undefined;
    const factoryCall = (node: ts.Node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      factories.has(node.expression.text);

    if (envAccess.test(text)) env.add(file);
    if (
      !hidden(file) &&
      /project-presentation\/0\.3|schematic-packet-request\/0\.2/u.test(text)
    )
      issues.push(`${file}: unreleased format outside title-data`);
    const dependencies: string[] = [];
    const add = (specifier: string | undefined, dynamic = false) => {
      if (specifier === undefined) {
        if (dynamic)
          issues.push(
            `${file}: unresolved dynamic import/require could expose title-data`,
          );
        return;
      }
      const target = targetPath(file, specifier, files);
      if (target) dependencies.push(target);
    };
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        add(node.moduleSpecifier.text);
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression
      )
        add(constantText(node.moduleReference.expression), true);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      )
        add(node.argument.literal.text);
      if (
        ts.isStringLiteralLike(node) ||
        ts.isBinaryExpression(node) ||
        ts.isTemplateExpression(node)
      ) {
        const value = ts.isStringLiteralLike(node)
          ? node.text
          : constantText(node as ts.Expression);
        const target =
          value === undefined ? undefined : targetPath(file, value, files);
        if (target && hidden(target)) dependencies.push(target);
      }
      if (
        ts.isIdentifier(node) &&
        (node.text === "require" || factories.has(node.text)) &&
        !ts.isImportSpecifier(node.parent) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      )
        issues.push(
          `${file}: indirect require/createRequire cannot be audited for hidden access`,
        );
      if (factoryCall(node)) {
        const arg = node.arguments[0];
        const localBase =
          arg &&
          ts.isPropertyAccessExpression(arg) &&
          arg.name.text === "url" &&
          ts.isMetaProperty(arg.expression) &&
          arg.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
        const parent = node.parent;
        if (
          !localBase ||
          !(
            (ts.isCallExpression(parent) && parent.expression === node) ||
            (ts.isPropertyAccessExpression(parent) &&
              parent.expression === node &&
              parent.name.text === "resolve")
          )
        )
          issues.push(
            `${file}: unresolved createRequire loader could expose title-data`,
          );
      }
      if (ts.isCallExpression(node)) {
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require") ||
          factoryCall(node.expression)
        )
          add(
            node.arguments[0] ? constantText(node.arguments[0]) : undefined,
            true,
          );
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "resolve" &&
          factoryCall(node.expression.expression)
        )
          add(closedText(node.arguments[0]), true);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    edges.set(file, dependencies);
  }
  const reaches = (
    file: string,
    predicate: (file: string) => boolean,
    seen = new Set<string>(),
  ): boolean => {
    if (seen.has(file)) return false;
    seen.add(file);
    return (edges.get(file) ?? []).some(
      (target) => predicate(target) || reaches(target, predicate, seen),
    );
  };
  for (const file of files.keys()) {
    if (!hidden(file) && reaches(file, hidden))
      issues.push(
        `${file}: public module or barrel reaches hidden title-data${env.has(file) ? " behind an env gate" : ""}`,
      );
    if (
      hidden(file) &&
      (env.has(file) || reaches(file, (target) => env.has(target)))
    )
      issues.push(`${file}: title-data reaches an env gate`);
  }
  for (const file of files.keys())
    if (
      file.startsWith("packages/schema/src/internal/title-data/") &&
      reaches(file, (target) => target.startsWith("packages/render/src/"))
    )
      issues.push(`${file}: structural presentation depends on render`);
  return [...new Set(issues)].sort();
}
