# Extract packet composition from sheets.ts

Issue: #43 (part of #17). Target: `dev`.

## Problem and root cause

Packet rendering coupled report metrics, pagination, continuations, indexes and
paper framing inside `packages/render/src/sheets.ts`. Its 419-line orchestrator
also owned reference numbering and family dispatch, so unrelated render work
collided and helper invariants could only be exercised through full packets.

## Change

Move packet composition into internal `packet/*` modules with typed draft,
page and continuation boundaries. Keep request admission, authored view order,
family dispatch, sheet assembly and final coverage validation in the packet
orchestrator. Preserve existing try/catch boundaries, validation order, object
property order, text, geometry and public package exports. No goldens change.

The extraction includes eleven synthetic direct tests for page bounds/zones,
protected cuts, reciprocal continuations and collision refusals, packet-wide
reference numbering, compact-pack zones, folded destinations, filtered reference
appearances, measured cell padding/row heights and identical direct/packet
report-row errors. Existing end-to-end tests remain intact.

P2 can add view context at the dispatch call in `sheets.ts` and use the existing
shared R006 constructor in `packet/errors.ts`. Coverage still enters through
`buildPacketCoverage` at the original final failure boundary; this change adds
no diagnostics or warnings.

## Ownership map

Paths below are relative to `packages/render/src/`. Each invariant has one owner.

| Invariant                                                                                   | Owner                                                                       |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Packet request admission, validation/failure order and packet sheet-count limits            | `sheets.ts`                                                                 |
| View-family dispatch                                                                        | `packet/dispatch.ts`                                                        |
| Paper normalization, title-block space, drawing bounds, zone resolution and framed SVG      | `packet/page.ts`                                                            |
| Protected rooted-page cuts and ELK candidate preference                                     | `packet/rooted.ts`                                                          |
| Compact packing of existing rooted sections                                                 | `packet/folding.ts`                                                         |
| Local reciprocal conductor links, continuation label spacing and circuit part destinations  | `packet/continuations.ts`                                                   |
| Global sheet numbering, continuation serials, authored view indices and destination offsets | `packet/assembly.ts`                                                        |
| Compact topology packing and resulting appearance coordinates                               | `packet/assembly.ts`                                                        |
| Content-only drawing index and filtered device/function reference groups                    | `packet/references.ts`                                                      |
| Fixed-size measured report cells, wrapping, glyph context and cell paint order              | `packet/report-cells.ts`                                                    |
| Report row fit, intact row pagination and report selections                                 | `packet/reports.ts`                                                         |
| Per-report 100-sheet limit                                                                  | `packet/reports.ts`                                                         |
| Cable core rows and complete cable inventory pagination                                     | `packet/cable.ts`                                                           |
| Circuit group/column placement and circuit note fit                                         | `packet/circuit.ts`                                                         |
| Topology diagram/note fitting and topology title construction                               | `packet/topology.ts`                                                        |
| R006 envelope construction                                                                  | `packet/errors.ts`                                                          |
| Packet HTML/viewer wrapper                                                                  | `packet/html.ts`                                                            |
| Unchanged SVG primitives and legacy wrapping policies                                       | `packet/svg.ts`                                                             |
| Shared packet/draft types                                                                   | `packet/types.ts`                                                           |
| Source-identity coverage inventory and rejection of unknown identities                      | `coverage.ts` (unchanged; invoked by `sheets.ts`)                           |
| Topology identity/route conservation                                                        | `layout/topology-conservation.ts` (unchanged; called by family preparation) |

There are no runtime imports from the packet helpers back into `sheets.ts`.
The public index and package export map are untouched; packet modules remain
internal. Type-only edges share packet contracts without runtime cycles.

## Size

Count physical lines including imports, comments and blanks, excluding a trailing
empty line. Count functions with the TypeScript AST: end line minus start line
plus one, from the function's first token through its closing brace; include
nested functions/arrows. The same local `stats.mjs` measures both revisions.

| Metric                                       |                        Before |                  After |
| -------------------------------------------- | ----------------------------: | ---------------------: |
| `sheets.ts`                                  |                         2,471 |                    221 |
| `renderSchematicPacket`                      |                           419 |                    156 |
| Largest function in the changed source scope | 419 (`renderSchematicPacket`) |    198 (`cableDrafts`) |
| Largest resulting source file                |           2,471 (`sheets.ts`) | 269 (`packet/page.ts`) |

Every function in `sheets.ts` and `packet/*` is at most 200 lines; every file is
below 1,200 lines. No size exception was needed.

## Files touched

