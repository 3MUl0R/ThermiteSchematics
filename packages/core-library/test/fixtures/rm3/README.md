# RM3 generic interface inventory

This synthetic fixture contains every basic-machine inventory item from RM3,
plus a dry-contact level switch, junction box and a second relay for a PLC output
sample. It uses only shipped core 0.2.0. It is an interface and rendering fixture,
not a selected, rated or operational machine design.

`starter.json` retains the DOL starter's supply, motor power train and control
circuit. `automation.json` adds the larger PLC, HMI, operators and sensors. All
18 PLC channels have authored logical addresses; 7 are in use and 11 explicitly
spare. The four-core sensor cordset has three connected cores and one loose
spare end. Ethernet is a separate planned relation, with connector and protocol
unspecified, and never joins electrical nets.

The transmitter-to-AI harness has two separate nets through the single-pair cable
and terminal strip. It is deliberately unpowered. It demonstrates two-ended
interface continuity and the existing signal-loop profile; it does not assert
loop power, a current shunt, a configured AI mode or electrical compatibility.
A normal passive-input loop wired through an external power supply fails R006,
with or without an auxiliary supply pair; only the direct TX-to-AI harness draws
today. This is a renderer gap, not a reason to substitute the unpowered harness
for a complete machine loop. Select and review actual loop hardware before service.

`specimens.json` contains the remaining 1P/2P breakers, 2P/3P fuses and a separate
three-pole disconnect. These optional-pole inventory specimens are unconnected;
no pole is selected for service. DS1 is unwired because the existing switch
profile has no power binding: inserting it before Q1 makes the motor power view
fail R002. Its poles draw as plain NO switches, without disconnector identity.
Their ganging and function shapes are retained.
RM3 tests draw every circuit-supported device function, the transmitter signal
loop, all cable cores and the Ethernet link in both flows. L1's matrix separately
pins every catalog family and the rooted successes/gaps, including this new
switch's missing power binding. The packet audit covers circuit/wiring drawings;
it does not yet count signal-loop or conductor-inventory sheets. Tests check
the actual SVG records for those views separately.

Validation has zero errors and warnings, with one honest I304 notice about an
unassessed rated net. Completeness has zero missing required points and I003;
generic and optional/spare connection information remains visible.

PLC/HMI supplies declare DC class without a voltage magnitude. Each supply has
a loads binding. The complete PS1 loads view reaches an existing R004 layout
failure where the PLC/HMI return wires overlap; it is pinned separately from
the successful individual-supply probes. The larger PLC's AI pairs are separate;
isolation and shared returns unspecified.
