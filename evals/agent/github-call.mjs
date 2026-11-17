import {
  canonicalText,
  canonicalUrl,
  touchesGitHub,
} from "./github-canonical.mjs";
import { shellRequest } from "./github-shell.mjs";
import { issueSearch, issueUrl, jsonHeaders } from "./issue-lookup.mjs";
import { sourceScanInput } from "./source-scan-input.mjs";
import { readsLocalSource } from "./local-source.mjs";
import { githubRequest } from "./github-tools.mjs";
import { allowedLibraryUrl } from "./library-acquisition.mjs";
export { pathText } from "./local-source.mjs";
export const strings = (value) =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];

// Extract actual request arguments, never display text or fetch prompts.
function request(event, github) {
  if (github)
    return (
      githubRequest(event) ?? {
        text: strings(event.input).join("\n"),
        network: true,
      }
    );
  const { name, input, lookupKind } = event;
  if (/^(?:webfetch|open_page)$/i.test(name) || lookupKind === "fetch")
    return {
      target: typeof input === "string" ? input : input?.url,
      headers: [],
      safe:
        typeof input === "string" ||
        (!!input &&
          Object.keys(input).every((key) => ["url", "prompt"].includes(key))),
      network: true,
    };
  if (/^(?:web_search|websearch|search)$/i.test(name))
    return {
      query:
        typeof input === "string"
          ? input
          : `${input?.repository_full_name ? `repo:${input.repository_full_name} ` : ""}${input?.query ?? ""}`,
    };
  const shell = /^(?:command_execution|bash|shell|exec_command)$/i.test(name);
  const values = strings(
    shell && input && typeof input === "object"
      ? (input.command ?? input.cmd)
      : input,
  );
  const text = sourceScanInput(name, values);
  if (shell) return { ...shellRequest(values.join("\n"), text), text };
  // Other tools can name source files/URLs, but do not acquire an exemption.
  return { text };
}
function classifySearch(query, github, engineRoots) {
  const { text, valid } = canonicalText(query);
  if (readsLocalSource(text, engineRoots)) return "source-read";
  if (valid && issueSearch(text)) return "issue-lookup";
  return github || touchesGitHub(text) ? "source-read" : "other";
}
/**
 * V8 measures honest agents' natural source-reading behavior; it is not a
 * sandbox. Plausible honest forms must be classified correctly. Anything not
 * fully understood never earns an issue exemption; if it might reach the
 * network it is a source read. Static commands cannot defeat deliberate
 * obfuscation in general. Opaque IPs, redirectors and novel encodings are limits;
 * they never earn an exemption. Runtime egress logging is the real adversarial
 * control, tracked separately by the helm, not implemented here. Stop at this
 * threat model: further obfuscated bypasses are follow-ups, not sandbox work.
 */
export function classifyToolCall(
  event,
  { engineRoots = [], allowedLibraryPaths = [] } = {},
) {
  const github = [event.name, event.server, event.tool].some(
    (value) => typeof value === "string" && /github/i.test(value),
  );
  if (!github && /^(?:write|todowrite|todo_list)$/i.test(event.name))
    return { class: "other" };
  const call = request(event, github);
  if (Object.hasOwn(call, "query"))
    return { class: classifySearch(call.query, github, engineRoots) };
  const canonical = canonicalUrl(call.target);
  const text =
    call.text === undefined ? canonical.text : canonicalText(call.text).text;
  const local = readsLocalSource(call.text ?? call.target ?? "", engineRoots);
  const understood = call.safe && canonical.valid && canonical.url;
  if (!local && understood) {
    if (jsonHeaders(call.headers) && issueUrl(canonical.url))
      return { class: "issue-lookup" };
    if (
      jsonHeaders(call.headers, true) &&
      allowedLibraryUrl(canonical.url, allowedLibraryPaths, call.target)
    )
      return { class: "other", libraryAcquisition: true };
  }
  const source =
    local ||
    github ||
    touchesGitHub(text) ||
    touchesGitHub(canonical.url?.href ?? canonical.text) ||
    (!understood && call.network);
  return { class: source ? "source-read" : "other" };
}
