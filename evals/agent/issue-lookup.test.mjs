import { expect, it } from "vitest";
import { score } from "./score-log.mjs";
import { classifyToolCall } from "./github-call.mjs";
const approvedIssueLookup = (input, { search = false } = {}) =>
  classifyToolCall({ name: search ? "web_search" : "open_page", input })
    .class === "issue-lookup";
const metric = (command) =>
  score({
    engineRoots: ["/engine"],
    transcript: [
      {
        type: "item.completed",
        item: { id: "c", type: "command_execution", command, exit_code: 0 },
      },
    ],
  });
const metricQuery = (query) =>
  score({
    transcript: [
      {
        type: "item.started",
        item: { id: "s", type: "web_search", query: "" },
      },
      { type: "item.completed", item: { id: "s", type: "web_search", query } },
    ],
  });
it("keeps guide-required read-only issue context separate from source rescue", () => {
  for (const command of [
    `curl --fail 'https://api.github.com/repos/BlackettApplied/ThermiteSchematics/issues?state=open&per_page=100' -o issues.json`,
    `gh api --method GET 'repos/BlackettApplied/ThermiteSchematics/issues?state=open&per_page=100' > issues.json`,
    `gh api 'repos/3MUl0R/ThermiteSchematics/issues/367/comments'`,
  ]) {
    expect(metric(command).sourceReads, command).toBe(0);
    expect(metric(command).issueLookups).toHaveLength(1);
  }
  const transcript = [
    { type: "item.started", item: { id: "w", type: "web_search", query: "" } },
    {
      type: "item.completed",
      item: {
        id: "w",
        type: "web_search",
        action: {
          type: "open_page",
          url: "https://github.com/BlackettApplied/ThermiteSchematics/issues/367",
        },
      },
    },
  ];
  expect(score({ transcript }).sourceReads).toBe(0);
  expect(score({ transcript }).issueLookups).toHaveLength(1);
});
it("retains engine code, docs, clone/search and write-request negatives", () => {
  for (const command of [
    `curl 'https://api.github.com/repos/BlackettApplied/ThermiteSchematics/contents/packages/compiler/src/index.ts'`,
    `curl 'https://github.com/BlackettApplied/ThermiteSchematics/blob/dev/docs/modeling.md'`,
    `curl 'https://api.github.com/repos/BlackettApplied/ThermiteSchematics/issues/../contents/packages/query/src/index.ts'`,
    `gh api --method POST 'repos/BlackettApplied/ThermiteSchematics/issues'`,
    `curl -X PATCH 'https://api.github.com/repos/BlackettApplied/ThermiteSchematics/issues/367'`,
    `curl 'https://github.com/BlackettApplied/ThermiteSchematics/pull/372/files'`,
    `gh repo clone BlackettApplied/ThermiteSchematics`,
    `gh search code repo:BlackettApplied/ThermiteSchematics`,
    `gh api graphql -f 'query={repository(owner:"BlackettApplied",name:"ThermiteSchematics"){object(expression:"HEAD:packages/compiler/src/index.ts"){id}}}'`,
    `curl 'https://api.github.com/repos/BlackettApplied/ThermiteSchematics/issues' -o issues.json && cat /engine/source.ts`,
  ]) {
    expect(metric(command).sourceReads, command).toBe(1);
    expect(metric(command).issueLookups, command).toHaveLength(0);
  }
});

it("native searches distinguish issue-only context from code/repository queries", () => {
  const issue = metricQuery(
    "site:github.com/BlackettApplied/ThermiteSchematics/issues Thermite",
  );
  expect(issue.sourceReads).toBe(0);
  expect(issue.issueLookups).toHaveLength(1);
  for (const query of [
    "site:github.com/BlackettApplied/ThermiteSchematics/packages/compiler compileProject",
    "repo:BlackettApplied/ThermiteSchematics compileProject",
    "site:github.com/BlackettApplied/ThermiteSchematics/issues OR site:github.com/BlackettApplied/ThermiteSchematics/packages/compiler",
  ])
    expect(metricQuery(query).sourceReads, query).toBe(1);
});

