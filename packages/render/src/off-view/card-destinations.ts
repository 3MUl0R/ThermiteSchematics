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
import { required } from "../presentation/util.js";
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

type CardHeadingSpec = { tag: string; text: string };
type CardRowSpec = { baseText: string; destinations: readonly string[] };
type CardObstacles = { ink: Rect[]; texts: Rect[] };
type CardPlacement = { x: number; y: number; layout: CardLayout };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTerminalId(raw: string): TerminalId | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed.deviceUid !== "string" ||
    typeof parsed.terminalKey !== "string"
  )
    return undefined;
  return { deviceUid: parsed.deviceUid, terminalKey: parsed.terminalKey };
}

function parseConductorId(value: unknown): ConductiveElementId | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (
    (value.kind === "wire" || value.kind === "jumper") &&
    typeof value.uid === "string"
  )
    return { kind: value.kind, uid: value.uid };
  if (
    value.kind === "cable_conductor" &&
    typeof value.cableUid === "string" &&
    typeof value.conductorId === "string"
  )
    return {
      kind: "cable_conductor",
      cableUid: value.cableUid,
      conductorId: value.conductorId,
    };
  return undefined;
}

function parseConductorIds(raw: string): ConductiveElementId[] | undefined {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return undefined;
  const out: ConductiveElementId[] = [];
  for (const item of parsed) {
    const id = parseConductorId(item);
    if (!id) return undefined;
    out.push(id);
  }
  return out;
}

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
  const [primary, ...alternates] = destinations;
  if (!primary) return baseLines;
  const formatted = formatPeerDestination(destinations);
  const last = baseLines[baseLines.length - 1] ?? "";
  if (
    cardTextMetrics(`${last} ${formatted}`, fontSize).width <=
    innerWidth + 0.001
  )
    return [...baseLines.slice(0, -1), `${last} ${formatted}`];
  if (cardTextMetrics(formatted, fontSize).width <= innerWidth + 0.001)
    return [...baseLines, formatted];
  if (!alternates.length)
    return [...baseLines, ...wrapCardText(primary, innerWidth, fontSize)];
  return [
    ...baseLines,
    primary,
    ...wrapDestinationWords(
      `also shown ${alternates.join(", ")}`,
      innerWidth,
      fontSize,
    ),
  ];
}

function attrValue(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "u").exec(tag);
  return match && match[1] !== undefined ? decodeXml(match[1]) : undefined;
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
  headingLines: {
    tag: string;
    text: string;
    baseline: number;
    offsetX: number;
  }[];
  rowLines: { text: string; baseline: number; offsetX: number }[];
}

