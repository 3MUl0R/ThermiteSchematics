# Formats and compatibility

Thermite 0.3.0-alpha.2 supports the formats below through its runtime ZIP and
source workflows. Workspace package versions and original `thermite` interfaces
retain their compatibility identities. These are file and API contracts, not
separate public registry packages.

## Paper and packets

See [view requests, paper and packet contracts](views.md).

## Cable assignments

Cable JSON adds optional `fromLocation`, `toLocation`, and conductor `usage`
(`in-use` or `spare`). Endpoint slots are end A and end B for an annotated cable.
A null endpoint is permitted only for an explicit spare; this cross-field rule
is enforced by the schema package's structural validation (like duplicate core
IDs and identical endpoint checks).

- Two endpoints create the same physical connection regardless of usage.
- One endpoint occupies a terminal but does not invent another endpoint or net.
- Two null endpoints describe an unterminated spare.
- No assignment means unassigned, not spare.
- Legacy assignments without usage remain unspecified; their old canonical
  endpoint ordering and net IDs remain compatible.

The compiler preserves authored A/B order in optional cable `assignments`
metadata. Its connected-conductor topology tables remain reserved for complete
physical endpoint pairs. Invalid dangling core IDs still report E200; partial
terminations participate in E201 exclusive-terminal checks. The old engineering
rules and diagnostic suppression order remain in force.

`buildCableSchedule(ir, cableUid)` returns every physical type core and totals.
New annotated cable queries include that schedule alongside the old connected
conductor list. `netId` identifies a complete physical core connection; null
means there is no complete connection, not that an attached end is de-energized.
Shielded construction is independent of authored shield bonding.

## Libraries and deployment

`thermite init <new-directory>` creates and validates a staged project before
making it available. It copies the exact generic library JSON to `libraries/core`
and writes a relative path reference and fresh integrity lock. Existing projects
using shipped library identities continue to work. The `cabinets` template
provides two cabinets, two used cores, and two loose spare cores.

Generated output cannot overwrite project inputs, requests, libraries, or agent
configuration. Symlinked/hard-linked output paths are rejected. Output must use
SVG, HTML, JSON, PDF, or CSV extensions; a file matching an authored source glob is also
rejected. The CLI uses atomic file replacement for ordinary generated outputs.

Runtime and source workflows use Bun 1.4.2 on the systems listed in
[platform checks](platforms.md). Keep the runtime or source checkout separate
from the electrical project; see [runtime packaging](runtime-package.md).

## Documentation and library metadata

A packet may include `{ "format": "documentation-view-request/0.1", "kind": "io" }`.
Kinds are `bom`, `wires`, `cables`, `terminals`, `io`, `io-ports`, `network`, and
`assemblies`. Only terminal and I/O
requests accept `device`, resolving a unique UID or designation. CLI `report`
exports the same tables as CSV or printable packets. `--json` / `.json` returns
packet data, including SVGs; the query package's `buildDocumentation` API returns
structured rows and columns without drawing geometry.

Device types may declare `category`, `terminalOrder`, and `catalog` with
manufacturer, exact `orderNumber`, `document` (HTTPS URL, title, revision, pages),
and optional `modelingNotes`. E203 requires terminalOrder to include every key
exactly once. Instances may declare `io: { addressSpace, channels }`. Channel
keys must refer to channel functions; each assignment may contain address,
signal and usage (`in-use` or `spare`). E202 rejects unknown channels and exact
case-insensitive duplicate addresses within one authored address space. Address
spaces are case-sensitive identifiers. Addresses are opaque documentation
labels: byte/word overlap, PLC configuration and online state are not validated.

Instances may additionally declare `connectorIo: { addressSpace?, ports }`.
This identifies a connector I/O module and provides socket assignments separately
from terminal channels. The `io-ports` schedule lists every declared connector
on these modules, including ports absent from the assignment dictionary.
See [connector I/O](connector-io.md) for unknown addresses, caps and mapping limits.

Circuit drawings also accept explicit per-function `circuitSymbols` in device
types. E206 rejects unknown function keys and marks incompatible with declared
function kind, terminal count or contact state. See the [closed mark catalog and
diagnostic contract](circuit-symbols.md). The additive specialized marks preserve
existing source formats and the original continuous renderer. Successful packet
results now include an additive `coverage` inventory with explicit circuit/wiring
scope and a separate assembly/communication `coverage.topology` inventory; see
[packet coverage](circuit-views.md#packet-coverage-inventory) and
[topology coverage](topology-coverage.md). The six
guarded agent tool contracts are unchanged.

Symbol profiles are explicit: `thermite:io-module`, `thermite:terminal-strip`,
and `thermite:dc-supply`. Supported shapes are single-terminal channels and bus
points, two-terminal DC loads, and two-terminal DC sources with explicit
positive/return roles. Other shapes remain explicit omissions. Neither a part
name nor a symbol profile creates electrical continuity.

Reports list physical facts. Terminal rows group immediate connections by known
location; missing locations stay unspecified. I/O rows list every declared
channel, external members of its physical net, and authored assignments. The BOM
counts instances by type/location and does not estimate accessories or cable
lengths. CSV quotes fields and prefixes formula-like cells with an apostrophe.
This spreadsheet protection does not mutate source values.

## Compact sheets and references

See [view composition and references](views.md#compact-sheets-and-references).

## PDF and semantic review

See [snapshot, review, watch and PDF](review.md).

## Declared physical continuity review

`continuity-check-request/0.1` is a standalone saved review request, not a project
source extension. `physical-continuity-report/0.1` returns explicit obligations,
resolved endpoint net IDs and model coverage, and satisfied/missing-modeled-path/
indeterminate outcomes. The query API and source-alpha `continuity` command use
only the existing physical net semantics. See [request, exits and limits](continuity-checks.md).
No library or project schema, net derivation or guarded agent contract is changed.
