import type { ElectricalIr } from "@thermite/compiler";
import { serializeIr } from "@thermite/compiler";
import type { Draft, RenderedSheet } from "./types.js";
import type {
  IssuedNavigation,
  AnnotationReservation,
  NavigationAnnotation,
  PlacedOccurrence,
} from "./navigation-types.js";
import { placeOccurrences } from "./navigation-occurrences.js";
import {
  planRepeatNavigation,
  NAVIGATION_FONT_MM,
} from "./navigation-repeats.js";
import { allocateNavigationSlots } from "./navigation-slots.js";
import { navigationDraftInputs } from "./navigation-seeds.js";
import { navigationHash } from "./navigation-identity.js";
import { text } from "./svg.js";
import { escapeXmlAttribute as attr } from "../svg/escape.js";
import { printableTextMetrics } from "../symbols/printable-font.js";
import { inside } from "../device-legend/geometry.js";
import { required } from "../presentation/util.js";
import type { RenderOutcome } from "../types.js";
import { failure } from "./errors.js";
import type { SheetSlotRequest } from "./navigation-slots.js";
import type { RepeatPlan } from "./navigation-repeats.js";
import { symbolGeometry, type SymbolGeometry } from "./navigation-symbols.js";
import { resolveLabelLocality } from "./navigation-locality.js";
import { validateAppearanceIncidence } from "./navigation-incidence.js";

function annotationSvg(
  annotation: NavigationAnnotation,
  reservation: AnnotationReservation,
): string {
  const box = required(
    reservation.allocatedMm,
    "Unallocated navigation reservation",
  ).rect;
  const lines = annotation.text.split("\n");
  for (const [i, line] of lines.entries()) {
    const m = printableTextMetrics(line, NAVIGATION_FONT_MM);
    if (
      !inside(
        {
          x: box.x + 1 + m.left,
          y: box.y + 3.7 + i * 4.8 - m.top,
          w: m.right - m.left,
          h: m.top - m.bottom,
        },
        box,
      )
    )
      throw Error(`Navigation actual ink exceeds ${reservation.profileId}`);
  }
  return `<g id="${attr(required(annotation.primitiveIds[0], "Missing annotation primitive"))}" data-navigation-annotation="${attr(annotation.id)}" data-navigation-owner="${attr(annotation.ownerOccurrence)}" data-navigation-role="${annotation.role}">${lines.map((s, i) => text(box.x + 1, box.y + 3.7 + i * 4.8, s, NAVIGATION_FONT_MM)).join("")}</g>`;
}
function emitSheetNavigation(
  sheet: RenderedSheet,
  owners: readonly import("./navigation-types.js").PlacedOccurrence[],
  all: readonly NavigationAnnotation[],
  allocated: readonly AnnotationReservation[],
): RenderedSheet {
  const annotations = all.filter((a) =>
    owners.some((o) => o.id === a.ownerOccurrence),
  );
  const ink = annotations
    .map((a) =>
      annotationSvg(
        a,
        required(
          allocated.find((r) => r.id === a.reservationId),
          "Missing allocated annotation",
        ),
      ),
    )
    .join("");
  return {
    ...sheet,
    svg: sheet.svg.replace(
      /<\/svg>(\s*)$/,
      (_, tail: string) => `${ink}</svg>${tail}`,
    ),
    ...(owners.length ? { occurrenceIds: owners.map((o) => o.id) } : {}),
    ...(annotations.length
      ? { annotationIds: annotations.map((a) => a.id) }
      : {}),
  };
}

/** Pure finalization over immutable native drafts. Calling it twice produces the same bytes. */
export function finalizeNavigation(
  ir: Readonly<ElectricalIr>,
  drafts: readonly Draft[],
  sheets: readonly RenderedSheet[],
): RenderOutcome<{ sheets: RenderedSheet[]; navigation: IssuedNavigation }> & {
  failedSheet?: number;
} {
  try {
    return finalizeCheckedNavigation(ir, drafts, sheets);
  } catch (error) {
    return failure(
      "unprintable-layout",
      `Navigation invariant: ${error instanceof Error ? error.message : String(error)}`,
      { navigationInvariant: true },
    );
  }
}
function finalizeCheckedNavigation(
  ir: Readonly<ElectricalIr>,
  drafts: readonly Draft[],
  sheets: readonly RenderedSheet[],
): ReturnType<typeof finalizeNavigation> {
  const occurrences = placeOccurrences(ir, drafts, sheets),
    plan = planRepeatNavigation(
      ir,
      occurrences,
      selectedAppearanceCounts(drafts),
    );
  validateAppearanceIncidence(ir, occurrences, sheets);
  const reservations: AnnotationReservation[] = [];
  const result: RenderedSheet[] = [];
  for (const [i, sheet] of sheets.entries()) {
    const owners = occurrences.filter(
      (o) => o.destination.sheet === sheet.number,
    );
    const draft = required(drafts[i], "Missing navigation draft");
    const requests = sheetRequests(plan, owners, occurrences, sheet, draft);
    const allocation = allocateSheetRequests(
      requests,
      owners,
      sheet,
      draft,
      drafts.length,
    );
    if (!allocation.ok) return { ...allocation, failedSheet: i };
    const allocated = allocation.value;
    const annotations = plan.annotations.map((a) => {
      const slot = allocated.find((r) => r.id === a.reservationId);
      if (!slot) return a;
      const request = required(
        requests.find((r) => r.reservation.id === slot.id),
        "Missing navigation request",
      );
      const owner = required(
        owners.find((o) => o.id === a.ownerOccurrence),
        "Missing label owner",
      );
      return resolveLabelLocality(
        ir,
        a,
        slot,
        request.locality,
        owner.source.deviceUid,
      );
    });
    plan.annotations = annotations;
    reservations.push(...allocated);
    result.push(
      emitSheetNavigation(sheet, owners, plan.annotations, allocated),
    );
  }
  if (new Set(reservations.map((r) => r.id)).size !== reservations.length)
    throw Error("Duplicate navigation reservation identity");
  const navigation = issuedNavigation(
    ir,
    drafts,
    occurrences,
    plan,
    reservations,
  );
  return { ok: true, value: { sheets: result, navigation } };
}