function layoutCard(
  headingLines: readonly CardHeadingSpec[],
  rowSpecs: readonly CardRowSpec[],
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
    headingLines: headingLines.map((h, i) => {
      const pos = required(positioned[i], "Missing heading line metrics");
      return {
        ...h,
        baseline: pos.baseline * scale,
        offsetX: (padUnscaled + pos.offsetX) * scale,
      };
    }),
    rowLines: rows.map((text, j) => {
      const pos = required(
        positioned[headingLines.length + j],
        "Missing row line metrics",
      );
      return {
        text,
        baseline: pos.baseline * scale,
        offsetX: (padUnscaled + pos.offsetX) * scale,
      };
    }),
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

function cardCandidatePositions(
  rect: Rect,
  layout: CardLayout,
  visibleCard: NavigationGeometry,
) {
  const base = [
    { x: rect.x, y: rect.y },
    { x: rect.x, y: rect.y + rect.h - layout.height },
    { x: rect.x + rect.w - layout.width, y: rect.y },
    { x: rect.x + rect.w - layout.width, y: rect.y + rect.h - layout.height },
  ];
  const shifted: { x: number; y: number }[] = [];
  const pageScale = Math.hypot(visibleCard.matrix[0], visibleCard.matrix[1]);
  if (!(pageScale > 0)) return { base, shifted };
  const oldPage = project(rect, visibleCard.matrix);
  const clipBottom = visibleCard.clip.y + visibleCard.clip.h;
  const maxY =
    rect.y + (clipBottom - (oldPage.y + layout.height * pageScale)) / pageScale;
  const clampedY = Math.min(rect.y, maxY);
  if (clampedY < rect.y - 0.01) shifted.push({ x: rect.x, y: clampedY });
  for (const dxMm of [2, 4, 6]) {
    const dx = dxMm / pageScale;
    shifted.push(
      { x: rect.x + dx, y: rect.y },
      { x: rect.x + dx, y: rect.y + rect.h - layout.height },
      ...(clampedY < rect.y - 0.01 ? [{ x: rect.x + dx, y: clampedY }] : []),
    );
  }
  return { base, shifted };
}

function tryCardBoxes(
  rect: Rect,
  layout: CardLayout,
  visibleCard: NavigationGeometry,
  oldPageRect: Rect,
  field: Rect,
  obstacles: CardObstacles,
  gaps: readonly (readonly [number, number])[],
  allowShifted = false,
): CardPlacement | undefined {
  const { base, shifted } = cardCandidatePositions(rect, layout, visibleCard);
  const positions = allowShifted ? shifted : base;
  for (const [inkGap, textGap] of gaps) {
    for (const pos of positions) {
      const candidate = project(
        { x: pos.x, y: pos.y, w: layout.width, h: layout.height },
        visibleCard.matrix,
      );
      if (
        cardFitsClear(
          candidate,
          oldPageRect,
          visibleCard.clip,
          field,
          obstacles,
          inkGap,
          textGap,
        )
      )
        return { x: pos.x, y: pos.y, layout };
    }
  }
  return undefined;
}

function singleLineCardWidth(
  headingLines: readonly CardHeadingSpec[],
  rowSpecs: readonly CardRowSpec[],
  minWidth: number,
  maxWidth: number,
  fontSize: number,
  pad: number,
) {
  return Math.min(
    maxWidth,
    Math.max(
      minWidth,
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
}

interface CardBoxContext {
  headingLines: readonly CardHeadingSpec[];
  rowSpecs: readonly CardRowSpec[];
  rect: Rect;
  scale: number;
  pageScale: number;
  maxWidthUnscaled: number;
  visibleCard: NavigationGeometry;
  oldPageRect: Rect;
  field: Rect;
  obstacles: CardObstacles;
}

function tryCardBox(
  ctx: CardBoxContext,
  layout: CardLayout,
  gaps: readonly (readonly [number, number])[],
  allowShifted = false,
): CardPlacement | undefined {
  return tryCardBoxes(
    ctx.rect,
    layout,
    ctx.visibleCard,
    ctx.oldPageRect,
    ctx.field,
    ctx.obstacles,
    gaps,
    allowShifted,
  );
}

function tryCompactCardBox(ctx: CardBoxContext): CardPlacement | undefined {
  const { headingLines, rowSpecs, rect, scale, pageScale } = ctx;
  const printedEmMm = CARD_FONT * scale * pageScale;
  const floorFont = Math.min(
    CARD_FONT,
    Math.max(
      CARD_FONT * (MIN_CARD_FONT_MM / printedEmMm),
      MIN_CARD_FONT_MM / (scale * pageScale),
    ),
  );
  if (floorFont >= CARD_FONT - 0.05) return undefined;
  const pad = Math.max(2.5, (CARD_PAD * floorFont) / CARD_FONT);
  const compactSame = layoutCard(
    headingLines,
    rowSpecs,
    rect.w / scale,
    floorFont,
    scale,
    pad,
  );
  if (compactSame.height <= rect.h + 0.05)
    return { x: rect.x, y: rect.y, layout: { ...compactSame, height: rect.h } };
  const wideW = singleLineCardWidth(
    headingLines,
    rowSpecs,
    rect.w / scale,
    ctx.maxWidthUnscaled,
    floorFont,
    pad,
  );
  const compactWide = layoutCard(
    headingLines,
    rowSpecs,
    wideW,
    floorFont,
    scale,
    pad,
  );
  for (const gap of [
    [1.5, 1.5],
    [0.8, 1.5],
    [0.4, 0.8],
  ] as const) {
    const fit =
      tryCardBox(ctx, compactSame, [gap]) ??
      tryCardBox(ctx, compactWide, [gap]);
    if (fit) return fit;
  }
  return undefined;
}

function chooseCardBox(
  headingLines: readonly CardHeadingSpec[],
  rowSpecs: readonly CardRowSpec[],
  rect: Rect,
  scale: number,
  visibleCard: NavigationGeometry,
  field: Rect,
  obstacles: CardObstacles,
): CardPlacement | undefined {
  const pageScale = Math.hypot(visibleCard.matrix[0], visibleCard.matrix[1]);
  const ctx: CardBoxContext = {
    headingLines,
    rowSpecs,
    rect,
    scale,
    pageScale,
    maxWidthUnscaled: Math.max(
      rect.w / scale,
      Math.min(260, (field.w / (pageScale * scale)) * 0.9),
    ),
    visibleCard,
    oldPageRect: project(rect, visibleCard.matrix),
    field,
    obstacles,
  };
  const fullGaps = [
    [1.5, 1.5],
    [0.8, 1.5],
  ] as const;
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
      layout: {
        ...sameWidthFull,
        height: Math.max(sameWidthFull.height, rect.h),
      },
    };
  const wrapped = tryCardBox(ctx, sameWidthFull, fullGaps);
  if (wrapped) return wrapped;
  const wideW = singleLineCardWidth(
    headingLines,
    rowSpecs,
    rect.w / scale,
    ctx.maxWidthUnscaled,
    CARD_FONT,
    CARD_PAD,
  );
  const wideFull = layoutCard(headingLines, rowSpecs, wideW, CARD_FONT, scale);
  return (
    tryCardBox(ctx, wideFull, fullGaps) ??
    tryCompactCardBox(ctx) ??
    tryCardBox(ctx, sameWidthFull, fullGaps, true) ??
    tryCardBox(ctx, wideFull, fullGaps, true)
  );
}

function collectVisibleCards(geometry: readonly NavigationGeometry[]) {
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
  return visibleCards;
}

function renderCardMarkup(
  openTag: string,
  rectTag: string,
  chosen: CardPlacement,
): string {
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
    return `<text class="off-view-row" data-text-role="secondary" x="${lx}" y="${ly}" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="${fmt(layout.fontSize)}" fill="#101828">${xml(line.text)}</text>`;
  });
  return `${openTag}\n    ${updatedRect}\n    ${updatedHeadings.join("\n    ")}\n    ${updatedRows.join("\n    ")}\n  </g>`;
}

