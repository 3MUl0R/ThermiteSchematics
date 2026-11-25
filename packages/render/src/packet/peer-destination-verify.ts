import type { RenderedSheet } from "./types.js";
import { authoredTerminalIncidence } from "../off-view/incidence.js";
import { cardRowKey } from "../off-view/card-destinations.js";
import { terminalIdKey } from "../ordering.js";
import { required } from "../presentation/util.js";
import { record } from "./errors.js";
import { inside, project, type Rect } from "../device-legend/geometry.js";
import {
  navigationGeometry,
  type NavigationGeometry,
} from "./navigation-walk.js";
import { paintedStroke } from "./document-assembly-geometry.js";
import type { PeerReference } from "./peer-reference-ink.js";

export function paintedFill(g: NavigationGeometry) {
  const s = g.style ?? g.node.attrs;
  return (
    g.visible &&
    Number(s.opacity ?? 1) > 0 &&
    Number(s["fill-opacity"] ?? 1) > 0 &&
    !["none", "transparent", "white", "#fff", "#ffffff"].includes(
      s.fill ?? "black",
    )
  );
}

export function markCard(
  geometry: readonly NavigationGeometry[],
  card: NavigationGeometry,
): { rect: Rect; text: string } | undefined {
  const byNode = new Map(geometry.map((g) => [g.node, g]));
  const box = card.node.children.find((n) => n.name === "rect");
  const mark = box && byNode.get(box);
  if (!box || !mark || !paintedStroke(mark)) return;
  const rect = project(
    {
      x: Number(box.attrs.x),
      y: Number(box.attrs.y),
      w: Number(box.attrs.width),
      h: Number(box.attrs.height),
    },
    mark.matrix,
  );
  if (rect.w <= 0 || rect.h <= 0 || !inside(rect, mark.clip)) return;
  const rows = card.node.children.flatMap((n) => {
    const g = byNode.get(n);
    return g && n.attrs.class === "off-view-row" && paintedFill(g)
      ? [n.text]
      : [];
  });
  return { rect, text: rows.join(" ").replace(/\s+/gu, " ") };
}

function parseDestinationSlotTokens(
  raw: string,
  allowCardWrap = false,
): string[] | undefined {
  const text = raw.trim().replace(/\s+/gu, " ");
  const single = /^(\d{2,}\.[A-D][1-6])$/u.exec(text);
  if (single?.[1]) return [single[1]];
  const multi = (
    allowCardWrap
      ? /^(\d{2,}\.[A-D][1-6])\s+(?:\(\s*)?also shown\s+((?:\d{2,}\.[A-D][1-6])(?:\s*,\s*\d{2,}\.[A-D][1-6])*)\s*\)?$/u
      : /^(\d{2,}\.[A-D][1-6]) \(also shown (\d{2,}\.[A-D][1-6](?:, \d{2,}\.[A-D][1-6])*)\)$/u
  ).exec(text);
  if (!multi?.[1] || !multi[2]) return undefined;
  return [multi[1], ...multi[2].split(/\s*,\s*/u).map((part) => part.trim())];
}

function stripTrailingDestination(value: string, destination: string): string {
  const suffix = ` ${destination}`;
  return value.endsWith(suffix)
    ? value.slice(0, value.length - destination.length)
    : value;
}

function extractNoteDestinationSlice(
  printed: string,
  entry: PeerReference,
): string | undefined {
  const text = printed.trim().replace(/\s+/gu, " ");
  const fullPrefix = stripTrailingDestination(entry.value, entry.destination);
  const compactPrefix = stripTrailingDestination(
    entry.compact,
    entry.destination,
  );
  const prefixes = [
    fullPrefix,
    ...(entry.ownerLabel ? [`${entry.ownerLabel} ${compactPrefix}`] : []),
    compactPrefix,
    ...(entry.ownerLabel ? [`${entry.ownerLabel} → `] : []),
  ].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  }
  return undefined;
}

function cardRowDestinationSlice(
  cardText: string,
  rowPrefixes: readonly string[],
  rowIndex: number,
): string | undefined {
  const prefix = rowPrefixes[rowIndex];
  if (!prefix) return undefined;
  let cursor = 0;
  for (let i = 0; i <= rowIndex; i++) {
    const p = rowPrefixes[i];
    if (!p) return undefined;
    const at = cardText.indexOf(p, cursor);
    if (at < 0) return undefined;
    cursor = at + p.length;
  }
  const nextPrefix = rowPrefixes[rowIndex + 1];
  if (!nextPrefix) return cardText.slice(cursor);
  const nextAt = cardText.indexOf(nextPrefix, cursor);
  return nextAt < 0 ? cardText.slice(cursor) : cardText.slice(cursor, nextAt);
}

function assertTokenMultiplicity(
  sheetNumber: number,
  subject: string,
  expected: readonly string[],
  printed: readonly string[],
) {
  const counts = new Map<string, number>();
  for (const token of printed) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const token of expected) {
    const n = counts.get(token) ?? 0;
    if (n !== 1)
      throw new Error(
        `Peer destination invariant violated on sheet ${sheetNumber} (${subject}): expected ${token} once, printed ${n} time(s) in [${printed.join(", ")}].`,
      );
  }
  if (printed.length !== expected.length)
    throw new Error(
      `Peer destination invariant violated on sheet ${sheetNumber} (${subject}): expected [${expected.join(", ")}], printed [${printed.join(", ")}].`,
    );
}

