import type {
  ConductiveElementId,
  ElectricalIr,
  IrFunction,
  TerminalId,
} from "@thermite/compiler";
import type { Draft, PaperPage, RenderedSheet } from "./types.js";
import { authoredTerminalIncidence } from "../off-view/incidence.js";
import {
  cardRowKey,
  formatPeerDestination,
  injectOffViewCardDestinations,
  syncRewrittenOffViewCards,
} from "../off-view/card-destinations.js";
import { compareText, functionIdKey, terminalIdKey } from "../ordering.js";
import { required } from "../presentation/util.js";
import { record } from "./errors.js";
import { inside, project, type Rect } from "../device-legend/geometry.js";
import { wireScheduleTerminalKeys } from "./wire-schedule-terminals.js";
import { drawnTerminalAnchor } from "./wire-schedule-locations.js";
import {
  navigationGeometry,
  type NavigationGeometry,
} from "./navigation-walk.js";
import { destinationToken, navigationZone } from "./navigation-location.js";
import { textInk } from "../device-legend/svg-ink.js";
import { bounds } from "./page.js";
import { peerRouteIndex, landsOnMarks } from "./peer-route-ink.js";
import { paintedStroke } from "./document-assembly-geometry.js";
import {
  emitPeerReferences,
  type PeerReference,
} from "./peer-reference-ink.js";