type NavigationRequest = SheetSlotRequest & { locality: SymbolGeometry };
function sheetRequests(
  plan: RepeatPlan,
  owners: readonly PlacedOccurrence[],
  occurrences: readonly PlacedOccurrence[],
  sheet: RenderedSheet,
  draft: Draft,
): NavigationRequest[] {
  return plan.reservations.flatMap((reservation) => {
    const owner = owners.find(
      (o) => o.id === reservation.ownerOccurrence && o.role === "full-function",
    );
    if (!owner) return [];
    const locality = symbolGeometry(
      owner,
      occurrences,
      sheet.svg,
      required(draft.drawingBounds, "Missing navigation field"),
    );
    return [{ reservation, owner: locality.frameMm, locality }];
  });
}
function allocateSheetRequests(
  requests: readonly NavigationRequest[],
  owners: readonly PlacedOccurrence[],
  sheet: RenderedSheet,
  draft: Draft,
  pageCount: number,
): RenderOutcome<AnnotationReservation[]> {
  try {
    const allocated = requests.length
      ? allocateNavigationSlots(
          requests,
          required(draft.drawingBounds, "Missing navigation field"),
          sheet.svg,
          sheet.number,
        )
      : [];
    return { ok: true, value: allocated };
  } catch (error) {
    const failed = failure(
      "unprintable-layout",
      error instanceof Error ? error.message : "Navigation slot unavailable",
      {
        sheet: sheet.number,
        profiles: requests.map((r) => r.reservation.profileId),
        requiredMm: requests.map((r) => r.reservation.inkMm),
        actualScaleMmPerUnit: owners.map((o) =>
          Math.hypot(o.provenance.transform[0], o.provenance.transform[1]),
        ),
        minimumScale: "not applicable to fixed sheet slots",
        availableMm: draft.drawingBounds,
        nativeRootedPages: draft.rootedFit?.basePages ?? null,
        candidatePacketPages: pageCount,
        sources: owners.map((o) => o.source),
      },
    );
    return failed;
  }
}
function selectedAppearanceCounts(drafts: readonly Draft[]) {
  const groups = new Map<string, Set<string>>();
  for (const input of navigationDraftInputs(drafts))
    for (const s of input.seeds) {
      if (["terminal", "boundary"].includes(s.representation)) continue;
      const key = JSON.stringify([s.source.deviceUid, s.source.functionKey]);
      const appearances = groups.get(key) ?? new Set<string>();
      appearances.add(JSON.stringify([input.view.key, s.logicalKey]));
      groups.set(key, appearances);
    }
  return new Map([...groups].map(([k, v]) => [k, v.size]));
}
function issuedNavigation(
  ir: Readonly<ElectricalIr>,
  drafts: readonly Draft[],
  occurrences: import("./navigation-types.js").PlacedOccurrence[],
  plan: import("./navigation-repeats.js").RepeatPlan,
  reservations: AnnotationReservation[],
): IssuedNavigation {
  return {
    format: "issued-navigation/0.1",
    snapshotDigest: navigationHash(serializeIr(ir)),
    anchorRule: "function-terminal-centroid/2",
    quantumMm: 0.01,
    rounding: "decimal-half-up/1",
    seeds: exportedSeeds(drafts),
    measurementGaps: [
      ...new Map(
        navigationDraftInputs(drafts).flatMap((input) =>
          input.seeds
            .filter((s) =>
              ir.functions.some(
                (f) =>
                  f.id.deviceUid === s.source.deviceUid &&
                  f.id.functionKey === s.source.functionKey &&
                  !f.terminals.length,
              ),
            )
            .map((s) => {
              const appearance = JSON.stringify([input.view.key, s.logicalKey]);
              return [
                JSON.stringify([s.source, appearance]),
                {
                  source: s.source,
                  appearance,
                  reason:
                    "terminal-free function has no catalog body anchor" as const,
                },
              ] as const;
            }),
        ),
      ).values(),
    ],
    pageRegions: [
      ...occurrences.map((o) => ({
        sheet: o.destination.sheet,
        ownerId: o.id,
        kind: "occurrence" as const,
        basis:
          o.representation === "circuit"
            ? ("adapter-box" as const)
            : ("catalog-box" as const),
        rectMm: o.provenance.bodyMm,
      })),
      ...reservations.map((r) => ({
        sheet: required(r.allocatedMm, "Missing allocated region").sheet,
        ownerId: r.id,
        kind: "annotation" as const,
        basis: "reservation-box" as const,
        rectMm: required(r.allocatedMm, "Missing allocated region").rect,
      })),
    ],
    occurrences,
    canonicalGroups: plan.groups,
    reservations,
    annotations: plan.annotations,
  };
}
function exportedSeeds(drafts: readonly Draft[]): IssuedNavigation["seeds"] {
  return [
    ...new Map(
      navigationDraftInputs(drafts).flatMap((input) =>
        input.seeds.map((s) => {
          const appearance = JSON.stringify([input.view.key, s.logicalKey]);
          return [
            JSON.stringify([s.source, appearance]),
            {
              source: s.source,
              appearance,
              representation: s.representation,
              terminalKeys: [...new Set(s.terminals.map((t) => t.key))],
            },
          ] as const;
        }),
      ),
    ).values(),
  ];
}
