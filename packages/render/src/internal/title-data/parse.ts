import {
  createAjv2020,
  parseJson,
  validateJsonValue,
  type JsonValue,
} from "@thermite/schema";
import { packetSchema, presentationSchema } from "./schema.js";
import {
  Issues,
  checkPresentation,
  checkStrings,
  checkTitleData,
  isObject,
} from "./validation.js";
import type { PacketRequest, Presentation, Result } from "./model.js";

const ajv = createAjv2020();
ajv.opts.allowUnionTypes = true;
const validatePresentation = ajv.compile(presentationSchema);
const validatePacket = ajv.compile(packetSchema);
export const PRESENTATION_BYTE_LIMIT = 64 * 1024;
function decode(
  input: string | Uint8Array,
  issues: Issues,
): string | undefined {
  if (typeof input === "string") return input;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      input,
    );
  } catch {
    issues.add("E002", "", "Input is not strict UTF-8.");
    return undefined;
  }
}
function parse<T>(
  input: string | Uint8Array,
  file: string,
  presentation: boolean,
): Result<T> {
  const initial = new Issues(file);
  const bytes =
    typeof input === "string"
      ? Buffer.byteLength(input, "utf8")
      : input.byteLength;
  if (presentation && bytes > PRESENTATION_BYTE_LIMIT) {
    initial.add("E015", "", "Presentation exceeds 64 KiB.");
    return { diagnostics: initial.sorted() };
  }
  const text = decode(input, initial);
  if (text === undefined) return { diagnostics: initial.sorted() };
  const parsed = parseJson(text, file);
  if (parsed.diagnostics.length || parsed.value === undefined)
    return { diagnostics: parsed.diagnostics };
  const issues = new Issues(file, parsed.nodes);
  issues.diagnostics.push(
    ...validateJsonValue(
      presentation ? validatePresentation : validatePacket,
      parsed.value,
      { file, nodes: parsed.nodes },
    ),
  );
  if (isObject(parsed.value)) {
    if (presentation) {
      checkStrings(parsed.value, "", issues);
      checkPresentation(parsed.value, issues);
    } else {
      // Existing per-view selection/validation remains owned by the dispatcher.
      // This internal parser only adds a strict packet envelope and title data.
      checkPacketEnvelope(parsed.value, issues);
      if (isObject(parsed.value.titleData)) {
        checkStrings(parsed.value.titleData, "/titleData", issues);
        checkTitleData(
          parsed.value.titleData,
          Array.isArray(parsed.value.views) ? parsed.value.views.length : 0,
          issues,
        );
      }
    }
  }
  const diagnostics = issues.sorted();
  return diagnostics.length
    ? { diagnostics }
    : { value: parsed.value as T, diagnostics };
}
function checkPacketEnvelope(
  value: Record<string, JsonValue>,
  issues: Issues,
): void {
  const refs = value.references;
  const malformedRefs =
    isObject(refs) &&
    (!Object.keys(refs).length ||
      Object.keys(refs).some((k) => !["filter", "appearances"].includes(k)) ||
      (refs.appearances !== undefined &&
        !["all", "drawings"].includes(String(refs.appearances))));
  if (
    refs !== undefined &&
    (value.index !== true || refs === true || malformedRefs)
  ) {
    issues.add(
      "R006",
      "/references",
      "Reference options require index: true and false or filter/appearances settings.",
      "invalid-packet",
    );
  }
  if (Array.isArray(value.views))
    value.views.forEach((view, i) => {
      if (isObject(view) && Object.hasOwn(view, "page"))
        issues.add(
          "R006",
          `/views/${i}/page`,
          "Individual views cannot override the packet page.",
          "invalid-packet",
        );
    });
}
export function parseInternalPresentation(
  input: string | Uint8Array,
  file = "presentation.json",
): Result<Presentation> {
  return parse(input, file, true);
}
export function parseInternalPacket(
  input: string | Uint8Array,
  file = "packet.json",
): Result<PacketRequest> {
  return parse(input, file, false);
}
