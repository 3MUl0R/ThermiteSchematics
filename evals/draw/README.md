# Drawing evaluations (E3)

The source-only kit invokes the built CLI and measures the resulting SVG, real
CLI HTML and direct PDF independently of the renderer's layout estimates.
It does not join `bun run check`: only the browser-free synthetic `*.test.mjs`
files run there. No engine source or electrical project is changed.

```sh
bun install --frozen-lockfile
bun run build
bun evals/draw/run.mjs --checkpoint C1-e3fu
bun evals/draw/run.mjs --checkpoint preview --quick
VITEST_MAX_WORKERS=2 bun run test -- evals/draw
```

Checkpoints are write-once directories under gitignored `evals/out/draw/`.
Open `summary.md`, `summary.json`, `gallery.html` and `reviewer-form.json`.
The JSON sorts keys and observations, rounds coordinates to 0.001 mm, and
contains no timestamps, absolute paths, checkpoint names or wall timings.
`timing.json` and `cost.json` are separate. Compare consecutive full summaries
with `cmp`; use identical checker/marker bytes, engine, corpus and browser.

## Prerequisites and costs

Bun 1.4.2 and R2's existing development dependencies are used:
`playwright-core ^1.64.1`, `pdfjs-dist ^6.5.438`, `@napi-rs/canvas ^1.1.0`.
No extra dependency or browser is installed by a checkpoint. Install Chromium
with `bunx playwright-core install chromium`, or set `THERMITE_DRAW_CHROMIUM`.
Discovery checks macOS `~/Library/Caches/ms-playwright` and Linux
`~/.cache/ms-playwright`; on Windows set the executable path explicitly.
Missing Chromium exits 2 with an installation/path instruction; no silent skips.
A run uses at most two browser pages/case workers.

Strict markers are calibrated on darwin-arm64. Other platforms use
`--report-only`; their font substitutions are not calibrated. Every E3 unit test
is portable and imports no browser, canvas, pdf.js or PDFKit. Seal tests create a
synthetic temporary git repository; check never reads the live corpus.

pdf.js supplies text positions, operators and raster parity. PDFKit is an
optional macOS cross-check (`--pdfkit`); `THERMITE_DRAW_PDFKIT=0` disables it.
The portable historical detector is a labelled construct audit, described below.

Default retained output has a hard **100,000,000-byte** limit, including
`cost.json`; excess is infrastructure failure. Every sheet SVG, direct PDF,
compact IR/query/packet metadata and actual CLI HTML are retained. HTML is measured
then gzipped as `packet.html.gz`; decompress to inspect it. Duplicate SVG/HTML
strings are omitted from packet metadata. Only failing observations with real
on-sheet regions receive 300 dpi crops. Sheet-level or wholly off-sheet findings
have no invented crop. `--artifacts` opts into full-sheet PNGs and uncompressed
HTML, waiving the 100 MB budget. Explicit acceptance samples live separately under
`evals/out/draw-samples/`. Delete old raw checkpoints after archiving summaries.

## Corpus, content seal and sweep

`corpus.mjs` and `corpus/requests.mjs` enumerate frozen cases, referencing shipped
projects and requests by path:

- Fixed-UUID shipped init starter `PS1 --loads`, both flows. It materializes the
  template's declared local core version and alpha-init presentation; this tests
  drawings, while initializer behavior remains in CLI tests.
- Machine-demo, conveyor-line, both motor-starter alpha packets,
  operator-console and functional-symbols, both flows where supported.
- Nine feature examples: circuit-pagination, network-pagination, cap-pagination,
  connector-io, self-loop-labels, topology-coverage, report-filtering,
  assembly-note-bounds and analog-output. Analog-output and an additional
  signal-loop reuse shipped CLI fixtures/requests. Field libraries are copied
  locally and byte-locked; field TTB sheets use the shipped portrait convention.
- EA F3: the starter's first wire gets a 120-ASCII-W display label; the requested
  output is the wire schedule. Electrical facts and UUIDs are preserved.
- D1/D2 packets have a documented deferred E2 slot, never substituted or scored.

