# Fresh-agent evaluator (E2 v1.4.0)

This kit measures task outcomes, workflow violations and context cost. It ports
the GI prototype shim/scorer/T02 checker. It does not launch models in `check`.
All transcripts, runtime copies, projects and timing evidence stay under the
already gitignored `evals/out/agent/<checkpoint>/`.

```sh
bun evals/agent/run.mjs --agent reference --task T02 --checkpoint reference-t02
bun evals/agent/run.mjs --agent reference --all --checkpoint references
bun evals/agent/run.mjs --agent reference --task T05 --context source --commit 38720de --checkpoint source-t05
```

Use Bun 1.4.2, Git, installed frozen dependencies and a built engine. Runtime
context (default) builds `bun run package:pack --preview` in a detached worktree
of `--commit` (default HEAD), then extracts the verified ZIP. Source context
builds and copies that pinned worktree, including dependencies; its lock must
match the installed dependency lock. Engine source is never patched by the kit.
The prepared context is retained for reproducibility and resumption.

Every case has its own copied runtime, project, home/config/memory and audit
folder in a temporary run directory. The runner initializes the template, runs
setup, substitutes the guide, and commits a local Git baseline. It renames the
launcher to `thermite.real.mjs` and installs the shim. After the agent/reference,
it flushes a shim `validate`, checks independently with the real CLI, scores and
copies evidence out. Per-run workspaces are removed after success or failure;
Only `--keep` retains ordinary workspaces, including command-only runs. An unresolved explicit checker infrastructure error retains its workspace for a checker-only retry; its isolated auth is removed unless `--keep` was requested. `--keep` with keys or `--codex-auth` retains credential-bearing auth.json (0600) in that private workspace. Reference mode uses the
same pipeline without a model or auth requirement.

## Authentication and command inspection

These commands never request a model:

```sh
bun evals/agent/run.mjs --agent claude --check-auth
bun evals/agent/run.mjs --agent codex --check-auth
bun evals/agent/run.mjs --agent codex --task T02 --checkpoint inspect-command --print-agent-command --keep
```

Both normal and command-only runs execute `claude auth status` or
`codex login status` before a model could launch. Auth failure is infrastructure
failure. `--check-auth` needs neither task nor checkpoint and exits 0/1 for
ready/not ready. It prints only readiness, intended billing route and a generic
failure reason. Status commands do not prove provider/model availability.

Claude subscription OAuth recipe (run token setup in your normal CLI session):

```sh
claude setup-token
# Paste the resulting token at the silent prompt, then press Enter.
read -rs CLAUDE_CODE_OAUTH_TOKEN
export CLAUDE_CODE_OAUTH_TOKEN
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
bun evals/agent/run.mjs --agent claude --check-auth
```

This uses the Claude account's subscription OAuth route. Existing keychain login
alone does not carry into a fresh HOME/config. For API billing, set
`ANTHROPIC_API_KEY` instead and unset `CLAUDE_CODE_OAUTH_TOKEN` before checking.
No setup token or API value is written to the manifest, printed command or log.

Codex API billing recipe:

```sh
read -rs CODEX_API_KEY
export CODEX_API_KEY
unset OPENAI_API_KEY
bun evals/agent/run.mjs --agent codex --check-auth
```

`OPENAI_API_KEY` is also supported; `CODEX_API_KEY` takes precedence. The runner
imports the key locally with `codex login --with-api-key` on stdin into the fresh
CODEX_HOME, then checks status. No model call is part of this import.

Codex ChatGPT-login recipe:

```sh
bun evals/agent/run.mjs --agent codex --codex-auth "$HOME/.codex/auth.json" --check-auth
bun evals/agent/run.mjs --agent codex --codex-auth "$HOME/.codex/auth.json" --task T02 --checkpoint codex-smoke --print-agent-command --keep
```

`--codex-auth` copies **only** `auth.json`; config, memory and instructions are
rejected. This explicit option suppresses inherited Codex API keys so billing
follows the supplied auth file. A ChatGPT-login file uses that account's login
route; an API-key auth file uses API billing. If the CLI refreshes credentials,
the runner backs up the original and atomically writes the refreshed file back.
It refuses to overwrite a concurrently changed original; that becomes an infra
failure. Default concurrency is 1, avoiding shared-token refresh races.