const issueSite = "site:github.com/3MUl0R/ThermiteSchematics/issues";
it.each([
  [
    "reviewer raw",
    "https://raw.githubusercontent.com/3MUl0R/ThermiteSchematics/main/packages/compiler/src/index.ts",
  ],
  ["reviewer clone", "git@github.com:3MUl0R/ThermiteSchematics.git"],
  [
    "raw",
    "https://raw.githubusercontent.com/BlackettApplied/ThermiteSchematics/dev/packages/query/src/index.ts",
  ],
  ["raw host", "raw.githubusercontent.com"],
  [
    "blob",
    "https://github.com/BlackettApplied/ThermiteSchematics/blob/dev/docs/modeling.md",
  ],
  ["tree", "github.com/3MUl0R/ThermiteSchematics/tree/dev/packages"],
  ["commit", "https://github.com/3MUl0R/ThermiteSchematics/commit/fac3c43"],
  [
    "commits",
    "https://github.com/BlackettApplied/ThermiteSchematics/commits/dev",
  ],
  ["dot-git", "https://github.com/BlackettApplied/ThermiteSchematics.git"],
  ["git-at", "git@github.com:BlackettApplied/ThermiteSchematics.git"],
  ["other git-at host", "git@gitlab.example:review/source.git"],
  ["ssh clone", "ssh://git@github.com/3MUl0R/ThermiteSchematics"],
  ["git clone", "git://github.com/3MUl0R/ThermiteSchematics.git"],
  [
    "archive",
    "https://github.com/3MUl0R/ThermiteSchematics/archive/refs/heads/dev.tar.gz",
  ],
  [
    "zip",
    "https://codeload.github.com/BlackettApplied/ThermiteSchematics/zip/refs/heads/dev",
  ],
  ["mirror zip", "https://source.example/review/source.zip"],
  [
    "mirror tree",
    "sourcegraph.com/github.com/3MUl0R/ThermiteSchematics/-/tree/packages",
  ],
  ["repository qualifier", "repo:3MUl0R/ThermiteSchematics"],
  [
    "bare repository path",
    "3MUl0R/ThermiteSchematics/packages/query/src/index.ts",
  ],
  [
    "nested query URL",
    "https://github.com/3MUl0R/ThermiteSchematics/issues/367?source=https://raw.githubusercontent.com/3MUl0R/ThermiteSchematics/dev/packages/query/src/index.ts",
  ],
  [
    "nested fragment URL",
    "https://github.com/3MUl0R/ThermiteSchematics/issues/367#https://github.com/3MUl0R/ThermiteSchematics/tree/dev",
  ],
])(
  "issue-search exemption refuses %s repository references",
  (_form, reference) => {
    expect(
      approvedIssueLookup(`${issueSite} ${reference}`, { search: true }),
    ).toBe(false);
    const result = metricQuery(`${issueSite} ${reference}`);
    expect(result.sourceReads).toBe(1);
    expect(result.issueLookups).toHaveLength(0);
    expect(result.violations.filter((v) => v.rule === "V8")).toHaveLength(1);
  },
);

it.each([
  `${issueSite} Thermite`,
  "site:github.com/BlackettApplied/ThermiteSchematics/issues Thermite",
])("issue-only search stays an issue lookup: %s", (query) => {
  const result = metricQuery(query);
  expect(result.sourceReads).toBe(0);
  expect(result.issueLookups).toHaveLength(1);
});

it("a raw repository URL alone remains exactly one source read", () => {
  const result = metricQuery(
    "https://raw.githubusercontent.com/3MUl0R/ThermiteSchematics/main/packages/compiler/src/index.ts",
  );
  expect(result.sourceReads).toBe(1);
  expect(result.issueLookups).toHaveLength(0);
});

const repoSlug = "BlackettApplied/ThermiteSchematics";
const issuesBase = `https://api.github.com/repos/${repoSlug}/issues`;
const searchBase = "https://api.github.com/search/issues";

it.each([
  ["issues", `${issuesBase}?state=open&per_page=100`],
  ["search/issues", `${searchBase}?q=repo:${repoSlug}+is:issue+foo`],
])("E2 1.20.11 applies the same output policy to %s", (_endpoint, url) => {
  for (const command of [
    `curl -s '${url}' -o issues.json`,
    `curl -s '${url}' -o /tmp/x`,
    `curl -s '${url}' > drawings/issues.json`,
    `wget -qO- '${url}'`,
    `wget '${url}'`,
    `wget -qO issues.json '${url}'`,
  ]) {
    const result = metric(command);
    expect(result.sourceReads, command).toBe(0);
    expect(result.issueLookups, command).toHaveLength(1);
    expect(
      result.violations.filter((v) => v.rule === "V8"),
      command,
    ).toHaveLength(0);
  }
  const remoteName = metric(`curl -s -O '${url}'`);
  expect(remoteName.sourceReads).toBe(1);
  expect(remoteName.issueLookups).toHaveLength(0);
  expect(remoteName.violations.filter((v) => v.rule === "V8")).toHaveLength(1);
});

