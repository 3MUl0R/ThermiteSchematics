import { appendJsonPointer } from "../../json-pointer.js";
import type { JsonValue } from "../../parser.js";
import { bindings, slots } from "./model.js";
import { parsePattern } from "./pattern.js";
import { Issues, checkLiteral, isObject } from "./validation-common.js";
function checkField(
  key: string,
  field: Record<string, JsonValue>,
  pointer: string,
  issues: Issues,
): void {
  const slot = field.slot;
  if (!slots.includes(key as (typeof slots)[number]) || slot !== key)
    issues.add(
      "E013",
      pointer,
      "Built-in title keys must match their slot; compact has no extra slots.",
    );
  const mechanisms = ["value", "bind", "pattern"].filter((k) =>
    Object.hasOwn(field, k),
  );
  if (mechanisms.length > 1)
    issues.add(
      "E013",
      pointer,
      "Title value, bind and pattern are mutually exclusive.",
    );
  const binding = bindings[key as keyof typeof bindings];
  if (binding && field.bind !== binding)
    issues.add("E013", pointer, `Title ${key} requires binding ${binding}.`);
  if (!binding && field.bind !== undefined)
    issues.add("E013", `${pointer}/bind`, "This slot has no binding.");
  if (field.pattern !== undefined && key !== "drawingNumber")
    issues.add(
      "E013",
      `${pointer}/pattern`,
      "Patterns are allowed only for drawingNumber.",
    );
  if (typeof field.pattern === "string" && !parsePattern(field.pattern))
    issues.add(
      "E013",
      `${pointer}/pattern`,
      "Malformed drawing-number pattern.",
    );
  if (typeof field.label === "string" && !field.label.trim())
    issues.add("E013", `${pointer}/label`, "Title labels must be nonblank.");
  checkLiteral(field.value, key, `${pointer}/value`, issues);
}
export function checkPresentation(
  value: Record<string, JsonValue>,
  issues: Issues,
): void {
  checkLiteral(value.revision, "revision", "/revision", issues);
  const header = isObject(value.frame) ? value.frame.header : undefined;
  if (
    isObject(header) &&
    typeof header.text === "string" &&
    !header.text.trim()
  )
    issues.add("E013", "/frame/header/text", "Title header must be nonblank.");
  const tb = value.titleBlock;
  if (!isObject(tb)) return;
  if (Array.isArray(tb.lines))
    tb.lines.forEach((v, i) =>
      checkLiteral(v, "line", `/titleBlock/lines/${i}`, issues),
    );
  if (!isObject(tb.fields)) return;
  if (Object.keys(tb.fields).length > slots.length)
    issues.add(
      "E015",
      "/titleBlock/fields",
      "Compact has at most ten fixed title fields.",
    );
  const used = new Set<JsonValue>();
  for (const [key, field] of Object.entries(tb.fields))
    if (isObject(field)) {
      const pointer = appendJsonPointer("/titleBlock/fields", key);
      if (used.has(field.slot ?? null))
        issues.add("E013", `${pointer}/slot`, "Duplicate title slot.");
      used.add(field.slot ?? null);
      checkField(key, field, pointer, issues);
    }
}
