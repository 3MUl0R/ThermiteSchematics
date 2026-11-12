import type { FunctionId, SourceRef } from "@thermite/compiler";
import type { Rect, Matrix } from "../device-legend/geometry.js";

export type OccurrenceRole =
  "full-function" | "boundary-fragment" | "terminal-context" | "lookup-row";
/** Logical source placement, assigned before any crop, fold or pagination. */
export interface NativeOccurrenceSeed {
  source: FunctionId;
  logicalKey: string;
  nativeId: string;
  terminalScopeId?: string;
  fragmentEndpoints?: readonly string[];
  partEndpointKeys?: readonly string[];
  representation: string;
  terminals: readonly { key: string; primitiveId: string }[];
  body: Rect;
}
export interface NavigationView {
  key: string;
  authoredOrder: number;
}
export interface NavigationDraftInput {
  view: NavigationView;
  seeds: readonly NativeOccurrenceSeed[];
}
export interface PlacedOccurrence {
  id: string;
  source: FunctionId;
  appearance: string;
  role: OccurrenceRole;
  representation: string;
  terminalKeys: readonly string[];
  sourceOrigins: readonly SourceRef[];
  parentAppearance?: string;
  fragmentKey?: string;
  destination: {
    sheet: number;
    zone: string;
    anchorMm: { x: number; y: number };
    anchorRule: "function-terminal-centroid/2";
  };
  primitiveIds: readonly string[];
  terminalPrimitiveIds: readonly string[];
  provenance: {
    transform: Matrix;
    clipMm: Rect;
    bodyMm: Rect;
    view: NavigationView;
  };
}
export interface AnnotationReservation {
  id: string;
  ownerAppearance: string;
  profileId: string;
  space: "sheet-slot";
  inkMm: Rect;
  maximumForms: readonly string[];
  allocatedMm?: { sheet: number; rect: Rect };
}
export interface NavigationAnnotation {
  id: string;
  ownerOccurrence: string;
  role: "canonical" | "repeat";
  targets: readonly string[];
  text: string;
  primitiveIds: readonly string[];
  reservationId: string;
}
export interface IssuedNavigation {
  format: "issued-navigation/0.1";
  snapshotDigest: string;
  anchorRule: "function-terminal-centroid/2";
  quantumMm: 0.01;
  seeds: readonly {
    source: FunctionId;
    appearance: string;
    representation: string;
    terminalKeys: readonly string[];
  }[];
  measurementGaps: readonly {
    source: FunctionId;
    appearance: string;
    reason: "terminal-free function has no catalog body anchor";
  }[];
  pageRegions: readonly {
    sheet: number;
    ownerId: string;
    kind: "occurrence" | "annotation";
    rectMm: Rect;
  }[];
  occurrences: readonly PlacedOccurrence[];
  canonicalGroups: readonly {
    source: FunctionId;
    canonical: string;
    occurrences: readonly string[];
  }[];
  reservations: readonly AnnotationReservation[];
  annotations: readonly NavigationAnnotation[];
}
/** NAV2 consumes fixed sheet slots; NAV3 closes documents before this seam freezes. */
export interface NavigationExtension {
  reserve(
    occurrences: readonly PlacedOccurrence[],
  ): readonly AnnotationReservation[];
}

/** NAV3 supplies issued row locations before destinations freeze; no companion behavior in NAV1. */
export interface IssuedDocumentLocation {
  documentId: string;
  rowId: string;
  sourceKeys: readonly string[];
  sheet: number;
  rectMm: Rect;
}
