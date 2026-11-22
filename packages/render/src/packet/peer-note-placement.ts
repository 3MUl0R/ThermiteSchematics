import type { Rect } from "../device-legend/geometry.js";
import { required } from "../presentation/util.js";
import {
  navigationObstacles,
  NavigationSlotFailure,
} from "./navigation-slots.js";
import {
  NAVIGATION_CLEARANCE_MM,
  searchNavigationSlot,
} from "./navigation-slot-search.js";
import type { PeerReference } from "./peer-reference-ink.js";
import type { NavigationShape } from "./navigation-types.js";
import type { RenderedSheet } from "./types.js";

// One wire plate (4.6 mm) plus the existing 1.5 mm ink clearance.
const PEER_REACH_MM = 6.1;
// Source-free text must start directly beside its owner.
const UNNAMED_REACH_MM = 2.1;
const unnamed = new Set(["compact", "compact-wrapped"]);
const alongPreference = [
  "qualified-wrapped",
  "named-compact-wrapped",
  "wrapped",
  "named-compact",
  "qualified",
  "full",
];

export interface PeerNotePlacement {
  box: Rect;
  lines: readonly string[];
}

const TIGHT_TEXT_CLEARANCE_MM = 0.75;

function place(
  entry: PeerReference,
  shapes: readonly NavigationShape[],
  field: Rect,
  ink: ReturnType<typeof navigationObstacles>,
  textVerticalClearanceMm = NAVIGATION_CLEARANCE_MM,
) {
  const search = (
    forms: readonly NavigationShape[],
    anchors: readonly Rect[],
    reachMm: (shape: NavigationShape) => number,
  ) => {
    const found = searchNavigationSlot(
      forms,
      field,
      entry.owner,
      ink.ink,
      undefined,
      ink.texts,
      false,
      undefined,
      undefined,
      false,
      (shape) => ({
        anchors,
        gap: reachMm(shape),
        textVerticalClearanceMm,
        ...(entry.foreignOwners?.length
          ? { foreignOwners: entry.foreignOwners }
          : {}),
      }),
    );
    if (found) return { box: found.box, lines: found.shape.maximumForms };
  };
  const reachFor = (form: NavigationShape) =>
    unnamed.has(form.id) ? UNNAMED_REACH_MM : PEER_REACH_MM;
  const near = search(shapes, [entry.owner], reachFor);
  if (near) return near;
  const alternates = entry.owners?.filter((o) => o !== entry.owner) ?? [];
  if (alternates.length) {
    const alt = search(shapes, alternates, reachFor);
    if (alt) return alt;
  }

  // In a tight drawing the same conductor's painted stroke or existing
  // continuation caption supplies a second anchor, always with the source named.
  const supports = [...(entry.along ?? []), ...(entry.captions ?? [])];
  if (!supports.length) return;
  const named = alongPreference.flatMap((id) =>
    shapes.filter((s) => s.id === id),
  );
  return search(named, supports, () => PEER_REACH_MM);
}

const WORDING_FAMILIES: readonly (readonly string[])[] = [
  ["full", "wrapped"],
  ["named-compact", "named-compact-wrapped"],
  ["compact", "compact-wrapped"],
  ["qualified", "qualified-wrapped"],
];

type PeerCandidate = {
  index: number;
  entry: PeerReference;
  shapes: NavigationShape[];
};

function tryPeerOrder(
  order: readonly PeerCandidate[],
  allowed: ReadonlySet<string>,
  field: Rect,
  ink: ReturnType<typeof navigationObstacles>,
  textVerticalClearanceMm: number,
) {
  const localInk = { ink: [...ink.ink], texts: [...ink.texts] };
  const placed = new Map<number, PeerNotePlacement>();
  for (const { index, entry, shapes } of order) {
    const familyShapes = shapes.filter((s) => allowed.has(s.id));
    if (!familyShapes.length) return { failed: entry };
    const result = place(
      entry,
      familyShapes,
      field,
      localInk,
      textVerticalClearanceMm,
    );
    if (!result) return { failed: entry };
    localInk.ink.push(result.box);
    localInk.texts.push(result.box);
    placed.set(index, result);
  }
  return { placed, ink: localInk };
}

function withoutDrawingTextInk(
  ink: ReturnType<typeof navigationObstacles>,
  drawingTexts: ReadonlySet<Rect>,
) {
  return {
    ink: ink.ink.filter((box) => !drawingTexts.has(box)),
    texts: ink.texts,
  };
}

