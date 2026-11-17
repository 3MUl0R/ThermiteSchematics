// Fixed operations, never an exemption inferred from an arbitrary GitHub name.
export function githubRequest(event) {
  const name =
      event.tool ?? event.name?.split("__").at(-1)?.split(/[.:/]/).at(-1),
    input = event.input;
  const operation = name?.toLowerCase();
  const fields = {
    fetch: ["url", "prompt"],
    search_issues: ["query", "repository_full_name", "sort", "order", "topn"],
    issue_read: ["owner", "repo", "issue_number", "method", "page", "perPage"],
    pull_request_read: [
      "owner",
      "repo",
      "pullNumber",
      "method",
      "page",
      "perPage",
    ],
  };
  if (
    !Object.hasOwn(fields, operation ?? "") ||
    !input ||
    typeof input !== "object" ||
    !Object.keys(input).every((key) => fields[operation].includes(key))
  )
    return null;
  if (operation === "fetch")
    return { target: input?.url, headers: [], safe: true, network: true };
  if (operation === "search_issues")
    return {
      query: `${input?.repository_full_name ? `repo:${input.repository_full_name} ` : ""}${input?.query ?? ""}`,
    };
  if (
    !["issue_read", "pull_request_read"].includes(operation) ||
    !["get", "get_comments"].includes(input?.method)
  )
    return null;
  const number =
    operation === "issue_read" ? input.issue_number : input.pullNumber;
  if (
    !/^[1-9][0-9]*$/.test(String(number)) ||
    !/^[a-z0-9-]+$/i.test(input.owner ?? "") ||
    !/^[a-z0-9_.-]+$/i.test(input.repo ?? "")
  )
    return null;
  const path =
    input.method === "get_comments" || operation === "issue_read"
      ? "issues"
      : "pulls";
  return {
    target: `https://api.github.com/repos/${input.owner}/${input.repo}/${path}/${number}${input.method === "get_comments" ? "/comments" : ""}`,
    headers: [],
    safe: true,
    network: true,
  };
}
