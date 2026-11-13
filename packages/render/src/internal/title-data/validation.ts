import {
  appendJsonPointer,
  normalizeDiagnosticFile,
  type JsonPointerNodeMap,
  type JsonValue,
} from "@thermite/schema";
import { supportsGlyph } from "../../text-metrics.js";
import { bindings, slots, type TitleDiagnostic } from "./model.js";
import { parsePattern } from "./pattern.js";

export class Issues {
  readonly diagnostics: TitleDiagnostic[] = [];
  constructor(
    readonly file: string,
    readonly nodes: JsonPointerNodeMap = new Map(),
  ) {}
  add(
    code: TitleDiagnostic["code"],
    pointer: string,
    message: string,
    reason?: string,
  ): void {
    let anchor = pointer;
    while (!this.nodes.has(anchor) && anchor)
      anchor = anchor.slice(0, anchor.lastIndexOf("/"));
    const location = this.nodes.get(anchor)?.value;
    this.diagnostics.push({
      code,
      severity: "error",
      file: normalizeDiagnosticFile(this.file),
      line: location?.line ?? 1,
      column: location?.column ?? 1,
      jsonPointer: pointer,
      message,
      ...(reason
        ? code === "R006"
          ? { reason: "invalid-packet", details: { reason } }
          : { reason }
        : {}),
      ...(code === "R005"
        ? {
            ownerKind: "title-field" as const,
            ownerId: pointer,
            field: pointer,
          }
        : {}),
    });
  }
  sorted(): TitleDiagnostic[] {
    const seen = new Set<string>();
    return [...this.diagnostics]
      .sort(
        (a, b) =>
          a.line - b.line ||
          a.column - b.column ||
          (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
      )
      .filter((d) => {
        const key = JSON.stringify([d.code, d.file, d.jsonPointer]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
}
export function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0)
  );
}
export function checkText(
  value: string,
  pointer: string,
  issues: Issues,
): void {
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      /\p{Cc}|[\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/u.test(
        ch,
      ) ||
      (cp >= 0xd800 && cp <= 0xdfff)
    ) {
      issues.add(
        "R005",
        pointer,
        `Title field ${pointer} contains forbidden code point U+${cp.toString(16).toUpperCase()}.`,
        "forbidden-code-point",
      );
      return;
    }
    if (!supportsGlyph("sans", cp) || !supportsGlyph("bold", cp)) {
      issues.add(
        "R005",
        pointer,
        `Title field ${pointer} contains unsupported printable glyph U+${cp.toString(16).toUpperCase()}.`,
        "unsupported-glyph",
      );
      return;
    }
  }
  if (/<\/?[A-Za-z][^>]*>/u.test(value))
    issues.add(
      "E013",
      pointer,
      "Title text must be plain text, without markup.",
    );
}
export function checkStrings(
  value: JsonValue,
  pointer: string,
  issues: Issues,
): void {
  if (typeof value === "string") checkText(value, pointer, issues);
  else if (Array.isArray(value))
    value.forEach((v, i) =>
      checkStrings(v, appendJsonPointer(pointer, i), issues),
    );
  else if (isObject(value))
    for (const [k, v] of Object.entries(value)) {
      checkStrings(v, appendJsonPointer(pointer, k), issues);
    }
}
export function checkLiteral(
  value: unknown,
  slot: string,
  pointer: string,
  issues: Issues,
): void {
  if (typeof value !== "string") return;
  const limit =
    slot === "drawingNumber"
      ? 128
      : ["customer", "drawnBy", "checkedBy", "approvedBy"].includes(slot)
        ? 80
        : slot === "revision"
          ? 128
          : 160;
  if (!value.trim() || [...value].length > limit)
    issues.add(
      "E013",
      pointer,
      `Title ${slot} must be nonblank and at most ${limit} code points.`,
    );
  if (slot === "date" && !validDate(value))
    issues.add(
      "E013",
      pointer,
      "Title date must be a valid Gregorian YYYY-MM-DD date.",
    );
}
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
  if (field.missing !== undefined && key === "revision")
    issues.add(
      "E013",
      `${pointer}/missing`,
      "Unknown revision must display UNSPECIFIED.",
    );
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
  const tb = value.titleBlock;
  if (!isObject(tb)) return;
  if (Array.isArray(tb.lines))
    tb.lines.forEach((v, i) =>
      checkLiteral(v, "line", `/titleBlock/lines/${i}`, issues),
    );
  if (!isObject(tb.fields)) return;
  if (Object.keys(tb.fields).length > 14)
    issues.add(
      "E015",
      "/titleBlock/fields",
      "At most 14 title fields are allowed.",
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
export function checkTitleRecord(
  record: Record<string, JsonValue>,
  pointer: string,
  issues: Issues,
): void {
  checkLiteral(
    record.sheetTitle,
    "sheetTitle",
    `${pointer}/sheetTitle`,
    issues,
  );
  checkLiteral(record.revision, "revision", `${pointer}/revision`, issues);
  checkLiteral(
    record.drawingBase,
    "drawingNumber",
    `${pointer}/drawingBase`,
    issues,
  );
  if (isObject(record.values))
    for (const [key, value] of Object.entries(record.values)) {
      const p = appendJsonPointer(`${pointer}/values`, key);
      if (
        !slots.includes(key as (typeof slots)[number]) ||
        Object.hasOwn(bindings, key)
      )
        issues.add(
          "R006",
          p,
          "Packet values must name an ordinary title field; bound project/page/title/revision fields cannot be overridden here.",
          "unknown-title-field",
        );
      checkLiteral(value, key, p, issues);
    }
  if (Array.isArray(record.revisionRows))
    record.revisionRows.forEach((row, i) => {
      if (!isObject(row)) return;
      const p = `${pointer}/revisionRows/${i}`;
      checkLiteral(row.version, "version", `${p}/version`, issues);
      checkLiteral(row.date, "date", `${p}/date`, issues);
      checkLiteral(row.drawnBy, "drawnBy", `${p}/drawnBy`, issues);
    });
}
export function checkTitleData(
  value: Record<string, JsonValue>,
  viewCount: number,
  issues: Issues,
): void {
  if (isObject(value.defaults))
    checkTitleRecord(value.defaults, "/titleData/defaults", issues);
  for (const selector of ["byView", "bySheet"] as const) {
    const entries = value[selector];
    if (!Array.isArray(entries)) continue;
    const used = new Set<JsonValue>();
    entries.forEach((entry, i) => {
      if (!isObject(entry)) return;
      const p = `/titleData/${selector}/${i}`;
      checkTitleRecord(entry, p, issues);
      const selected = selector === "byView" ? entry.viewIndex : entry.sheetKey;
      if (used.has(selected ?? null))
        issues.add(
          "R006",
          p,
          "Duplicate title selector.",
          "duplicate-title-slot",
        );
      used.add(selected ?? null);
      if (
        selector === "byView" &&
        typeof selected === "number" &&
        selected > viewCount
      )
        issues.add(
          "R006",
          `${p}/viewIndex`,
          "Unused authored-view selector.",
          "unresolved-sheet-key",
        );
    });
  }
}
