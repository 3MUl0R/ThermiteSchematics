import { acquisitionRequest } from "./acquisition-command.mjs";

const repositories = [
  "blackettapplied/thermiteschematics",
  "3mul0r/thermiteschematics",
];
const siteScopes = new Set(
  repositories.map((r) => `site:github.com/${r}/issues`),
);
const repoScopes = new Set(repositories.map((r) => `repo:${r}`));
const issueKinds = new Set(["is:issue", "is:pr"]);
const operators = new Set([
  ...siteScopes,
  ...repoScopes,
  ...issueKinds,
  "in:title,body,comments",
]);
const word = /^[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*$/u;
const booleans = new Set(["or", "and", "not"]);
const repository = "(?:blackettapplied|3mul0r)/thermiteschematics";
const webIssuePath = new RegExp(
  "^/" + repository + "/(?:issues(?:/[1-9][0-9]*)?|pull/[1-9][0-9]*)/?$",
);
const apiIssuePath = new RegExp(
  "^/repos/" +
    repository +
    "/(?:issues(?:/[1-9][0-9]*(?:/comments)?)?|pulls/[1-9][0-9]*)/?$",
);
const filters = {
  state: /^(?:open|closed|all)$/,
  page: /^[1-9][0-9]*$/,
  per_page: /^(?:[1-9][0-9]?|100)$/,
  sort: /^(?:created|updated|comments)$/,
  direction: /^(?:asc|desc)$/,
};

// Classification only; no normalization is executed as a shell command or URL.
function normalize(input) {
  if (typeof input !== "string") return null;
  try {
    let previous,
      value = input;
    do {
      previous = value;
      value = decodeURIComponent(value)
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\s+/gu, " ")
        .trim();
    } while (value !== previous);
    return value;
  } catch {
    return null;
  }
}

// Quotes are whole tokens, never a way to discard unparsed query text.
function tokenize(query) {
  const tokens = query.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
  return tokens.length && tokens.join(" ") === query ? tokens : null;
}
function plainTerm(token) {
  if (word.test(token)) return !booleans.has(token);
  if (!/^(["']).+\1$/u.test(token)) return false;
  return token
    .slice(1, -1)
    .split(" ")
    .every((term) => word.test(term));
}
function approvedIssueSearch(input) {
  const query = normalize(input);
  if (!query) return false;
  const tokens = tokenize(query);
  if (!tokens || !tokens.every((t) => operators.has(t) || plainTerm(t)))
    return false;
  const repo = tokens.some((t) => repoScopes.has(t));
  const kind = tokens.some((t) => issueKinds.has(t));
  return repo === kind && (repo || tokens.some((t) => siteScopes.has(t)));
}
function issueParameters(url) {
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (
      seen.has(key) ||
      !Object.hasOwn(filters, key) ||
      !filters[key].test(value)
    )
      return false;
    seen.add(key);
  }
  return /^(?:|#(?:issue-|issuecomment-|discussion_r)[1-9][0-9]*)$/.test(
    url.hash,
  );
}
function issueUrl(input) {
  const target = normalize(input);
  if (!target) return false;
  try {
    const url = new URL(target);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return false;
    const path =
      url.host === "github.com"
        ? webIssuePath.test(url.pathname)
        : url.host === "api.github.com" && apiIssuePath.test(url.pathname);
    return path && issueParameters(url);
  } catch {
    return false;
  }
}

// Search text and actual fetches have different allowlists.
export function approvedIssueLookup(input, { search = false } = {}) {
  if (search) return approvedIssueSearch(input);
  if (typeof input !== "string") return false;
  const request = acquisitionRequest(input);
  const target = request?.url ?? input;
  return issueUrl(
    request?.url.startsWith("repos/")
      ? "https://api.github.com/" + target
      : target,
  );
}
