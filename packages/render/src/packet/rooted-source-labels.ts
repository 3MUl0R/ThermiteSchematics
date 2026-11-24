import type { PreparedSchematicDrawing } from "../renderer.js";
import {
  OUTER_SVG_PADDING,
  verticalSourcePortSpacing,
  type VerticalSourcePortSpec,
} from "../symbols/catalog.js";
import {
  labelInkWidth,
  originatingSymbolPortId,
  sourceTerminalCaptions,
  splitTwoLineNetLabel,
  twoLineNetLabel,
} from "../presentation/net-label-wrap.js";
import { MIN_PITCH_CLEARANCE } from "../presentation/vertical-source-spacing.js";
import type {
  LayoutLabel,
  LayoutNode,
  PresentationLabel,
  SymbolPresentationNode,
} from "../types.js";
import { protectedDrawingIntervals } from "./rooted-geometry.js";
import type { Interval } from "./rooted-cuts.js";
import { mergedIntervals } from "./safe-cuts.js";
import { bankBounds, continuationBanks } from "./continuation-bank.js";
import { rootedSpace } from "./rooted-build.js";
import type { RootedSearch } from "./rooted-search.js";
import type { PaperPage } from "./types.js";

const COMPACT_HEADER_MARGIN = 8;

export interface OversizedVerticalSourceNetLabels {
  readonly potentialNames: readonly string[];
  readonly wrappableLabelIds: ReadonlySet<string>;
  readonly fitsWithTwoLine: boolean;
}

interface SourceNetLabelEntry {
  readonly netLabel: PresentationLabel;
  readonly portIndex: number;
  readonly box: LayoutLabel | undefined;
}

interface SourceInSpan {
  readonly node: SymbolPresentationNode;
  readonly spec: VerticalSourcePortSpec;
  readonly southCount: number;
  readonly box: LayoutNode;
  readonly deviceBox: LayoutNode | undefined;
  readonly entries: readonly SourceNetLabelEntry[];
}

function sourceNodeWidthForSymbol(
  node: SymbolPresentationNode,
  symbolWidth: number,
): number {
  if (node.contentBox === undefined) {
    const headerWidth = Math.max(
      0,
      ...node.labels
        .filter(
          (label) =>
            label.ownerKind === "symbol" &&
            (label.role === "function" || label.role === "aggregate"),
        )
        .map((label) => label.width),
    );
    return Number(
      (Math.max(symbolWidth, headerWidth) + COMPACT_HEADER_MARGIN * 2).toFixed(
        3,
      ),
    );
  }
  return Number(
    Math.max(0, node.width - (node.symbolSize.width - symbolWidth)).toFixed(3),
  );
}

function symbolWidthForLabels(
  source: SourceInSpan,
  inkWidthOf: (label: PresentationLabel) => number,
): number {
  const baseWidth = source.spec.widthForPitch(source.spec.defaultPitch);
  if (source.node.symbolSize.width <= baseWidth) {
    return source.node.symbolSize.width;
  }
  let maxInk = 0;
  for (const entry of source.entries) {
    if (entry.portIndex >= source.southCount - 1) continue;
    maxInk = Math.max(maxInk, inkWidthOf(entry.netLabel));
  }
  const pitch = Math.max(
    source.spec.defaultPitch,
    Math.ceil((maxInk + MIN_PITCH_CLEARANCE) / 2) * 2,
  );
  return Math.max(
    baseWidth,
    Math.min(source.node.symbolSize.width, source.spec.widthForPitch(pitch)),
  );
}

