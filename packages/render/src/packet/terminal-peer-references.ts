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
import {
  isNonTerminalCircle,
  wireScheduleTerminalKeys,
} from "./wire-schedule-terminals.js";
import { drawnTerminalAnchor } from "./wire-schedule-locations.js";
import {
  navigationGeometry,
  type NavigationGeometry,
} from "./navigation-walk.js";
import { destinationToken, navigationZone } from "./navigation-location.js";
import { textInk } from "../device-legend/svg-ink.js";
import { bounds } from "./page.js";
import {
  attachmentRouteEnds,
  landsOnMarks,
  markerRegion,
  peerRouteIndex,
} from "./peer-route-ink.js";
import { paintedStroke } from "./document-assembly-geometry.js";
import {
  emitPeerReferences,
  type PeerReference,
} from "./peer-reference-ink.js";
import {
  markCard,
  paintedFill,
  verifyPrintedPeerDestinations,
} from "./peer-destination-verify.js";

export { verifyPrintedPeerDestinations };

interface Landing {
  sheet: number;
  zone: string;
  point: Rect;
  owner: Rect;
  marks: Rect[];
  paintedMarks: Rect[];
  routeMarks: Rect[];
}

function terminalLandings(
  ir: Readonly<ElectricalIr>,
  draft: Draft,
  sheet: RenderedSheet,
  field: Rect,
  geometry: readonly NavigationGeometry[],
) {
  const keys = wireScheduleTerminalKeys(ir, draft, geometry);
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
    const paintedMark = circle ? markerRegion(mark, true) : point;
    const existing = terminals.get(key);
    if (existing) {
      existing.marks.push(owner);
      existing.paintedMarks.push(paintedMark);
      existing.routeMarks.push(owner);
      continue;
    }
    terminals.set(key, {
      sheet: sheet.number,
      zone: navigationZone(point.x, point.y, field),
      point,
      owner,
      marks: [owner],
      paintedMarks: [paintedMark],
      routeMarks: [owner],
    });
  }
  const marksByKey = new Map(
    [...terminals.entries()].map(([k, l]) => [k, [...l.routeMarks]]),
  );
  addBranchRouteMarks(geometry, field, terminals);
  for (const [key, ends] of attachmentRouteEnds(geometry, field, marksByKey))
    terminals.get(key)?.routeMarks.push(...ends);
  return terminals;
}

/** Branch dots on a sheet that already draws the physical terminal carry
 * fan-out route endpoints for connectivity checks, never zones or owners. */
