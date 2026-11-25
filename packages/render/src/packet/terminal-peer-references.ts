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
  attachmentRouteBindings,
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

interface TerminalAppearance {
  groupKey?: string;
  owner: Rect;
  paintedMark: Rect;
  routeMarks: Rect[];
}

interface Landing {
  sheet: number;
  zone: string;
  point: Rect;
  owner: Rect;
  marks: Rect[];
  paintedMarks: Rect[];
  routeMarks: Rect[];
  appearances: TerminalAppearance[];
}

function appearanceGroupKey(mark: NavigationGeometry, fallbackView: string) {
  return mark.circuitGroup
    ? JSON.stringify([mark.viewKey || fallbackView, mark.circuitGroup])
    : undefined;
}

function terminalLandings(
  ir: Readonly<ElectricalIr>,
  draft: Draft,
  sheet: RenderedSheet,
  field: Rect,
  geometry: readonly NavigationGeometry[],
) {
  const keys = wireScheduleTerminalKeys(ir, draft, geometry);
  const fallbackView = draft.navigationView?.key ?? `sheet:${sheet.number}`;
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
    const groupKey = appearanceGroupKey(mark, fallbackView);
    const appearance: TerminalAppearance = {
      ...(groupKey ? { groupKey } : {}),
      owner,
      paintedMark,
      routeMarks: [owner],
    };
    const existing = terminals.get(key);
    if (existing) {
      existing.marks.push(owner);
      existing.paintedMarks.push(paintedMark);
      existing.routeMarks.push(owner);
      existing.appearances.push(appearance);
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
      appearances: [appearance],
    });
  }
  const marksByKey = new Map(
    [...terminals.entries()].map(([k, l]) => [k, [...l.routeMarks]]),
  );
  addBranchRouteMarks(geometry, field, terminals, fallbackView);
  for (const { key, marker, tip, groupKey } of attachmentRouteBindings(
    geometry,
    field,
    marksByKey,
    fallbackView,
  )) {
    const landing = terminals.get(key);
    if (!landing) continue;
    landing.routeMarks.push(tip);
    for (const app of landing.appearances)
      if (app.owner === marker && app.groupKey === groupKey)
        app.routeMarks.push(tip);
  }
  return terminals;
}

/** Branch dots on a sheet that already draws the physical terminal carry
 * fan-out route endpoints for connectivity checks, never zones or owners. */
function addBranchRouteMarks(
  geometry: readonly NavigationGeometry[],
  field: Rect,
  terminals: ReadonlyMap<string, Landing>,
  fallbackView: string,
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
    const region = markerRegion(mark);
    existing.routeMarks.push(region);
    const dotGroup = appearanceGroupKey(mark, fallbackView);
    for (const app of existing.appearances)
      if (app.groupKey === dotGroup) app.routeMarks.push(region);
  }
}

type ConductorPeerRecord = {
  from: TerminalId;
  to: TerminalId;
  connection: { elementId: ConductiveElementId; designation: string };
  owner: Rect;
  hasCard: boolean;
  targets: Map<string, Landing>;
  appearances?: TerminalAppearance[];
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
  appearances?: readonly TerminalAppearance[],
) {
  const key = JSON.stringify([from, connection.elementId, to]);
  const token = destinationToken(target);
  const existing = part.conductorPeers.get(key);
  if (existing) {
    if (hasCard) {
      existing.hasCard = true;
      existing.owner = owner;
      delete existing.appearances;
    } else if (!appearances) {
      delete existing.appearances;
    } else if (existing.appearances) {
      for (const app of appearances)
        if (!existing.appearances.includes(app)) existing.appearances.push(app);
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
    ...(appearances?.length ? { appearances: [...appearances] } : {}),
  });
}

function sortedDestinationTokens(targets: ReadonlyMap<string, Landing>) {
  return [...targets.values()]
    .sort((a, b) => a.sheet - b.sheet || compareText(a.zone, b.zone))
    .map(destinationToken);
}