it("E2 1.20.11 accepts gh api output redirects equally for issues and search/issues", () => {
  for (const command of [
    `gh api -X GET 'repos/${repoSlug}/issues?state=open' > issues.json`,
    `gh api -X GET search/issues -f q='repo:${repoSlug} is:issue foo' > issues.json`,
  ]) {
    const result = metric(command);
    expect(result.sourceReads, command).toBe(0);
    expect(result.issueLookups, command).toHaveLength(1);
    expect(
      result.violations.filter((v) => v.rule === "V8"),
      command,
    ).toHaveLength(0);
  }
});

it.each([
  [
    "guide recipe gh api GET search/issues",
    `gh api -X GET search/issues -f q='repo:${repoSlug} is:issue field-interfaces'`,
  ],
  [
    "form 1 gh api GET search/issues with sort/order fields",
    `gh api -X GET search/issues -f q='repo:${repoSlug} is:issue field-interfaces' -f sort=updated -f order=desc`,
  ],
  [
    "form 1 gh api --method GET search/issues with sort/order/per_page",
    `gh api --method GET search/issues -f q='repo:${repoSlug} is:issue' -f sort=updated -f order=desc -F per_page=20`,
  ],
  [
    "form 1 gh api GET search/issues with sort=/order= query params",
    `gh api -X GET 'search/issues?q=repo:${repoSlug}+is:issue+field-interfaces&sort=updated&order=desc'`,
  ],
  [
    "form 1 gh api GET full search/issues URL with sort/order fields",
    `gh api -X GET '${searchBase}' -f q='repo:${repoSlug} is:issue' -f sort=updated -f order=desc`,
  ],
  [
    "form 1 gh api GET repos/issues with sort=/order= query params",
    `gh api -X GET 'repos/${repoSlug}/issues?state=open&sort=updated&order=desc&per_page=20'`,
  ],
  [
    "form 2 C3 T07/claude curl -fsSL search/issues piped to head",
    `curl -fsSL '${searchBase}?q=repo:${repoSlug}+is:issue+field-interfaces' | head -c 3000; echo; echo "exit $?"`,
  ],
  [
    "form 2 C3 T07/claude curl -fsSL search/issues -o /tmp/... && bun -e",
    `curl -fsSL '${searchBase}?q=repo:${repoSlug}+is:issue+field-interfaces' -o /tmp/thermite-issues-fi.json && bun -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));for(const i of j.items)console.log("#"+i.number,i.state,i.title,"\\n",(i.body||"").slice(0,1500),"\\n----")' /tmp/thermite-issues-fi.json`,
  ],
  [
    "form 2 curl search/issues with sort=/order= piped to grep and head",
    `curl -s --max-time 15 '${searchBase}?q=repo:${repoSlug}+is:issue+field-interfaces&sort=updated&order=desc' | grep -E '"(total_count|title|html_url)"' | head`,
  ],
  [
    "form 2 curl search/issues piped to jq",
    `curl -s '${searchBase}?q=repo:${repoSlug}+is:issue+field-interfaces' | jq '.total_count'`,
  ],
  [
    "form 2 curl search/issues piped to sed -n and wc",
    `curl -s '${searchBase}?q=repo:${repoSlug}+is:issue+field-interfaces' | sed -n '1,20p' | wc -l`,
  ],
  [
    "form 2 wget search/issues with sort=/order= piped to head",
    `wget -qO- '${searchBase}?q=repo:${repoSlug}+is:issue+field-interfaces&sort=updated&order=desc' | head -n 20`,
  ],
  [
    "form 2 wget repos/issues with sort=/order= piped to wc",
    `wget -qO- 'https://api.github.com/repos/${repoSlug}/issues?state=open&sort=updated&order=desc&per_page=20' | wc -l`,
  ],
])("E2 1.20.11 accepts %s as issue lookup", (_label, command) => {
  const result = metric(command);
  expect(result.sourceReads, command).toBe(0);
  expect(result.issueLookups, command).toHaveLength(1);
  expect(result.violations.filter((v) => v.rule === "V8")).toHaveLength(0);
});

