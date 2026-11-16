import {
  horizontalLabelSupport,
  ownedLabelLeader,
  labelLeaderArrow,
  labelFrameObstacles,
} from "../layout/wire-label-support.js";
import type { LayoutLabel, NormalizedSchematicLayout } from "../types.js";
import type { SvgWriter, SvgAttributes } from "./writer.js";
import { OUTER_SVG_PADDING } from "../symbols/catalog.js";
import { printableLabelGeometry } from "../symbols/printable-label.js";
import { printableFitAttributes } from "../symbols/printable-font.js";
import { svgSemanticId } from "./escape.js";
const global = (value: number) => value + OUTER_SVG_PADDING;
export function emitLabelInk(
  writer: SvgWriter,
  label: LayoutLabel,
  printed: string,
  capacity: number,
  layout: Readonly<NormalizedSchematicLayout>,
  mmPerUnit: number,
  attributes: SvgAttributes,
) {
  const position = printableLabelGeometry(
    label,
    printed,
    capacity,
    label.ownerKind === "edge"
      ? [layout.edges.find((e) => e.id === label.ownerId)?.points ?? []]
      : undefined,
  );
  emitOwnedLabelLeader(writer, label, position.ink, layout, mmPerUnit);
  writer.element(1, "rect", {
    class: `label-background label-${label.role}`,
    x: global(position.ink.left),
    y: global(position.ink.top),
    width: position.ink.right - position.ink.left,
    height: position.ink.bottom - position.ink.top,
  });
  writer.element(
    1,
    "text",
    {
      class: `label-text label-${label.role}`,
      ...attributes,
      "clip-path": `url(#${svgSemanticId("clip", [label.id])})`,
      x: global(position.x),
      y: global(position.baseline),
      "font-family": "Thermite Sans, Thermite Math, sans-serif",
      "font-size": 10,
      "text-anchor": "start",
      "dominant-baseline": "alphabetic",
      ...printableFitAttributes(printed, 10, capacity),
    },
    printed,
  );
}

function emitOwnedLabelLeader(
  writer: SvgWriter,
  label: LayoutLabel,
  ink: { left: number; right: number; top: number; bottom: number },
  layout: Readonly<NormalizedSchematicLayout>,
  mmPerUnit: number,
) {
  const reach = 2 / mmPerUnit;
  if (label.ownerKind !== "edge") return;
  const own = [layout.edges.find((e) => e.id === label.ownerId)?.points ?? []];
  const foreign = layout.edges
    .filter((e) => e.id !== label.ownerId)
    .map((e) => e.points);
  if (horizontalLabelSupport(ink, own, reach, foreign)) return;
  const box = (r: { x: number; y: number; width: number; height: number }) => ({
    left: r.x,
    right: r.x + r.width,
    top: r.y,
    bottom: r.y + r.height,
  });
  const points = ownedLabelLeader(
    ink,
    box(label),
    own,
    {
      foreign,
      obstacles: [
        ...layout.nodes
          .filter((n) => ["symbol", "rail", "junction"].includes(n.kind))
          .map(box),
        ...layout.labels.filter((l) => l.id !== label.id).map(box),
        ...layout.nodes
          .filter((n) => n.kind === "location" || n.kind === "device")
          .flatMap((n) => labelFrameObstacles(box(n))),
      ],
      bounds: { left: 0, top: 0, right: layout.width, bottom: layout.height },
      strokeClearance: 1,
    },
    reach,
  );
  if (!points) return;
  const path = (ps: readonly { x: number; y: number }[]) =>
    ps
      .map((p, i) => `${i ? "L" : "M"} ${global(p.x)} ${global(p.y)}`)
      .join(" ");
  writer.element(1, "path", {
    class: "wire-label-leader",
    "data-label-leader-owner": label.ownerId,
    d: path(points),
    fill: "none",
    stroke: "#475467",
    "stroke-width": 0.5,
    "stroke-dasharray": "2 1.5",
  });
  writer.element(1, "path", {
    class: "wire-label-leader-arrow",
    d: path(labelLeaderArrow(points)),
    fill: "none",
    stroke: "#475467",
    "stroke-width": 0.5,
  });
}