function addBranchRouteMarks(
  geometry: readonly NavigationGeometry[],
  field: Rect,
  terminals: ReadonlyMap<string, Landing>,
) {
  for (const mark of geometry) {
    const a = mark.node.attrs;
    if (
      mark.node.name !== "circle" ||
      !mark.deviceUid ||
      !a["data-terminal-key"] ||
      !isNonTerminalCircle(a) ||
      Number(a.r) <= 0 ||
      (!paintedFill(mark) && !paintedStroke(mark))
    )
      continue;
    const existing = terminals.get(
      JSON.stringify([mark.deviceUid, a["data-terminal-key"]]),
    );
    if (!existing) continue;
    const point = drawnTerminalAnchor(mark);
    if (!inside(point, mark.clip) || !inside(point, field)) continue;
    existing.routeMarks.push(markerRegion(mark));
  }
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
  circuitGroups: ReadonlySet<string>;
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

function foreignTerminalOwners(
  part: TerminalSheet,
  own: TerminalId,
  sameFunction?: ReadonlySet<string>,
): Rect[] {
  const ownKey = terminalIdKey(own);
  const out: Rect[] = [];
  for (const [key, landing] of part.landings)
    if (key !== ownKey && !sameFunction?.has(key))
      out.push(...landing.paintedMarks);
  return out;
}

function terminalLabelBoxes(part: TerminalSheet, own: TerminalId): Rect[] {
  const ownKey = terminalIdKey(own);
  const byNode = new Map(part.geometry.map((g) => [g.node, g]));
  const out: Rect[] = [];
  for (const g of part.geometry) {
    if (
      g.node.name !== "g" ||
      !g.visible ||
      g.node.attrs["data-terminal-id"] !== ownKey
    )
      continue;
    for (const child of g.node.children) {
      if (child.name !== "text") continue;
      const cg = byNode.get(child);
      if (!cg || !paintedFill(cg) || !cg.style) continue;
      const ink = textInk(child, cg.style);
      if (!ink) continue;
      const box = project(ink, cg.matrix);
      if (inside(box, cg.clip)) out.push(box);
    }
  }
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
      const route = part.route.route(elementId);
      const fromLanding = part.landings.get(terminalIdKey(from));
      const toLanding = part.landings.get(terminalIdKey(to));
      const marks = fromLanding?.marks;
      if (
        landsOnMarks(route, fromLanding?.routeMarks) &&
        landsOnMarks(route, toLanding?.routeMarks)
      )
        continue;
      const destinations = sortedDestinationTokens(targets);
      if (!destinations.length) continue;
      if (hasCard) {
        part.cardDestinations.set(cardRowKey(from, elementId), destinations);
        continue;
      }
      const destination = formatPeerDestination(destinations);
      const terminalLabels = terminalLabelBoxes(part, from);
      const paintedMarks = fromLanding?.paintedMarks;
      part.entries.push({
        kind: "conductor-peer",
        identity: [from, elementId, to],
        owner,
        ...(marks && marks.length > 1 ? { owners: marks } : {}),
        ...(paintedMarks?.length ? { paintedOwners: paintedMarks } : {}),
        foreignOwners: foreignTerminalOwners(part, from),
        foreignConductors: part.route.foreignRuns(elementId),
        along: route.reachRuns,
        paintedAlong: route.runs,
        captions: conductorCaptions(part, elementId),
        ...(terminalLabels.length ? { terminalLabels } : {}),
        ownerLabel: name(from),
        value: `${designation} · ${name(from)} → ${name(to)} ${destination}`,
        compact: `→ ${name(to)} ${destination}`,
        destination,
      });
    }
  }
}

function sharesSplitCircuitGroup(a: TerminalSheet, b: TerminalSheet) {
  if (a === b || !a.circuitGroups.size || !b.circuitGroups.size) return false;
  for (const group of a.circuitGroups)
    if (b.circuitGroups.has(group)) return true;
  return false;
}

function hasDrawnIncidentConductor(
  part: TerminalSheet,
  ownerKey: string,
  byTerminal: ReturnType<typeof authoredTerminalIncidence>,
) {
  const landing = part.landings.get(ownerKey);
  if (!landing) return false;
  return (byTerminal.get(ownerKey) ?? []).some((conn) =>
    landsOnMarks(part.route.route(conn.elementId), landing.routeMarks),
  );
}