it("E2 1.20.11 accepts guide web search and C3 connector search/fetch forms", () => {
  const web = metricQuery(`repo:${repoSlug} is:issue field-interfaces`);
  expect(web.sourceReads).toBe(0);
  expect(web.issueLookups).toHaveLength(1);

  const c3Fetch = score({
    transcript: [
      {
        type: "item.completed",
        item: {
          id: "item_12",
          type: "mcp_tool_call",
          server: "codex_apps",
          tool: "github.fetch",
          arguments: {
            url: `${searchBase}?q=repo%3ABlackettApplied%2FThermiteSchematics%20is%3Aissue%20cable%20pdf&per_page=20`,
          },
          status: "completed",
        },
      },
    ],
  });
  expect(c3Fetch.sourceReads).toBe(0);
  expect(c3Fetch.issueLookups).toHaveLength(1);

  const connectorSort = classifyToolCall({
    name: "mcp__github__search_issues",
    input: {
      repository_full_name: repoSlug,
      query: "is:issue field-interfaces",
      sort: "updated",
      order: "desc",
      topn: 15,
    },
  });
  expect(connectorSort.class).toBe("issue-lookup");

  const connectorBadSort = classifyToolCall({
    name: "mcp__github__search_issues",
    input: {
      repository_full_name: repoSlug,
      query: "is:issue field-interfaces",
      sort: "invalid",
      order: "desc",
    },
  });
  expect(connectorBadSort.class).toBe("source-read");
});

