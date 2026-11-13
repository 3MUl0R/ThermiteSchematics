// TB1 staging model. Imported by tests only; do not export from the runtime API.
import type {
  SchematicPacketRequest,
  PageSettings,
} from "../../packet/types.js";
import type { Diagnostic } from "@thermite/schema";

export const slots = [
  "project",
  "sheetTitle",
  "drawingNumber",
  "customer",
  "drawnBy",
  "date",
  "checkedBy",
  "approvedBy",
  "revision",
  "sheetNumber",
] as const;
export type Slot = (typeof slots)[number];
export const bindings = {
  project: "project.name",
  sheetTitle: "sheet.title",
  revision: "sheet.revision",
  sheetNumber: "sheet.numberOfTotal",
} as const;
export type Binding = (typeof bindings)[keyof typeof bindings];
export interface Field {
  readonly slot: Slot;
  readonly label: string;
  readonly value?: string | null;
  readonly bind?: Binding;
  readonly pattern?: string;
  readonly missing?: "blank";
}
export interface Grid {
  readonly columns: 6;
  readonly rows: 4;
}
export interface Presentation {
  readonly format: "project-presentation/0.3";
  readonly $schema?: string;
  readonly revision?: string;
  readonly backgroundColor?: string;
  readonly page?: PageSettings;
  readonly frame?: {
    readonly zones?: {
      readonly default?: Grid;
      readonly byPaper?: Partial<
        Record<
          NonNullable<PageSettings["size"]>,
          Partial<Record<NonNullable<PageSettings["orientation"]>, Grid>>
        >
      >;
    };
    readonly header?: { readonly text: string | null };
    readonly generatorStamp?: "title" | "border" | "metadata";
  };
  readonly titleBlock?: {
    readonly profile?: "compact";
    readonly lines?: readonly string[];
    readonly fields?: Readonly<Record<string, Field>>;
  };
}
export interface RevisionRow {
  readonly version: string;
  readonly comment?: string;
  readonly date?: string;
  readonly drawnBy?: string;
}
export interface TitleRecord {
  readonly values?: Readonly<Record<string, string | null>>;
  readonly sheetTitle?: string | null;
  readonly revision?: string | null;
  readonly revisionRows?: readonly RevisionRow[];
}
export interface TitleData {
  readonly defaults?: TitleRecord & { readonly drawingBase?: string | null };
  readonly byView?: readonly (TitleRecord & { readonly viewIndex: number })[];
  readonly bySheet?: readonly (TitleRecord & { readonly sheetKey: string })[];
}
export interface PacketRequest extends Omit<SchematicPacketRequest, "format"> {
  readonly format: "schematic-packet-request/0.2";
  readonly titleData?: TitleData;
}
export interface TitleDiagnostic extends Omit<Diagnostic, "code"> {
  readonly code: Diagnostic["code"] | "R005" | "R006";
  readonly reason?: string;
  readonly ownerKind?: "title-field";
  readonly ownerId?: string;
  readonly field?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
export interface Result<T> {
  readonly value?: T;
  readonly diagnostics: readonly TitleDiagnostic[];
}
/** These identities come from native producers, never from titles/page numbers. */
export type SheetIdentity =
  | { readonly kind: "view"; readonly viewKey: string }
  | { readonly kind: "document"; readonly documentId: string }
  | { readonly kind: "companion"; readonly documentId: string }
  | { readonly kind: "index" }
  | { readonly kind: "references" };
export interface FinalSheet {
  readonly identity: SheetIdentity;
  readonly partIndex: number;
  readonly partTotal: number;
  /** One-based authored view; absent on independent index/reference documents. */
  readonly viewIndex?: number;
  readonly title: string;
}
export type Source =
  | "presentation"
  | "request-defaults"
  | "request-view"
  | "request-sheet"
  | "project"
  | "title"
  | "page";
export interface Fact<T> {
  readonly value: T | null;
  readonly known: boolean;
  readonly source: Source | null;
  readonly pointer: string | null;
  readonly inputs?: readonly Fact<string>[];
}
export interface ResolvedField {
  readonly key: string;
  readonly slot: Slot;
  readonly label: string;
  readonly fact: Fact<string>;
  /** Unknown revision displays UNSPECIFIED, while its fact remains unknown. */
  readonly text: string;
}
export interface ResolvedTitle {
  readonly sheetKey: string;
  readonly fields: readonly ResolvedField[];
  readonly revisionRows: Fact<readonly RevisionRow[]>;
  readonly history: readonly Readonly<
    Record<keyof Required<RevisionRow>, Fact<string>>
  >[];
}
