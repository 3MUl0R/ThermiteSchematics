export const wiringAdvice = new Map([
  [
    "Keep captions clear of wires.",
    "Manual print review. The terminal-label clearance, wire-label mask and face-clearance browser tests check painted geometry.",
  ],
  [
    "Net labels stay at route source; registered multi-port TTB source symbols widen only when a source net label collides.",
    "Checked by ttb-net-label-source.test.ts, ttb-net-label-variants.test.ts and the DQ-17 browser regression in evals/draw/checker-net-browser.test.mjs.",
  ],
  [
    "See `thermite guide circuit-views` for rail crossings and terminal marks.",
    "The generated guide test resolves this offline topic. Coincident-caption and default-symbol-roles tests cover the drawing conventions.",
  ],
  [
    "Add terminal/wire schedules for complete detail.",
    "Advice for explicit full inventories; required companions cover only the concrete hidden-detail scope.",
  ],
  [
    "Also read `thermite guide circuit-views`; never guess marks; check links/earth/DC ink in both flows.",
    "Manual drawing review advice; geometry and mutations are checked in polarity-qualifiers.test.ts and circuit-operator-fidelity.test.ts.",
  ],
]);
