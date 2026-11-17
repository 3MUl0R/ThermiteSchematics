import { acquisitionRequest } from "./acquisition-command.mjs";
// The project guide requires checking public issues; this is not engine source.
export function approvedIssueLookup(input, { search = false } = {}) {
  const request = acquisitionRequest(input);
  if (!request) return search && approvedIssueSearch(input);
  return issueUrl(request.url);
}
function approvedIssueSearch(input) {
  if (
    !/^site:(?:https?:\/\/)?github\.com\/(?:BlackettApplied|3MUl0R)\/ThermiteSchematics\/issues(?:\/[1-9][0-9]*)?(?=\s|$)/i.test(
      input,
    )
  )
    return false;
  const targets =
    input.match(
      /(?:site:(?:https?:\/\/)?|https?:\/\/)?github\.com\/[^\s"'()]+|repo:[^\s"'()]+/gi,
    ) ?? [];
  return (
    targets.length > 0 &&
    targets.every((t) =>
      issueUrl(t.replace(/^site:/i, "").replace(/^(?!https?:)/i, "https://")),
    )
  );
}
function issueUrl(target) {
  try {
    const url = new URL(
      target.startsWith("repos/") ? "https://api.github.com/" + target : target,
    );
    if (url.username || url.password) return false;
    const repository = "(?:BlackettApplied|3MUl0R)/ThermiteSchematics";
    if (url.hostname === "github.com")
      return new RegExp(
        "^/" + repository + "/issues(?:/[1-9][0-9]*)?/?$",
        "i",
      ).test(url.pathname);
    if (url.hostname === "api.github.com")
      return new RegExp(
        "^/repos/" + repository + "/issues(?:/[1-9][0-9]*(?:/comments)?)?/?$",
        "i",
      ).test(url.pathname);
    return false;
  } catch {
    return false;
  }
}
