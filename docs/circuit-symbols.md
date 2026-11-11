# Function-level circuit symbols

A device type may declare an optional `circuitSymbols` object. Its keys name
actual functions in that same type; its values select marks from a closed
catalog. This lets a motor breaker show its power contacts as breakers and its
auxiliary contacts as NO/NC contacts, while retaining one physical device.

```json
{
  "symbol": "thermite:breaker",
  "circuitSymbols": {
    "pole1": "breaker",
    "pole2": "breaker",
    "pole3": "breaker",
    "fault": "contact-no",
    "interlock": "contact-nc"
  }
}
```

The example assumes those five functions are explicitly declared: `fault` is
normally open and `interlock` normally closed. Unspecified functions retain the
renderer profile's mapping. Function names do not imply a symbol or electrical
behavior. Circuit drawings honor compatible explicit marks before profile
defaults. Rooted power views also honor the supported contact marks on fuse and
breaker profiles, as described below; other profiles keep their existing rules.

The compiler checks each explicit mark against these function shapes:

| Mark | Function kind | Terminal count | Additional requirement |
| --- | --- | --- | --- |
| `contact-no`, `switch-no`, `pushbutton-no`, `pressure-no`, `level-no` | contact | 2 | `normal_state: "open"` |
| `contact-nc`, `switch-nc`, `pushbutton-nc`, `pressure-nc`, `level-nc` | contact | 2 | `normal_state: "closed"` |
| `breaker`, `overload`, `fuse` | contact | 2 | — |
| `coil`, `solenoid` | coil | 2 | — |
| `motor`, `heater`, `load`, `receptacle`, `ac-input` | load | 2 or 3 | — |
| `lamp` | load | 2 | — |
| `winding` | load or source | 2 | — |
| `source` | source | 1–4 | — |
| `dc-output` | source | 2 | — |
| `terminal`, `earth` | bus | 1 | — |
| `interface` | channel | 1 or 2 | — |
| `interface` | other | 1–32 | — |
| `level-sensor` | other | 2 or 3 | — |
| `level-sensor` | channel | 1 or 2 | — |
| `conductivity-probe` | other | 2–8 | — |
| `thermocouple`, `fuse` | other | 2 | — |

`mechanism` functions have no terminals and cannot receive a mark. Choosing
`earth` does not create a bond or assign a protective-earth terminal role.
Terminal roles, ratings, wires, jumpers and cable cores remain explicit source
facts. A drawing mark never joins physical nets, including a normally closed
contact, transformer winding or fuse.

Unknown marks fail schema validation (E014). **E206** reports a missing function
key or incompatible kind, terminal count or contact state. It points to the
individual `circuitSymbols` value and links the relevant function/type declaration.
All loaded library types are checked, including unused types. Correct the
library metadata, regenerate its lock, and validate again; do not alter electrical
facts merely to force a preferred mark.

The IR retains the optional map as `IrDeviceType.circuitSymbols` and source
locations as `circuitSymbolSources`. Both are detached from loaded source objects
and preserved by canonical IR serialization, so saved/reloaded IR produces the
same diagnostics. Old types without the map acquire neither field.

Pressure and float contact marks depict an actuator together with the authored
normal contact state. The sensor/probe and receptacle marks identify an interface;
they do not infer pin roles, probe technology, float behavior or GFCI protection.
`ac-input` must be explicitly chosen when AC conversion is known. A two-terminal
`thermite:dc-supply` source uses the DC output mark; the input retains the generic
power mark unless explicitly bound to `ac-input`.

A `thermite:transformer` circuit block places its primary load windings opposite
its secondary source windings on one shared magnetic core. Each winding retains
its two distinct physical terminals. The core is a presentation association;
series/parallel wiring still requires explicit wires or jumpers. Selecting one
winding shows only that winding and its source-backed references. The drawing
neither infers a turns ratio nor asserts galvanic isolation.

### Transformer control sources

Rooted control also accepts a two-terminal transformer source whose terminals
both have the secondary role. Input and return must reach distinct terminals on
distinct nets of the same source function. Wiring chooses feed and return,
preserving X1/X2 labels when reversed; array order assigns no polarity.
Primary/load windings gain no rooted power or loads binding. Ambiguous or
incompatible source pairs refuse with R002. The drawing does not establish
voltage, waveform or coil compatibility. The
[unrated transformer fixture](../packages/core-library/test/fixtures/transformer-control/source.json)
exercises this drawing convention without a coil rating or waveform claim.

The catalog uses original Thermite geometry, not reproduced legacy drawings or
a claim of compliance with a particular symbol standard. The
[synthetic example](../examples/functional-symbols/README.md) demonstrates these
marks, separate PE, an explicit primary jumper, and a twelve-pin interface in
both flows. The maximum generic interface size is 32 pins; readable paper fit is
still checked and can return R006.

## Shared printable vocabulary

