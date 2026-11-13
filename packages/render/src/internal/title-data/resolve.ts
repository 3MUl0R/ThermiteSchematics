import { appendJsonPointer } from "@thermite/schema";
import {
  bindings,
  slots,
  type Fact,
  type Field,
  type FinalSheet,
  type PacketRequest,
  type Presentation,
  type ResolvedField,
  type ResolvedTitle,
  type Result,
  type RevisionRow,
  type Slot,
  type Source,
  type TitleRecord,
} from "./model.js";
import { expandPattern, parsePattern } from "./pattern.js";
import { sheetKey } from "./sheet-key.js";
import { Issues, checkLiteral, checkText } from "./validation.js";

const labels: Record<Slot, string> = {
  project: "Project",
  sheetTitle: "Sheet title",
  drawingNumber: "DWG NO",
  customer: "Customer",
  drawnBy: "Drawn by",
  date: "Date",
  checkedBy: "Checked by",
  approvedBy: "Approved by",
  revision: "REV",
  sheetNumber: "Sheet",
};
const unknown = <T>(
  source: Source | null = null,
  pointer: string | null = null,
): Fact<T> => ({ value: null, known: false, source, pointer });
function fact(
  value: string | null | undefined,
  source: Source,
  pointer: string,
): Fact<string> {
  return value === undefined
    ? unknown()
    : value === null || !value.trim()
      ? unknown(source, pointer)
      : { value, known: true, source, pointer };
}
interface State {
  values: Map<string, Fact<string>>;
  title: Fact<string>;
  revision: Fact<string>;
  history: Fact<readonly RevisionRow[]>;
  base: Fact<string>;
}
function initial(presentation: Presentation): State {
  return {
    values: new Map(),
    title: unknown(),
    revision: fact(presentation.revision, "presentation", "/revision"),
    history: unknown(),
    base: unknown(),
  };
}
function overlay(
  state: State,
  record: TitleRecord | undefined,
  source: Source,
  pointer: string,
): void {
  if (!record) return;
  for (const [k, v] of Object.entries(record.values ?? {}))
    state.values.set(
      k,
      fact(v, source, appendJsonPointer(`${pointer}/values`, k)),
    );
  if (record.sheetTitle !== undefined)
    state.title = fact(record.sheetTitle, source, `${pointer}/sheetTitle`);
  if (record.revision !== undefined)
    state.revision = fact(record.revision, source, `${pointer}/revision`);
  if (record.revisionRows !== undefined)
    state.history = {
      value: record.revisionRows,
      known: record.revisionRows.length > 0,
      source,
      pointer: `${pointer}/revisionRows`,
    };
}
function fieldsFor(presentation: Presentation): readonly [string, Field][] {
  return slots.map((slot) => {
    const binding = bindings[slot as keyof typeof bindings];
    return [
      slot,
      presentation.titleBlock?.fields?.[slot] ?? {
        slot,
        label: labels[slot],
        ...(binding ? { bind: binding } : {}),
      },
    ];
  });
}
function resolveField(
  key: string,
  field: Field,
  state: State,
  project: string,
  sheet: FinalSheet,
  number: number,
  total: number,
  issues: Issues,
): ResolvedField {
  const pointer = appendJsonPointer("/titleBlock/fields", key);
  let result =
    state.values.get(key) ??
    fact(field.value, "presentation", `${pointer}/value`);
  if (field.bind === "project.name") result = fact(project, "project", "/name");
  if (field.bind === "sheet.title")
    result =
      state.title.source === null
        ? fact(sheet.title, "title", "/title")
        : state.title;
  if (field.bind === "sheet.revision") result = state.revision;
  if (field.bind === "sheet.numberOfTotal")
    result = fact(`${number} of ${total}`, "page", "/numberOfTotal");
  if (field.pattern !== undefined && !state.values.has(key)) {
    const tokens = parsePattern(field.pattern);
    const expanded = tokens
      ? expandPattern(tokens, state.base, number, total)
      : null;
    result = {
      ...fact(expanded, "presentation", `${pointer}/pattern`),
      inputs: [
        state.base,
        fact(String(number), "page", "/sheetNumber"),
        fact(String(total), "page", "/sheetTotal"),
      ],
    };
    if (expanded !== null && [...expanded].length > 160)
      issues.add(
        "E013",
        `${pointer}/pattern`,
        `Drawing-number expansion exceeds 160 code points on sheet ${number} (${sheet.title}).`,
      );
  }
  if (key === "revision" && result.value === "UNSPECIFIED")
    result = { ...result, known: false };
  if (result.value !== null) {
    checkText(result.value, `${pointer}/resolved`, issues);
    if (field.pattern === undefined || state.values.has(key))
      checkLiteral(result.value, key, `${pointer}/resolved`, issues);
  }
  return {
    key,
    slot: field.slot,
    label: field.label,
    fact: result,
    text: result.known
      ? (result.value ?? "")
      : key === "revision"
        ? "UNSPECIFIED"
        : "",
  };
}
function authoredViewIndex(sheet: FinalSheet): number | undefined {
  return sheet.identity.kind === "view" || sheet.identity.kind === "document"
    ? sheet.viewIndex
    : undefined;
}
function validateSheets(
  request: PacketRequest,
  sheets: readonly FinalSheet[],
  issues: Issues,
): void {
  if (!sheets.length || sheets.length > 100)
    issues.add(
      "R006",
      "",
      "A packet must contain 1–100 final sheets.",
      "invalid-packet",
    );
  const keys = new Set<string>();
  for (const sheet of sheets) {
    if (
      !Number.isInteger(sheet.partIndex) ||
      !Number.isInteger(sheet.partTotal) ||
      sheet.partIndex < 1 ||
      sheet.partTotal < sheet.partIndex ||
      sheet.partTotal > 100
    )
      issues.add(
        "R006",
        "",
        "Invalid final-sheet part index/total.",
        "unresolved-sheet-key",
      );
    const key = sheetKey(sheet);
    if (keys.has(key))
      issues.add(
        "R006",
        "",
        "Duplicate final-sheet identity.",
        "unresolved-sheet-key",
      );
    keys.add(key);
  }
  request.titleData?.bySheet?.forEach((entry, i) => {
    if (!keys.has(entry.sheetKey))
      issues.add(
        "R006",
        `/titleData/bySheet/${i}/sheetKey`,
        "Exact sheet key is unresolved; pagination may have changed. Preview and review the final sheets again.",
        "unresolved-sheet-key",
      );
  });
  request.titleData?.byView?.forEach((entry, i) => {
    if (!sheets.some((s) => authoredViewIndex(s) === entry.viewIndex))
      issues.add(
        "R006",
        `/titleData/byView/${i}/viewIndex`,
        "Authored-view selector has no final sheet.",
        "unresolved-sheet-key",
      );
  });
}
function resolveHistory(state: State) {
  return (state.history.value ?? []).map((row, rowIndex) => {
    const source = state.history.source;
    const cell = (name: keyof RevisionRow) =>
      source === null
        ? unknown<string>()
        : fact(
            row[name],
            source,
            `${state.history.pointer}/${rowIndex}/${name}`,
          );
    return {
      version: cell("version"),
      comment: cell("comment"),
      date: cell("date"),
      drawnBy: cell("drawnBy"),
    };
  });
}
/** Pure final-sheet resolution. Call only with successfully parsed internal inputs.
 * No clock, environment, path, git, user identity or electrical facts are read. */
