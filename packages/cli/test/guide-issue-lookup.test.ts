import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalText } from "../../../evals/agent/github-canonical.mjs";
import { classifyToolCall } from "../../../evals/agent/github-call.mjs";
import { issueSearch } from "../../../evals/agent/issue-lookup.mjs";
import { repositoryRoot } from "./project-guide/harness.js";

const BACKTICK_QUERY = /`(repo:BlackettApplied\/ThermiteSchematics [^`]+)`/gu;
const QUOTED_QUERY = /"(repo:BlackettApplied\/ThermiteSchematics [^"]+)"/gu;
const GH_COMMAND =
  /\bgh api -X GET search\/issues -f q='(repo:BlackettApplied\/ThermiteSchematics [^']+)'/gu;

function extractExactlyOne(
  text: string,
  pattern: RegExp,
  label: string,
  group = 0,
): string {
  const matches = [...text.matchAll(pattern)].map((m) => m[group]!);
  expect(matches, label).toHaveLength(1);
  return matches[0]!;
}

function assertAcceptedWebQuery(query: string, label: string): void {
  const normalized = canonicalText(query);
  expect(normalized.valid, `${label} canonical`).toBe(true);
  expect(issueSearch(normalized.text, { repoOnly: true }), label).toBe(true);
  expect(
    classifyToolCall({ name: "web_search", input: query }).class,
    `${label} web_search`,
  ).toBe("issue-lookup");
}

function assertAcceptedShellCommand(command: string, label: string): void {
  expect(
    classifyToolCall({ name: "Bash", input: { command } }).class,
    `${label} Bash`,
  ).toBe("issue-lookup");
}

function verifyIssueLookupDocs(guide: string, libraries: string): void {
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
    expect(text, `${name} context-neutral`).toMatch(
      /source[\s\S]*runtime[- ]package/iu,
    );
    expect(text, `${name} no runtime-only gate`).not.toMatch(
      /When using a runtime package, issue lookup/u,
    );
    expect(text, `${name} no unqualified connector recommendation`).not.toMatch(
      /In a GitHub issue-search tool/iu,
    );
  }

  const guideCommand = extractExactlyOne(
    guide,
    GH_COMMAND,
    "THERMITE_AGENTS.md gh api command",
  );
  const guideShellQuery = extractExactlyOne(
    guide,
    GH_COMMAND,
    "THERMITE_AGENTS.md gh api query",
    1,
  );
  const guideQuotedQuery = extractExactlyOne(
    guide,
    QUOTED_QUERY,
    "THERMITE_AGENTS.md quoted query",
    1,
  );

  const docCommand = extractExactlyOne(
    libraries,
    GH_COMMAND,
    "docs/libraries.md gh api command",
  );
  const docShellQuery = extractExactlyOne(
    libraries,
    GH_COMMAND,
    "docs/libraries.md gh api query",
    1,
  );
  const docBacktickQuery = extractExactlyOne(
    libraries,
    BACKTICK_QUERY,
    "docs/libraries.md backticked query",
    1,
  );

  expect(guideCommand).toBe(docCommand);
  expect(guideShellQuery).toBe(docShellQuery);
  expect(guideQuotedQuery).toBe(guideShellQuery);
  expect(docBacktickQuery).toBe(docShellQuery);

  assertAcceptedShellCommand(guideCommand, "THERMITE_AGENTS.md");
  assertAcceptedShellCommand(docCommand, "docs/libraries.md");
  assertAcceptedWebQuery(guideQuotedQuery, "THERMITE_AGENTS.md quoted");
  assertAcceptedWebQuery(docBacktickQuery, "docs/libraries.md backticked");
}

it("documents one context-neutral, offline-first issue-lookup recipe accepted by E2", async () => {
  const guide = await readFile(
    join(repositoryRoot, "packages/cli/assets/THERMITE_AGENTS.md"),
    "utf8",
  );
  const libraries = await readFile(
    join(repositoryRoot, "docs/libraries.md"),
    "utf8",
  );
  verifyIssueLookupDocs(guide, libraries);
});

it("catches query drift without truncation when sort:updated is appended", async () => {
  const guide = await readFile(
    join(repositoryRoot, "packages/cli/assets/THERMITE_AGENTS.md"),
    "utf8",
  );
  const libraries = await readFile(
    join(repositoryRoot, "docs/libraries.md"),
    "utf8",
  );
  const query =
    "repo:BlackettApplied/ThermiteSchematics is:issue field-interfaces";
  const drifted = `${query} sort:updated`;

  expect(() =>
    verifyIssueLookupDocs(
      guide,
      libraries.replace(`\`${query}\``, `\`${drifted}\``),
    ),
  ).toThrow();
  expect(() =>
    verifyIssueLookupDocs(
      guide.replace(`"${query}"`, `"${drifted}"`),
      libraries,
    ),
  ).toThrow();
  expect(() =>
    verifyIssueLookupDocs(
      guide,
      libraries.replace(`q='${query}'`, `q='${drifted}'`),
    ),
  ).toThrow();
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
    // E2 1.20.11 (#612) accepts a literal scoped curl search; a dynamic URL stays V8.
    'curl -fsSL "https://api.github.com/search/issues?q=repo:BlackettApplied/ThermiteSchematics+is:issue+$TERM"',
    'for q in a b; do gh api -X GET search/issues -f q="repo:BlackettApplied/ThermiteSchematics is:issue $q"; done',
  ];
  for (const command of badCommands) {
    expect(
      classifyToolCall({ name: "Bash", input: { command } }).class,
      command,
    ).toBe("source-read");
  }
});
