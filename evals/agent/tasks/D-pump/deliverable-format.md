## Deliverable format

Use the already initialized project and supplied launcher; the historical path is provenance only. Save views in drawings/ (motor-power.pdf, contactor-actuation.pdf); packet.request.json and generated drawings/packet.{json,html,pdf}; drawings/<kind>.csv reports; drawings/{diagnostics,cable,before,review}.json; friction.md. Final deliverables must reflect the final sources: after the guarded change, regenerate every final output. Pre-change outputs may be kept elsewhere.

Write requirement-matrix.json as an array with each ID exactly once, case-insensitive. Fixed statuses: satisfied, substituted, deferred. Shape:

```json
{
  "id": "P-MOTOR",
  "status": "satisfied",
  "designations": ["M1"],
  "evidence": { "summary": "Source and schematic evidence" }
}
```

Satisfied/substituted names must resolve in manifest-listed validated sources and appear on a non-report drawing. Start/stop require the pushbutton profile with NO/NC sense respectively; level requires a level-family profile; indicator requires a lamp profile. Different roles need distinct designations; the same role may be shared by rows such as PLC and coil drive. Explain substitutions. A deferred must row needs its own non-empty designations and a substantive summary, plus either a final diagnostic on its own appropriate device or the listed evidence.libraryGap verified against installed core. A generic limit-switch LS1 can only defer the absent level capability, not satisfy it. A proposed component absent from source may be named only for its specific verified capability gap, with evidence.unmodeled:true; this never claims it is modeled or drawn. Existing unrelated objects cannot stand in for a missing component (PS1 is not a missing pressure transmitter). A deferred may row needs a reason. Draw all modeled non-terminal devices and any designed PSU feed; defer the undesigned feed on the PSU's own diagnostic. Judges assess adequacy, not electrical approval.

- **P-GUIDE (must)**: “Read its AGENTS.md. Record its size and how much you actually needed.”. Roles/gap: deliverable observation.
- **P-SUPPLY (must)**: “480 VAC 3-phase supply”. Roles/gap: supply.
- **P-BREAKER (must)**: “main breaker”. Roles/gap: breaker.
- **P-STARTER (must)**: “motor starter (contactor + overload)”. Roles/gap: contactor, overload.
- **P-MOTOR (must)**: “for a 5 HP pump motor”. Roles/gap: motor.
- **P-PSU (must)**: “24 VDC power supply”. Roles/gap: psu.
- **P-PLC (must)**: “a compact PLC”. Roles/gap: plc.
- **P-TERMINALS (must)**: “a terminal strip in the cabinet”. Roles/gap: terminal.
- **P-CABLE (must)**: “through a multi-core field cable (with at least one explicit spare core)”. Roles/gap: cable; gap: `{"library":"core","capability":"pressure-transmitter"}`.
- **P-START (must)**: “a start pushbutton”. Roles/gap: start-button.
- **P-STOP (must)**: “a stop (NC) pushbutton”. Roles/gap: stop-button.
- **P-COIL (must)**: “the PLC output drives the contactor coil”. Roles/gap: plc, contactor.
- **P-TRANSMITTER (must)**: “a 4-20 mA two-wire pressure transmitter”. Roles/gap: pressure-transmitter; gap: `{"library":"core","capability":"pressure-transmitter"}`.
- **P-ANALOG (must)**: “into a PLC analog input”. Roles/gap: analog-input; gap: `{"library":"core","capability":"analog-input"}`.
- **P-LEVEL (must)**: “a level switch”. Roles/gap: level-switch.
- **P-NETWORK (must)**: “an Ethernet link from the PLC to an HMI”. Roles/gap: plc, hmi; gap: `{"library":"core","capability":"hmi"}`.
- **P-OUTPUTS (must)**: “a validated project with zero errors; a power view of the motor; a control/actuation view of the contactor; a packet (HTML and PDF) with an index, I/O report, BOM, cable schedule, network report; the connection-completeness diagnostics.”. Roles/gap: deliverable observation.
- **P-CHANGE (must)**: “Make one guarded patch change with dry-run then apply, plus snapshot/review.”. Roles/gap: deliverable observation.
- **P-FRICTION (must)**: “Keep a running friction log”. Roles/gap: deliverable observation.

P-GUIDE: record guide bytes and how much you needed in guide-observation.json or friction.md. PDF V1/V5 are additional scorecard judge items; visual inspection is not requested by this pump brief.