function parseCardBlock(
  block: string,
  byTerminal: ReadonlyMap<string, readonly OffViewConnection[]>,
  destinationsByRow: ReadonlyMap<string, readonly string[]>,
) {
  const openTag = block.slice(0, block.indexOf(">") + 1);
  const terminalRaw = attrValue(openTag, "data-off-view-terminal-id");
  const conductorsRaw = attrValue(openTag, "data-off-view-conductors");
  if (!terminalRaw || !conductorsRaw) return undefined;
  const terminal = parseTerminalId(terminalRaw);
  const conductors = parseConductorIds(conductorsRaw);
  if (
    !terminal ||
    !conductors?.some(
      (c) => destinationsByRow.get(cardRowKey(terminal, c))?.length,
    )
  )
    return undefined;
  const rectMatch = /<rect\b[^>]*class="off-view-card"[^>]*\/>/u.exec(block);
  const headingMatches = [
    ...block.matchAll(
      /<text\b[^>]*class="off-view-heading"[^>]*>([\s\S]*?)<\/text>/gu,
    ),
  ];
  const firstHeading = headingMatches[0];
  if (!rectMatch || !firstHeading) return undefined;
  const rectTag = rectMatch[0];
  const rect = {
    x: Number(attrValue(rectTag, "x")),
    y: Number(attrValue(rectTag, "y")),
    w: Number(attrValue(rectTag, "width")),
    h: Number(attrValue(rectTag, "height")),
  };
  const headingFont = Number(
    attrValue(firstHeading[0], "font-size") ?? CARD_FONT,
  );
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.w) ||
    !Number.isFinite(rect.h) ||
    !Number.isFinite(headingFont) ||
    headingFont <= 0
  )
    return undefined;
  const connections = byTerminal.get(terminalIdKey(terminal)) ?? [];
  const rowSpecs: CardRowSpec[] = [];
  for (const elementId of conductors) {
    const key = elementKey(elementId);
    const connection = connections.find((c) => elementKey(c.elementId) === key);
    if (!connection) return undefined;
    rowSpecs.push({
      baseText: `${connection.designation} → ${connection.destination}`,
      destinations:
        destinationsByRow.get(cardRowKey(terminal, elementId)) ?? [],
    });
  }
  return {
    openTag,
    rectTag,
    rect,
    scale: headingFont / CARD_FONT,
    cardKey: JSON.stringify([terminalRaw, conductorsRaw]),
    rowSpecs,
    headingLines: headingMatches.map((m) => ({
      tag: m[0],
      text: decodeXml(m[1] ?? ""),
    })),
  };
}

