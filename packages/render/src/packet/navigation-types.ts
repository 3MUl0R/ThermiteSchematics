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
    /** Drawn device/symbol scope; a locator, never a completeness oracle. */
    symbolKey: string;
    transform: Matrix;
    clipMm: Rect;
    bodyMm: Rect;
    view: NavigationView;
  };
}
export interface NavigationShape {
  id: string;
  mode: "local" | "self-located";
  inkMm: Rect;
  maximumForms: readonly string[];
  wrapWidthMm: number;
}
export interface AnnotationReservation {
  id: string;
  ownerAppearance: string;
  ownerOccurrence: string;
  profileId: string;
  space: "sheet-slot";
  inkMm: Rect;
  maximumForms: readonly string[];
  shapes?: readonly NavigationShape[];
  allocatedMm?: {
    sheet: number;
    rect: Rect;
    placement?: "local" | "self-located";
    shapeId?: string;
  };
}
export interface NavigationAnnotation {
  id: string;
  ownerOccurrence: string;
  ownerOccurrences: readonly string[];
  role: "canonical" | "repeat" | "mixed";
  targets: readonly string[];
  text: string;
  primitiveIds: readonly string[];
  reservationId: string;
  locality?: {
    mode: "local" | "self-located";
    anchorMm: { x: number; y: number };
    frameMm: Rect;
    ownerLocation: { sheet: number; zone: string };
    distanceMm: number;
  };
}
export interface IssuedNavigation {
  format: "issued-navigation/0.1";
  snapshotDigest: string;
  anchorRule: "function-terminal-centroid/2";
  quantumMm: 0.01;
  rounding: "decimal-half-up/1";
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
    basis: "catalog-box" | "adapter-box" | "reservation-box";
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
