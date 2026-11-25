import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { retrieveTopics } from "../../../evals/agent/retrieval.mjs";
import { repositoryRoot } from "./project-guide/harness.js";

type Activity =
  | "source-change"
  | "repair"
  | "conflict-response"
  | "patch"
  | "select-type"
  | "edit-or-acquire-type"
  | "missing-library-draft"
  | "unresolved-connection"
  | "diagnostics"
  | "view"
  | "packet"
  | "packet-with-reports"
  | "review";

interface GuideTopic {
  id: string;
  readBefore: string[];
}

interface CueClause {
  topic: string;
  trigger: string;
}

interface Stage {
  activities: readonly Activity[];
  call?: Record<string, unknown>;
}

interface TaskSpec {
  stages: readonly Stage[];
  options?: Record<string, unknown>;
}

const GUARDED = () => ["devices/equipment.json"];

const PATCH_CALL = {
  argv: ["agent", "apply-source-patch", "--input", "patch.json"],
  exit: 0,
  request: JSON.stringify({
    patchFormat: "json-patch/0.1",
    dryRun: true,
    files: [{ path: "devices/equipment.json", operations: [] }],
  }),
};

const VIEW_CALL = {
  argv: ["view", "PS1", "--loads", "-o", "drawings/ps1-loads.pdf"],
  exit: 0,
};

const PACKET_CALL = (views: readonly Record<string, unknown>[]) => ({
  argv: [
    "packet",
    "--input",
    "packet.request.json",
    "-o",
    "drawings/packet.pdf",
  ],
  exit: 0,
  request: JSON.stringify({ format: "schematic-packet-request/0.1", views }),
});

const DIAGNOSTICS_CALL = { argv: ["diagnostics", "--json"], exit: 0 };

const REVIEW_CALL = {
  argv: ["review", "--before", "drawings/before.json", "--json"],
  exit: 0,
};

const LIBRARY_INSTALL_CALL = {
  argv: ["lock", "."],
  exit: 0,
  directEditsSincePrevious: [
    { path: "libraries/field-interfaces/library.json", change: "created" },
  ],
};

const REPORT_VIEWS = [
  { format: "documentation-view-request/0.1", kind: "terminals" },
  { format: "documentation-view-request/0.1", kind: "io" },
  {
    format: "schematic-view-request/0.2",
    root: { by: "designation", value: "CBL1" },
    intent: { kind: "conductors" },
  },
];

const HOOKUP_VIEWS = [{ format: "signal-loop-view-request/0.1" }];
const CIRCUIT_VIEWS = [{ format: "circuit-view-request/0.1" }];
const NETWORK_VIEWS = [{ format: "communication-view-request/0.1" }];

const DESIGN_STAGES: readonly Stage[] = [
  { activities: ["select-type", "source-change", "patch"], call: PATCH_CALL },
  { activities: ["view"], call: VIEW_CALL },
  {
    activities: ["packet", "packet-with-reports"],
    call: PACKET_CALL(REPORT_VIEWS),
  },
  { activities: ["diagnostics"], call: DIAGNOSTICS_CALL },
  { activities: ["review"], call: REVIEW_CALL },
];