`--check-auth` checks local credential presence/readiness, not provider validity; dummy tokens can pass. Invalid tokens surface as structured provider-auth failures on a live run. Codex warns that temporary CODEX_HOME cannot install PATH helper aliases; verify apply_patch availability in the first live smoke run (no model was launched here).

The recipe contracts have offline tests with stub status/import CLIs. Non-model
checks on the development host also passed for an isolated ChatGPT login and a
synthetic local API-key import. Fresh Claude config correctly reports not ready
without an explicit token/key; a paid Claude request was not used for validation.

Fresh environment forwarding is a small allowlist including the five supported
credential variables. Checkout paths are removed from PATH and asserted absent
from public agent environment values. Audit paths and TMPDIR point inside the
run directory, which Codex's workspace sandbox can write. Claude imports the
project guide through a harness-authored `CLAUDE.md` containing only
`@AGENTS.md`; Codex loads `AGENTS.md` normally. Assertions reject inherited
ancestor instructions, user memory/config and unexpected project settings.
The only initial CODEX_HOME file permitted is the chosen `auth.json`.

`agents.json` pins Codex to `gpt-6.1-sol` with reasoning effort `xhigh` and
Claude to `claude-opus-5-5`. Codex receives both `-m gpt-6.1-sol` and
`-c model_reasoning_effort="xhigh"` explicitly, independent of user config.
Claude receives `--model` only. Manifests record CLI versions. Claude's updater
is disabled in the environment and Codex receives
`-c check_for_update_on_startup=false`. Commands otherwise follow GI §7.
`--print-agent-command` prints the exact argv and an empty-environment launch;
credential variables are referenced, never expanded into the printed text.
Without `--keep` its paths are intentionally cleaned after inspection.

Use `--model <id>` to override the model for one invocation and `--effort <level>`
to override Codex reasoning effort. Claude and reference runs reject `--effort`;
reference runs also reject `--model`. For example, this only prints a command:

```sh
bun evals/agent/run.mjs --agent codex --codex-auth "$HOME/.codex/auth.json" --task T02 --checkpoint inspect-override --model gpt-6.1-sol --effort high --print-agent-command
```

Every record, including command-only and failed runs, stores effective `model`
and `effort`, the committed `modelPin`, and requested `modelOverrides`. Both
effective values and override provenance enter the run key and directory suffix.
Even an explicit override equal to a pin has a separate history. Resume cannot
reuse a pinned result for an override. Analyze each configuration separately;
the analyzer rejects mixed model/effort/override configurations and never pairs
different configurations across arms. Changing agents.json changes harnessHash.
The price table has no verified rates for these new pins: their cost estimates
are explicitly partial with null amounts and unknownModels, never inherited
from the previous models' rates.

## Arms, external tasks and attempts

`--arm B --guide /absolute/path/compact-guide.md` substitutes a project guide
before the baseline. A defaults to the current generated guide. Both arms use
the same engine; the kit does not supply a compact guide or claim an A/B result.
`--tasks-dir /absolute/path` loads trusted external task modules, with the same
`task.json`, optional setup, checker and reference contract. H1/H2 are held by
scorers and are absent here. `--concurrency 1|2` caps the batch at two.

A checkpoint is resumable; commit and context must match. The **first complete attempt counts**, including task failures. Completed cases are skipped. Only rate-limit failures and nonzero unstructured CLI exits automatically create another attempt, at most two reruns per run key (three failed executions including the original), including across resume. The two categories share that cap. Billing stops dispatch, terminates in-flight owned processes, and is never retried. Other infrastructure failures require an explicit subsequent resume after fixing the cause. `--force-rerun` explicitly creates another completed attempt, recorded in the manifest and analyzer warnings; it cannot replace the first completed score.

Evidence lives at `<checkpoint>/<task>-<agent>-<arm>-<seed>-<configuration-hash>/attempt-001/manifest.json` (reference directories omit the suffix). Keys include context, task, arm, agent, seed, effective model/effort, override provenance and attempt. Originals and adjudicated copies coexist. Analysis reports attempt counts and forced reruns, and blocks unresolved infrastructure/checker faults.

