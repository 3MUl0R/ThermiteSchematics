import type { PreparedSchematicDrawing } from "../renderer.js";
import {
  OUTER_SVG_PADDING,
  verticalSourcePortSpacing,
} from "../symbols/catalog.js";
import {
  labelInkWidth,
  splitTwoLineNetLabel,
  twoLineNetLabel,
} from "../presentation/net-label-wrap.js";
import {
  MIN_PITCH_CLEARANCE,
  originatingSymbolPortId,
} from "../presentation/vertical-source-spacing.js";
import type { PresentationLabel, SymbolPresentationNode } from "../types.js";
import { protectedDrawingIntervals } from "./rooted-geometry.js";
import { mergedIntervals } from "./safe-cuts.js";
import { bankBounds, continuationBanks } from "./continuation-bank.js";
import { rootedSpace } from "./rooted-build.js";
import type { RootedSearch } from "./rooted-search.js";
import type { PaperPage } from "./types.js";

export interface OversizedVerticalSourceNetLabels {
  readonly potentialNames: readonly string[];
  readonly wrappableLabelIds: ReadonlySet<string>;
}

function collectBlockingSourceLabels(
  p: PreparedSchematicDrawing,
  node: SymbolPresentationNode,
  maxSymbolWidth: number,
  availableWidthMm: number,
  scale: number,
  potentialNames: Set<string>,
  wrappableLabelIds: Set<string>,
): void {
  const spec = verticalSourcePortSpacing(node.symbolId);
  if (spec === undefined) return;
  const southPorts = node.ports
    .filter((port) => port.side === "south")
    .sort((left, right) => left.offset - right.offset);
  const layoutLabels = new Map(p.layout.labels.map((l) => [l.id, l]));
  for (const [index, port] of southPorts.entries()) {
    for (const edge of p.graph.edges) {
      const netLabel = edge.netLabel;
      if (netLabel === undefined) continue;
      if (originatingSymbolPortId(p.graph, edge) !== port.id) continue;
      const inkWidth = labelInkWidth(netLabel);
      const pitch = Math.ceil((inkWidth + MIN_PITCH_CLEARANCE) / 2) * 2;
      const forcesWidth =
        index < southPorts.length - 1 &&
        spec.widthForPitch(pitch) > maxSymbolWidth + 0.001;
      const box = layoutLabels.get(netLabel.id);
      const boxOverflows =
        box !== undefined && (box.width + 24) * scale > availableWidthMm + 0.001;
      if (!forcesWidth && !boxOverflows) continue;
      recordBlockingLabel(netLabel, inkWidth, potentialNames, wrappableLabelIds);
    }
  }
}

function recordBlockingLabel(
  netLabel: PresentationLabel,
  currentInkWidth: number,
  potentialNames: Set<string>,
  wrappableLabelIds: Set<string>,
): void {
  potentialNames.add(netLabel.text);
  if (netLabel.lines !== undefined) return;
  const lines = splitTwoLineNetLabel(netLabel.printableText ?? netLabel.text);
  if (lines === undefined) return;
  if (labelInkWidth(twoLineNetLabel(netLabel, lines)) < currentInkWidth) {
    wrappableLabelIds.add(netLabel.id);
  }
}

/**
 * Identify TTB vertical source net labels whose width forces a protected span
 * beyond `availableWidthMm` at `scale`, returning both the authored potential
 * names (for actionable R006 diagnostics) and the subset that can wrap onto two
 * lines at an existing separator.
 */
export function oversizedVerticalSourceNetLabels(
  p: PreparedSchematicDrawing,
  availableWidthMm: number,
  scale: number,
): OversizedVerticalSourceNetLabels | undefined {
  if (p.view.flow !== "top-to-bottom") return undefined;
  const { protectedX } = protectedDrawingIntervals(p.layout, OUTER_SVG_PADDING);
  const intervals = mergedIntervals(protectedX);
  const layoutNodes = new Map(p.layout.nodes.map((n) => [n.id, n]));
  const potentialNames = new Set<string>();
  const wrappableLabelIds = new Set<string>();
  for (const node of p.graph.nodes) {
    if (node.kind !== "symbol" || node.orientation !== "top-to-bottom") continue;
    if (verticalSourcePortSpacing(node.symbolId) === undefined) continue;
    const box = layoutNodes.get(node.id);
    if (box === undefined) continue;
    const left = box.x + OUTER_SVG_PADDING;
    const right = left + box.width;
    const enclosing = intervals.find((i) => i.start <= left && i.end >= right);
    if (enclosing === undefined) continue;
    const spanMm = (enclosing.end - enclosing.start) * scale;
    if (spanMm <= availableWidthMm + 0.001) continue;
    const maxSymbolWidth =
      node.symbolSize.width - (spanMm - availableWidthMm) / scale;
    collectBlockingSourceLabels(
      p,
      node,
      maxSymbolWidth,
      availableWidthMm,
      scale,
      potentialNames,
      wrappableLabelIds,
    );
  }
  return potentialNames.size > 0
    ? { potentialNames: [...potentialNames], wrappableLabelIds }
    : undefined;
}

export function wrappableVerticalSourceNetLabelIds(
  run: RootedSearch,
  page: PaperPage,
): ReadonlySet<string> | undefined {
  const ids = new Set<string>();
  for (const { p, profile } of run.prepared) {
    if (p.view.flow !== "top-to-bottom") continue;
    const { b, scale } = rootedSpace(p, page, !!profile);
    const banks = continuationBanks(
      p,
      b,
      scale,
      run.referenceOffset ?? 0,
      true,
    );
    const maxAvailable = Math.max(
      b.w,
      ...banks.map((bank) => bankBounds(b, bank).w),
    );
    const found = oversizedVerticalSourceNetLabels(p, maxAvailable, scale);
    if (found === undefined) continue;
    for (const id of found.wrappableLabelIds) ids.add(id);
  }
  return ids.size > 0 ? ids : undefined;
}
