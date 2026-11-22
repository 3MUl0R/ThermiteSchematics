import type { ConductiveElementId, TerminalId } from "@thermite/compiler";
import type { OffViewConnection } from "./model.js";
import { CARD_FONT, CARD_PAD, CARD_PITCH } from "./card.js";
import { cardTextMetrics, wrapCardText } from "./metrics.js";
import { terminalIdKey } from "../ordering.js";
import { escapeXmlText as xml } from "../svg/escape.js";
import {
  expand,
  inside,
  project,
  separated,
  type Rect,
} from "../device-legend/geometry.js";
import type { NavigationGeometry } from "../packet/navigation-walk.js";
import { navigationObstacles } from "../packet/navigation-slots.js";

const decodeXml = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const fmt = (value: number) => Number(value.toFixed(3));
const MIN_CARD_FONT_MM = 2.52;

function wrapDestinationWords(
  text: string,
  width: number,
  fontSize: number,
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && cardTextMetrics(next, fontSize).width > width + 0.001) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.flatMap((row) =>
    cardTextMetrics(row, fontSize).width <= width + 0.001
      ? [row]
      : wrapCardText(row, width, fontSize),
  );
}

export function formatPeerDestination(destinations: readonly string[]): string {
  const [primary, ...alternates] = destinations;
  if (!primary) return "";
  return alternates.length
    ? `${primary} (also shown ${alternates.join(", ")})`
    : primary;
}

function rowLinesWithDestinations(
  baseText: string,
  destinations: readonly string[],
  innerWidth: number,
  fontSize: number,
): string[] {
  const baseLines = wrapCardText(baseText, innerWidth, fontSize);
  if (!destinations.length) return baseLines;
  const formatted = formatPeerDestination(destinations);
  const last = baseLines[baseLines.length - 1] ?? "";
  if (
    cardTextMetrics(`${last} ${formatted}`, fontSize).width <=
    innerWidth + 0.001
  )
    return [...baseLines.slice(0, -1), `${last} ${formatted}`];
  if (cardTextMetrics(formatted, fontSize).width <= innerWidth + 0.001)
    return [...baseLines, formatted];
  const [primary, ...alternates] = destinations;
  if (!alternates.length)
    return [...baseLines, ...wrapCardText(primary!, innerWidth, fontSize)];
  return [
    ...baseLines,
    primary!,
    ...wrapDestinationWords(
      `also shown ${alternates.join(", ")}`,
      innerWidth,
      fontSize,
    ),
  ];
}

function attrValue(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "u").exec(tag);
  return match ? decodeXml(match[1]!) : undefined;
}

function replaceAttr(tag: string, name: string, value: string | number) {
  const pattern = new RegExp(`(\\b${name}=")[^"]*(")`, "u");
  return tag.replace(pattern, `$1${value}$2`);
}

function elementKey(id: ConductiveElementId): string {
  return id.kind === "cable_conductor"
    ? JSON.stringify([id.kind, id.cableUid, id.conductorId])
    : JSON.stringify([id.kind, id.uid]);
}

export function cardRowKey(
  terminal: TerminalId,
  elementId: ConductiveElementId,
): string {
  return JSON.stringify([terminalIdKey(terminal), elementKey(elementId)]);
}

interface CardLayout {
  width: number;
  height: number;
  fontSize: number;
  headingLines: { tag: string; text: string; baseline: number; offsetX: number }[];
  rowLines: { text: string; baseline: number; offsetX: number }[];
}

