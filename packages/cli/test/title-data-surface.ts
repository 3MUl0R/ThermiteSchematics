import ts from "typescript";
import { posix } from "node:path";
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
  const scoped = /^@thermite\/([^/]+)(?:\/(.*))?$/u.exec(specifier);
  let path = scoped
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
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      )
        add(
          node.arguments[0] ? constantText(node.arguments[0]) : undefined,
          true,
        );
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
