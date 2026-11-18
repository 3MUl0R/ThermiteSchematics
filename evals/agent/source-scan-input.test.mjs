import { expect, it } from "vitest";
import { score } from "./score-log.mjs";
const url =
  "https://github.com/BlackettApplied/ThermiteSchematics/blob/dev/packages/compiler/src/index.ts";
const metric = (command) =>
  score({
    engineRoots: ["/engine"],
    transcript: [
      {
        type: "item.completed",
        item: { id: "write", type: "command_execution", command, exit_code: 0 },
      },
    ],
  });
it("writing source/issue links into quoted Markdown is not a source read", () => {
  const command = `/bin/zsh -lc "cat > friction.md <<'EOF'\n# Findings\nSee ${url}\nhttps://github.com/BlackettApplied/ThermiteSchematics/issues/365\nEOF"`;
  expect(metric(command).sourceReads).toBe(0);
  expect(metric(command).issueLookups).toHaveLength(0);
});
it("preserves real reads around reports and executable/unquoted here-docs", () => {
  for (const command of [
    `cat > friction.md <<'EOF'\n${url}\nEOF\ncat /engine/source.ts`,
    `curl '${url}'\ncat > friction.md <<'EOF'\n# Findings\nEOF`,
    `python3 - <<'PY'\nfetch('${url}')\nPY`,
    `cat > helper.sh <<'EOF'\ncurl '${url}'\nEOF\nbash helper.sh`,
    `cat > friction.md <<'EOF'\ncurl '${url}'\nEOF\nbash friction.md`,
    `cat > friction.md <<EOF\n$(cat /engine/source.ts)\nEOF`,
  ])
    expect(metric(command).sourceReads, command).toBe(1);
});

it("keeps a local Python heredoc after an authored report as other", () => {
  expect(
    metric(
      `cat > friction.md <<'EOF'\nnotes\nEOF\npython3 - <<'PY'\nprint('write matrix')\nPY`,
    ).sourceReads,
  ).toBe(0);
});

it("recognizes a completed Markdown append and the Codex wrapper's spliced delimiter", () => {
  const script = `cp work/issue-draft.md issue-draft.md\ncat >> issue-draft.md <<'EOF'\ncurl ${url}\nEOF\ncat > friction.md <<'EOF'\ncurl ${url}\nEOF\npython3 - <<'PY'\nprint('local output')\nPY\ngit status --short`;
  const wrap = (body) =>
    "/bin/zsh -lc '" + body.replaceAll("'", "'\"'\"'") + "'";
  expect(metric(wrap(script)).sourceReads).toBe(0);
  for (const tail of [
    `curl ${url}`,
    "bash issue-draft.md",
    "sh < friction.md",
    "chmod +x friction.md\n./friction.md",
  ]) {
    expect(metric(wrap(script + "\n" + tail)).sourceReads, tail).toBe(1);
  }
});