function sourceEntriesForNode(
  p: PreparedSchematicDrawing,
  node: SymbolPresentationNode,
  layoutLabels: ReadonlyMap<string, LayoutLabel>,
): { readonly southCount: number; readonly entries: SourceNetLabelEntry[] } {
  const southPorts = node.ports
    .filter((port) => port.side === "south")
    .sort((left, right) => left.offset - right.offset);
  const indexByPort = new Map(southPorts.map((port, i) => [port.id, i]));
  const entries: SourceNetLabelEntry[] = [];
  for (const edge of p.graph.edges) {
    const netLabel = edge.netLabel;
    if (netLabel === undefined) continue;
    const portIndex = indexByPort.get(originatingSymbolPortId(p.graph, edge));
    if (portIndex === undefined) continue;
    entries.push({
      netLabel,
      portIndex,
      box: layoutLabels.get(netLabel.id),
    });
  }
  return { southCount: southPorts.length, entries };
}

function fixedSpanUnitsInside(
  p: PreparedSchematicDrawing,
  enclosing: Interval,
  sources: readonly SourceInSpan[],
): number {
  const excludedNodeIds = new Set<string>();
  const excludedPortIds = new Set<string>();
  const excludedLabelIds = new Set<string>();
  for (const source of sources) {
    excludedNodeIds.add(source.node.id);
    excludedNodeIds.add(source.node.deviceGroupId);
    for (const port of source.node.ports) excludedPortIds.add(port.id);
    for (const entry of source.entries) excludedLabelIds.add(entry.netLabel.id);
  }
  const excludedEdgeIds = new Set(
    p.graph.edges
      .filter((edge) =>
        excludedPortIds.has(originatingSymbolPortId(p.graph, edge)),
      )
      .map((edge) => edge.id),
  );
  const fixed: Interval[] = [];
  const inside = (start: number, end: number) =>
    start >= enclosing.start - 0.001 && end <= enclosing.end + 0.001;
  for (const node of p.layout.nodes) {
    if (node.kind === "location" || excludedNodeIds.has(node.id)) continue;
    const start = node.x + OUTER_SVG_PADDING - 12;
    const end = node.x + node.width + OUTER_SVG_PADDING + 12;
    if (inside(start, end)) fixed.push({ start, end });
  }
  for (const label of p.layout.labels) {
    if (
      excludedLabelIds.has(label.id) ||
      (label.ownerKind === "port" && excludedPortIds.has(label.ownerId))
    ) {
      continue;
    }
    const start = label.x + OUTER_SVG_PADDING - 12;
    const end = label.x + label.width + OUTER_SVG_PADDING + 12;
    if (inside(start, end)) fixed.push({ start, end });
  }
  for (const edge of p.layout.edges) {
    if (excludedEdgeIds.has(edge.id)) continue;
    for (const point of edge.points) {
      const start = point.x + OUTER_SVG_PADDING - 6;
      const end = point.x + OUTER_SVG_PADDING + 6;
      if (inside(start, end)) fixed.push({ start, end });
    }
  }
  return Math.max(0, ...mergedIntervals(fixed).map((i) => i.end - i.start));
}

function labelOverhangShrink(
  container: LayoutNode,
  entries: readonly SourceNetLabelEntry[],
  widthOf: (label: PresentationLabel) => number,
): number {
  let curLeft = 0;
  let simLeft = 0;
  let curRight = 0;
  let simRight = 0;
  for (const entry of entries) {
    if (entry.box === undefined) continue;
    const shrink = Math.max(0, entry.box.width - widthOf(entry.netLabel));
    const left = Math.max(0, container.x - entry.box.x);
    const right = Math.max(
      0,
      entry.box.x + entry.box.width - (container.x + container.width),
    );
    curLeft = Math.max(curLeft, left);
    simLeft = Math.max(simLeft, Math.max(0, left - shrink));
    curRight = Math.max(curRight, right);
    simRight = Math.max(simRight, Math.max(0, right - shrink));
  }
  return curLeft - simLeft + (curRight - simRight);
}

