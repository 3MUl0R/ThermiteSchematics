import type { IrFunction, IrDeviceType } from "@thermite/compiler";
import type {
  SymbolDefinition,
  SymbolPoint,
  SymbolPrimitive,
  SymbolSide,
} from "./types.js";

export type FunctionWord =
  | "NO"
  | "NC"
  | "DI"
  | "DO"
  | "AI"
  | "AO"
  | "PNP"
  | "coil"
  | "motor"
  | "source"
  | "load";
export type PrintableMark = SymbolDefinition["id"] | `circuit:${string}`;
export type GlyphWords = Readonly<
  Partial<Record<PrintableMark, readonly FunctionWord[]>>
>;
const GLYPH_WORDS: GlyphWords = Object.freeze({});

/** Physical ink dimensions; rooted drawing units are converted at composition time. */
export const PRINTABLE_SYMBOL_POLICY = Object.freeze({
  enclosureStrokeMm: 0.18,
  conductorStrokeMm: 0.4,
  enclosureDashMm: Object.freeze([0.6, 0.6] as const),
  minimumGapMm: 0.3,
  color: "#17212b",
  rootedMmPerUnit: 0.25,
  // R4 may list a word here only after that mark carries the same fact in ink.
  glyphWords: GLYPH_WORDS,
});

export function sourceEnclosureInk(mmPerUnit = 1) {
  return {
    strokeWidth: PRINTABLE_SYMBOL_POLICY.enclosureStrokeMm / mmPerUnit,
    dash: PRINTABLE_SYMBOL_POLICY.enclosureDashMm
      .map((v) => v / mmPerUnit)
      .join(" "),
    color: PRINTABLE_SYMBOL_POLICY.color,
  };
}

export type PrintableCaption =
  | { readonly kind: "internal-key" }
  | { readonly kind: "aggregate"; readonly mark: SymbolDefinition["id"] }
  | {
      readonly kind: "function";
      readonly fn: IrFunction;
      readonly type: IrDeviceType;
      readonly mark: PrintableMark;
    }
  | {
      readonly kind: "channel";
      readonly fn: IrFunction;
      readonly type: IrDeviceType;
      readonly address?: string;
      readonly spare: boolean;
    }
  | {
      readonly kind: "relation" | "relation-summary";
      readonly functions: readonly IrFunction[];
      readonly destination: string;
    };

function functionWord(
  fn: IrFunction,
  type: IrDeviceType,
): FunctionWord | undefined {
  if (fn.kind === "contact") return fn.normal_state === "open" ? "NO" : "NC";
  if (fn.kind === "coil") return "coil";
  if (fn.kind === "source") return "source";
  if (fn.kind === "load") return "load";
  if (fn.kind !== "channel") return undefined;
  const roles = fn.terminals.map(
    (t) => type.terminals.find((p) => p.key === t.terminalKey)?.role,
  );
  if (fn.direction === "input")
    return roles.includes("analog_input") ? "AI" : "DI";
  return roles.includes("analog_output") ? "AO" : "DO";
}

/** Keys identify source objects; printable captions carry authored or derived facts. */
export function printableCaption(
  caption: PrintableCaption,
  glyphWords: GlyphWords = PRINTABLE_SYMBOL_POLICY.glyphWords,
): string {
  switch (caption.kind) {
    case "internal-key":
      return "";
    case "aggregate": {
      const word =
        caption.mark === "ais:motor-3ph"
          ? "motor"
          : caption.mark === "ais:switch-sensor-pnp"
            ? "PNP"
            : caption.mark === "ais:power-source-3ph" ||
                caption.mark === "ais:power-source-dc"
              ? "source"
              : undefined;
      return word && !glyphWords[caption.mark]?.includes(word) ? word : "";
    }
    case "function": {
      const word = functionWord(caption.fn, caption.type);
      return word && !glyphWords[caption.mark]?.includes(word) ? word : "";
    }
    case "channel":
      return [
        caption.address ?? functionWord(caption.fn, caption.type),
        caption.spare ? "SPARE" : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    case "relation-summary": {
      const kinds = new Set(caption.functions.map((fn) => fn.kind));
      const kind = kinds.size === 1 ? caption.functions[0]?.kind : undefined;
      const noun =
        kind === "contact"
          ? "contact"
          : kind === "coil"
            ? "coil"
            : kind === "channel"
              ? "channel"
              : kind === "source"
                ? "source"
                : kind === "load"
                  ? "load"
                  : "function";
      return `${caption.functions.length} ${noun}${caption.functions.length === 1 ? "" : "s"}: ${caption.destination}`;
    }
    case "relation":
      return `${caption.functions.map((fn) => (fn.kind === "coil" ? "coil" : fn.terminals.map((t) => t.terminalKey).join("-"))).join(", ")}: ${caption.destination}`;
  }
}

export interface SourceEnclosureOpening {
  readonly side: SymbolSide;
  /** Coordinate along the enclosure edge, in the caller's drawing units. */
  readonly at: number;
}

/**
 * An enclosure with gaps around each terminal stub. Callers retain their port
 * anchors and draw independent leads; no outline segment may touch a lead.
 * Both symbol families use this geometry, in their own drawing units.
 */
export function sourceEnclosure(
  bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  openings: readonly SourceEnclosureOpening[],
  clearance: number,
): readonly Extract<SymbolPrimitive, { kind: "line" }>[] {
  const { x, y, width, height } = bounds;
  const edges = [
    {
      side: "west",
      low: y,
      high: y + height,
      point: (v: number): SymbolPoint => ({ x, y: v }),
    },
    {
      side: "east",
      low: y,
      high: y + height,
      point: (v: number): SymbolPoint => ({ x: x + width, y: v }),
    },
    {
      side: "north",
      low: x,
      high: x + width,
      point: (v: number): SymbolPoint => ({ x: v, y }),
    },
    {
      side: "south",
      low: x,
      high: x + width,
      point: (v: number): SymbolPoint => ({ x: v, y: y + height }),
    },
  ] as const;
  return edges.flatMap((edge) => {
    const cuts = openings
      .filter((o) => o.side === edge.side)
      .map((o) => o.at)
      .sort((a, b) => a - b);
    const lines: Extract<SymbolPrimitive, { kind: "line" }>[] = [];
    let start = edge.low;
    for (const at of [...cuts, edge.high + clearance]) {
      const end = Math.min(edge.high, at - clearance);
      if (end > start)
        lines.push({
          kind: "line",
          from: edge.point(start),
          to: edge.point(end),
          style: "enclosure",
        });
      start = Math.max(start, at + clearance);
    }
    return lines;
  });
}
