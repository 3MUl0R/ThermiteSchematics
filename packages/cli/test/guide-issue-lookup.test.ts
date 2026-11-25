import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalText } from "../../../evals/agent/github-canonical.mjs";
import { classifyToolCall } from "../../../evals/agent/github-call.mjs";
import { issueSearch } from "../../../evals/agent/issue-lookup.mjs";
import { repositoryRoot } from "./project-guide/harness.js";

const QUERY_PATTERN =
  /repo:BlackettApplied\/ThermiteSchematics is:issue [a-z0-9-]+/gu;

function extractUnique(text: string, pattern: RegExp, label: string): string {
  const matches = [...new Set([...text.matchAll(pattern)].map((m) => m[0]))];
  expect(matches, label).toHaveLength(1);
  return matches[0]!;
}

it("documents one offline-first, optional issue-lookup recipe accepted by issue-lookup.mjs", async () => {
  const guide = await readFile(
    join(repositoryRoot, "packages/cli/assets/THERMITE_AGENTS.md"),
    "utf8",
  );
  const libraries = await readFile(
    join(repositoryRoot, "docs/libraries.md"),
    "utf8",
  );

  for (const [name, text] of [
    ["THERMITE_AGENTS.md", guide],
    ["docs/libraries.md", libraries],
  ] as const) {
    expect(text, `${name} offline-first`).toMatch(
      /`thermite guide`.*before any network lookup/u,
    );
    expect(text, `${name} optional online`).toMatch(
      /optional and (?:online|requires network)/u,
    );
  }

  const guideQuery = extractUnique(guide, QUERY_PATTERN, "core guide query");
  const docQuery = extractUnique(libraries, QUERY_PATTERN, "libraries query");
  expect(guideQuery).toBe(docQuery);

  const normalized = canonicalText(guideQuery);
  expect(normalized.valid).toBe(true);
  expect(issueSearch(normalized.text, { repoOnly: true })).toBe(true);
  expect(
    classifyToolCall({ name: "web_search", input: guideQuery }).class,
  ).toBe("issue-lookup");

  const ghCommand = extractUnique(
    libraries,
    /^gh api -X GET search\/issues -f q='[^']+'$/gmu,
    "docs/libraries.md gh api command",
  );
  expect(ghCommand).toContain(`q='${docQuery}'`);
  expect(
    classifyToolCall({ name: "Bash", input: { command: ghCommand } }).class,
  ).toBe("issue-lookup");
});

it("keeps rejected search forms out of issueSearch and Bash issue-lookup", () => {
  const badQueries = [
    "repo:BlackettApplied/ThermiteSchematics is:issue field-interfaces OR cable",
    "repo:BlackettApplied/ThermiteSchematics field-interfaces",
    "repo:BlackettApplied/ThermiteSchematics is:issue sort:updated",
  ];
  for (const query of badQueries) {
    const normalized = canonicalText(query);
    expect(issueSearch(normalized.text, { repoOnly: true }), query).toBe(false);
  }
  const badCommands = [
    "curl -fsSL 'https://api.github.com/search/issues?q=repo:BlackettApplied/ThermiteSchematics+is:issue+field-interfaces'",
    'for q in a b; do gh api -X GET search/issues -f q="repo:BlackettApplied/ThermiteSchematics is:issue $q"; done',
  ];
  for (const command of badCommands) {
    expect(
      classifyToolCall({ name: "Bash", input: { command } }).class,
      command,
    ).toBe("source-read");
  }
});
