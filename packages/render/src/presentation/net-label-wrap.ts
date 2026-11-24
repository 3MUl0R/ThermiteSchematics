import {
  boundedPrintableAdvance,
  printableTextMetrics,
} from "../text-metrics.js";
import type { PresentationGraph, PresentationLabel } from "../types.js";
import { labelWidth } from "./util.js";

export const TWO_LINE_NET_LABEL_PITCH = 14;
export const TWO_LINE_NET_LABEL_HEIGHT = 28;

const NET_LABEL_SEPARATORS = new Set(["-", "_", ".", "/", " "]);

function lineInkWidth(text: string, capacity?: number): number {
  const metrics = printableTextMetrics(text, 10);
  const advance =
    capacity === undefined
      ? metrics.advance
      : boundedPrintableAdvance(text, 10, capacity);
  const scale = metrics.advance ? advance / metrics.advance : 1;
  return (metrics.right - metrics.left) * scale;
}

export function labelInkWidth(label: PresentationLabel): number {
  if (label.lines !== undefined) {
    return Math.max(
      lineInkWidth(label.lines[0], label.textLength),
      lineInkWidth(label.lines[1], label.textLength),
    );
  }
  return lineInkWidth(label.printableText ?? label.text, label.textLength);
}

/**
 * Split a potential name onto two lines at an existing authored separator,
 * preferring the separator closest to the middle and keeping the separator at
 * the end of the first line so concatenating both lines yields the exact name.
 */
export function splitTwoLineNetLabel(
  text: string,
): readonly [string, string] | undefined {
  const chars = Array.from(text);
  const mid = chars.length / 2;
  let best:
    | {
        readonly lines: readonly [string, string];
        readonly distance: number;
        readonly maxWidth: number;
        readonly index: number;
      }
    | undefined;
  for (let i = 0; i < chars.length - 1; i++) {
    const ch = chars[i];
    if (ch === undefined || !NET_LABEL_SEPARATORS.has(ch)) continue;
    const first = chars.slice(0, i + 1).join("");
    const second = chars.slice(i + 1).join("");
    if (!first.trim() || !second.trim() || second.startsWith(" ")) continue;
    const distance = Math.abs(i + 1 - mid);
    const maxWidth = Math.max(lineInkWidth(first), lineInkWidth(second));
    if (
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance && maxWidth < best.maxWidth)
    ) {
      best = { lines: [first, second], distance, maxWidth, index: i };
    }
  }
  return best?.lines;
}

export function twoLineNetLabel(
  label: PresentationLabel,
  lines: readonly [string, string],
): PresentationLabel {
  const width = Math.max(labelWidth(lines[0]), labelWidth(lines[1]));
  return {
    ...label,
    lines,
    width,
    height: TWO_LINE_NET_LABEL_HEIGHT,
    textLength: Number((width - 6).toFixed(3)),
  };
}

export function wrapPresentationNetLabels(
  graph: Readonly<PresentationGraph>,
  labelIds?: ReadonlySet<string>,
): PresentationGraph {
  if (graph.view.flow !== "top-to-bottom" || !labelIds?.size) return graph;
  let changed = false;
  const edges = graph.edges.map((edge) => {
    const netLabel = edge.netLabel;
    if (netLabel === undefined || !labelIds.has(netLabel.id)) return edge;
    const lines = splitTwoLineNetLabel(netLabel.printableText ?? netLabel.text);
    if (lines === undefined) return edge;
    changed = true;
    return { ...edge, netLabel: twoLineNetLabel(netLabel, lines) };
  });
  return changed ? { ...graph, edges } : graph;
}