function placePeerGroup(
  group: readonly PeerCandidate[],
  field: Rect,
  ink: ReturnType<typeof navigationObstacles>,
  drawingTexts: ReadonlySet<Rect>,
) {
  let firstFailed = required(group[0], "Missing peer group").entry;
  const fullPass = { source: ink, textGap: NAVIGATION_CLEARANCE_MM };
  const tightPass = {
    source: withoutDrawingTextInk(ink, drawingTexts),
    textGap: TIGHT_TEXT_CLEARANCE_MM,
  };
  const namedFamilies = WORDING_FAMILIES.slice(0, 3);
  const qualifiedFamily = WORDING_FAMILIES.slice(3);
  const attempts = [
    ...namedFamilies.map((family) => ({ ...fullPass, family })),
    {
      ...tightPass,
      family: required(WORDING_FAMILIES[0], "Missing full family"),
    },
    ...qualifiedFamily.map((family) => ({ ...fullPass, family })),
    ...WORDING_FAMILIES.slice(1).map((family) => ({ ...tightPass, family })),
  ];
  for (const { source, textGap, family } of attempts) {
    const allowed = new Set(family);
    const forward = tryPeerOrder(group, allowed, field, source, textGap);
    if (forward.placed) {
      return {
        placed: forward.placed,
        ink: {
          ink: [...ink.ink, ...[...forward.placed.values()].map((p) => p.box)],
          texts: [
            ...ink.texts,
            ...[...forward.placed.values()].map((p) => p.box),
          ],
        },
      };
    }
    firstFailed = forward.failed;
    // Nearby captions can compete for the same slot. Retry in reverse order
    // within the same wording family before stepping down to a shorter family.
    if (group.length > 1) {
      const backward = tryPeerOrder(
        [...group].reverse(),
        allowed,
        field,
        source,
        textGap,
      );
      if (backward.placed) {
        return {
          placed: backward.placed,
          ink: {
            ink: [
              ...ink.ink,
              ...[...backward.placed.values()].map((p) => p.box),
            ],
            texts: [
              ...ink.texts,
              ...[...backward.placed.values()].map((p) => p.box),
            ],
          },
        };
      }
    }
  }
  return { failed: firstFailed };
}

export function placePeerNotes(
  sheet: RenderedSheet,
  field: Rect,
  entries: readonly PeerReference[],
  forms: (
    entry: PeerReference,
    unique: boolean,
    uniqueForOwner: boolean,
  ) => NavigationShape[],
): PeerNotePlacement[] {
  const uses = new Map<string, number>();
  const ownerUses = new Map<string, number>();
  const ownerDestination = (e: PeerReference) =>
    JSON.stringify([e.ownerLabel, e.destination]);
  for (const entry of entries) {
    uses.set(entry.destination, (uses.get(entry.destination) ?? 0) + 1);
    const key = ownerDestination(entry);
    ownerUses.set(key, (ownerUses.get(key) ?? 0) + 1);
  }
  const candidates: PeerCandidate[] = entries.map((entry, index) => ({
    index,
    entry,
    shapes: forms(
      entry,
      uses.get(entry.destination) === 1,
      ownerUses.get(ownerDestination(entry)) === 1,
    ),
  }));
  const obstacles = navigationObstacles(sheet.svg, true);
  const drawingTexts = new Set(obstacles.texts);
  // Enforce one consistent peer-reference wording family per kind per sheet (#483).
  const byKind = new Map<PeerReference["kind"], PeerCandidate[]>();
  for (const item of candidates) {
    const list = byKind.get(item.entry.kind) ?? [];
    list.push(item);
    byKind.set(item.entry.kind, list);
  }
  let currentInk = { ink: [...obstacles.ink], texts: [...obstacles.texts] };
  const placements = new Array<PeerNotePlacement>(entries.length);
  for (const group of byKind.values()) {
    const result = placePeerGroup(group, field, currentInk, drawingTexts);
    if ("failed" in result) {
      const entry = result.failed;
      throw new NavigationSlotFailure(
        `Navigation ${entry.kind} cannot fit sheet ${sheet.number}: ${entry.value} has no clear slot within ${PEER_REACH_MM} mm of its owner.`,
        { field, owner: entry.owner },
      );
    }
    currentInk = result.ink;
    for (const [index, placed] of result.placed) placements[index] = placed;
  }
  return placements;
}