An exception while evaluating agent output is a completed task failure with its reason. Missing or invalid deliverables never request a paid retry. A checker module may throw the exported `CheckerInfrastructureError` only for an infrastructure fault (for example a missing checker installation). This yields `checker-error`, keeps the original workspace, and saves recheck.json. Resume re-runs only that checker in the same attempt; no agent process launches and usage is unchanged. Checker revisions retain `checker-history-001.json` and record checkerHarnessHash. An unavailable kept workspace blocks rechecking; it never starts the agent. Rechecks refuse changes to the task directory unless `--force-recheck` is supplied; the new tree hash and forced revision are recorded. The original agent harness hash remains immutable, while checkerHarnessHash and checkerTaskTreeHash identify the actual checker. Analysis compares both agent and effective checker identities. Reference exceptions and agent-side error results/timeouts are task failures. Provider/auth/transport signals, CLI crashes and shim/harness failures are infrastructure; classification uses structured codes/status or embedded provider JSON, never domain words in agent prose. Exit 0 plus successful completion is judged solely by the checker; earlier retry/error rows become retryCount/retryEvents. A terminal error without completion remains a failure. Infra counts by kind are reported per arm, including resolved attempts.

One exception does not abort siblings. On SIGINT, owned model **and reference** process groups terminate and the runner returns 130. `--timeout <seconds>` defaults to 900; killed usage remains partial.

## Audit and file-state rules

The shim logs argv, file/stdin requests, status/signal/error code, byte counts,
compiler diagnostics, before/after project states, changes since the previous
call and changes during the call. Calls serialize on a PID-owned audit lock.
Queued/start/command-end timestamps distinguish waiting from the actual call
interval. This prevents a legitimate overlapping packet and apply from being
misattributed as direct edits. Returned patch-integrity hashes also detect a
subsequent unguarded edit to a committed patch target.

The log/state live under the run directory, not in the checkout. Each record
is hash-chained; the runner verifies the chain/head and records the final log
hash. Audit failures write a `shim-error` marker and become infrastructure
failures. They never change the real CLI's stdout, stderr or exit code.
The real CLI inherits the caller's output descriptors. A small preload observer records writes out of band; no intermediate stdout pipe can absorb a downstream EPIPE. The CLI itself determines the exit code (including `| head`), and signals are forwarded. The observer and marker files are ephemeral and contain no checkout environment path. The evaluation protocol uses non-TTY streams.

Project snapshots exclude `.git`; runtime hashes include all directories,
including newly created empty `.git` directories. The runtime baseline is after
shim installation. Initial, per-call and final snapshots close the before-first,
after-last and child-process-write holes. A quiet real-CLI `validate --json`
labels each boundary's JSON/schema-invalid files; an unchanged invalid file
keeps that state. Permissions never depend on the immediately preceding command.
Human `validate`, `--help` and other calls cannot revoke a valid repair exception.

The current generated guide is normative. Updating its edit permissions requires
a reviewed scorer change and eval-version bump.

| File/change                                         | Direct edit permission                                       | Guide provenance                                                                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing referenced source/presentation             | Guarded dry-run then apply                                   | “To change existing source or presentation files:” followed by the guarded workflow.                                                                                                                                                      |
| New source files and `system.json` source listing   | Ordinary edits; later edits to admitted files become guarded | “New files, `system.json` and libraries are ordinary file edits; list new source files in `system.json` `sources`, then validate.”                                                                                                        |
| Libraries, including visible core                   | Ordinary edits, then CLI lock                                | Same sentence; “After an intentional library change run `thermite lock .`, then validate”.                                                                                                                                                |
| JSON/schema-invalid existing source                 | Ordinary repair while its before-state remains invalid       | Guide lines 93–94: “fix JSON or schema errors with an ordinary edit, then validate.” The full sentence starts “Only when sources load and pass schema checks but fail to compile (no guards returned) hash the file to patch the repair”. |
| Schema-valid source with a compile error, e.g. E102 | Guarded repair; explicit byte hash permitted                 | Same full sentence; a compile error does not authorize a direct edit.                                                                                                                                                                     |
| Library lock                                        | Successful CLI `lock` writes only                            | “referenced by system.json and pinned by electrical-system.lock.json”; “run `thermite lock .`”.                                                                                                                                           |
| Project `AGENTS.md` and Claude import wrapper       | Frozen after arm setup                                       | The guide excludes itself from patch eligibility; the evaluator freezes instructions as V3.                                                                                                                                               |
| Requests, notes and generated artifacts             | Ordinary files; source remains authoritative                 | “Electrical JSON is authoritative. PDF, SVG and HTML are generated outputs. Never hand-author schematic geometry”.                                                                                                                        |

