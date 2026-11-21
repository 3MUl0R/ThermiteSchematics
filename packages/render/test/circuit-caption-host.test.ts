import { expect, it } from "vitest";
import { captionHostWitness } from "./helpers/circuit-caption-host.js";
import { circuitCaptionPlacement } from "../src/circuit/caption-placement.js";
import { plannedCircuitCaption } from "../src/circuit/caption-plan.js";
import { InlineLabelCollisionError } from "../src/layout/inline-label-error.js";

it("requires a caption placement when a short tail prevents the fully coincident fallback", async () => {
  const [line, i, label, state] = await captionHostWitness();
  const owner = { ...label, x: 145, y: 98.1 };
  const a = { x: 140, y: 100 },
    b = { x: 165, y: 100 };
  for (const end of [b, { x: 164.75, y: 100 }]) {
    const blocked = {
      ...state,
      labels: [owner],
      segments: [
        { index: label.index, a, b },
        { index: 0, a, b: end },
      ],
    };
    expect(circuitCaptionPlacement(line, i, owner, blocked)).toBeUndefined();
    if (end !== b)
      expect(() => plannedCircuitCaption(line, i, owner, blocked)).toThrow(
        InlineLabelCollisionError,
      );
  }
});
