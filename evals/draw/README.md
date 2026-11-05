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
not a macOS substitute. Missing PDF cap metadata is not-implemented. PDF geometry/policy discards clipped duplicate text extractions unless a visible source label matches within two ems; raw extraction remains available to the existing parity checks. SVG/HTML advance and scaled font-cap ratios describe the same anisotropy; they
are not independent rendered-cap measurements. One `distorted-glyphs` finding
combines advance outside [0.90,1.10] and vertical/horizontal em-axis ratio outside
[0.90,1.10], retaining both measured ratios and triggered predicates. PDF uses its
physical em-axis ratio in that same finding. ISO policy still uses the declared
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
scope envelopes are labelled and are not full-run temporal comparisons.

A fixed scope is an xpass, including a D1 blank-cell fix. After reviewing a full
strict report containing only expected defects and xpasses, update the registry
with one command:

```sh
bun evals/draw/update-markers.mjs evals/out/draw/after-D1/summary.json --retire-xpasses --apply
```

It verifies the current registry hash, rejects new failures/infrastructure and
retires only the exact xpassed scopes. It preserves other IDs/bands. For a
reviewable proposal, replace `--apply` with `--output evals/out/retirement.mjs`.
Run a fresh strict checkpoint afterwards. Never regenerate an established
registry blindly. `pin.mjs <full-strict-summary> <ignored-proposal.mjs>` is for
initial proposals only; new defects require source/crop review before pinning.

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

## Adding reviewed C1 findings

For this checker follow-up, the strict discovery run records newly exposed M2
labels. Existing view-scoped font markers already cover them, so this baseline
has count drift rather than new marker keys/scopes. A previously uncovered view
would fail. After inspecting the source labels and crops, create the proposal
through the existing command:

```sh
bun evals/draw/pin.mjs evals/out/draw/C1-e3fu-discovery/summary.json evals/out/e3fu/proposal.mjs
```

Compare expanded identities/scopes and bands against the current registry. Accept
only the reviewed delta; retain every unrelated marker and band. Copy the reviewed
proposal to `evals/draw/expectations.mjs`, then run a fresh strict `C1-e3fu`.
This is an explicitly reviewed C1 re-pin, not routine regeneration of failures.
