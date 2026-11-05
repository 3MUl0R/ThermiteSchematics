import { it, expect } from "vitest";
import { score } from "./score-log.mjs";
const state = (hash, invalid = []) => ({
  files: { "system.json": "m", "source.json": hash },
  documents: {
    "system.json": { sources: ["source.json"] },
    "source.json": { objects: [] },
  },
  schemaInvalidFiles: invalid,
});
it("schema-repair permission survives plain validate and unrelated help", () => {
  const invalid = state("invalid", ["source.json"]),
    fixed = state("fixed");
  const c = (argv) => ({
    argv,
    exit: 0,
    before: invalid,
    after: invalid,
    stdoutBytes: 0,
    stderrBytes: 0,
  });
  expect(
    score({
      initial: invalid,
      final: fixed,
      calls: [c(["validate", "."]), c(["--help"])],
    }).violations,
  ).toEqual([]);
});
for (const [name, input] of [
  ["Grep", { path: "/engine" }],
  ["LS", { path: "/engine" }],
  [
    "Bash",
    { command: "git clone git@github.com:3MUl0R/ThermiteSchematics.git" },
  ],
  ["Bash", { command: "gh repo clone someone/ThermiteSchematics /tmp/copy" }],
  [
    "Bash",
    { command: "gh api repos/someone/ThermiteSchematics/contents/docs" },
  ],
  [
    "WebFetch",
    { url: "https://github.com/3MUl0R/ThermiteSchematics/issues/46" },
  ],
  ["Bash", { command: "cd /engine && rg uid packages" }],
  [
    "WebFetch",
    {
      url: "https://github.com/BlackettApplied/ThermiteSchematics/blob/dev/docs/agent-requests.md",
    },
  ],
])
  it(`source reads include ${name}`, () => {
    const transcript = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool", name, input }] },
    });
    expect(score({ engineRoots: ["/engine"], transcript }).sourceReads).toBe(1);
  });
it("agent-authored notes do not inflate guide bytes", () => {
  const transcript = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "read",
            name: "Read",
            input: { file_path: "/project/review-notes.md" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "read", content: "my notes" },
        ],
      },
    },
  ]
    .map(JSON.stringify)
    .join("\n");
  expect(score({ transcript }).guideBytes).toBe(0);
});

it("warning sets follow a recreated designation rather than its previous UID", () => {
  const initial = state("a"),
    final = state("b");
  initial.documents["source.json"].objects = [
    { uid: "old", kind: "device", designation: "PX1" },
  ];
  final.documents["source.json"].objects = [
    { uid: "new", kind: "device", designation: "PX1" },
  ];
  const result = score({
    initial,
    final,
    expectedWarnings: [
      {
        anyOf: ["W903", "W904", "W905"].map((code) => ({
          code,
          designation: "PX1",
        })),
      },
    ],
    actualWarnings: [
      {
        code: "W905",
        uid: "new",
        severity: "warning",
        message: "PX1: return destination unknown",
      },
    ],
  });
  expect(result.violations.filter((v) => v.rule === "V7")).toEqual([]);
});

it("frozen dogfood briefs retain their bytes and are separated from the format appendix", async () => {
  const { readFileSync } = await import("node:fs");
  const { sha256 } = await import("./snapshot.mjs");
  for (const name of ["D-pump", "D-conveyor"]) {
    const brief = readFileSync(
        new URL(`./tasks/${name}/brief.source.txt`, import.meta.url),
        "utf8",
      ),
      task = JSON.parse(
        readFileSync(
          new URL(`./tasks/${name}/task.json`, import.meta.url),
          "utf8",
        ),
      );
    expect(sha256(brief)).toBe(task.briefSha256);
    expect(task.prompt).toContain(brief);
    expect(task.prompt.indexOf("## Deliverable format")).toBeGreaterThan(
      task.prompt.indexOf(brief),
    );
    for (const requirement of task.deliverables.requirements)
      expect(brief.replace(/\s+/g, " ")).toContain(
        requirement.quote.replace(/\s+/g, " "),
      );
  }
});

it("required retrieval topics match G3's public topic index", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const ids = JSON.parse(
    readFileSync(new URL("../../docs/topics.json", import.meta.url), "utf8"),
  ).map((t) => t.id);
  for (const name of readdirSync(new URL("./tasks", import.meta.url))) {
    const t = JSON.parse(
      readFileSync(
        new URL(`./tasks/${name}/task.json`, import.meta.url),
        "utf8",
      ),
    );
    for (const r of t.requiredTopics ?? []) expect(ids).toContain(r.topic);
  }
});
