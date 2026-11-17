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
const repository = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/[a-z0-9_][a-z0-9_.-]*";
const webIssuePath = new RegExp(
  "^/" + repository + "/(?:issues(?:/[1-9][0-9]*)?|pull/[1-9][0-9]*)/?$",
);
const apiIssuePath = new RegExp(
  "^/repos/" +
    repository +
    "/(?:issues(?:/[1-9][0-9]*(?:/comments)?|/comments(?:/[1-9][0-9]*)?)?|pulls/[1-9][0-9]*)/?$",
);
const filters = {
  state: /^(?:open|closed|all)$/,
  page: /^[1-9][0-9]*$/,
  per_page: /^(?:[1-9][0-9]?|100)$/,
  sort: /^(?:created|updated|comments)$/,
  direction: /^(?:asc|desc)$/,
};

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
export function issueSearch(query) {
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
export function issueUrl(url) {
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
}
export function jsonHeaders(headers = [], library = false) {
  return headers.every(
    (header) =>
      /^accept:\s*(?:application\/json|application\/vnd\.github\+json)\s*$/i.test(
        header,
      ) ||
      (library &&
        /^accept:\s*application\/vnd\.github\.raw\+json\s*$/i.test(header)),
  );
}