interface Landing {
  sheet: number;
  zone: string;
  point: Rect;
  owner: Rect;
  marks: Rect[];
}
function paintedFill(g: NavigationGeometry) {
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

function peerTerminalKeys(
  ir: Readonly<ElectricalIr>,
  draft: Draft,
  geometry: readonly NavigationGeometry[],
) {
  const base = wireScheduleTerminalKeys(ir, draft, geometry);
  if (!("kind" in draft.view) || draft.view.kind !== "circuit") return base;
  const keys = new Map(base);
  const native = new Map(
    ir.terminals.map(({ id }) => [terminalIdKey(id), id.deviceUid]),
  );
  for (const port of geometry) {
    const a = port.node.attrs;
    const key = a["data-terminal-id"];
    if (
      port.node.name !== "g" ||
      !a["data-layout-port"] ||
      !key ||
      !port.deviceUid ||
      native.get(key) !== port.deviceUid
    )
      continue;
    // A circuit boundary can carry native identity on the port group.
    const circle = port.node.children.find((n) => n.name === "circle");
    if (circle && !keys.has(circle)) keys.set(circle, key);
  }
  return keys;
}

function markerRegion(mark: NavigationGeometry) {
  const { cx, cy, r } = mark.node.attrs;
  const radius = Number(r);
  return project(
    {
      x: Number(cx ?? 0) - radius,
      y: Number(cy ?? 0) - radius,
      w: 2 * radius,
      h: 2 * radius,
    },
    mark.matrix,
  );
}

function terminalLandings(
  ir: Readonly<ElectricalIr>,
  draft: Draft,
  sheet: RenderedSheet,
  field: Rect,
  geometry: readonly NavigationGeometry[],
) {
  const keys = peerTerminalKeys(ir, draft, geometry);
  const terminals = new Map<string, Landing>();
  for (const mark of geometry) {
    const key = keys.get(mark.node);
    if (!key) continue;
    const circle = mark.node.name === "circle";
    if (circle && Number(mark.node.attrs.r) <= 0) continue;
    if (!paintedFill(mark) && !(circle && paintedStroke(mark))) continue;
    const point = drawnTerminalAnchor(mark);
    if (!inside(point, mark.clip) || !inside(point, field)) continue;
    const owner = circle ? markerRegion(mark) : point;
    const existing = terminals.get(key);
    if (existing) {
      existing.marks.push(owner);
      continue;
    }
    terminals.set(key, {
      sheet: sheet.number,
      zone: navigationZone(point.x, point.y, field),
      point,
      owner,
      marks: [owner],
    });
  }
  return terminals;
}

function markCard(
  geometry: readonly NavigationGeometry[],
  card: NavigationGeometry,
) {
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

type ConductorPeerRecord = {
  from: TerminalId;
  to: TerminalId;
  connection: { elementId: ConductiveElementId; designation: string };
  owner: Rect;
  hasCard: boolean;
  targets: Map<string, Landing>;
};

type TerminalSheet = {
  sheet: RenderedSheet;
  field: Rect;
  geometry: readonly NavigationGeometry[];
  landings: ReadonlyMap<string, Landing>;
  entries: PeerReference[];
  conductorPeers: Map<string, ConductorPeerRecord>;
  cardDestinations: Map<string, string[]>;
  route: ReturnType<typeof peerRouteIndex>;
};
function conductorCaptions(part: TerminalSheet, element: ConductiveElementId) {
  const key = JSON.stringify(element);
  const calls = new Set(
    part.sheet.continuations
      .filter((c) => JSON.stringify(c.provenance) === key)
      .map((c) => c.id),
  );
  return part.geometry.flatMap((g) => {
    if (
      g.node.name !== "text" ||
      !paintedFill(g) ||
      !g.style ||
      !calls.has(g.style["data-continuation-id"] ?? "")
    )
      return [];
    const ink = textInk(g.node, g.style);
    if (!ink) return [];
    const box = project(ink, g.matrix);
    return inside(box, g.clip) ? [box] : [];
  });
}

function foreignTerminalOwners(part: TerminalSheet, own: TerminalId): Rect[] {
  const ownKey = terminalIdKey(own);
  const out: Rect[] = [];
  for (const [key, landing] of part.landings)
    if (key !== ownKey) out.push(...landing.marks);
  return out;
}

function recordConductorPeer(
  part: TerminalSheet,
  from: TerminalId,
  to: TerminalId,
  connection: { elementId: ConductiveElementId; designation: string },
  owner: Rect,
  target: Landing,
  hasCard: boolean,
) {
  const key = JSON.stringify([from, connection.elementId, to]);
  const token = destinationToken(target);
  const existing = part.conductorPeers.get(key);
  if (existing) {
    if (hasCard) {
      existing.hasCard = true;
      existing.owner = owner;
    }
    if (!existing.targets.has(token)) existing.targets.set(token, target);
    return;
  }
  part.conductorPeers.set(key, {
    from,
    to,
    connection,
    owner,
    hasCard,
    targets: new Map([[token, target]]),
  });
}

function sortedDestinationTokens(targets: ReadonlyMap<string, Landing>) {
  return [...targets.values()]
    .sort((a, b) => a.sheet - b.sheet || compareText(a.zone, b.zone))
    .map(destinationToken);
}

function finalizeConductorPeers(
  parts: readonly TerminalSheet[],
  name: (t: TerminalId) => string,
) {
  for (const part of parts) {
    for (const peer of part.conductorPeers.values()) {
      const { from, to, connection, owner, hasCard, targets } = peer;
      const { elementId, designation } = connection;
      const route = part.route(elementId);
      const marks = part.landings.get(terminalIdKey(from))?.marks;
      const opposite = part.landings.get(terminalIdKey(to))?.marks;
      if (landsOnMarks(route, marks) && landsOnMarks(route, opposite)) continue;
      const destinations = sortedDestinationTokens(targets);
      if (!destinations.length) continue;
      if (hasCard) {
        part.cardDestinations.set(cardRowKey(from, elementId), destinations);
        continue;
      }
      const destination = formatPeerDestination(destinations);
      part.entries.push({
        kind: "conductor-peer",
        identity: [from, elementId, to],
        owner,
        ...(marks && marks.length > 1 ? { owners: marks } : {}),
        foreignOwners: foreignTerminalOwners(part, from),
        along: route.runs,
        captions: conductorCaptions(part, elementId),
        ownerLabel: name(from),
        value: `${designation} · ${name(from)} → ${name(to)} ${destination}`,
        compact: `→ ${name(to)} ${destination}`,
        destination,
      });
    }
  }
}

function cardPeers(
  parts: readonly TerminalSheet[],
  ir: Readonly<ElectricalIr>,
  byTerminal: ReturnType<typeof authoredTerminalIncidence>,
) {
  const deviceNames = new Map(ir.devices.map((d) => [d.uid, d.designation]));
  const name = (t: TerminalId) =>
    `${deviceNames.get(t.deviceUid)}.${t.terminalKey}`;
  for (const part of parts)
    for (const card of part.geometry) {
      const key = card.node.attrs["data-off-view-terminal-id"];
      if (!key || !card.visible) continue;
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
      const origin = part.landings.get(terminalIdKey(owner));
      const ink = origin && markCard(part.geometry, card);
      if (!origin || !ink) continue;
      const source: unknown = JSON.parse(
        card.node.attrs["data-off-view-conductors"] ?? "[]",
      );
      if (!Array.isArray(source)) continue;
      const ids = new Set(source.map((item) => JSON.stringify(item)));
      const peers = byTerminal.get(terminalIdKey(owner)) ?? [];
      for (const connection of peers) {
        const { other, elementId, designation } = connection;
        if (
          !other ||
          !ids.has(JSON.stringify(elementId)) ||
          !ink.text.includes(`${designation} → ${connection.destination}`)
        )
          continue;
        const receiver = parts.find(
          (p) => p !== part && p.landings.has(terminalIdKey(other)),
        );
        const target = receiver?.landings.get(terminalIdKey(other));
        if (!receiver || !target) continue;
        recordConductorPeer(
          part,
          owner,
          other,
          connection,
          ink.rect,
          target,
          true,
        );
        recordConductorPeer(
          receiver,
          other,
          owner,
          connection,
          target.owner,
          origin,
          false,
        );
      }
    }
  finalizeConductorPeers(parts, name);
}

function interfaceAppearances(
  ir: Readonly<ElectricalIr>,
  fn: IrFunction,
  wiring: readonly TerminalSheet[],
) {
  const others = new Set(
    ir.functions
      .filter(
        (other) =>
          other !== fn &&
          other.id.deviceUid === fn.id.deviceUid &&
          other.kind === fn.kind,
      )
      .flatMap((other) => other.terminals.map(terminalIdKey)),
  );
  return wiring.flatMap((part) => {
    for (const terminal of fn.terminals) {
      const key = terminalIdKey(terminal);
      if (others.has(key)) continue;
      const landing = part.landings.get(key);
      if (landing) return [{ part, terminal, landing, kind: fn.kind }];
    }
    return [];
  });
}

function interfacePeers(
  parts: readonly TerminalSheet[],
  ir: Readonly<ElectricalIr>,
) {
  const wiring = parts.filter(
    (p) => "kind" in p.sheet.view && p.sheet.view.kind === "wiring",
  );
  if (wiring.length < 2) return;
  const functions = new Map(
    ir.functions.map((fn) => [functionIdKey(fn.id), fn]),
  );
  const names = new Map(ir.devices.map((d) => [d.uid, d.designation]));
  for (const relay of ir.internalRelations) {
    if (relay.verb !== "actuates") continue;
    const coil = functions.get(functionIdKey(relay.from));
    const contact = functions.get(functionIdKey(relay.to));
    if (coil?.kind !== "coil" || contact?.kind !== "contact") continue;
    const a = interfaceAppearances(ir, coil, wiring);
    const b = interfaceAppearances(ir, contact, wiring);
    for (const [here, there] of [
      [a, b],
      [b, a],
    ] as const)
      for (const origin of here) {
        const target = there.find((p) => p.part !== origin.part);
        if (!target) continue;
        origin.part.entries.push({
          kind: "terminal-interface",
          identity: [origin.terminal, target.terminal],
          owner: origin.landing.owner,
          foreignOwners: foreignTerminalOwners(origin.part, origin.terminal),
          ownerLabel: `${names.get(relay.deviceUid)} ${origin.terminal.terminalKey}`,
          value: `${names.get(relay.deviceUid)} · ${origin.kind} terminal ${origin.terminal.terminalKey} → ${target.kind} terminal ${target.terminal.terminalKey} ${destinationToken(target.landing)}`,
          compact: `→ ${names.get(relay.deviceUid)} ${target.kind} terminal ${target.terminal.terminalKey} ${destinationToken(target.landing)}`,
          destination: destinationToken(target.landing),
        });
      }
  }
}

function peerNoteField(draft: Draft, page: PaperPage) {
  return draft.drawingBounds ?? bounds(draft.title, page);
}

function collectTerminalSheets(
  ir: Readonly<ElectricalIr>,
  drafts: readonly Draft[],
  sheets: readonly RenderedSheet[],
  page: PaperPage,
): TerminalSheet[] {
  return sheets.flatMap((sheet, i): TerminalSheet[] => {
    const draft = required(drafts[i], "Missing peer reference source");
    if (draft.documentationTable) return [];
    const field = draft.drawingBounds ?? bounds(draft.title, page);
    const geometry = navigationGeometry(sheet.svg);
    return [
      {
        sheet,
        field,
        geometry,
        landings: terminalLandings(ir, draft, sheet, field, geometry),
        entries: [],
        conductorPeers: new Map(),
        cardDestinations: new Map(),
        route: peerRouteIndex(geometry),
      },
    ];
  });
}

export function terminalPeerReferences(
  ir: Readonly<ElectricalIr>,
  drafts: readonly Draft[],
  sheets: readonly RenderedSheet[],
  page: PaperPage,
) {
  if (
    !sheets.some(
      (s) =>
        s.svg.includes("data-off-view-terminal-id=") ||
        ("kind" in s.view && s.view.kind === "wiring"),
    )
  )
    return [...sheets];
  const byTerminal = authoredTerminalIncidence(ir);
  const parts = collectTerminalSheets(ir, drafts, sheets, page);
  cardPeers(parts, ir, byTerminal);
  interfacePeers(parts, ir);
  const viewRewrites = new Map<string, Map<string, string>>();
  const withCards = parts.map((part) => {
    const viewId = JSON.stringify(part.sheet.view);
    const rewrites = viewRewrites.get(viewId) ?? new Map<string, string>();
    viewRewrites.set(viewId, rewrites);
    const svg = injectOffViewCardDestinations(
      part.sheet.svg,
      part.field,
      part.geometry,
      byTerminal,
      part.cardDestinations,
      rewrites,
    );
    return { ...part, sheet: { ...part.sheet, svg }, viewId };
  });
  const changes = new Map(
    withCards.map(({ sheet, entries, viewId }) => {
      const synced = {
        ...sheet,
        svg: syncRewrittenOffViewCards(
          sheet.svg,
          viewRewrites.get(viewId) ?? new Map(),
        ),
      };
      const draft = required(
        drafts[sheet.number - 1],
        "Missing peer note drawing",
      );
      const uniqueEntries = [
        ...new Map(entries.map((entry) => [entry.value, entry])).values(),
      ];
      return [
        sheet.number,
        emitPeerReferences(synced, peerNoteField(draft, page), uniqueEntries),
      ];
    }),
  );
  return sheets.map((sheet) => changes.get(sheet.number) ?? sheet);
}