- `packages/render/src/sheets.ts`: orchestration and compatibility re-exports.
- `packages/render/src/packet/*.ts`: the internal modules listed above.
- `packages/render/test/packet-helpers.test.ts`: direct synthetic invariant tests.
- `packages/render/test/public-api.test.ts`: regression check over emitted packet imports.
- `PR.md`: local review notes, to be removed before commit.

## Verification

- `bun run build`: pass.
- Render suite: 44 files and 741 tests passed; focused helper/public-boundary
  tests: 15 passed.
- `bun scripts/update-shipped-core-goldens.mjs --check`: exit 0.
- `bun scripts/update-task4-goldens.mjs --check`: exit 0 (33 ledger paths,
  6 R005 paths); no golden edits.
- Declaration export comparison: all 66 public symbols and resolved signatures
  match the saved baseline; public index/package export map unchanged. An AST
  token comparison also confirms 24 moved function bodies are unchanged.
- Corpus comparison: **811 cases and 3,434 artifacts match byte for byte**.
  Total: 388 successful packets, 1,010 SVG sheets, 388 HTML documents,
  384 direct PDFs, four expected PDF font refusals and 423 render refusals.
  All refusal JSON matches, including 414 actual CLI stderr captures and
  nine synthetic IR-only cases serialized with the same diagnostic envelope.
  The main matrix has 686 cases: 342 successful packets (689 SVG sheets, 342 HTML documents,
  338 direct PDFs and four expected PDF font refusals), 344 render refusals,
  and 342 actual CLI stderr captures. All 2,745 artifacts match byte for byte.
  Coverage includes all 13 shipped example projects, both E1 corpus projects,
  all 12 E1 topology variants, the generated 300-device/1,500-wire project,
  all eight report kinds and the R2 synthetic report fixtures. Rooted/circuit/
  signal-loop flows are paired where supported; communication, assembly,
  wiring and report schemas do not accept flow options. Invalid requests are
  retained as negative cases. A supplemental matrix exercises valid media,
  mixed-family packets without unsupported flow fields, standard/compact
  layouts, analog output and additional errors. Its 125 cases add 46 successful
  packets, 321 sheets and 79 refusals (72 with actual CLI stderr). Supplemental
  probes include incomplete traces, R004 ambiguous routes in both flows, R005
  text, impossible wire/terminal rows and the source-backed CLI equivalents.
  Comparison includes entire API JSON (therefore codes, messages, details,
  field order, selections, coverage and references), individual SVGs, HTML,
  direct PDF bytes or exact PDF refusal JSON, and real CLI stderr/exit codes.
- `bun evals/run.mjs --checkpoint C0-h1`: exit 0; 295 passed, no expected
  failures, stale markers, unexpected failures or infrastructure errors. Diagnostic
  actionability: 57/57.
- `VITEST_MAX_WORKERS=2 bun run check`: exit 0; 142 test files passed,
  2,663 tests passed and 6 skipped. Type generation, build, text metrics,
  formatting and committed-JSON stability checks all passed.
- `git diff --check`: pass.

Local scripts, saved original build, manifests, exact bytes and logs are under
`.verification-work/h1/`; checkpoint evidence is under `evals/out/C0-h1/`.
Both directories are gitignored. The scripts are intentionally uncommitted:
they contain this worktree's saved build paths and a one-time verification matrix.

## Performance

Both medians are within ±5%. Bun 1.4.2, darwin-arm64, on this shared host.
The machine-demo packet contains all 12 authored views (20 sheets); the large
300-device/1,500-wire fixture renders its complete wire report (72 sheets).
Compile once outside timing, warm each renderer once, then take five paired
samples in one Bun process, alternating order: B/A, A/B, B/A, A/B, B/A.
Complete results are compared outside timing. PDF conversion, hashing and
compilation are excluded. Our corpus/check jobs had finished before timing;
other work on the shared host continued. Raw values are milliseconds, rounded
here to three decimals; unrounded evidence is in `.verification-work/h1/perf.json`.

| Fixture         | Before raw runs                             | After raw runs                              | Before median | After median | Change |
| --------------- | ------------------------------------------- | ------------------------------------------- | ------------: | -----------: | -----: |
| machine-demo    | 383.333, 333.142, 331.005, 336.925, 301.105 | 349.088, 359.080, 323.776, 354.011, 304.303 |       333.142 |      349.088 | +4.79% |
| large 300/1,500 | 48.458, 52.263, 55.223, 41.288, 48.014      | 46.226, 48.002, 49.143, 44.688, 47.698      |        48.458 |       47.698 | -1.57% |

This is the sole completed timing comparison; no samples were discarded.

## Remaining limitations

This is a behavior-preserving extraction. Existing print refusals, report font
fallback/PDF refusals and unaudited coverage limitations remain. No electrical
source, library bytes, golden output, release path, public request format or
project guide changes are included. There is no user-visible rule to document.

