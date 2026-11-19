import { escapeXmlAttribute as attr } from "../svg/escape.js";
import type { Rect } from "../device-legend/geometry.js";
import { printableTextMetrics } from "../symbols/printable-font.js";
import { required } from "../presentation/util.js";
import { allocateNavigationSlots } from "./navigation-slots.js";
import type { NavigationShape } from "./navigation-types.js";
import { text } from "./svg.js";
import type { RenderedSheet } from "./types.js";

const FONT_MM = 2.5;
const LINE_MM = 3.5;

export interface PeerReference {
  kind:
    | "attachment"
    | "assembly-inventory"
    | "conductor-peer"
    | "terminal-interface";
  identity: readonly unknown[];
  value: string;
  compact: string;
  destination: string;
  owner: Rect;
}

const advance = (value: string) => printableTextMetrics(value, FONT_MM).advance;

function twoLines(value: string) {
  let narrowest = Infinity;
  let result: string[] = [];
  for (const { index } of value.matchAll(/ (?=\S)/gu)) {
    const lines = [value.slice(0, index).trimEnd(), value.slice(index + 1)];
    if (!lines[0]) continue;
    const width = Math.max(...lines.map(advance));
    if (width >= narrowest) continue;
    narrowest = width;
    result = lines;
  }
  return result;
}

function shape(id: string, lines: readonly string[]): NavigationShape {
  const width = Math.max(...lines.map(advance));
  return {
    id,
    mode: "local",
    inkMm: { x: 0, y: 0, w: width + 2, h: 4.6 + LINE_MM * (lines.length - 1) },
    maximumForms: lines,
    wrapWidthMm: width,
  };
}

function noteShapes(entry: PeerReference, unique: boolean) {
  const forms = [
    shape("full", [entry.value]),
    shape("compact", [entry.compact]),
  ];
  if (unique) forms.push(shape("locator", [`→ ${entry.destination}`]));
  const wrapped = twoLines(entry.value);
  if (wrapped.length) forms.push(shape("wrapped", wrapped));
  return forms;
}

function noteInk(
  { kind, identity }: PeerReference,
  lines: readonly string[],
  box: Rect,
) {
  const claims = `data-peer-reference="${kind}" data-peer-source="${attr(JSON.stringify(identity))}"`;
  const ink = lines.map((line, i) =>
    text(box.x + 1, box.y + 3 + i * LINE_MM, line, FONT_MM),
  );
  return ink.length === 1
    ? required(ink[0], "Missing peer reference line").replace(
        "<text ",
        `<text ${claims} `,
      )
    : `<g ${claims}>${ink.join("\n")}</g>`;
}

export function emitPeerReferences(
  sheet: RenderedSheet,
  field: Rect,
  entries: readonly PeerReference[],
): RenderedSheet {
  if (!entries.length) return sheet;
  const uses = new Map<string, number>();
  for (const { destination } of entries)
    uses.set(destination, (uses.get(destination) ?? 0) + 1);
  const requests = entries.map((entry, i) => {
    const id = `peer-reference/${sheet.number}/${i}`;
    const shapes = noteShapes(entry, uses.get(entry.destination) === 1);
    const full = required(shapes[0], "Missing peer reference full form");
    return {
      owner: entry.owner,
      reservation: {
        id,
        ownerAppearance: id,
        ownerOccurrence: id,
        profileId: entry.kind,
        space: "sheet-slot" as const,
        inkMm: full.inkMm,
        maximumForms: full.maximumForms,
        shapes,
      },
    };
  });
  const slots = allocateNavigationSlots(
    requests,
    field,
    sheet.svg,
    sheet.number,
  );
  const markup = entries
    .map((entry, i) => {
      const slot = required(slots[i], "Missing peer reference slot");
      return noteInk(
        entry,
        slot.maximumForms,
        required(slot.allocatedMm, "Missing peer reference placement").rect,
      );
    })
    .join("");
  return {
    ...sheet,
    svg: sheet.svg.replace(/<\/svg>(\s*)$/u, `${markup}</svg>$1`),
  };
}