The 36-cell sweep is three projects × tabloid/A3/letter × landscape/portrait ×
standard/compact, each executed in both flows (72 cases). Motor-starter covers
power/control; functional-symbols covers circuit/report sheets; report-filtering
covers filtered reports. Full corpus: 108 cases. Flow-neutral schemas are replayed
unchanged rather than receiving an unsupported flow field. Each successful case
runs the built CLI for JSON/SVG, HTML and direct PDF and compiles unchanged IR;
expected report identities/multiplicities come from the public query API.

The reference manifest covers only `git ls-files` drawing JSON inputs, excluding
package/tsconfig JSON and ignored output. A checkpoint explicitly invokes
`seal.mjs --output <checkpoint>/corpus-seal.json`; it never rewrites the reference.
The content hash covers `{format, casesSha256, files}`. `base` records the commit
beside that hash and is not part of it. `--compare <summary.json>` warns only when
content/inventory differs; legacy reports are compared through their adjacent
`corpus-seal.json`. Changed tracked files are listed, not a CI failure.
Run `bun evals/draw/seal.mjs` to update the committed reference only after reviewing
an actual content change. Other workstreams need not reseal.

## Status, strictness and policy

| Status               | Meaning                                                             |
| -------------------- | ------------------------------------------------------------------- |
| pass                 | The stated scoped predicate passed; not a category score.           |
| fail                 | New identity/scope, out-of-band measurement or missing observation. |
| xfail                | A pinned defect remains within its band; still a defect.            |
| xpass                | A pinned defect/scope disappeared; review and retire it.            |
| manual               | Reviewer form, including DQ-03 visual, DQ-04 and DQ-22.             |
| not-implemented      | Explicit missing export or unmeasured portion; no credit.           |
| infrastructure-error | Measurement failed; always exit 2.                                  |

Strict exits mirror E1: 0 has no unexpected failure/stale marker, 1 has fail/xpass,
2 has infrastructure failure. `--report-only` retains failures and xpasses while
permitting historical replay; infrastructure still exits 2. Missing observations
cannot turn green, and a missing PDF scope cannot borrow an SVG observation.

Geometry compares the declared em size with 2.5 mm for primary electrical/report
labels and the documented 2.3 mm for secondary circuit/boundary references, with
one combined advance/em-axis-ratio finding for distortion. The ISO 3098 reading of
2.5 mm as capital height is a separate `iso-cap-height-policy` gap, pinned once
per (font, medium), pending renderer/user adoption (DECISIONS-FOR-USER item 12).

