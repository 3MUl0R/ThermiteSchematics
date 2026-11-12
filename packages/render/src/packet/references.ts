import { printedFunction } from "../print-projection.js";
import type { ElectricalIr } from "@thermite/compiler";
import type { DocumentationTable, resolveDeviceFilter } from "@thermite/query";
import type {
  Draft,
  SheetReference,
  SchematicPacketRequest,
  ReferenceSelection,
} from "./types.js";
import { sheetLabel, bounds, normalizePaperPage } from "./page.js";
import { wrapText } from "../text-metrics.js";

type ReferenceDraft = Pick<
  Draft,
  "view" | "references" | "documentationTable" | "referenceNotes"
>;
function referenceNotes(
  drafts: readonly ReferenceDraft[],
  request: Pick<SchematicPacketRequest, "page">,
) {
  const notes = [...new Set(drafts.flatMap((d) => d.referenceNotes ?? []))];
  if (!notes.length) return notes;
  const paper = normalizePaperPage(request.page);
  if (!paper.ok) return notes; // Packet validation already reports an invalid page.
  const width = bounds(
    {
      projectName: "",
      revision: "",
      toolVersion: "",
      backgroundColor: "#ffffff",
      lines: [],
    },
    paper.value,
  ).w;
  // The report retains its legacy character wrapping. Bound new engine lines
  // by measured width first; any further split can only make them narrower.
  return notes.flatMap((note) => wrapText(note, width, 2.5));
}

const designationOrder = (
  a: { designation: string },
  b: { designation: string },
) =>
  a.designation < b.designation ? -1 : a.designation > b.designation ? 1 : 0;

function referenceGroupKey(r: SheetReference): string {
  return JSON.stringify([
    r.deviceUid,
    r.functions,
    ...(r.representation ? [r.representation] : []),
  ]);
}
function referenceRepresentation(
  ir: Readonly<ElectricalIr>,
  r: SheetReference,
): string {
  return r.representation === "terminal"
    ? "Terminal context (coil outside view)"
    : r.functions
        .map((key) => {
          const fn = ir.functions.find(
            (f) => f.id.deviceUid === r.deviceUid && f.id.functionKey === key,
          );
          return fn ? printedFunction(fn) : "Function facts not specified";
        })
        .join(", ") || "Terminal / schedule";
}

function isDeviceReference(r: SheetReference): boolean {
  return !r.functions.length && !r.representation;
}

/** Content drafts already carry final terminal-centroid locations from the
 * navigation seam. Preserve aggregate report groups while collecting each
 * function's final zones; appending index pages must happen later. */
export function referenceTables(
  ir: Readonly<ElectricalIr>,
  drafts: readonly ReferenceDraft[],
  request: Pick<SchematicPacketRequest, "references" | "page">,
  referenceDevices: ReturnType<typeof resolveDeviceFilter> | undefined,
): {
  tables: DocumentationTable[];
  referenceSelection: ReferenceSelection | undefined;
} {
  let referenceSelection: ReferenceSelection | undefined;
  const indexTable: DocumentationTable = {
    kind: "index",
    title: "Drawing index",
    columns: ["Sheet", "View", "Devices"],
    widths: [0.08, 0.42, 0.5],
    notes: [
      "Index covers the generated content sheets. References point to this packet revision.",
      ...(request.references === false
        ? [
            "Device/function reference index omitted by request; content sheets remain indexed.",
          ]
        : []),
    ],
    rows: drafts.map((d, i) => ({
      key: String(i + 1),
      cells: [
        String(i + 1),
        sheetLabel(d.view),
        [...new Set(d.references?.map((r) => r.designation) ?? [])].join(", "),
      ],
      deviceUids: [...new Set(d.references?.map((r) => r.deviceUid) ?? [])],
    })),
  };
  const groups = new Map<
    string,
    {
      designation: string;
      functions: string;
      locations: string[];
      uid: string;
    }
  >();
  const retainedGroups: typeof groups = new Map();
  const selectedReferenceDevices = new Set(
    referenceDevices?.deviceUids ?? ir.devices.map((d) => d.uid),
  );
  drafts.forEach((d, i) =>
    d.references?.forEach((r) => {
      const key = referenceGroupKey(r);
      const g = groups.get(key) ?? {
        designation: r.designation,
        functions: referenceRepresentation(ir, r),
        locations: [],
        uid: r.deviceUid,
      };
      g.locations.push(`${i + 1} / ${r.zone}`);
      groups.set(key, g);
      if (
        request.references !== false &&
        selectedReferenceDevices.has(r.deviceUid) &&
        !(
          request.references?.appearances === "drawings" && d.documentationTable
        )
      ) {
        const retained = retainedGroups.get(key) ?? {
          ...g,
          functions:
            request.references?.appearances === "drawings" &&
            isDeviceReference(r)
              ? "Device / terminal / port"
              : g.functions,
          locations: [],
        };
        retained.locations.push(`${i + 1} / ${r.zone}`);
        retainedGroups.set(key, retained);
      }
    }),
  );
  if (request.references !== undefined)
    referenceSelection = {
      format: "reference-selection/0.1",
      enabled: request.references !== false,
      appearances:
        request.references === false
          ? "all"
          : (request.references.appearances ?? "all"),
      ...(referenceDevices ? { filter: referenceDevices.filter } : {}),
      deviceUids:
        referenceDevices?.deviceUids ?? ir.devices.map((d) => d.uid).sort(),
      outsideDeviceUids: referenceDevices?.outsideDeviceUids ?? [],
      totalGroups: groups.size,
      retainedGroups: retainedGroups.size,
      omittedGroupKeys: [...groups.keys()].filter(
        (k) => !retainedGroups.has(k),
      ),
    };
  const refTable: DocumentationTable = {
    kind: "references",
    title: "Device and function references",
    columns: ["Device", "Function / representation", "Sheet / zone"],
    widths: [0.2, 0.35, 0.45],
    notes: [
      request.references && request.references.appearances === "drawings"
        ? "Repeated functions represent the same physical device. References include diagram appearances only."
        : "Repeated functions represent the same physical device. References include schedule appearances.",
      ...(referenceSelection
        ? [
            `Filtered reference index: ${retainedGroups.size} of ${groups.size} device/function groups retained. Content sheets and continuation references are unchanged.`,
          ]
        : []),
      ...referenceNotes(drafts, request),
    ],
    rows: [...retainedGroups]
      .sort(([, a], [, b]) => designationOrder(a, b))
      .map(([key, g]) => ({
        key,
        cells: [
          g.designation,
          g.functions,
          [...new Set(g.locations)].join("; "),
        ],
        deviceUids: [g.uid],
      })),
  };
  return {
    tables:
      request.references === false ? [indexTable] : [indexTable, refTable],
    referenceSelection,
  };
}
