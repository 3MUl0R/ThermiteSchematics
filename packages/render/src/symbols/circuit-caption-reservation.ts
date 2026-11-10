import { CAPTION_CLEARANCE_MM, CaptionPlacementError } from "./caption-ink.js";
import { printableTextMetrics } from "./printable-font.js";

interface CaptionOwner {
  width: number;
  device: { designation: string };
  relationLabels: readonly string[];
  pins: { x: number; side: string }[];
}

/** Validate with the emitter's actual local ink before ELK. Only an owner
 * without a legal caption position receives an extra measured side lane.
 * Existing printable nodes, wrapping and port identities stay unchanged. */
export function reserveCircuitCaptions<Node extends CaptionOwner>(
  nodes: Node[],
  vertical: boolean,
  probe: (node: Node) => unknown,
): void {
  const gap = CAPTION_CLEARANCE_MM + 0.4 / 2 + 0.002;
  for (const node of nodes) {
    if (!vertical && !node.relationLabels.length) continue;
    for (let attempt = 0; ; attempt++) {
      try {
        probe(node);
        break;
      } catch (error) {
        if (!(error instanceof CaptionPlacementError) || attempt === 2)
          throw error;
        const metrics = [
          printableTextMetrics(node.device.designation, 2.7, true),
          ...node.relationLabels.map((s) => printableTextMetrics(s, 2.3)),
        ];
        node.width +=
          Math.max(...metrics.map((m) => m.right - m.left)) + 2 * gap;
        if (!vertical)
          for (const p of node.pins) if (p.side === "EAST") p.x = node.width;
      }
    }
  }
}