function layoutCard(
  headingLines: readonly { tag: string; text: string }[],
  rowSpecs: readonly { baseText: string; destinations: readonly string[] }[],
  widthUnscaled: number,
  fontSize: number,
  scale: number,
  padUnscaled = CARD_PAD,
): CardLayout {
  const innerWidth = widthUnscaled - 2 * padUnscaled;
  const pitch = (CARD_PITCH * fontSize) / CARD_FONT;
  const rows = rowSpecs.flatMap((spec) =>
    rowLinesWithDestinations(
      spec.baseText,
      spec.destinations,
      innerWidth,
      fontSize,
    ),
  );
  const all = [
    ...headingLines.map((h) => ({ text: h.text, bold: true })),
    ...rows.map((text) => ({ text, bold: false })),
  ];
  const metrics = all.map((l) => cardTextMetrics(l.text, fontSize, l.bold));
  const firstBaseline = padUnscaled + Math.max(...metrics.map((m) => m.ascent));
  const positioned = all.map((l, i) => ({
    ...l,
    baseline: firstBaseline + i * pitch,
    offsetX: metrics[i]?.offsetX ?? 0,
  }));
  const heightUnscaled =
    Math.ceil(
      (padUnscaled +
        Math.max(
          ...positioned.map((l, i) => l.baseline + (metrics[i]?.descent ?? 0)),
        )) *
        1000,
    ) / 1000;
  return {
    width: widthUnscaled * scale,
    height: heightUnscaled * scale,
    fontSize: fontSize * scale,
    headingLines: headingLines.map((h, i) => ({
      ...h,
      baseline: positioned[i]!.baseline * scale,
      offsetX: (padUnscaled + positioned[i]!.offsetX) * scale,
    })),
    rowLines: rows.map((text, j) => ({
      text,
      baseline: positioned[headingLines.length + j]!.baseline * scale,
      offsetX:
        (padUnscaled + positioned[headingLines.length + j]!.offsetX) * scale,
    })),
  };
}

function cardFitsClear(
  candidate: Rect,
  oldPageRect: Rect,
  clip: Rect,
  field: Rect,
  obstacles: { ink: readonly Rect[]; texts: readonly Rect[] },
  inkGap: number,
  textGap: number,
) {
  if (!inside(candidate, clip) || !inside(candidate, field)) return false;
  const self = expand(oldPageRect, 0.25);
  for (const t of obstacles.texts) {
    if (inside(t, self)) continue;
    if (!separated(candidate, t, textGap)) return false;
  }
  for (const o of obstacles.ink) {
    if (inside(o, self)) continue;
    if (!separated(candidate, o, inkGap)) return false;
  }
  return true;
}