The shared host was busy during verification; timing evidence is local and does
not establish cross-platform performance.

## Review round 2

The independent Claude review approved H1 with nits: 5,356 CLI invocations over
4,154 cases were byte-identical to a6bf6ec (including 2,756 failure runs), and
its AST/export/cycle checks were clean. Its pooled timing deltas were -0.14%
for machine-demo and +0.83% for the 300/1,500 fixture. Full independent evidence:
[review.md](../../review-h1/review.md) under the shared scratchpad, as supplied by the reviewer.

Changes in this round:

- Convert all 21 declarations that contained only inline `type` specifiers to
  `import type`. Mixed value/type imports retain real runtime dependencies.
  The built render package now has zero `import {} from` statements;
  `packet/types.js` loads no modules.
- Add a cheap built-file regression test in `public-api.test.ts`: inspect each
  emitted packet JS module for empty named imports and require built files to
  exist. The test failed before the import correction. It uses only filesystem
  reads and a regex matching the compiler's emitted import syntax.
- Add four direct tests for compact-pack zone recomputation, fold destination
  mapping, report-cell padding and printed row heights. All four one-at-a-time
  mutations are killed; the normal source is restored and rebuilt after each.
- Use `DrawingBounds` at the remaining page/circuit sites, merge the duplicate
  imports in circuit/reports and clarify the public contract in `packet/types.ts`.
  `record()` remains in `errors.ts`: there is no existing general utility module
  that is an obvious home. The positional helper signatures are unchanged.
- Add the per-report 100-sheet cap to the ownership map. The largest resulting
  source file is now 269 lines; the largest function remains 198 lines.

Mutation proof (`VITEST_MAX_WORKERS=2 bun run test -- packages/render/test/packet-helpers.test.ts`):

| Probe             | Temporary mutation                               | Observed direct test failure           |
| ----------------- | ------------------------------------------------ | -------------------------------------- |
| Compact zones     | Retain `r.zone` after moving the appearance      | Expected C4, received A4               |
| Fold destinations | Map packed destination to `index + 2`            | Expected sheet 2/1, received sheet 3/2 |
| Cell padding      | Subtract 2 mm instead of 4.01 mm before wrapping | Expected two lines, received one       |
| Row height        | Replace the row-height floor with constant 8 mm  | Expected 7.6 mm, received 8 mm         |

Each mutation command exited 1 in the named direct test; restoration rebuilt
successfully. Logs and the mutation/restoration manifest are under
`.verification-work/h1r2/`. No mutant is staged or left in the working tree.

P2 handoff: failures from `circuitFunctionAppearances` run before the per-view
loop and carry no view index. Final assembly/frame/coverage failures also carry
no view index, as do index-table failures. `Draft` has no view-index field, and
compact packing can merge sheets from consecutive authored views. P2 will need
to record the authored view index in `appendViewDrafts` and account for merged
sheets. This round adds no view provenance or failure context.

Round 2 verification:

- Build and focused helper/public-boundary tests: exit 0, 15 tests passed.
- Both golden `--check` scripts: exit 0; task4 checked 33 ledger paths and
  six R005 paths, with no golden edits.
- `VITEST_MAX_WORKERS=2 bun run test -- packages/render`: exit 0, 44 files
  and 741 tests passed.
- `bun evals/run.mjs --checkpoint C0-h1r2`: exit 0; 295 probes passed,
  no failures/stale markers/infrastructure errors; diagnostics actionable 57/57.
- Own byte comparison against the saved a6bf6ec build: exit 0 for both
  `corpus.mjs after` (686 cases) and `supplement.mjs` (125 cases): all 811 cases
  and 3,434 artifacts remain byte-identical, including SVG/HTML/PDF, full API
  JSON and refusal stderr. The saved baseline source was rechecked byte for byte
  against `git show a6bf6ec:packages/render/src/sheets.ts`.
- `VITEST_MAX_WORKERS=2 bun run check`: exit 0; 142 files passed,
  2,663 tests passed and six skipped (277.09 s for the test phase). Type
  generation, build, metrics, formatting and JSON stability checks also passed.
- Staging: the original staged extraction is retained; code, tests and updated
  `PR.md` are staged. No commit or push.

## Suggested commit message

```text
refactor(render): extract packet composition helpers

Split report cells and pagination, continuations, references, family
composition and paper framing into typed internal packet modules.
Keep packet dispatch, assembly and coverage orchestration in sheets.ts.

Preserve output bytes, diagnostics and public exports. Add direct
synthetic tests alongside the existing packet and golden coverage.
```

No commit, push, external service call or CLA acceptance was performed.