| Rule | Meaning                                                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1   | Existing referenced source/presentation edited outside a successful guarded patch, except a before-state JSON/schema repair. Includes run boundaries, deletions and child writes.                                                         |
| V2   | Library lock edited except by successful CLI `lock`.                                                                                                                                                                                      |
| V3   | Project instructions/import wrapper changed after the baseline. Successful `init` may create instructions for a new project.                                                                                                              |
| V4   | Apply has no identical successful earlier dry run. Canonicalize the whole request except `dryRun`, retaining guards and operation order.                                                                                                  |
| V5   | Runtime tree changed, per call or across the run.                                                                                                                                                                                         |
| V6   | Invented facts; rubric only.                                                                                                                                                                                                              |
| V7   | A checker-declared warning set disappears, an unsupported `intentionally-unused` disposition appears, or T10 changes electrical bytes. Expected W903/W904/W905 alternatives key by designation, not the reference UID or modeling choice. |
| V8   | Runtime-context transcript tools access known engine checkouts or the project's GitHub source. Source context permits reads.                                                                                                              |

V8 covers Read/Grep/Glob/LS/WebFetch/Task/Agent and shell/exec events, including
bare-root `cd`, `rg`, `ls`, `git -C`, `find`, `cat` and realpath aliases.
A small write-only tool list is excluded. This is transcript evidence, not a
filesystem security audit; ambiguous/indirect accesses require scorer review.
Snapshots also cannot detect an edit reverted entirely between observations.
Hash chaining detects damaged/inconsistent audit data; it is not a defense
against a malicious actor rewriting the entire audit and state together.

`undocumented-shape` matches checker-declared `(code, pointer)` discovery gaps;
it does not label every schema error as a documentation defect. Raw codes and
reports are retained. Update declarations when discovery ships and replay the
previous checkpoint with the new checker version.

## Independent checks and dogfoods

Checkers resolve electrical objects through `system.json` source patterns,
using the compiler's glob implementation/options. Unlisted JSON with `objects`
cannot supply devices, connections or provenance. Library types likewise come
from declared library sources. Checkers rebuild outputs with the real CLI in a
separate copy and write fresh outputs outside it. They compare artifacts with
the regenerated outputs; view metadata must match the requested root/intent.
Buffered stdin requests can be replayed from the audit. PDFs need a real page
count and extractable text, not just `%PDF-`.

T01–T12 have thirteen executable cases because T09a/T09b split task 9. T09a
compares semantic JSON with sorted keys; T11 permits only the label change;
T12 accepts `p2 line 7`, `page 2, line 7` and `p2 line7`. T04's message, T07,
T09b and T12 remain two-judge rubric tasks.

Each D task includes its exact frozen `brief.source.txt` and a separately
headed **Deliverable format** appendix. The task prompt embeds the frozen bytes
verbatim. Historical paths in the quoted brief are provenance; the appendix
instructs the agent to use the supplied launcher in the already-initialized
project. Every matrix ID quotes only the relevant verbatim clause, declares must/may and lists
its roles. Roles use the engine SYMBOL_PROFILES catalog, alias resolver and library function metadata, tested against both installed core versions; start/stop use the pushbutton profile and NO/NC sense, level uses a level-family profile, and indicator uses the lamp profile. Notes never establish a role. Different roles require distinct designations. A generic limit-switch can only defer a specifically absent level capability, naming itself. Rows have `id`, `status`, `designations`, `evidence`; fixed statuses
are `satisfied`, `substituted`, `deferred`. Display wording/capitalization does
not affect scoring.

