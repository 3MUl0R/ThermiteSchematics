import {
  canonicalText,
  canonicalUrl,
  touchesGitHub,
} from "./github-canonical.mjs";
import { shellRequest } from "./github-shell.mjs";
import { issueSearch, issueUrl, jsonHeaders } from "./issue-lookup.mjs";
import { sourceScanInput } from "./source-scan-input.mjs";
import { readsLocalSource } from "./local-source.mjs";
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
function request(event) {
  const { name, input, lookupKind } = event;
  if (
    /^(?:webfetch|open_page|codex_apps\.github\.fetch)$/i.test(name) ||
    lookupKind === "fetch"
  )
    return {
      target: typeof input === "string" ? input : input?.url,
      headers: [],
      rest: "",
      safe: true,
    };
  if (
    /^(?:web_search|websearch|search|codex_apps\.github\.search_issues)$/i.test(
      name,
    )
  )
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
  if (shell) return shellRequest(text);
  // Other tools can name source files/URLs, but do not acquire an exemption.
  return { text };
}
function classifySearch(query, github, engineRoots) {
  const { text, valid } = canonicalText(query);
  if (readsLocalSource(text, engineRoots)) return "source-read";
  if (valid && issueSearch(text)) return "issue-lookup";
  return github || touchesGitHub(text) ? "source-read" : "other";
}
export function classifyToolCall(
  event,
  { engineRoots = [], allowedLibraryPaths = [] } = {},
) {
  if (/^(?:write|todowrite|todo_list)$/i.test(event.name))
    return { class: "other" };
  const call = request(event);
  const github = /(?:^|[._])github(?:[._]|$)/i.test(event.name);
  if (Object.hasOwn(call, "query"))
    return { class: classifySearch(call.query, github, engineRoots) };
  const canonical = canonicalUrl(call.target);
  const text =
    call.text === undefined ? canonical.text : canonicalText(call.text).text;
  const rest = canonicalText(call.rest).text;
  // Any residual access (including a second request) dominates an exemption.
  const local = readsLocalSource(call.text ?? call.target ?? "", engineRoots);
  const ghCommand = (text) =>
    /(?:^|[;&|\n])\s*(?:[^\s;&|]*\/)?gh\s+[a-z]/u.test(text);
  const residual = touchesGitHub(rest) || ghCommand(call.rest ?? rest);
  const touched =
    github ||
    touchesGitHub(text) ||
    touchesGitHub(canonical.url?.href ?? canonical.text) ||
    call.github ||
    ghCommand(call.text ?? text);
  if (!local && !residual && call.safe && canonical.valid && canonical.url) {
    if (jsonHeaders(call.headers) && issueUrl(canonical.url))
      return { class: "issue-lookup" };
    if (
      jsonHeaders(call.headers, true) &&
      allowedLibraryUrl(canonical.url, allowedLibraryPaths, call.target)
    )
      return { class: "other", libraryAcquisition: true };
  }
  return { class: local || touched || residual ? "source-read" : "other" };
}