Fuse and breaker profiles resolve power symbols per function. An open unmarked
contact on a fuse-profile type draws as a plain NO contact, including a monitor
contact on a fuse base. Unmarked `other/2`, a closed unmarked `contact/2`, or an
explicit `fuse` mark retains fuse identity. Other compatible contact marks use
their authored identity: `breaker`, `overload`, `contact-no/nc`, `switch-no/nc`
and `pushbutton-no/nc`. Unmarked breaker main pairs use their power roles;
auxiliary contacts retain their normal state. Pressure and level marks, and
non-fuse `other/2` marks, have no rooted power primitive and refuse with R002 and
a specific cause. Use a circuit view for those supported circuit marks.

Overload-profile power contacts use the same per-function explicit contact marks
and refuse pressure and level marks with R002 and circuit-view advice. Power
still requires ordered `power_input`/`power_output` terminal roles; an explicit
mark does not grant a binding to another shape or role pair. Unmarked power
contacts retain the overload pole. There is no overload `other/2` binding;
non-overload marks on that shape receive an explicit power refusal cause too.
Overload control and circuit behavior is unchanged: control retains its auxiliary
contact defaults, and circuit views retain compatible authored marks.

Control retains its narrower protection policy. Fuse control accepts unmarked
`other/2`, an explicit `fuse` mark, or a closed unmarked `contact/2`. Breaker
control accepts unmarked contacts or `breaker`, `contact-no` and `contact-nc`
marks. Other identities refuse with R002 rather than acquire protective ink.
Circuit views preserve compatible explicit marks; an unmarked open fuse contact
draws as contact-no there too. If any selected circuit function cannot be drawn,
the whole view refuses with R006 and names the selected keys; it is never omitted.

Rooted and circuit views use independently authored, IEC-informed marks from the
printable policy. A coil is a rectangle; AC/DC appears only from its authored
coil-terminal voltage class. A breaker uses a blade and cross without inferred
trip technology. Aligned authored breaker and disconnector gangs get a nonconductive mechanical
link where the corridor is clear. Unmarked overload power poles use a stepped thermal
element; their auxiliary contact uses its own authored normal state. Protection
elements have no NC/NO caption. NO/NC contacts differ by the NC stroke.

`thermite:disconnector` is a canonical profile with no alias. It draws an open
blade, gap and fixed-contact disconnector bar in power, control and circuit
views. Opting in asserts author-selected disconnector-function identity. Isolation
suitability (impulse withstand, contact gap, position indication, lockability),
load-break and ratings are not asserted. No manual-operator linkage or trip
element is drawn. Gang ink requires authored `ganged_with` relations and a clear,
aligned corridor; unaligned poles retain their device tags and terminal pairs.
Power requires `power_input`/`power_output` roles in authored function order;
control retains switch traversal. Loads and signal-loop bindings are absent.
Main contacts require `normal_state: "open"`. A contact with role `aux` on both
real terminals draws as a plain contact of its authored open or closed state in
control and circuit views. This auxiliary exception adds no power binding or
main-blade gang decoration. Closed main contacts still refuse: R002 in rooted
views and R006 for circuit defaults. W111 and render refusals name
`closed contact/2` when state is the failed constraint; arity or role failures
keep their own descriptions.
There is no new `circuitSymbols` override value. Core 0.2.0's `disconnect-3p`
opts in; project-local switch types require an explicit profile change. On older
engines the unknown profile can validate with a renderability warning, but rooted
rendering refuses with R002. A profile change never changes physical nets.

Motor marks carry M, with 3~ only for a three-phase profile or a function with
explicit U/V/W phase-input roles. A three-terminal L/N/PE function does not
establish three phases.
Core 0.2.0's `estop-nc` uses `thermite:estop` (mushroom head and latch), and
`selector-2pos` uses `thermite:selector` (rotary handle and maintained detents).
They inherit the function/family support of `thermite:pushbutton` and
`thermite:switch`. Custom types opt in by profile; tags and descriptions do not
select operator identity. Core 0.1.0 source bytes stay frozen.

Both families use bundled Noto Sans Regular/Bold, plus Noto Sans Math for missing
mathematical glyphs. R2's shared model bounds individual glyphs; it models no
OpenType positioning or substitution features. GPOS, GSUB, GDEF and legacy/AAT
layout tables are removed from the faces used for exact metrics, SVG/HTML WOFF
subsets and PDFKit. Glyph outlines, advances and hinting are unchanged; PDFKit
embeds its own subsets of those feature-free faces. Unicode fallback positioning
and NFC normalization remain; no OpenType shaping feature is delivered.
Rooted labels use natural advance or compression down to 0.91. Necessary caption
reservations and containing node widths widen; the complete slot list is recorded
in the R4 handoff. Symbol bounds and electrical ports stay fixed. The opaque
plate uses the same exact ink box as validation. No artwork is copied and no
standards compliance or safety performance is claimed.

Breaker auxiliary captions are placed beside their owning contact and checked
against nearby ink. If no clear position fits, the renderer omits the redundant
NO/NC caption and reports `W907`; the contact mark still shows the authored state.

Rooted vertical NO/NC captions occupy a measured slot beside their own contact.
The renderer reserves and validates that slot before ELK routing, retaining the
leaf envelope and electrical port anchors. Caption ink clears the contact and
nearby wiring by at least 1 mm at printed scale.