export function resolveTitles(
  presentation: Presentation,
  request: PacketRequest,
  projectName: string,
  sheets: readonly FinalSheet[],
): Result<readonly ResolvedTitle[]> {
  const issues = new Issues("packet.json");
  validateSheets(request, sheets, issues);
  if (issues.diagnostics.length) return { diagnostics: issues.sorted() };
  const value = sheets.map((sheet, i): ResolvedTitle => {
    const state = initial(presentation);
    const defaults = request.titleData?.defaults;
    overlay(state, defaults, "request-defaults", "/titleData/defaults");
    if (defaults?.drawingBase !== undefined)
      state.base = fact(
        defaults.drawingBase,
        "request-defaults",
        "/titleData/defaults/drawingBase",
      );
    const viewIndex =
      request.titleData?.byView?.findIndex(
        (r) => r.viewIndex === authoredViewIndex(sheet),
      ) ?? -1;
    overlay(
      state,
      viewIndex < 0 ? undefined : request.titleData?.byView?.[viewIndex],
      "request-view",
      `/titleData/byView/${viewIndex}`,
    );
    const key = sheetKey(sheet);
    const exactIndex =
      request.titleData?.bySheet?.findIndex((r) => r.sheetKey === key) ?? -1;
    overlay(
      state,
      exactIndex < 0 ? undefined : request.titleData?.bySheet?.[exactIndex],
      "request-sheet",
      `/titleData/bySheet/${exactIndex}`,
    );
    const fields = fieldsFor(presentation).map(([k, field]) =>
      resolveField(
        k,
        field,
        state,
        projectName,
        sheet,
        i + 1,
        sheets.length,
        issues,
      ),
    );
    return {
      sheetKey: key,
      fields,
      revisionRows: state.history,
      history: resolveHistory(state),
    };
  });
  return issues.diagnostics.length
    ? { diagnostics: issues.sorted() }
    : { value, diagnostics: [] };
}
