import { fieldTextLeft, fieldTextRight, text } from "./svg.js";
import {
  CABLE_USAGE_EM,
  CABLE_USAGE_PITCH,
  type cableUsagePlan,
} from "./cable-usage.js";
import {
  CABLE_OPEN_END_CAPTION_LIFT,
  CABLE_USAGE_BASELINE,
} from "./cable-row-metrics.js";

type CableRowLabels = {
  a: readonly string[];
  z: readonly string[];
  centerRows: readonly string[];
  aBaselines: readonly number[];
  zBaselines: readonly number[];
  centerBaselines: readonly number[];
  usage: ReturnType<typeof cableUsagePlan>;
};

export function cableRowLabels(
  plan: CableRowLabels,
  position: { left: number; right: number; y: number; midY: number },
  endpoints: readonly unknown[],
): string[] {
  const { left, right, y, midY } = position;
  const midX = (left + right) / 2;
  const liftA = endpoints[0] === null ? CABLE_OPEN_END_CAPTION_LIFT : 0;
  const liftZ = endpoints[1] === null ? CABLE_OPEN_END_CAPTION_LIFT : 0;
  const baseline = (baselines: readonly number[], index: number) =>
    baselines[index] ?? 0;
  return [
    ...plan.a.map((row, index) =>
      text(
        "body",
        fieldTextLeft(left, row, 2.7, false, true),
        y + baseline(plan.aBaselines, index) - liftA,
        row,
        2.7,
        "start",
        400,
        true,
      ),
    ),
    ...plan.z.map((row, index) =>
      text(
        "body",
        fieldTextRight(right, row, 2.7, false, true),
        y + baseline(plan.zBaselines, index) - liftZ,
        row,
        2.7,
        "end",
        400,
        true,
      ),
    ),
    ...plan.centerRows.map((row, index) =>
      text(
        "body",
        midX,
        y + baseline(plan.centerBaselines, index),
        row,
        2.6,
        "middle",
        400,
        true,
      ),
    ),
    ...plan.usage.rows.map((row, index) =>
      text(
        "body",
        midX,
        midY + CABLE_USAGE_BASELINE + index * CABLE_USAGE_PITCH,
        row,
        CABLE_USAGE_EM,
        "middle",
        400,
        true,
      ),
    ),
  ];
}