function verifyCardDestinationsPrinted(
  sheetNumber: number,
  geometry: readonly NavigationGeometry[],
  cardDestinations: ReadonlyMap<string, readonly string[]>,
  byTerminal: ReturnType<typeof authoredTerminalIncidence>,
) {
  const verifiedRows = new Set<string>();
  for (const card of geometry) {
    const key = card.node.attrs["data-off-view-terminal-id"];
    if (!key || !card.visible) continue;
    const ink = markCard(geometry, card);
    if (!ink) continue;
    const native: unknown = JSON.parse(key);
    if (
      !record(native) ||
      typeof native.deviceUid !== "string" ||
      typeof native.terminalKey !== "string"
    )
      continue;
    const owner = {
      deviceUid: native.deviceUid,
      terminalKey: native.terminalKey,
    };
    const source: unknown = JSON.parse(
      card.node.attrs["data-off-view-conductors"] ?? "[]",
    );
    if (!Array.isArray(source)) continue;
    const peers = byTerminal.get(terminalIdKey(owner)) ?? [];
    const rows = source.flatMap((id) => {
      const idKey = JSON.stringify(id);
      const conn = peers.find((p) => JSON.stringify(p.elementId) === idKey);
      return conn ? [{ conn, rowKey: cardRowKey(owner, conn.elementId) }] : [];
    });
    const prefixes = rows.map(
      ({ conn }) => `${conn.designation} → ${conn.destination}`,
    );
    for (const [i, { rowKey, conn }] of rows.entries()) {
      const expected = cardDestinations.get(rowKey);
      if (!expected?.length) continue;
      const slice = cardRowDestinationSlice(ink.text, prefixes, i);
      if (slice === undefined)
        throw new Error(
          `Peer destination invariant violated on sheet ${sheetNumber} (card ${conn.designation}): row missing from card ink.`,
        );
      const tokens = parseDestinationSlotTokens(slice, true);
      if (!tokens)
        throw new Error(
          `Peer destination invariant violated on sheet ${sheetNumber} (card ${conn.designation} → ${conn.destination}): malformed destination slot ${JSON.stringify(slice.trim())}.`,
        );
      assertTokenMultiplicity(
        sheetNumber,
        `card ${conn.designation} → ${conn.destination}`,
        expected,
        tokens,
      );
      verifiedRows.add(rowKey);
    }
  }
  for (const [rowKey, expected] of cardDestinations) {
    if (expected.length && !verifiedRows.has(rowKey))
      throw new Error(
        `Peer destination invariant violated on sheet ${sheetNumber}: resolved card destinations [${expected.join(", ")}] for ${rowKey} have no visible owning card.`,
      );
  }
}

function verifyFreePeerDestinationsPrinted(
  sheetNumber: number,
  geometry: readonly NavigationGeometry[],
  entries: readonly PeerReference[],
) {
  const byClaim = new Map<string, string[]>();
  for (const g of geometry) {
    const kind = g.node.attrs["data-peer-reference"];
    const source = g.node.attrs["data-peer-source"];
    if (!kind || !source || !g.visible) continue;
    const claim = JSON.stringify([kind, source]);
    const text =
      g.node.name === "g"
        ? g.node.children
            .filter((c) => c.name === "text")
            .map((c) => c.text)
            .join(" ")
        : g.node.text;
    const list = byClaim.get(claim) ?? [];
    list.push(text);
    byClaim.set(claim, list);
  }
  for (const entry of entries) {
    const claim = JSON.stringify([entry.kind, JSON.stringify(entry.identity)]);
    const printedNotes = byClaim.get(claim) ?? [];
    if (printedNotes.length !== 1)
      throw new Error(
        `Peer destination invariant violated on sheet ${sheetNumber} (${entry.value}): expected 1 owning note, found ${printedNotes.length}.`,
      );
    const printedText = required(printedNotes[0], "Missing printed peer note");
    const slice = extractNoteDestinationSlice(printedText, entry);
    if (slice === undefined)
      throw new Error(
        `Peer destination invariant violated on sheet ${sheetNumber} (${entry.value}): note subject does not match ${JSON.stringify(printedText)}.`,
      );
    const expectedTokens = parseDestinationSlotTokens(entry.destination);
    const printedTokens = parseDestinationSlotTokens(slice);
    if (!expectedTokens || !printedTokens)
      throw new Error(
        `Peer destination invariant violated on sheet ${sheetNumber} (${entry.value}): malformed destination slot ${JSON.stringify(slice)}.`,
      );
    assertTokenMultiplicity(
      sheetNumber,
      entry.value,
      expectedTokens,
      printedTokens,
    );
  }
}

export function verifyPrintedPeerDestinations(
  sheet: RenderedSheet,
  cardDestinations: ReadonlyMap<string, readonly string[]>,
  entries: readonly PeerReference[],
  byTerminal: ReturnType<typeof authoredTerminalIncidence>,
) {
  if (!cardDestinations.size && !entries.length) return;
  const geometry = navigationGeometry(sheet.svg);
  if (cardDestinations.size)
    verifyCardDestinationsPrinted(
      sheet.number,
      geometry,
      cardDestinations,
      byTerminal,
    );
  if (entries.length)
    verifyFreePeerDestinationsPrinted(sheet.number, geometry, entries);
}
