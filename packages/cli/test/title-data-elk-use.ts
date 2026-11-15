import ts from "typescript";
import { permittedExternalMember } from "./title-data-elk-globals.js";
import { deniedMemberNames } from "./title-data-elk-slots.js";
import { elkText } from "./title-data-elk-keys.js";
import { elkIssue } from "./title-data-elk-policy.js";
import type { ElkPermissions } from "./title-data-elk-imports.js";

interface MemberUse {
  key: string;
  symbol: ts.Symbol | undefined;
}
type Text = (node: ts.Expression | undefined) => string | undefined;
function keyOf(name: ts.PropertyName | ts.BindingName, text: Text) {
  return ts.isComputedPropertyName(name)
    ? text(name.expression)
    : ts.isIdentifier(name) ||
        ts.isStringLiteralLike(name) ||
        ts.isNumericLiteral(name)
      ? name.text
      : undefined;
}
function propertyUses(
  node: ts.Node,
  checker: ts.TypeChecker,
  text: Text,
): MemberUse[] {
  let uses: MemberUse[] = [];
  if (ts.isPropertyAccessExpression(node))
    uses = [
      { key: node.name.text, symbol: checker.getSymbolAtLocation(node.name) },
    ];
  if (ts.isElementAccessExpression(node)) {
    const key = text(node.argumentExpression);
    if (key !== undefined)
      uses = [
        {
          key,
          symbol: checker.getPropertyOfType(
            checker.getNonNullableType(
              checker.getTypeAtLocation(node.expression),
            ),
            key,
          ),
        },
      ];
  }
  return uses;
}
function bindingUses(
  node: ts.Node,
  checker: ts.TypeChecker,
  text: Text,
): MemberUse[] {
  let uses: MemberUse[] = [];
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const type = checker.getNonNullableType(
      checker.getTypeAtLocation(node.parent),
    );
    const key = keyOf(node.propertyName ?? node.name, text);
    uses = node.dotDotDotToken
      ? checker
          .getPropertiesOfType(type)
          .map((symbol) => ({ key: symbol.name, symbol }))
      : key === undefined
        ? []
        : [{ key, symbol: checker.getPropertyOfType(type, key) }];
  }
  return uses;
}
function assignmentUses(
  node: ts.Node,
  checker: ts.TypeChecker,
  text: Text,
): MemberUse[] {
  let uses: MemberUse[] = [];
  if (
    (ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isSpreadAssignment(node)) &&
    ts.isObjectLiteralExpression(node.parent)
  ) {
    const assignment = node.parent.parent;
    if (
      ts.isBinaryExpression(assignment) &&
      assignment.left === node.parent &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const type = checker.getNonNullableType(
        checker.getTypeAtLocation(assignment.right),
      );
      if (ts.isSpreadAssignment(node))
        uses = checker
          .getPropertiesOfType(type)
          .map((symbol) => ({ key: symbol.name, symbol }));
      else {
        const key = keyOf(node.name, text);
        if (key !== undefined)
          uses = [
            {
              key,
              symbol: checker.getPropertyOfType(type, key),
            },
          ];
      }
    }
  }
  return uses;
}
// Local and merged declarations cannot acquire an external member's admission.
export function deniedMemberUse(
  key: string,
  symbol: ts.Symbol | undefined,
  denied: ReadonlySet<string>,
) {
  return denied.has(key) && !permittedExternalMember(symbol);
}
export function elkUseSiteAudit(
  tree: ts.SourceFile,
  checker: ts.TypeChecker,
  permissions: ElkPermissions,
  issues: string[],
) {
  const denied = deniedMemberNames(tree, checker, permissions),
    text = elkText(checker);
  return (node: ts.Node) => {
    const uses = [
      ...propertyUses(node, checker, text),
      ...bindingUses(node, checker, text),
      ...assignmentUses(node, checker, text),
    ];
    for (const { key, symbol } of uses)
      if (deniedMemberUse(key, symbol, denied))
        elkIssue(issues, "forbidden ELK denied member use: " + key);
  };
}