function chooseCardBox(
  headingLines: readonly { tag: string; text: string }[],
  rowSpecs: readonly { baseText: string; destinations: readonly string[] }[],
  rect: { x: number; y: number; w: number; h: number },
  scale: number,
  visibleCard: NavigationGeometry,
  field: Rect,
  obstacles: { ink: Rect[]; texts: Rect[] },
): { x: number; y: number; layout: CardLayout } | undefined {
  const pageScale = Math.hypot(visibleCard.matrix[0], visibleCard.matrix[1]);
  const oldPageRect = project(rect, visibleCard.matrix);
  const clip = visibleCard.clip;
  const maxWidthUnscaled = Math.max(
    rect.w / scale,
    Math.min(260, (field.w / (pageScale * scale)) * 0.9),
  );
  const tryBoxes = (
    layout: CardLayout,
    inkGap: number,
    textGap: number,
  ): { x: number; y: number; layout: CardLayout } | undefined => {
    const positions = [
      { x: rect.x, y: rect.y },
      { x: rect.x, y: rect.y + rect.h - layout.height },
      { x: rect.x + rect.w - layout.width, y: rect.y },
      { x: rect.x + rect.w - layout.width, y: rect.y + rect.h - layout.height },
    ];
    for (const pos of positions) {
      const candidate = project(
        { x: pos.x, y: pos.y, w: layout.width, h: layout.height },
        visibleCard.matrix,
      );
      if (
        cardFitsClear(
          candidate,
          oldPageRect,
          clip,
          field,
          obstacles,
          inkGap,
          textGap,
        )
      )
        return { x: pos.x, y: pos.y, layout };
    }
    return undefined;
  };

  const singleLineWidth = (fontSize: number, pad: number) =>
    Math.min(
      maxWidthUnscaled,
      Math.max(
        rect.w / scale,
        ...headingLines.map(
          (h) => cardTextMetrics(h.text, fontSize, true).width + 2 * pad,
        ),
        ...rowSpecs.map((s) => {
          const dest = s.destinations.length
            ? ` ${formatPeerDestination(s.destinations)}`
            : "";
          return (
            cardTextMetrics(`${s.baseText}${dest}`, fontSize).width + 2 * pad
          );
        }),
      ),
    );

  // 1. Existing card dimensions at full CARD_FONT (zero box change).
  const sameWidthFull = layoutCard(
    headingLines,
    rowSpecs,
    rect.w / scale,
    CARD_FONT,
    scale,
  );
  if (sameWidthFull.height <= rect.h + 0.05)
    return {
      x: rect.x,
      y: rect.y,
      layout: { ...sameWidthFull, height: Math.max(sameWidthFull.height, rect.h) },
    };

  // 2. Wrap inside existing card width at full CARD_FONT (grow height cleanly).
  for (const [inkGap, textGap] of [
    [1.5, 1.5],
    [0.8, 1.5],
  ] as const) {
    const wrapped = tryBoxes(sameWidthFull, inkGap, textGap);
    if (wrapped) return wrapped;
  }

  // 3. Single-line at full CARD_FONT (grow width cleanly into open space).
  const wideFull = layoutCard(
    headingLines,
    rowSpecs,
    singleLineWidth(CARD_FONT, CARD_PAD),
    CARD_FONT,
    scale,
  );
  for (const [inkGap, textGap] of [
    [1.5, 1.5],
    [0.8, 1.5],
  ] as const) {
    const widened = tryBoxes(wideFull, inkGap, textGap);
    if (widened) return widened;
  }

  // 4. Compact 2.52 mm printed font (>= 2.5 mm floor) inside existing rect or clear growth.
  const printedEmMm = CARD_FONT * scale * pageScale;
  const floorFont = Math.min(
    CARD_FONT,
    Math.max(
      CARD_FONT * (MIN_CARD_FONT_MM / printedEmMm),
      MIN_CARD_FONT_MM / (scale * pageScale),
    ),
  );
  if (floorFont < CARD_FONT - 0.05) {
    const padCompact = Math.max(2.5, (CARD_PAD * floorFont) / CARD_FONT);
    const compactSame = layoutCard(
      headingLines,
      rowSpecs,
      rect.w / scale,
      floorFont,
      scale,
      padCompact,
    );
    if (compactSame.height <= rect.h + 0.05)
      return {
        x: rect.x,
        y: rect.y,
        layout: { ...compactSame, height: rect.h },
      };
    const compactWide = layoutCard(
      headingLines,
      rowSpecs,
      singleLineWidth(floorFont, padCompact),
      floorFont,
      scale,
      padCompact,
    );
    for (const [inkGap, textGap] of [
      [1.5, 1.5],
      [0.8, 1.5],
      [0.4, 0.8],
    ] as const) {
      const fitSame = tryBoxes(compactSame, inkGap, textGap);
      if (fitSame) return fitSame;
      const fitWide = tryBoxes(compactWide, inkGap, textGap);
      if (fitWide) return fitWide;
    }
  }
  return undefined;
}

/** Rewrite packet off-view cards in place to carry resolved sheet.zone destinations
 * with zero ELK reflow, checking sheet obstacles before any box expansion. */
