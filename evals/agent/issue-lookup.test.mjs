import { expect, it } from "vitest";
import { score } from "./score-log.mjs";
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
        query:
          "https://github.com/BlackettApplied/ThermiteSchematics/issues/367",
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
  const metricQuery = (query) =>
    score({
      transcript: [
        {
          type: "item.started",
          item: { id: "s", type: "web_search", query: "" },
        },
        {
          type: "item.completed",
          item: { id: "s", type: "web_search", query },
        },
      ],
    });
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