const TASK_SCENARIOS: Record<string, TaskSpec> = {
  "D-conveyor": { stages: DESIGN_STAGES },
  "D-pump": { stages: DESIGN_STAGES },
  T01: {
    stages: [
      { activities: ["source-change", "patch"], call: PATCH_CALL },
      { activities: ["view"], call: VIEW_CALL },
    ],
  },
  T02: {
    stages: [
      {
        activities: ["select-type", "source-change", "patch"],
        call: PATCH_CALL,
      },
      { activities: ["view"], call: VIEW_CALL },
    ],
  },
  T03: {
    stages: [{ activities: ["source-change", "patch"], call: PATCH_CALL }],
  },
  T04: {
    stages: [
      {
        activities: ["source-change", "patch", "unresolved-connection"],
        call: PATCH_CALL,
      },
    ],
  },
  T05: {
    stages: [
      {
        activities: ["packet", "packet-with-reports"],
        call: PACKET_CALL(REPORT_VIEWS),
      },
    ],
  },
  T06: {
    stages: [
      {
        activities: ["select-type", "source-change", "patch"],
        call: PATCH_CALL,
      },
    ],
  },
  T07: {
    stages: [
      { activities: ["edit-or-acquire-type"], call: LIBRARY_INSTALL_CALL },
      { activities: ["source-change", "patch"], call: PATCH_CALL },
      { activities: ["packet"], call: PACKET_CALL(HOOKUP_VIEWS) },
    ],
  },
  T08: {
    stages: [{ activities: ["packet"], call: PACKET_CALL(CIRCUIT_VIEWS) }],
  },
  T09a: {
    stages: [{ activities: ["repair", "patch"], call: PATCH_CALL }],
  },
  T09b: {
    stages: [{ activities: ["conflict-response"] }],
    options: { completed: true },
  },
  T10: {
    stages: [{ activities: ["packet"], call: PACKET_CALL(NETWORK_VIEWS) }],
  },
  T11: {
    stages: [
      { activities: ["source-change", "patch"], call: PATCH_CALL },
      { activities: ["review"], call: REVIEW_CALL },
    ],
  },
  T12: {
    stages: [
      {
        activities: ["source-change", "conflict-response", "patch"],
        call: PATCH_CALL,
      },
    ],
  },
};

const ACTIVITY_MATCHERS: Record<Activity, RegExp> = {
  "source-change": /source change/i,
  repair: /repair/i,
  "conflict-response": /conflict response/i,
  patch: /\bpatch\b/i,
  "select-type": /\bselecting\b.*type/i,
  "edit-or-acquire-type": /(?:editing|acquiring).*type|optional librar/i,
  "missing-library-draft": /missing-library/i,
  "unresolved-connection": /unresolved connection/i,
  diagnostics: /diagnostics/i,
  view: /\bview\b/i,
  packet: /\bpacket\b/i,
  "packet-with-reports": /packets? containing reports/i,
  review: /\breview\b/i,
};

function parseGuideCues(guide: string): CueClause[] {
  const line = guide
    .split("\n")
    .find((entry) =>
      entry.startsWith("Read every applicable topic before acting:"),
    );
  expect(line, "core guide retrieval cue line").toBeDefined();
  const body = line!
    .slice(line!.indexOf(":") + 1)
    .replace(/\.$/, "")
    .trim();
  return body.split("; ").map((clause) => {
    const topics = [...clause.matchAll(/`thermite guide ([a-z-]+)`/g)].map(
      (match) => match[1]!,
    );
    expect(topics, `one topic per cue clause: ${clause}`).toHaveLength(1);
    const before = clause.indexOf(" before ");
    expect(before, `before trigger in clause: ${clause}`).toBeGreaterThan(0);
    return { topic: topics[0]!, trigger: clause.slice(before + 1) };
  });
}