export function injectOffViewCardDestinations(
  svg: string,
  field: Rect,
  geometry: readonly NavigationGeometry[],
  byTerminal: ReadonlyMap<string, readonly OffViewConnection[]>,
  destinationsByRow: ReadonlyMap<string, readonly string[]>,
): string {
  if (!destinationsByRow.size || !svg.includes('class="off-view-annotation"'))
    return svg;
  const obstacles = navigationObstacles(svg, true);
  const visibleCards = new Map<string, NavigationGeometry>();
  for (const g of geometry) {
    if (!g.visible || !g.node.attrs["data-off-view-terminal-id"]) continue;
    const rect = g.node.children.find((n) => n.name === "rect");
    if (!rect) continue;
    const pageRect = project(
      {
        x: Number(rect.attrs.x),
        y: Number(rect.attrs.y),
        w: Number(rect.attrs.width),
        h: Number(rect.attrs.height),
      },
      g.matrix,
    );
    if (!inside(pageRect, expand(g.clip, 0.05))) continue;
    const key = JSON.stringify([
      g.node.attrs["data-off-view-terminal-id"],
      g.node.attrs["data-off-view-conductors"] ?? "[]",
    ]);
    if (!visibleCards.has(key)) visibleCards.set(key, g);
  }
  const placements = new Map<string, { x: number; y: number; layout: CardLayout }>();
  return svg.replace(
    /<g\b[^>]*class="off-view-annotation"[^>]*>[\s\S]*?<\/g>/gu,
    (block) => {
      const openEnd = block.indexOf(">");
      const openTag = block.slice(0, openEnd + 1);
      const terminalRaw = attrValue(openTag, "data-off-view-terminal-id");
      const conductorsRaw = attrValue(openTag, "data-off-view-conductors");
      if (!terminalRaw || !conductorsRaw) return block;
      const terminal = JSON.parse(terminalRaw) as TerminalId;
      const conductors = JSON.parse(conductorsRaw) as ConductiveElementId[];
      if (
        !conductors.some((c) =>
          destinationsByRow.get(cardRowKey(terminal, c))?.length,
        )
      )
        return block;
      const rectMatch = /<rect\b[^>]*class="off-view-card"[^>]*\/>/u.exec(
        block,
      );
      const headingMatches = [
        ...block.matchAll(
          /<text\b[^>]*class="off-view-heading"[^>]*>([\s\S]*?)<\/text>/gu,
        ),
      ];
      if (!rectMatch || !headingMatches.length) return block;
      const rectTag = rectMatch[0];
      const rect = {
        x: Number(attrValue(rectTag, "x")),
        y: Number(attrValue(rectTag, "y")),
        w: Number(attrValue(rectTag, "width")),
        h: Number(attrValue(rectTag, "height")),
      };
      const headingFont = Number(
        attrValue(headingMatches[0]![0], "font-size") ?? CARD_FONT,
      );
      if (
        !Number.isFinite(rect.x) ||
        !Number.isFinite(rect.y) ||
        !Number.isFinite(rect.w) ||
        !Number.isFinite(rect.h) ||
        !Number.isFinite(headingFont) ||
        headingFont <= 0
      )
        return block;
      const scale = headingFont / CARD_FONT;
      const connections = byTerminal.get(terminalIdKey(terminal)) ?? [];
      const rowSpecs: { baseText: string; destinations: readonly string[] }[] =
        [];
      for (const elementId of conductors) {
        const key = elementKey(elementId);
        const connection = connections.find(
          (c) => elementKey(c.elementId) === key,
        );
        if (!connection) return block;
        rowSpecs.push({
          baseText: `${connection.designation} → ${connection.destination}`,
          destinations:
            destinationsByRow.get(cardRowKey(terminal, elementId)) ?? [],
        });
      }
      const headingLines = headingMatches.map((m) => ({
        tag: m[0],
        text: decodeXml(m[1]!),
      }));
      const cardKey = JSON.stringify([terminalRaw, conductorsRaw]);
      let chosen = placements.get(cardKey);
      if (!chosen) {
        const visibleCard = visibleCards.get(cardKey);
        if (!visibleCard) return block;
        chosen = chooseCardBox(
          headingLines,
          rowSpecs,
          rect,
          scale,
          visibleCard,
          field,
          obstacles,
        );
        if (!chosen) return block;
        placements.set(cardKey, chosen);
        const newPageRect = project(
          {
            x: chosen.x,
            y: chosen.y,
            w: chosen.layout.width,
            h: chosen.layout.height,
          },
          visibleCard.matrix,
        );
        obstacles.ink.push(newPageRect);
        obstacles.texts.push(newPageRect);
      }
      const { x, y, layout } = chosen;
      let updatedRect = replaceAttr(rectTag, "x", fmt(x));
      updatedRect = replaceAttr(updatedRect, "y", fmt(y));
      updatedRect = replaceAttr(updatedRect, "width", fmt(layout.width));
      updatedRect = replaceAttr(updatedRect, "height", fmt(layout.height));
      const updatedHeadings = layout.headingLines.map((h) => {
        let tag = replaceAttr(h.tag, "x", fmt(x + h.offsetX));
        tag = replaceAttr(tag, "y", fmt(y + h.baseline));
        tag = replaceAttr(tag, "font-size", fmt(layout.fontSize));
        return tag;
      });
      const updatedRows = layout.rowLines.map((line) => {
        const lx = fmt(x + line.offsetX);
        const ly = fmt(y + line.baseline);
        return `<text class="off-view-row" x="${lx}" y="${ly}" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="${fmt(layout.fontSize)}" fill="#101828">${xml(line.text)}</text>`;
      });
      return `${openTag}\n    ${updatedRect}\n    ${updatedHeadings.join("\n    ")}\n    ${updatedRows.join("\n    ")}\n  </g>`;
    },
  );
}
