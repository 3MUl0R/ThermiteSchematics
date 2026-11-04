# `@thermite/core-library`

The Bun source alpha and public runtime ship **core 0.1.0 and 0.2.0**. These are
generic electrical models, not manufacturer-certified parts. The package version
is separate from its electrical library versions.

Core **0.1.0 is frozen** at `library/`: its bytes, paths, locator and existing
locks remain unchanged. Core **0.2.0 stays open on dev until the next release
tag, then freezes like 0.1.0**. L1/L2 will extend it separately; L0 retains the
same thirteen type IDs (twelve devices and one cable).

## Selection, files and locks

Select a shipped version by exact name/version, omitting `path`:

```json
{ "name": "core", "version": "0.2.0" }
```

| Version | Package directory | Lock/IR locator          | Diagnostic display root                 |
| ------- | ----------------- | ------------------------ | --------------------------------------- |
| 0.1.0   | `library/`        | `ais-shipped:core@0.1.0` | `@thermite/core-library`                |
| 0.2.0   | `versions/0.2.0/` | `ais-shipped:core@0.2.0` | `@thermite/core-library/versions/0.2.0` |

Each directory contains `library.json` and thirteen declared `types/*.json`
files. `SHIPPED_CORE_VERSIONS` inventories both. The original exported constants
and `resolveShippedCoreLibrary()` continue selecting 0.1.0;
`resolveShippedCoreLibraryVersion(version)` selects an exact version or returns
undefined. The compiler rejects unavailable versions with E032. Resolution is
relative to the installed module, with no registry, network, environment,
`NODE_PATH`, cwd-ancestor or cache discovery. Locators are internal provenance,
not authored paths or registry addresses.

Any explicit dependency `path` selects local resolution, including a library
named core. Both initializer paths now select 0.2.0; the alpha initializer
copies it into visible `libraries/core`, including LICENSE and NOTICE outside
its locked JSON sources. The runtime ships both version directories, compiled
resolver, README, LICENSE and NOTICE.

## Connection and profile review for 0.2.0

All twelve device types declare their catalog `thermite:*` equivalent directly.
Their `connectionCoverage` is **generic**: the abstract interfaces were reviewed,
while exact hardware inventories require part selection. I005 in the completeness
audit includes each device's notes and actual-part limits; it is not a compiler
warning. A model omitting connections of its own intended interface must instead
stay partial (W904). Generic coverage forbids exact-part catalog facts (E014). Each type's notes name modeled points, application-dependent use and
unmodeled features. Existing terminal names, ratings, functions, descriptions,
relations and cable construction are retained; this review adds no hardware facts.

| Type (`core:` prefix) | Universal required points                | Optional by application                                                        | Unmodeled features / limits                                                                                                                                            |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| breaker-3p            | None                                     | Three pole pairs; require both ends of used poles                              | Neutral, bonding, auxiliaries; trip suitability unknown                                                                                                                |
| contactor-3p-1no      | A1, A2 (electrical coil actuation)       | Three main pairs and 13/14                                                     | Extra auxiliaries, suppressors, bonding                                                                                                                                |
| junction-box-8        | None                                     | X1.1–X1.8, independently                                                       | Enclosure bond, shields, connectors; no commoning                                                                                                                      |
| limit-switch-2wire    | 13, 14 (sole sensing circuit)            | None in this interface                                                         | Extra contacts, electronics, bonding                                                                                                                                   |
| motor-3ph             | U, V, W, PE                              | None in this interface                                                         | Winding links, thermal sensors, brakes, heaters, shields                                                                                                               |
| overload-3p-1nc       | 95, 96 (sole modeled trip output)        | Three power pole pairs; require used pairs                                     | Alarm/reset contacts, electronics, bonding; suitability unknown                                                                                                        |
| plc-compact           | L+, M                                    | X1.0, X1.1, X2.0, X2.1                                                         | I/O commons/group power, analog I/O, communications, shields, bonding                                                                                                  |
| prox-pnp-3wire        | 1, 3                                     | Output 4 (may be powered spare)                                                | Shields, configuration pins, bonding                                                                                                                                   |
| psu-24vdc             | L, N                                     | DC +/−; require both for used output circuits                                  | Bonding, shields, sense, alarm/control; AC rating unknown                                                                                                              |
| pushbutton-nc         | 11, 12 (sole stop contact circuit)       | None in this interface                                                         | Illumination, extra contacts, bonding; no safety claim                                                                                                                 |
| supply-480v-3ph       | PE                                       | Phase outputs L1/L2/L3; require used outputs                                   | Neutral, upstream equipment/protection, capacity, extra bonding                                                                                                        |
| terminal-block-8      | None                                     | Isolated points 1–8                                                            | PE terminals, shields, jumpers, multiple landings, bonding                                                                                                             |
| cable-2pair-shielded  | No terminal requirements in cable schema | Review use/spare dispositions for 1+, 1−, 2+, 2−; omitted cores are unassigned | **Reviewed partial:** four conductors and shield/construction are modeled; shield/drain termination, PE, connector pinouts and electrical suitability remain unmodeled |

The cable is the sole **profile/coverage-field exception**: `cable_type` has no
`symbol` or `connectionCoverage` property. Its reviewed partial inventory above
is documentation, not an engine coverage declaration. Cable conductor views
use physical cores rather than device profiles; no schema extension is needed.
Review explicit use/spare dispositions for every core. The engine permits an
omitted core and reports it as unassigned; it does not require every core to be
listed. Legacy two-ended assignments may omit usage, while null endpoints need
an explicit spare declaration.

The overload's 95/96 trip pair is required because the trip contact is the only
modeled output; unwired, the overload cannot interrupt its load. This is an
interface modeling obligation, not an electrical rating or protection-suitability
claim. Power pole use remains application-dependent.

Spare I/O is an instance channel disposition, not a library connection review.
Only terminals used exclusively by explicitly spare channels receive that
unconnected disposition. It does not waive required supplies/commons, partial
coverage, deferred work or project-specific requirements. Optional points still
need application review; promote used pairs/channels with `connectionReview`.

The starter deliberately leaves PS1.L/N unfed, with existing `deferred` reviews
and reasons. W903 retains the missing universal requirement; W905 discloses the
deferral. A fresh starter has zero I003 and zero W904, but `validate --strict`
exits 1 until the feed is designed and its review completed. The fresh cabinets
template exits 0 under strict validation. Reviewed generic models with all required
points connected do not incur W904. Zero I003 means reviewed coverage, not
complete wiring or electrical safety. See
[connection completeness](../../docs/completeness.md).

## Deliberate migration

Existing projects and copied libraries never update automatically. For a shipped
dependency, change its version to 0.2.0, run `thermite lock`, inspect the source
and lock diff, validate, review completeness and render. Type IDs and UUIDs need
no change; required points can introduce warnings. Genuine partial models retain
W904; generic interfaces carry I005 in the completeness audit.

For a visible local copy, compare and preserve project-specific changes before
replacing its files with 0.2.0. Update the dependency version as well as the local
manifest, regenerate the lock and perform the same review. There is no automatic
migration command. Keep LICENSE and NOTICE when sharing copied libraries.