function buildTrace(
  cues: readonly CueClause[],
  stages: readonly Stage[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const trace: Record<string, unknown>[] = [];
  for (const stage of stages) {
    for (const activity of stage.activities) {
      const pattern = ACTIVITY_MATCHERS[activity];
      for (const cue of cues) {
        if (!seen.has(cue.topic) && pattern.test(cue.trigger)) {
          seen.add(cue.topic);
          trace.push({ argv: ["guide", cue.topic], exit: 0 });
        }
      }
    }
    if (stage.call) trace.push(stage.call);
  }
  return trace;
}

it("gives each retrieval topic its own non-alternative cue in the guide and topics.json", async () => {
  const guide = await readFile(
    join(repositoryRoot, "packages/cli/assets/THERMITE_AGENTS.md"),
    "utf8",
  );
  const topics: GuideTopic[] = JSON.parse(
    await readFile(join(repositoryRoot, "docs/topics.json"), "utf8"),
  );
  const cues = parseGuideCues(guide);
  const cueByTopic = new Map(cues.map((cue) => [cue.topic, cue.trigger]));
  const topicMeta = new Map(
    topics.map((topic) => [topic.id, topic.readBefore.join("; ")]),
  );

  for (const [topic, expected] of [
    ["libraries", [/\bselecting\b/i, /\bediting\b/i, /\bacquiring\b/i]],
    ["completeness", [/unresolved connection/i, /diagnostics/i]],
    ["views", [/\bview\b/i, /\bpacket\b/i]],
    ["report-filtering", [/packets? containing reports/i]],
    ["modeling", [/source change/i, /repair/i, /conflict response/i]],
    ["agent-requests", [/patch/i]],
    ["review", [/review/i]],
  ] as const) {
    for (const pattern of expected) {
      expect(cueByTopic.get(topic), `THERMITE_AGENTS.md ${topic}`).toMatch(
        pattern,
      );
      expect(topicMeta.get(topic), `docs/topics.json ${topic}`).toMatch(
        pattern,
      );
    }
  }
});

it("covers every task declaration in evals/agent/tasks/ under retrieveTopics()", async () => {
  const guide = await readFile(
    join(repositoryRoot, "packages/cli/assets/THERMITE_AGENTS.md"),
    "utf8",
  );
  const topics: GuideTopic[] = JSON.parse(
    await readFile(join(repositoryRoot, "docs/topics.json"), "utf8"),
  );
  const guideCues = parseGuideCues(guide);
  const indexCues: CueClause[] = topics
    .filter((topic) => topic.id !== "project-workflows")
    .map((topic) => ({
      topic: topic.id,
      trigger: topic.readBefore.join("; "),
    }));

  const tasksDir = join(repositoryRoot, "evals/agent/tasks");
  const taskNames = (await readdir(tasksDir)).sort();
  expect(taskNames).toEqual(Object.keys(TASK_SCENARIOS).sort());

  for (const [source, cues] of [
    ["THERMITE_AGENTS.md", guideCues],
    ["docs/topics.json", indexCues],
  ] as const) {
    for (const name of taskNames) {
      const task = JSON.parse(
        await readFile(join(tasksDir, name, "task.json"), "utf8"),
      );
      const scenario = TASK_SCENARIOS[name]!;
      const trace = buildTrace(cues, scenario.stages);
      const results = retrieveTopics(trace, task.requiredTopics, {
        guarded: GUARDED,
        ...scenario.options,
      });
      for (const row of results) {
        expect(
          row.retrieved,
          `${source} -> ${name} -> ${row.topic} (${row.action})`,
        ).toBe(true);
      }
    }

    const t07 = JSON.parse(
      await readFile(join(tasksDir, "T07/task.json"), "utf8"),
    );
    const draftTrace = buildTrace(cues, [
      { activities: ["missing-library-draft"] },
    ]);
    const draftResults = retrieveTopics(draftTrace, t07.requiredTopics, {
      guarded: GUARDED,
      acceptedIssueDraft: true,
      final: { files: { "issue.md": "sha256-draft" } },
    });
    expect(draftResults, `${source} -> T07 draft-only`).toEqual([
      expect.objectContaining({ topic: "libraries", retrieved: true }),
      expect.objectContaining({ topic: "views", applicability: "draft-only" }),
    ]);
  }
});

it("demonstrates that the prior round-1 cue wording missed T04, T05 and T06", async () => {
  const tasksDir = join(repositoryRoot, "evals/agent/tasks");
  const oldCues: CueClause[] = [
    {
      topic: "modeling",
      trigger: "before any source change, repair or conflict response",
    },
    { topic: "agent-requests", trigger: "before any patch" },
    {
      topic: "libraries",
      trigger:
        "before type edits, optional libraries or missing-library drafts",
    },
    {
      topic: "completeness",
      trigger: "before unused/deferred reviews or `diagnostics`",
    },
    { topic: "views", trigger: "before `view` or `packet`" },
  ];
  for (const [taskId, missedTopic] of [
    ["T04", "completeness"],
    ["T05", "report-filtering"],
    ["T06", "libraries"],
  ] as const) {
    const task = JSON.parse(
      await readFile(join(tasksDir, taskId, "task.json"), "utf8"),
    );
    const scenario = TASK_SCENARIOS[taskId]!;
    const trace = buildTrace(oldCues, scenario.stages);
    const results = retrieveTopics(trace, task.requiredTopics, {
      guarded: GUARDED,
      ...scenario.options,
    });
    expect(
      results.find((row: { topic: string }) => row.topic === missedTopic)
        ?.retrieved,
      `${taskId} old cues miss ${missedTopic}`,
    ).toBe(false);
  }
});