/** Rewrite packet off-view cards in place to carry resolved sheet.zone destinations
 * with zero ELK reflow, checking sheet obstacles before any box expansion. */
export function injectOffViewCardDestinations(
  svg: string,
  field: Rect,
  geometry: readonly NavigationGeometry[],
  byTerminal: ReadonlyMap<string, readonly OffViewConnection[]>,
  destinationsByRow: ReadonlyMap<string, readonly string[]>,
  rewrites?: Map<string, string>,
  localRewritten?: Set<string>,
): string {
  if (!destinationsByRow.size || !svg.includes('class="off-view-annotation"'))
    return svg;
  const obstacles = navigationObstacles(svg, true);
  const visibleCards = collectVisibleCards(geometry);
  const placements = new Map<string, CardPlacement>();
  return svg.replace(
    /<g\b[^>]*class="off-view-annotation"[^>]*>[\s\S]*?<\/g>/gu,
    (block) => {
      const parsed = parseCardBlock(block, byTerminal, destinationsByRow);
      if (!parsed) return block;
      let chosen = placements.get(parsed.cardKey);
      if (!chosen) {
        const visibleCard = visibleCards.get(parsed.cardKey);
        if (!visibleCard) return block;
        chosen = chooseCardBox(
          parsed.headingLines,
          parsed.rowSpecs,
          parsed.rect,
          parsed.scale,
          visibleCard,
          field,
          obstacles,
        );
        if (!chosen) return block;
        placements.set(parsed.cardKey, chosen);
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
      const rewritten = renderCardMarkup(
        parsed.openTag,
        parsed.rectTag,
        chosen,
      );
      rewrites?.set(parsed.cardKey, rewritten);
      localRewritten?.add(parsed.cardKey);
      return rewritten;
    },
  );
}

/** Keep hidden off-screen copies of rewritten off-view cards identical across
 * sibling tiles of the same multi-sheet view so tiled text reconciliation stays exact. */
export function syncRewrittenOffViewCards(
  svg: string,
  rewrites: ReadonlyMap<string, string>,
  skipKeys?: ReadonlySet<string>,
): string {
  if (!rewrites.size || !svg.includes('class="off-view-annotation"'))
    return svg;
  return svg.replace(
    /<g\b[^>]*class="off-view-annotation"[^>]*>[\s\S]*?<\/g>/gu,
    (block) => {
      const openEnd = block.indexOf(">");
      const openTag = block.slice(0, openEnd + 1);
      const terminalRaw = attrValue(openTag, "data-off-view-terminal-id");
      const conductorsRaw = attrValue(openTag, "data-off-view-conductors");
      if (!terminalRaw || !conductorsRaw) return block;
      const cardKey = JSON.stringify([terminalRaw, conductorsRaw]);
      if (skipKeys?.has(cardKey)) return block;
      return rewrites.get(cardKey) ?? block;
    },
  );
}