function activePeerMarks(
  part: TerminalSheet,
  peer: ConductorPeerRecord,
  fromLanding: Landing | undefined,
  toLanding: Landing | undefined,
) {
  const { elementId } = peer.connection;
  if (peer.appearances?.length) {
    const active = peer.appearances.filter((app) => {
      if (!app.groupKey) return true;
      const route = part.route.routeInGroup(elementId, app.groupKey);
      const sameGroupTo = (toLanding?.appearances ?? [])
        .filter((ta) => ta.groupKey === app.groupKey)
        .flatMap((ta) => ta.routeMarks);
      return !(
        landsOnMarks(route, app.routeMarks) && landsOnMarks(route, sameGroupTo)
      );
    });
    const [first] = active;
    if (!first) return undefined;
    return {
      owner: first.owner,
      marks: active.map((a) => a.owner),
      paintedMarks: active.map((a) => a.paintedMark),
    };
  }
  const route = part.route.route(elementId);
  if (
    landsOnMarks(route, fromLanding?.routeMarks) &&
    landsOnMarks(route, toLanding?.routeMarks)
  )
    return undefined;
  return {
    owner: peer.owner,
    marks: fromLanding?.marks,
    paintedMarks: fromLanding?.paintedMarks,
  };
}

function finalizeConductorPeers(
  parts: readonly TerminalSheet[],
  name: (t: TerminalId) => string,
) {
  for (const part of parts) {
    for (const peer of part.conductorPeers.values()) {
      const { from, to, connection, hasCard, targets } = peer;
      const { elementId, designation } = connection;
      const fromLanding = part.landings.get(terminalIdKey(from));
      const toLanding = part.landings.get(terminalIdKey(to));
      const resolved = activePeerMarks(part, peer, fromLanding, toLanding);
      if (!resolved) continue;
      const destinations = sortedDestinationTokens(targets);
      if (!destinations.length) continue;
      if (hasCard) {
        part.cardDestinations.set(cardRowKey(from, elementId), destinations);
        continue;
      }
      const route = part.route.route(elementId);
      const destination = formatPeerDestination(destinations);
      const terminalLabels = terminalLabelBoxes(part, from);
      const { owner, marks, paintedMarks } = resolved;
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

function eligibleSplitAppearances(
  coPart: TerminalSheet,
  parts: readonly TerminalSheet[],
  ownerKey: string,
  otherKey: string,
  byTerminal: ReturnType<typeof authoredTerminalIncidence>,
) {
  const coOwner = coPart.landings.get(ownerKey);
  if (!coOwner) return [];
  const incidences = byTerminal.get(ownerKey) ?? [];
  return coOwner.appearances.filter((app) => {
    const groupKey = app.groupKey;
    if (!groupKey) return false;
    const mateInSplitGroup = parts.some(
      (m) =>
        m !== coPart &&
        m.landings
          .get(otherKey)
          ?.appearances.some((ma) => ma.groupKey === groupKey),
    );
    if (!mateInSplitGroup) return false;
    return incidences.some((conn) =>
      landsOnMarks(
        coPart.route.routeInGroup(conn.elementId, groupKey),
        app.routeMarks,
      ),
    );
  });
}

function recordCoOwnerPeer(
  coPart: TerminalSheet,
  receiver: TerminalSheet,
  parts: readonly TerminalSheet[],
  owner: TerminalId,
  other: TerminalId,
  connection: { elementId: ConductiveElementId; designation: string },
  byTerminal: ReturnType<typeof authoredTerminalIncidence>,
) {
  const ownerKey = terminalIdKey(owner);
  const otherKey = terminalIdKey(other);
  const coOwner = coPart.landings.get(ownerKey);
  if (!coOwner) return;
  const coTargetPart =
    parts.find((p) => p !== coPart && p.landings.has(otherKey)) ?? coPart;
  const coTarget = coTargetPart.landings.get(otherKey);
  if (!coTarget) return;
  if (coPart === receiver) {
    recordConductorPeer(
      coPart,
      owner,
      other,
      connection,
      coOwner.owner,
      coTarget,
      false,
    );
    return;
  }
  const splitApps = eligibleSplitAppearances(
    coPart,
    parts,
    ownerKey,
    otherKey,
    byTerminal,
  );
  const [firstApp] = splitApps;
  if (firstApp)
    recordConductorPeer(
      coPart,
      owner,
      other,
      connection,
      firstApp.owner,
      coTarget,
      false,
      splitApps,
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
  const otherKey = terminalIdKey(other);
  const receiver = parts.find((p) => p !== part && p.landings.has(otherKey));
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
    recordCoOwnerPeer(
      coPart,
      receiver,
      parts,
      owner,
      other,
      connection,
      byTerminal,
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
    const fallbackView = draft.navigationView?.key ?? `sheet:${sheet.number}`;
    return [
      {
        sheet,
        field,
        geometry,
        landings: terminalLandings(ir, draft, sheet, field, geometry),
        entries: [],
        conductorPeers: new Map(),
        cardDestinations: new Map(),
        route: peerRouteIndex(geometry, fallbackView),
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
