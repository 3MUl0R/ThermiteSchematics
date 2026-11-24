import type { buildCableSchedule } from "@thermite/query";
import { placeWrappedLines } from "../line-placement.js";
import { cableUsagePlan } from "./cable-usage.js";
import { labelRows, labelMetrics } from "./label-text.js";
import {
  centeredTextExtent,
  fieldTextEndExtent,
  fieldTextRightExtent,
} from "./svg.js";
import { failure } from "./errors.js";
import {
  CABLE_ROW_PITCH,
  CABLE_ENDPOINT_BASELINE,
  CABLE_CORE_BASELINE,
} from "./cable-row-metrics.js";

const endALabelWidth = (row: string) =>
  fieldTextRightExtent(row, 2.7, false, true);
const endBLabelWidth = (row: string) =>
  fieldTextEndExtent(row, 2.7, false, true);
const centerLabelWidth = (row: string) =>
  centeredTextExtent(row, 2.6, false, true);

type Core = ReturnType<typeof buildCableSchedule>["cores"][number];
type Alignment = "left" | "right" | "center";

function cableGroupBaselines(
  rows: readonly string[],
  size: number,
  base: number,
): number[] {
  return placeWrappedLines(
    rows.map((text) => ({ text, size, literal: true })),
    base,
    CABLE_ROW_PITCH,
  ).map((placed) => placed.y);
}

function cableLabelGroup(
  rows: readonly string[],
  width: number,
  size: number,
  base: number,
  align: Alignment,
) {
  return {
    rows,
    baselines: cableGroupBaselines(rows, size, base),
    width,
    size,
    align,
  };
}

export function cableRowPlan(
  core: Core,
  cable: string,
  b: { left: number; right: number; jacketL: number; jacketR: number },
) {
  const end = (e: Core["endpoints"][number], w: number, rightEdge: boolean) =>
    e === null
      ? [core.status === "unassigned" ? "? UNASSIGNED" : "X UNTERMINATED"]
      : labelRows(
          e.display,
          w,
          2.7,
          rightEdge ? endBLabelWidth : endALabelWidth,
        );
  const aWidth = b.jacketL - b.left - 8,
    zWidth = b.right - b.jacketR - 8,
    centerWidth = b.jacketR - b.jacketL - 6;
  const a = end(core.endpoints[0], aWidth, false),
    z = end(core.endpoints[1], zWidth, true);
  const centerRows = labelRows(
    `${core.id} / ${core.color}${core.size ? ` / ${core.size}` : ""}`,
    centerWidth,
    2.6,
    centerLabelWidth,
  );
  const usage = cableUsagePlan(core.usage, centerWidth);
  const aGroup = cableLabelGroup(
      a,
      aWidth,
      2.7,
      CABLE_ENDPOINT_BASELINE,
      "left",
    ),
    zGroup = cableLabelGroup(z, zWidth, 2.7, CABLE_ENDPOINT_BASELINE, "right"),
    centerGroup = cableLabelGroup(
      centerRows,
      centerWidth,
      2.6,
      CABLE_CORE_BASELINE,
      "center",
    );
  const groups = [aGroup, zGroup, centerGroup];
  const constraint = rowConstraint(
    [
      ...groups,
      { rows: usage.rows, width: centerWidth, size: 2.5, align: "center" },
    ],
    cable,
    core.id,
  );
  if (constraint) return failure("unprintable-layout", constraint);
  const oldMid =
    Math.max(a.length, z.length, centerRows.length) * CABLE_ROW_PITCH + 1;
  const midOffset = Math.max(oldMid, ...groups.map(groupBottom));
  const value = {
    a,
    z,
    centerRows,
    aBaselines: aGroup.baselines,
    zBaselines: zGroup.baselines,
    centerBaselines: centerGroup.baselines,
    usage,
    midOffset,
    extraHeight: usage.extraHeight + midOffset - oldMid,
  };
  return { ok: true, value } as const;
}

function groupBottom(g: {
  rows: readonly string[];
  baselines: readonly number[];
  size: number;
}) {
  return Math.max(
    ...g.rows.map(
      (r, i) => (g.baselines[i] ?? 0) - labelMetrics(r, g.size).bottom + 1.15,
    ),
  );
}

function rowRequiredWidth(row: string, size: number, align: Alignment): number {
  if (align === "left") return fieldTextRightExtent(row, size, false, true);
  if (align === "right") return fieldTextEndExtent(row, size, false, true);
  return centeredTextExtent(row, size, false, true);
}

function rowConstraint(
  groups: readonly {
    rows: readonly string[];
    width: number;
    size: number;
    align: Alignment;
  }[],
  cable: string,
  core: string,
) {
  for (const g of groups)
    for (const row of g.rows) {
      const required = rowRequiredWidth(row, g.size, g.align);
      if (required > g.width + 0.001)
        return `Cable ${cable}.${core} label ${JSON.stringify(row)} needs ${required.toFixed(2)} mm; ${g.width.toFixed(2)} mm available, short by ${(required - g.width).toFixed(2)} mm. Use a larger sheet or landscape.`;
    }
}