function recordCardConnection(
  part: TerminalSheet,
  parts: readonly TerminalSheet[],
  owner: TerminalId,
  origin: Landing,
  inkRect: Rect,
  connection: {
    other?: TerminalId | null;
    elementId: ConductiveElementId;
    designation: string;
    destination: string;
  },
  byTerminal: ReturnType<typeof authoredTerminalIncidence>,
) {
  const { other } = connection;
  if (!other) return;
  const ownerKey = terminalIdKey(owner);
  const otherKey = terminalIdKey(other);
  const mateParts = parts.filter((p) => p !== part && p.landings.has(otherKey));
  const receiver = mateParts[0];
  const target = receiver?.landings.get(otherKey);
  if (!receiver || !target) return;
  recordConductorPeer(part, owner, other, connection, inkRect, target, true);
  recordConductorPeer(
    receiver,
    other,
    owner,
    connection,
    target.owner,
    origin,
    false,
  );
  for (const coPart of parts) {
    if (coPart === part) continue;
    const coOwner = coPart.landings.get(ownerKey);
    if (!coOwner) continue;
    const splitCoOwner =
      mateParts.some((m) => sharesSplitCircuitGroup(coPart, m)) &&
      hasDrawnIncidentConductor(coPart, ownerKey, byTerminal);
    if (coPart !== receiver && !splitCoOwner) continue;
    const coTargetPart =
      parts.find((p) => p !== coPart && p.landings.has(otherKey)) ?? coPart;
    const coTarget = coTargetPart.landings.get(otherKey);
    if (coTarget)
      recordConductorPeer(
        coPart,
        owner,
        other,
        connection,
        coOwner.owner,
        coTarget,
        false,
      );
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
      for (const connection of byTerminal.get(terminalIdKey(owner)) ?? []) {
        if (
          !connection.other ||
          !ids.has(JSON.stringify(connection.elementId)) ||
          !ink.text.includes(
            `${connection.designation} → ${connection.destination}`,
          )
        )
          continue;
        recordCardConnection(
          part,
          parts,
          owner,
          origin,
          ink.rect,
          connection,
          byTerminal,
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
  const shared = new Set(
    ir.functions
      .filter((other) => other !== fn && other.id.deviceUid === fn.id.deviceUid)
      .flatMap((other) => other.terminals.map(terminalIdKey)),
  );
  const ownKeys = new Set(
    fn.terminals.map(terminalIdKey).filter((k) => !shared.has(k)),
  );
  return wiring.flatMap((part) => {
    for (const terminal of fn.terminals) {
      const key = terminalIdKey(terminal);
      if (others.has(key)) continue;
      const landing = part.landings.get(key);
      if (landing) return [{ part, terminal, landing, kind: fn.kind, ownKeys }];
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
          paintedOwners: origin.landing.paintedMarks,
          foreignOwners: foreignTerminalOwners(
            origin.part,
            origin.terminal,
            origin.ownKeys,
          ),
          siblingOwners: [...origin.part.landings].flatMap(([k, l]) =>
            k !== terminalIdKey(origin.terminal) && origin.ownKeys.has(k)
              ? l.paintedMarks
              : [],
          ),
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

function sheetCircuitGroups(
  draft: Draft,
  sheet: RenderedSheet,
  geometry: readonly NavigationGeometry[],
) {
  const groups = new Set<string>();
  const fallbackView = draft.navigationView?.key ?? `sheet:${sheet.number}`;
  for (const g of geometry) {
    if (!g.visible) continue;
    const cg = g.node.attrs["data-circuit-group"];
    if (!cg) continue;
    groups.add(JSON.stringify([g.viewKey || fallbackView, cg]));
  }
  return groups;
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
        circuitGroups: sheetCircuitGroups(draft, sheet, geometry),
        entries: [],
        conductorPeers: new Map(),
        cardDestinations: new Map(),
        route: peerRouteIndex(geometry),
      },
    ];
  });
}

function rewriteSheetCards(
  parts: readonly TerminalSheet[],
  drafts: readonly Draft[],
  byTerminal: ReturnType<typeof authoredTerminalIncidence>,
) {
  const viewRewrites = new Map<string, Map<string, string>>();
  const withCards = parts.map((part) => {
    const draft = required(
      drafts[part.sheet.number - 1],
      "Missing peer note drawing",
    );
    const viewInstanceId =
      draft.navigationView?.key ?? `sheet:${part.sheet.number}`;
    const rewrites =
      viewRewrites.get(viewInstanceId) ?? new Map<string, string>();
    viewRewrites.set(viewInstanceId, rewrites);
    const localRewritten = new Set<string>();
    const svg = injectOffViewCardDestinations(
      part.sheet.svg,
      part.field,
      part.geometry,
      byTerminal,
      part.cardDestinations,
      rewrites,
      localRewritten,
    );
    return {
      ...part,
      sheet: { ...part.sheet, svg },
      viewInstanceId,
      localRewritten,
    };
  });
  return { viewRewrites, withCards };
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
  const { viewRewrites, withCards } = rewriteSheetCards(
    parts,
    drafts,
    byTerminal,
  );
  const changes = new Map(
    withCards.map(({ sheet, entries, viewInstanceId, localRewritten }) => {
      const synced = {
        ...sheet,
        svg: syncRewrittenOffViewCards(
          sheet.svg,
          viewRewrites.get(viewInstanceId) ?? new Map(),
          localRewritten,
        ),
      };
      const draft = required(
        drafts[sheet.number - 1],
        "Missing peer note drawing",
      );
      const uniqueEntries = [
        ...new Map(entries.map((entry) => [entry.value, entry])).values(),
      ];
      const emitted = emitPeerReferences(
        synced,
        peerNoteField(draft, page),
        uniqueEntries,
      );
      return [sheet.number, emitted];
    }),
  );
  return sheets.map((sheet) => changes.get(sheet.number) ?? sheet);
}