Satisfied/substituted rows must resolve to validated source and actual drawing
appearances. A deferred must row needs non-empty source designations and either a final compiler diagnostic on its own named device fitting the requirement role, or
the specified, independently checked library gap on its own subject. A proposed unmodeled component may be named for its own absent capability with evidence.unmodeled:true; an existing unrelated object cannot represent it. Optional conditional items
may be deferred with a reason. Blanket `deferred: n/a` fails. Visual inspection
is explicitly rubric-only, not a falsely satisfied matrix row.

Coverage is role-based: matrix-mapped brief devices must be drawn; every modeled
non-cable/non-terminal device must appear on a schematic; and the PSU input
conductors must be represented when designed; a specific final diagnostic on the PSU itself can justify its deferred feed without inventing wiring. Report/index/reference-table mentions do not
count. XT1/Q2/HL1/PX1 and other valid tags work. The packet used for coverage is
regenerated from source; an agent-written `packet.json` is never authority.
All eight deliverable items are checked, including independent reports/review,
requirement matrix and local-type/source-read/failure counts.

The D references now model the generic starter, real field/start wiring,
indexed packets, reports and guarded review. Pump pressure/analog hookup uses
specific, reproducible installed-library gaps rather than invented pins.
Conveyor stop monitoring retains W905 for the stock PLC input-capacity gap;
the conditional indicator is deferred with a reason. Both references leave PS1 AC input unwired and cite its own W905: no input rating or branch protection is invented. They exercise produce → guarded rendered-label change → regenerate, so final outputs match final sources. These are explicit gaps,
not blanket fulfillment claims. Judges assess their adequacy and substitutions.

E3 remains optional. A run's checker can consume `draw-evidence.json`:

```json
{
  "format": "thermite-agent-draw-evidence/1.0",
  "files": {
    "drawings/packet.pdf": "<sha256 hex>",
    "drawings/packet.html": "<sha256 hex>"
  },
  "V1": true,
  "V5": true,
  "checker": "<E3 or independent visual-review evidence>"
}
```

Digests must match. Without this evidence, PDF V1/V5 is `null`/pending, never a
visual pass. There is no import/dependency on the in-flight `evals/draw` work.

## Measurements, judgements and A/B

Both Claude Code stream-json and Codex exec JSON normalize to tools, results,
messages and usage. Repeated partial Claude messages use the latest/max counters.
Killed/noisy streams retain lower-bound usage marked partial. `modelUsage` includes
auxiliary models, and provider-reported cost is retained separately. The committed
price table estimates each model at its own rate; unknown rates remain partial,
not zero. Subscription authentication does not turn that API-equivalent estimate
into an asserted subscription charge.

Metrics include calls, failures by code, tools, wall time, tokens/cache usage,
source reads, topic retrieval and guide bytes. Guide bytes include the normally
loaded project guide, successful shim `guide` stdout once, and observed reads of
declared guide/engine-doc files. The guide pipeline's tool result is not counted
again, and agent-authored notes do not count as guides. Missing read outputs
remain unmeasured. Setup/checker/final-flush calls do not inflate agent counts.
Required topics must precede the task's declared first related command.

Manifests include engine commit; harness/task hashes; arm, context, model, effort, seed
and attempt; prompt/guide/runtime/log hashes; CLI versions; authentication route;
timings; usage and cost estimate. Judge packets include final message, source
and library diff, outputs and rubric, without run identity fields. Text/path
blinding covers provider/model aliases (Anthropic, OpenAI, GPT, Claude, Codex,
Opus, Sonnet, Haiku, Fable, o-series and peers). Base64 PDF bytes are never redacted.
Assign neutral packet IDs outside the packet and give `judge-prompt.md` to one
Claude judge and one Codex judge independently. The harness launches neither.

Original manifests remain immutable. Add an adjudicated sibling named
`manifest.adjudicated.json`, with the same facts plus:

