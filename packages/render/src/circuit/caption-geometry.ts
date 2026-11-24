import {
  CIRCUIT_CAPTION_PITCH,
  CIRCUIT_CAPTION_SLOT_HEIGHT,
  circuitCaptionSlots,
} from "../symbols/circuit-text.js";
import { printableLabelGeometry } from "../symbols/printable-label.js";
import type { CircuitLabelState } from "./layout-routes.js";

export function circuitCaptionSlot(
  label: CircuitLabelState["labels"][number],
  i: number,
) {
  const slots = circuitCaptionSlots(label.text.split("\n"));
  return (
    slots[i] ?? {
      yOffset: i * CIRCUIT_CAPTION_PITCH,
      height: CIRCUIT_CAPTION_SLOT_HEIGHT,
      fallback: false,
    }
  );
}

export function circuitCaptionGeometry(
  line: string,
  i: number,
  label: CircuitLabelState["labels"][number],
  state: CircuitLabelState,
) {
  const slot = circuitCaptionSlot(label, i);
  return printableLabelGeometry(
    {
      x: label.x,
      y: label.y + slot.yOffset,
      width: label.width,
      height: slot.height,
    },
    line,
    label.width - 1.5,
    state.segments
      .filter((s) => s.index === label.index)
      .map((s) => [s.a, s.b]),
    2.5,
    false,
    undefined,
    true,
  );
}