function counterfactualSpanUnits(
  enclosing: Interval,
  fixedUnits: number,
  sources: readonly SourceInSpan[],
  symbolWidthOf: (source: SourceInSpan) => number,
  labelWidthOf: (label: PresentationLabel) => number,
): number {
  let totalShrink = 0;
  let minRequired = fixedUnits;
  for (const source of sources) {
    const simNodeWidth = sourceNodeWidthForSymbol(
      source.node,
      symbolWidthOf(source),
    );
    totalShrink += Math.max(0, source.box.width - simNodeWidth);
    totalShrink += labelOverhangShrink(
      source.deviceBox ?? source.box,
      source.entries,
      labelWidthOf,
    );
    minRequired = Math.max(minRequired, simNodeWidth + 24);
    for (const entry of source.entries) {
      minRequired = Math.max(minRequired, labelWidthOf(entry.netLabel) + 24);
    }
  }
  return Math.max(minRequired, enclosing.end - enclosing.start - totalShrink);
}

function collectBlockingLabels(
  sources: readonly SourceInSpan[],
  excessUnits: number,
  availableWidthMm: number,
  scale: number,
) {
  const potentialNames = new Set<string>();
  const wrappedById = new Map<string, PresentationLabel>();
  for (const source of sources) {
    const maxSymbolWidth = source.node.symbolSize.width - excessUnits;
    const forbidden = sourceTerminalCaptions(source.node);
    for (const entry of source.entries) {
      const inkWidth = labelInkWidth(entry.netLabel);
      const pitch = Math.ceil((inkWidth + MIN_PITCH_CLEARANCE) / 2) * 2;
      const forcesWidth =
        entry.portIndex < source.southCount - 1 &&
        source.spec.widthForPitch(pitch) > maxSymbolWidth + 0.001;
      const boxOverflows =
        entry.box !== undefined &&
        (entry.box.width + 24) * scale > availableWidthMm + 0.001;
      if (!forcesWidth && !boxOverflows) continue;
      potentialNames.add(entry.netLabel.text);
      if (entry.netLabel.lines !== undefined) continue;
      const lines = splitTwoLineNetLabel(
        entry.netLabel.printableText ?? entry.netLabel.text,
        forbidden,
      );
      if (lines === undefined) continue;
      const candidate = twoLineNetLabel(entry.netLabel, lines);
      if (labelInkWidth(candidate) < inkWidth) {
        wrappedById.set(entry.netLabel.id, candidate);
      }
    }
  }
  return { potentialNames, wrappedById };
}

function evaluateOverflowingSpan(
  p: PreparedSchematicDrawing,
  enclosing: Interval,
  sources: readonly SourceInSpan[],
  availableWidthMm: number,
  scale: number,
) {
  const fixedUnits = fixedSpanUnitsInside(p, enclosing, sources);
  const baseSpanUnits = counterfactualSpanUnits(
    enclosing,
    fixedUnits,
    sources,
    (source) => source.spec.widthForPitch(source.spec.defaultPitch),
    () => 0,
  );
  if (baseSpanUnits * scale > availableWidthMm + 0.001) return undefined;

  const spanMm = (enclosing.end - enclosing.start) * scale;
  const { potentialNames, wrappedById } = collectBlockingLabels(
    sources,
    (spanMm - availableWidthMm) / scale,
    availableWidthMm,
    scale,
  );
  if (potentialNames.size === 0) return undefined;

  const twoLineSpanUnits = counterfactualSpanUnits(
    enclosing,
    fixedUnits,
    sources,
    (source) =>
      symbolWidthForLabels(source, (label) =>
        labelInkWidth(wrappedById.get(label.id) ?? label),
      ),
    (label) => (wrappedById.get(label.id) ?? label).width,
  );
  const fitsWithTwoLine =
    wrappedById.size > 0 &&
    twoLineSpanUnits * scale <= availableWidthMm + 0.001;
  return {
    potentialNames: [...potentialNames],
    wrappableLabelIds: fitsWithTwoLine ? [...wrappedById.keys()] : [],
    fitsWithTwoLine,
  };
}