```json
{
  "adjudication": { "revision": 1 },
  "judges": [
    { "judge": "claude", "pass": true, "violations": [] },
    { "judge": "codex", "pass": true, "violations": [] }
  ]
}
```

This is an illustration of the added fields, not a complete manifest. Both
judges must assess/pass every rubric item. Disagreement stays unresolved; obtain
new evidence/rerun rather than averaging. The analyzer allows the original and
adjudicated copy to coexist, but rejects changes to original run facts and
conflicting duplicate revisions.

Pin a green engine commit, Bun, model/CLI IDs and checker/price versions for a
checkpoint. C1 combines E1 deterministic checks, D × both agents, and G's twelve
task groups × both agents in runtime context (record the T09 split in the budget).
Scorers supply held-out cases. Randomize paired run order with a recorded seed;
this single-arm runner never silently selects an agent for a paid run.

The compact-guide gate adds B, seed 2 where runtime outcomes differ, and source
spot checks T02/T05/T06/T07 × both agents × both arms. Compare G-only directories:

```sh
bun evals/agent/analyze.mjs --A /path/to/A --B /path/to/B
bun evals/agent/analyze.mjs --A /path/to/A --B /path/to/B --json
```

Pairs use `(context, task, agent, seed)` after attempt/adjudication selection.
The table shows selected attempts; totals per arm and full attempt histories
remain available so survivor bias is visible. The analyzer rejects unresolved
infra, missing pairs, model/CLI/checker/engine mismatches, identical guide hashes,
unresolved rubrics and missing seed-2 follow-ups. All six merged rules apply:
zero B violations/no new class; task-group B−A lower 95% bound ≥−5 pp; no dual-agent
task collapse; ≥20% lower median guide bytes with no higher input tokens/failed
calls; retrieval ≥90%; source-spot B≥A. Partial usage cannot establish the cost
gate. The one-sided bootstrap uses 10,000 resamples and seed 460017. `pairedDelta`
is the task-group mean; `perRunDelta` is labeled separately. With about twelve
groups this bound is conservative: a single negative group can reject B even
when the per-run mean looks small. The threshold is not relaxed.

C-01…C-30 (H-docs claim audit) and R01–R04 remain E2b slots before C2/W3:
R01 worktree/focused test/rebuild; R02 seeded query-contract regression;
R03 supplied-fact component/coverage/lock/render; R04 printable-symbol repair
preserving continuous goldens. They are not runnable tasks here; H1/H2 remain
scorer-owned. Any task/checker change bumps the eval version and requires
previous-checkpoint replay before comparing scores.

## Verification

```sh
VITEST_MAX_WORKERS=2 bun run test -- evals/agent
VITEST_MAX_WORKERS=2 bun run check
bun evals/agent/run.mjs --agent reference --all --checkpoint references-new
bun evals/agent/probe-sandbox.mjs --runtime evals/out/agent/references-new/context/engine
```

The optional sandbox probe needs a local Codex CLI, but makes no model call. It
compares direct/shimmed validation inside the Codex workspace sandbox, including
an unwritable audit path. Normal tests use synthetic transcripts, fake auth CLIs,
policy negatives and one reference pipeline smoke with checker-only recovery. Full reference,
auth-readiness and sandbox probes stay outside the normal check. Verification
timings and the final harness hash are recorded in the worktree's `PR.md`.

## G3 replay and event provenance

On f0bfabd the guide permissions quoted above are unchanged, including schema
repair on lines 93–94. Required retrieval IDs now use `agent-requests` (formerly
requests) and `report-filtering` (formerly reports), matching G3's topic index.
The D briefs remain byte-for-byte frozen; appendices reflect decision 12's
profile and deferral requirements.

See [event provenance](fixtures/events/README.md) for verified versus inferred
CLI shapes. The earlier gpt-5.4 capture was rejected for ChatGPT login
(model_not_found). Decision 15 approved the new pins above. Exactly one further
trivial Codex capture with gpt-6.1-sol/xhigh succeeded: thread.started →
turn.started → item.completed (agent_message) → turn.completed with usage.
It returned OK with no tools. Recovered retry sequences remain synthetic.
Claude's isolated auth was unavailable and no Claude model call ran.