Frame/zone/title furniture has no documented primary-label minimum. Header and
title regions come from the measured frame and full-width divider rules; the top
zone strip ends at the measured ink bottom of the complete 1–6 zone row. The A–D
border column is recognized separately. There is no fixed 35 mm body cutoff.
Owned drawing labels and off-page continuation links are never furniture; bounds,
overlap, distortion and ISO policy still apply to furniture. Secondary captions
come from direct circuit-node roles, exported related-function/boundary metadata
and the primary designation from the IR (or a function's semantic title). Primary
designations keep the primary minimum regardless of y; an unknown role does not
silently receive the lower minimum. Geometry counts exclude `classification: policy-gap`; `policySummary`
reports those observations separately. Full details remain in results and gallery.

SVG/HTML em geometry uses computed CSS size and the actual CTM, independent of
platform font substitution. Capital ratios use the font Chromium resolves from
the declared family, explicitly labelled `fontMeasured`; generic monospace's
concrete platform face is not exported. PDF em sizes and named embedded fonts
come from pdf.js; cap policy uses that font's PDF FontDescriptor CapHeight,
not a macOS substitute. Missing PDF cap metadata is not-implemented. PDF geometry/policy discards clipped duplicate text extractions unless a visible source label matches within two ems; raw extraction remains available to the existing parity checks. SVG/HTML advance and scaled font-cap ratios are not independent rendered-cap
measurements. All three media use one predicate: **max(s, 1/s) > 1.10 + ε**,
with **ε = 1e-9**, a dimensionless floating-point allowance. Here s is horizontal
glyph scale (`advanceRatio`, or PDF horizontal em / vertical em). When both are
available, the worse anisotropy decides. Exactly 1/1.10 and 1.10 pass; 0.907 and
1.105 fail, including PDF. The predicate uses unrounded measurements; report
coordinates/scalars retain their normal 0.001 rounding. One `distorted-glyphs`
finding retains all scales and pins **anisotropy**, rather than compression and
stretch in opposite directions under raw s. Its severity envelope allows ±0.030
dimensionless drift; that envelope never changes the 1.10 predicate or turns a
disappeared finding into an xfail. ISO policy still uses the declared
font's natural capital metric; it does not claim pixel-measured capital ink.

## Ink geometry and calibration

`getBBox()` em boxes are retained as evidence, never used as text-ink collision
boxes. Canvas `actualBoundingBox*` uses SVG-rendered whitespace (XML/CSS collapse
unless preserved). Chromium's real baseline displacement is measured with an
alphabetic clone in the same SVG context, covering middle/central and inherited
baseline semantics. `getStartPositionOfChar`, actual textLength and CTM place the
ink on the sheet. Semantic tiled copies reconcile by source key; non-semantic
copies use their individual source DOM path/local text identity, not undefined.
Lost text reports only its outermost violated container: sheet, frame, viewport,
cell, then clip.

`calibrate.mjs` reuses the reviewer's inkcheck method: isolate each text, keep
clipPath primitives visible, take an integer-aligned 300 dpi crop, and compare
pixel ink against the measured box. Selection is random (seed 4242), stratified
by label role/report/frame class. Require at least 40 labels of each font class:

```sh
INK_FONT=monospace INK_OUT=evals/out/mono-ink.json bun evals/draw/calibrate.mjs \
  evals/out/draw/C1-e3fu machine-demo-left-to-right/1 machine-demo-left-to-right/2 \
  machine-demo-top-to-bottom/1 conveyor-line-top-to-bottom/1 motor-starter-left-to-right/1
INK_FONT=Arial INK_OUT=evals/out/proportional-ink.json bun evals/draw/calibrate.mjs \
  evals/out/draw/C1-e3fu functional-symbols-top-to-bottom/1 \
  circuit-pagination-left-to-right/1 analog-output-left-to-right/1 \
  machine-demo-left-to-right/11 report-filtering-left-to-right/1
```

Round-4 validation: 60 monospace and 60 proportional labels, identical selections
before/after; zero no-ink cases. Worst corrected edge deviation is 0.117 mm.
The accuracy bound is **two raster pixels at 300 dpi**, 0.16934 mm, rounded
outward to **0.170 mm**. Bounds and wire-distance comparisons use this bound;
text/text overlap requires 0.340 mm intersection for two uncertain edges.
The measured report pitch is 3.600 mm (bounds 4.7%, overlap 9.4% of pitch).
The 2.043 mm J1 distance is within noise, not a defect. PR.md records the complete
before/after distributions, two whitespace outliers, and differing compressed/
natural controls. `INK_TEXT` and `INK_MIN_COUNT=2` support those targeted controls.

A wire-label line is inline only when its own measured ink fits inside a shared
block plate that crosses its own conductor (0.170 mm containment uncertainty).
Sharing the block alone grants no exemption: a displaced line is measured normally.
Only the matching own-wire identity is exempt. Distances are from ink
to stroke edge, accounting for half the measured conductor stroke. Foreign
conductors remain checked. The DQ-16 distance threshold is **2.000 + 0.170 =
2.170 mm**. The 32 rooted-label offset markers are distance-only threshold hits,
not evidence of ambiguity: 2.147 mm passes and 2.195 mm fails, so a roughly
0.05 mm glyph/font change can flip them as a group. Their calibrated bands and
strict xpasses are intentional; review grouped flips rather than blindly re-pin.
The historical `ambiguous-wire-label` kind covers both distance and nearer-wire
predicates; evidence names the actual reason. White device/background plates are tested against
foreign conductor ink and, in paint order, foreign text ink. Earlier plates
under later text are not occlusions. Mechanical borders, white conductor halos,
legitimate terminal entries and ordinary crossings have clean controls. Symbol
route penetration remains a geometric check even if an opaque body hides it.
Detour geometry/length is clipped to sheet and viewport before thresholding.

## Checklist coverage

| DQ  | Automated measurement or explicit boundary                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | SVG text-only raster regions versus pdf.js dark ink; ≥8 SVG pixels and <18% retained PDF ink fails. Optional PDFKit. Historical mask audit separate.                       |
| 02  | Real ink bounds/overlap in SVG/HTML, plates, conductor interference, declared-em minima in SVG/HTML/matched PDF, combined em-axis/advance distortion. ISO policy separate. |
| 03  | Independent source-port electrical primitives and foreign route/body/port penetration. Circuit primitive electrical roles need an export; symbol meaning/legend manual.    |
| 04  | Selected-standard glyph/qualifier reviewer form.                                                                                                                           |
| 05  | Default IR function keys/aggregate vocabulary, preserving authored terminal identifiers/descriptions.                                                                      |
| 06  | Designation, authored description and explicit part/rating fields; no inferred electrical rating.                                                                          |
| 07  | Needs printed mirror identities, coil associations and destination exports.                                                                                                |
| 08  | Reciprocal continuations and printed conductor/sheet.zone; destination from measured reciprocal anchor/grid. Ordered ports need an export.                                 |
| 09  | Four borders and independently derived grid zones versus unique printed target references. Ambiguous repeated/spanning appearance anchors are a gap.                       |
| 10  | Measured phase/terminal order in both flows and upright qualifiers.                                                                                                        |
| 11  | Both sweep arms and executed remedies. Refusals remain diagnostics, never unseen visual markers.                                                                           |
| 12  | Packet median content envelope utilisation. Optimal repacking needs block/clearance exports.                                                                               |
| 13  | Stroke hierarchy and filled terminal/junction dots with fewer than three rays.                                                                                             |
| 14  | Distinct conductor endpoints sharing one final landing stroke. Missing physical endpoint identities are a gap.                                                             |
| 15  | Straight-route jogs <3 mm and visible detour >2×Manhattan+20 mm. Curves need segment exports; routing intent still needs review.                                           |
| 16  | Inline own-wire blocks; ink-to-own/competing-conductor distance with calibrated tolerance. Semantic wire identities recovered from emitted source keys.                    |
| 17  | Duplicate/overlapping terminal text and terminal-marker collisions.                                                                                                        |
| 18  | Production title fields and revision history.                                                                                                                              |
| 19  | Report bounds, semantic null placeholders, wire schedule sheet.zone, complete index and public-query row inventory/multiplicity.                                           |
| 20  | Computed font and actual symbol-catalog families per packet.                                                                                                               |
| 21  | Matched PDF/SVG advances, max(0.15 mm,2%) predicate. Split/unmatched text needs an association export.                                                                     |
| 22  | Two independent blind drafter forms, fixed checklist, 100% print scale and material/minor sheet.zone red-lines. No fabricated sign-off.                                    |
| 23  | Graphical terminal-strip availability; actual tables are labelled table-only.                                                                                              |
| 24  | Needs configured numbering policy and number-to-conductor exports.                                                                                                         |

## Marker identity, drift and updates

Markers pin DQ, source family, stable locator, defect kind and check, with exact
case/sheet/medium scopes. Shared storage uses verified content IDs; brace/range
compression expands to exactly the observed scope set, never future cases.
Source identities are designations, terminal/conductor keys and report fields.
Without a stable export, scope is physical sheet plus element class, labelled
coarse. Those can merge indistinguishable same-class defects: inspect counts and
the whole changed area even when xfail. A green run is not drafter approval.

DQ-21 has one font-pair/report/column cause, retaining the existing BaseFont-palette
key and font-pair ratio envelope ±0.05. DQ-19 placeholders have one source-family/
report/column/literal-placeholder cause, with each cell/instance retained as evidence.
DQ-08 missing requirements stay per connector: individual source endpoints can be
fixed separately. DQ-13 dots stay per physical terminal: changing one dot is an
independent visual fix, unlike a report column's shared null-formatting policy.

Bands are `[allowed min, reference min, reference max, allowed max]` scalar
severity envelopes. No absolute coordinates or per-cell measurements enter
identity. Bounds/distance tolerance is 0.170 mm, overlap 0.340 mm, stroke 0.010 mm,
angle 0.5°, jog noise 0.050 mm and em noise 0.030 mm. ISO cap policy stays in its
failing interval (<2.470 mm), with per-font counts/ranges. An out-of-band value
fails with its delta; in-band envelope/count changes appear in drift. Partial
scope envelopes are labelled and are not full-run temporal comparisons. Drift comparison uses the exported
0.001 lattice: a difference of one exported quantum is noise; two or more
quanta are drift. Live and saved values are rounded before this comparison, so
reassessing a saved report cannot invent a binary-subtraction drift. Derived envelope values use that same precision.

An absent pinned scope is an xpass; review whether it was fixed, intentionally
removed, or not measured. Use the guarded `repin.mjs` workflow below.
`update-markers.mjs` is **deprecated legacy tooling**: it binds only the registry,
has no reviewed-cause receipt and must not be used for current checkpoints or the
consolidated re-pin. `pin.mjs` remains an initial-proposal tool, never an updater.

## Cases, samples and historical acceptance

Add a shared source path and shipped request (or documented selection) in
`corpus.mjs`; never customer data or invented electrical facts. Review content
changes and update the reference explicitly if necessary. Inspect each new
finding's source, geometry and both media. Before accepting a family, inspect ten
seeded random, kind-stratified 300 dpi samples, or all if fewer:

```sh
bun evals/draw/samples.mjs evals/out/draw/C1-e3fu review-r4
```

Seed defaults to 4242 (`DRAW_SAMPLE_SEED` overrides it). Red overlays show the
measured finding box (ink for SVG/HTML text); PDF-em geometry is labelled as such.
The isolated raster calibration tests the ink accuracy itself. Samples/forms are
ignored and explicit, never run by check. A family that cannot be confirmed has
zero markers and a documented gap. DQ-22 forms remain unfilled until blind review.

```sh
THERMITE_DRAW_PDFKIT=0 bun evals/draw/run.mjs --checkpoint pre-WS-B \
  --rev '865ca55^1' --case machine-demo-left-to-right --report-only
```

This explicitly selects the compatible historical case; the current core-0.2
starter is unsupported by that old compiler. A temporary detached worktree outside
the repo is installed/built and removed in finally, including SIGINT/SIGTERM.
The pre-WS-B PDF triggers `soft-mask-label-loss-risk`: pdf.js operators show
luminosity-masked glyph origins outside the untransformed page bounds, the
construct Quartz clips. pdf.js itself renders it correctly, so the audit never
fabricates missing raster ink. PDFKit can corroborate it but is not required.
`pdfwhite` separately proves actual ink loss with an intact extracted text layer.
EA F3's old report overflow is fixed by R2; the current wide-label cell must fit.

## Guarded mixed re-pins and consolidated C1

`repin.mjs` applies reviewed deltas to the **existing** registry. It never calls
`seed()`, and never infers approvals from a whole fail row or a cause label.
Unlisted marker fields remain unchanged. `pin.mjs` remains a read-only initial/
legacy proposal generator; it is not the mixed-update path. `update-markers.mjs` is deprecated: it lacks checker-bundle bindings and reviewed
receipts. Use re-pin for current checkpoints, including retire-only updates.

For the current handoff, land E3 first, then re-pin D1 on a fresh dev C1.
R4 replays afterwards and audits its delta against that re-pinned registry
(decision 34); do not combine its new population with the reviewed D1 draft.
For each re-pin, make one full strict report on dev, then
reconcile **one decisions file per merged PR** (decision 13). Use that same target
report/registry/checker-bundle/seal/version binding in every file. Individual lane audits remain
review evidence; old lane report hashes cannot be copied into the consolidated
binding. Re-review their deltas against the consolidated report. No release or C1
score follows a red report.

```sh
bun evals/draw/run.mjs --checkpoint C1-consolidated-before
bun evals/draw/repin.mjs \
  --report evals/out/draw/C1-consolidated-before/summary.json \
  --baseline evals/out/draw/C1-previous/summary.json \
  --inventory evals/out/repin-inventory.json
```

Inventory writes binding values, current instance tokens/facts, stale scopes and
full envelope drift, full measured envelope proposals and baseline instances. It writes no approval decisions.
Tokens address a marker/scope, report row, finding and instance within a hash-bound
report. They are not geometry-derived marker identities. Rename facts compare
kind, source locator, view, medium, case and **exact recorded text**. Changed
text/source locators/views require literal `{from,to}` mappings per pair; no regex or
wildcard matching. Each old/new token can be consumed once. Compact aggregates
without exported instances cannot be proved as renames.

A decisions file has these top-level fields. File hashes cover raw bytes; the
checker hash covers the canonical sorted module manifest described below:

```json
{
  "format": "thermite-draw-decisions/1.0",
  "pr": "#56",
  "summarySha256": "<from inventory>",
  "registrySha256": "<from inventory>",
  "checkerSha256": "<from inventory>",
  "corpusSha256": "<from inventory>",
  "evalsVersion": "4.2",
  "baselineSha256": "<hash of supplied previous summary>",
  "entries": []
}
```

The checker binding hashes a stable sorted list of every drawing-kit `.mjs`, `.js`, `.cjs`, `.ts` and
`.swift` file recursively, including subdirectories such as `corpus/`, including the registry. The target manifest must match the local
files exactly. A changed, removed or added module invalidates the target and its
decisions; run a fresh full 4.2 report. Apply rechecks the bundle inside its lock.
Every supplied `baselineSha256` is validated even if that file has no rename.
Historical full baselines may have older compatible checkers; their raw bytes,
registry and full report are validated, including their own bundle when present.
They are stored observations, not permission to run a stale target checker.

Draft candidates with the shipped helper:

```sh
bun evals/draw/repin.mjs draft --inventory evals/out/repin-inventory.json \
  --pr '#56' --output evals/out/D1-decisions.json
```

It proposes only unique exact-fact instance pairs (allowing a literal view move),
leaves ambiguous and changed-text pairs for inspection, and calculates envelope
proposals from measured ranges and the documented tolerances. It fills **no
cause**: every entry has `reviewed: false`, empty `causeClass`/`note`, and an empty
retirement `cause`. The draft also leaves `signOff.kind` and `signOff.by` empty;
review records the applicable kind and reviewer. New defects have empty crop metadata too. Inspect each delta,
complete the cause/rationale/mappings/crops. **`reviewed: true` signs off those
crops and causes with provenance:** every entry requires
`signOff: {kind: "person" | "agent", by: "<name or agent and review round>"}`.
An agent sign-off must come from a reviewer independent of the change's author
(cross-model). Receipts label it **agent review**, never person's review. The tool
validates the kind and non-empty name, but cannot verify identity, independence,
attention or engineering judgment. A script flipping flags is not review;
automated fixtures mock sign-off solely to test the protocol.
A person may add `counterSignOffs: [{kind:"person",by:"<name>"}]` later, keeping
the original sign-off and all other decision fields unchanged. Receipts retain
both provenances. Unknown/missing kinds and empty names are refused.
The tool refuses an unreviewed entry. With several baselines, select
`--baseline-sha <raw-summary-hash>`. Draft creation is exclusive under `evals/out`.

Every reviewed entry requires `reviewed: true`, `signOff`, `causeClass`, `note` (the review rationale) and
`classification: "drawing"` or `"policy-gap"`. These align with D1's audit's
`markerId`, `causeClass`, exact scope tuples and envelope observations. D1's
`scopeDelta.absent`/`missing` and `renameLink` suggest decisions; they are not
approvals or instance-match evidence. Convert them into explicit entries using
both inventories. Retain `unexplainedItems` as a review checklist outside the
strict decisions schema; an unresolved item must stop the re-pin.

| Action           | Required decision data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retire`         | `markerId`, `scope: {case,sheet,medium}`, `cause: "fixed"`, `"removed"` (intentional content removal), or `"not-measured"`. A compatible check must be measured for fixed/removed, following a declared sheet rename when present. Intentional removal earns no repair credit; a missing observation cannot be booked as fixed/removed. Optional `instances` lists only the leftover baseline tokens of a partially paired old scope.                                                                                 |
| `rename`         | `from` and `to` each contain `markerId` and `scope`; `pairs` is an array of `{from: oldToken, to: newToken, view?: {from,to}, sourceLocator?: {from,to}, text?: {from,to}}`. Case/flow/medium, defect and locator kind, source row and logical view must match. Changed text or column label needs its literal mapping. A changed physical sheet needs a declared rename. Text-changing moves require their own crop. Every old instance and every target instance must be accounted for across the listed decisions. |
| `scope-added`    | `to: {markerId,scope}` on an existing identity and all target tokens in `instances`. Keeps its definition; optional reviewed crop. Use this for an added sheet occurrence, with no repair credit.                                                                                                                                                                                                                                                                                                                     |
| `new-defect`     | `to: {markerId,scope}` on a genuinely new identity, every target token in `instances`, and `crop: {path,sha256}`. Crop must be a retained PNG under `evals/out/draw-samples/`, inside this workspace after symlink resolution. The recorded review accepts the entire explicit instance set; every new-defect entry and every text-changing move must use a distinct non-empty crop file/hash; copying one PNG to different names is refused.                                                                         |
| `envelope-drift` | `markerId`, `metric`, exact `from`, `to`, `observed`, and `coverage: "full"`. Counts use metric `occurrences` and `[min,max]`; scalar bands use `[allowedMin,referenceMin,referenceMax,allowedMax]`. The new reference must equal the full observed range; allowed bounds must equal the measured range plus the documented tolerance; an undrifted metric is refused.                                                                                                                                                |

For example, a count decision records `from: [2,8]`, `to: [4,8]`,
`observed: [4,8]`. Drift is assessed from the bound report **after the listed
scope changes**, using the complete resulting marker population. This matters
when a header moves while old literal body cells disappear, or a sheet is added:
the still-matched old-scope subset is not the full new reference. Every metric
must actually drift at exported precision; an allowed-bound-only edit is refused.
Scalar `to` must exactly equal `bands()` for that measured population, including
the documented tolerance/policy ceiling. DQ-21 `advanceRatio` keeps the marker's
own reference range but takes its **allowed bounds from the whole font pair's
range across the bound report, ±0.05**, exactly as `seed()` does. New identities
use the same function. A per-marker ±0.05 window is refused. Arbitrary widening (such as max 99) and
arbitrary narrowing are refused. Policy-gap count changes need `classification:
"policy-gap"`; they never enter geometry scoring. Partial-scope drift cannot
replace a full reference: quick/selected/report-only inputs are refused.

A `font-pair-drift` decision records `fontPair`, `from` (the sorted unique
old `[allowedMin,allowedMax]` ranges), `to: [allowedMin,allowedMax]`,
`observed: [min,max]`, `coverage: "full"`, and the usual review fields.
The inventory lists `advanceRatioBounds` drift for **every** member of a changed
pair, and the draft proposes one pair-level decision. It expands copy-on-write
to all surviving members, including new identities; its receipt lists every
marker touched. Local reference/count decisions remain separate. A result with
mixed or non-derived pair bounds is refused. This re-pin derivation uses the
whole target population after scope reconciliation; C1's historical measured
statuses and temporal-reference drift are not rewritten by the proposal layer.

A text/source column change also needs an entry-level literal
`columnMap: {from: "Manufacturer", to: "Mfr."}`. Every pair in the entry must
follow that same map. If the old column still has observations in the target
view, the move is refused. Lack of such observations does not prove the column
was removed; the declared column rename remains reviewer judgment.

A `fixed` or `removed` retirement with a structurally compatible `new-defect`
or `scope-added` counterpart is refused, naming both marker IDs and exact instance tokens.
Supply a hash-bound baseline for these retirements, including whole-scope
retirements, so their old instances can be reconciled.
Potential column renames are included conservatively, even before the reviewer
chooses a column map. Book the change as a move, or add an explicit top-level
`notMove` array. Each item is `{from: oldToken, to: newToken, reason, crops}`:
a one-line reason and **two distinct retained PNG crops**, each `{path,sha256}`.
Every candidate pair needs its own declaration; unknown, duplicate and unused
declarations fail. Crops are hash-checked through the same real IO as other
review evidence and cannot be reused elsewhere. The receipt lists these
exceptions under `reviewerJudged.notMove`, never as a tool-proved distinction.

A rename inherits the old definition; it does not silently refresh its bands or
count. A genuinely new identity gets only its reviewed scopes and measured
references with the existing documented tolerances. An existing identity's new
scope keeps its old definition. List any resulting envelope change separately.
Retained old scopes cannot be consumed as renames; if only part of an aggregate
changes while its old scope stays measured, review the newly exposed defect and
its exact count drift instead. Conflicting inherited definitions are refused.

```sh
bun evals/draw/repin.mjs \
  --report evals/out/draw/C1-consolidated-before/summary.json \
  --baseline evals/out/draw/C1-previous/summary.json \
  --decisions evals/out/D1-decisions.json \
  --preview evals/out/consolidated-expectations.mjs
# Review that exact file and the printed projected statuses, then repeat with:
bun evals/draw/repin.mjs \
  --report evals/out/draw/C1-consolidated-before/summary.json \
  --baseline evals/out/draw/C1-previous/summary.json \
  --decisions evals/out/D1-decisions.json \
  --preview evals/out/consolidated-expectations.mjs --apply
bun evals/draw/run.mjs --checkpoint C1-consolidated
```

Preview uses exclusive creation under `evals/out/`. Apply requires that existing
preview to be byte-identical to the freshly computed result, rechecks the current
registry hash under an exclusive cooperative lock, then replaces the registry
atomically. Concurrent command writers refuse the lock; external editors must
not edit the registry or checker files during apply. Stale inputs, changed crops/previews, duplicate
keys, malformed UTF-8, escaping paths, reused pairs, conflicting files, incomplete
instance coverage and any unlisted failure/drift all stop before replacement.
A process killed during apply may leave a lock; inspect it before removing it.

`sheetRenames` optionally declares exact `{case,medium,from,to}` mappings. For
example, `{case:"machine-demo-left-to-right",medium:"svg",from:"sheet:14",to:"sheet:15"}`
records a physical page shift. Literal `pairs[].view` mappings also declare view
scope renames, allowing an old I/O title to resolve to the measured new title.
Conflicting maps and a change of logical view kind are refused. Moves keep their
semantic row (cell row keys are parsed independently of the column label), not
merely an arbitrary pair of texts. An unprovable move must be a fixed retirement
plus a crop-backed new defect, rather than a fabricated locator mapping.
Class-only or aggregate font-pair locators cannot prove a text-changing move;
unchanged literal text may still follow an explicitly declared sheet rename.

Receipts separate `toolProved` structural/measurement/hash checks from
`reviewerJudged` causes, crop sign-offs and rationale. `outcomes` counts fixed
retirements, intentional removals, not-measured retirements, moves (including
changed headers), scope additions, new defects and the explicit `notMove` count
separately. A nonzero `notMove` count makes the reviewer's exceptions visible. These are event
counts, not independently established repairs or category scores. The tool proves
structural correspondence, not intent. Moves, additions and intentional removals
receive no repair credit.

If D1 blanks a bad DQ-19 placeholder, that predicate may be fixed. A DQ-21 advance
finding that disappears only because its text was intentionally blanked is
`removed`, not a typography fix. Under a declared sheet/view rename, fixed and
removed causes are measured on the destination rather than called not-measured.
Keep a changed header in its rename; retire only the removed body instances.
The acceptance requirement remains a **fresh full strict C1 with exit 0 and no
drift**, after review of the applicable decisions, with each sign-off's kind recorded.