function verticalSourcesInDrawing(p: PreparedSchematicDrawing): SourceInSpan[] {
  const layoutNodes = new Map(p.layout.nodes.map((node) => [node.id, node]));
  const layoutLabels = new Map(
    p.layout.labels.map((label) => [label.id, label]),
  );
  const sources: SourceInSpan[] = [];
  for (const node of p.graph.nodes) {
    if (node.kind !== "symbol" || node.orientation !== "top-to-bottom")
      continue;
    const spec = verticalSourcePortSpacing(node.symbolId);
    const box = layoutNodes.get(node.id);
    if (spec === undefined || box === undefined) continue;
    const { southCount, entries } = sourceEntriesForNode(p, node, layoutLabels);
    sources.push({
      node,
      spec,
      southCount,
      box,
      deviceBox: layoutNodes.get(node.deviceGroupId),
      entries,
    });
  }
  return sources;
}

/**
 * Identify TTB vertical source net labels when single-line source-label
 * widening is the binding cause of a protected-width overflow. Returns the
 * authored potential names for actionable R006 diagnostics and whether wrapping
 * the selected labels onto two lines makes every overflowing span fit.
 */
export function oversizedVerticalSourceNetLabels(
  p: PreparedSchematicDrawing,
  availableWidthMm: number,
  scale: number,
  availableHeightMm?: number,
): OversizedVerticalSourceNetLabels | undefined {
  if (p.view.flow !== "top-to-bottom") return undefined;
  const { protectedX, protectedY } = protectedDrawingIntervals(
    p.layout,
    OUTER_SVG_PADDING,
  );
  const overflowing = mergedIntervals(protectedX).filter(
    (interval) =>
      (interval.end - interval.start) * scale > availableWidthMm + 0.001,
  );
  if (overflowing.length === 0) return undefined;

  const allSources = verticalSourcesInDrawing(p);
  const potentialNames = new Set<string>();
  const wrappableLabelIds = new Set<string>();
  let fitsWithTwoLine = true;
  for (const enclosing of overflowing) {
    const inSpan = allSources.filter((source) => {
      const left = source.box.x + OUTER_SVG_PADDING;
      const right = left + source.box.width;
      return enclosing.start <= left && enclosing.end >= right;
    });
    if (inSpan.length === 0) return undefined;
    const evaluated = evaluateOverflowingSpan(
      p,
      enclosing,
      inSpan,
      availableWidthMm,
      scale,
    );
    if (evaluated === undefined) return undefined;
    for (const name of evaluated.potentialNames) potentialNames.add(name);
    if (!evaluated.fitsWithTwoLine) fitsWithTwoLine = false;
    for (const id of evaluated.wrappableLabelIds) wrappableLabelIds.add(id);
  }
  if (availableHeightMm !== undefined) {
    const maxHeightMm = Math.max(
      0,
      ...mergedIntervals(protectedY).map((i) => (i.end - i.start) * scale),
    );
    if (maxHeightMm > availableHeightMm + 0.001) fitsWithTwoLine = false;
  }
  return potentialNames.size > 0
    ? {
        potentialNames: [...potentialNames],
        wrappableLabelIds: fitsWithTwoLine ? wrappableLabelIds : new Set(),
        fitsWithTwoLine,
      }
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
    const maxAvailableWidth = Math.max(
      b.w,
      ...banks.map((bank) => bankBounds(b, bank).w),
    );
    const maxAvailableHeight = Math.max(
      b.h,
      ...banks.map((bank) => bankBounds(b, bank).h),
    );
    const found = oversizedVerticalSourceNetLabels(
      p,
      maxAvailableWidth,
      scale,
      maxAvailableHeight,
    );
    if (found === undefined || !found.fitsWithTwoLine) continue;
    for (const id of found.wrappableLabelIds) ids.add(id);
  }
  return ids.size > 0 ? ids : undefined;
}