it.each([
  [
    "form 3 C3 D-pump/claude dynamic curl loop",
    `for q in "loose+cores+spare" "two-wire-transmitter+circuit+view" "unterminated+spare"; do curl -s --max-time 15 "${searchBase}?q=repo:${repoSlug}+$q" | bun -e "const r=JSON.parse(await Bun.stdin.text());console.log('$q',r.total_count);for(const i of r.items||[])console.log(' #'+i.number,i.state,i.title)"; done`,
  ],
  [
    "form 3 C3 T07/claude dynamic curl loop",
    `for q in 'loop_positive' 'polarity+not+verified' 'explicitly+spare+note' 'field-interfaces+role'; do echo "== $q"; curl -fsSL "${searchBase}?q=repo:${repoSlug}+is:issue+$q" -o /tmp/thermite-q.json && bun -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));for(const i of j.items)console.log("#"+i.number,i.state,i.title)' /tmp/thermite-q.json; done`,
  ],
  [
    "variable expansion in search URL",
    `curl -s "${searchBase}?q=repo:${repoSlug}+is:issue+$QUERY"`,
  ],
  [
    "braced variable expansion in search URL",
    `curl -s "${searchBase}?q=repo:${repoSlug}+is:issue+\${QUERY}"`,
  ],
  [
    "command substitution in search URL",
    `curl -s "${searchBase}?q=repo:${repoSlug}+is:issue+$(echo field)"`,
  ],
  [
    "backtick substitution in search URL",
    `curl -s "${searchBase}?q=repo:${repoSlug}+is:issue+\`echo field\`"`,
  ],
  [
    "variable expansion in gh api search/issues field",
    `gh api -X GET search/issues -f q="repo:${repoSlug} is:issue $TERM"`,
  ],
  [
    "eval wrapping curl search/issues",
    `eval "curl -s '${searchBase}?q=repo:${repoSlug}+is:issue+field-interfaces'"`,
  ],
  [
    "unscoped search/issues query",
    `curl -s '${searchBase}?q=is:issue+field-interfaces'`,
  ],
  [
    "foreign-repository search/issues query",
    `curl -s '${searchBase}?q=repo:other/repo+is:issue+field-interfaces'`,
  ],
  [
    "search/issues missing is:issue qualifier",
    `curl -s '${searchBase}?q=repo:${repoSlug}+spare+signal-loop'`,
  ],
  [
    "gh api foreign-repository search/issues with sort/order",
    `gh api -X GET search/issues -f q='repo:other/repo is:issue field-interfaces' -f sort=updated -f order=desc`,
  ],
  [
    "search/issues with invalid sort value",
    `curl -s '${searchBase}?q=repo:${repoSlug}+is:issue+foo&sort=invalid'`,
  ],
  [
    "search/issues with invalid order value",
    `curl -s '${searchBase}?q=repo:${repoSlug}+is:issue+foo&order=sideways'`,
  ],
  [
    "search/issues with unknown query parameter",
    `curl -s '${searchBase}?q=repo:${repoSlug}+is:issue+foo&raw=1'`,
  ],
  [
    "search/issues with duplicate q parameter",
    `curl -s '${searchBase}?q=repo:${repoSlug}+is:issue+foo&q=other'`,
  ],
  [
    "curl code search endpoint",
    `curl -s 'https://api.github.com/search/code?q=repo:${repoSlug}+compileProject'`,
  ],
  [
    "gh api code search endpoint",
    `gh api -X GET search/code -f q='repo:${repoSlug} compileProject'`,
  ],
  [
    "search/issues with in:file qualifier",
    `curl -s '${searchBase}?q=repo:${repoSlug}+is:issue+in:file+compileProject'`,
  ],
  [
    "contents endpoint",
    `curl -s 'https://api.github.com/repos/${repoSlug}/contents/packages/compiler/src/index.ts'`,
  ],
  [
    "raw endpoint",
    `curl -s 'https://raw.githubusercontent.com/${repoSlug}/dev/packages/compiler/src/index.ts'`,
  ],
  [
    "blob endpoint",
    `curl -s 'https://github.com/${repoSlug}/blob/dev/docs/modeling.md'`,
  ],
  [
    "tree endpoint",
    `curl -s 'https://github.com/${repoSlug}/tree/dev/packages'`,
  ],
  [
    "path traversal from search/issues to contents",
    `curl -s '${searchBase}/../../repos/${repoSlug}/contents/package.json'`,
  ],
  [
    "non-GET POST to search/issues",
    `curl -X POST '${searchBase}?q=repo:${repoSlug}+is:issue+foo'`,
  ],
  [
    "non-GET HEAD to search/issues",
    `curl -I '${searchBase}?q=repo:${repoSlug}+is:issue+foo'`,
  ],
  [
    "curl data flag on search/issues",
    `curl -d 'a=b' '${searchBase}?q=repo:${repoSlug}+is:issue+foo'`,
  ],
  [
    "wget non-GET POST on search/issues",
    `wget --method=POST '${searchBase}?q=repo:${repoSlug}+is:issue+foo'`,
  ],
  [
    "wget post-data flag on search/issues",
    `wget --post-data='a=b' '${searchBase}?q=repo:${repoSlug}+is:issue+foo'`,
  ],
  [
    "gh api search/issues fields without explicit GET",
    `gh api search/issues -f q='repo:${repoSlug} is:issue foo' -f sort=updated`,
  ],
  [
    "curl search/issues -O writing remote name into project",
    `curl -s -O '${searchBase}?q=repo:${repoSlug}+is:issue+foo'`,
  ],
  [
    "redirect host via curl -L",
    `curl -fsSL 'https://redirect.example/search/issues?q=repo:${repoSlug}+is:issue+foo'`,
  ],
  [
    "lookalike host via curl -L",
    `curl -fsSL 'https://api.github.com.evil.example/search/issues?q=repo:${repoSlug}+is:issue+foo'`,
  ],
  [
    "curl --location-trusted cross-host redirect",
    `curl --location-trusted '${searchBase}?q=repo:${repoSlug}+is:issue+foo'`,
  ],
  [
    "curl --proto-redir cross-protocol redirect",
    `curl --proto-redir all '${searchBase}?q=repo:${repoSlug}+is:issue+foo'`,
  ],
  [
    "curl Host header override to another host",
    `curl -fsSL -H 'Host: evil.example' '${searchBase}?q=repo:${repoSlug}+is:issue+foo'`,
  ],
  [
    "wget -H span-hosts redirect",
    `wget -H -qO- '${searchBase}?q=repo:${repoSlug}+is:issue+foo'`,
  ],
])("E2 1.20.11 keeps %s fail-closed as V8", (_label, command) => {
  const result = metric(command);
  expect(result.sourceReads, command).toBe(1);
  expect(result.issueLookups, command).toHaveLength(0);
  expect(result.violations.filter((v) => v.rule === "V8")).toHaveLength(1);
});
