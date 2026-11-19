import type { ElectricalIr } from "@thermite/compiler";
import { required } from "../presentation/util.js";
import type { Draft, PaperPage, RenderedSheet } from "./types.js";
import type { IssuedDocument } from "./document-types.js";
import {
  assemblyPortGeometry,
  connectorPortKey,
  paintedStroke,
} from "./document-assembly-geometry.js";
import { navigationGeometry } from "./navigation-walk.js";
import { conductorEndpoints } from "./navigation-incidence.js";
import { destinationToken } from "./navigation-location.js";
import { inside, project } from "../device-legend/geometry.js";
import {
  emitPeerReferences,
  type PeerReference,
} from "./peer-reference-ink.js";

type Geometry = ReturnType<typeof assemblyPortGeometry>;
type Part = Geometry["parts"][number];

function drawnAttachments(
  svg: string,
  part: Part,
  inventory: Geometry["inventory"],
) {
  const assemblies = new Map(inventory.assemblies.map((a) => [a.uid, a]));
  const geometry = navigationGeometry(svg);
  const byNode = new Map(geometry.map((g) => [g.node, g]));
  const drawn = new Set<string>();
  for (const { node } of geometry) {
    const relation = assemblies.get(
      node.attrs["data-connector-assembly"] ?? "",
    );
    if (!relation) continue;
    const ends = [
      connectorPortKey(relation.fromDeviceUid, relation.assembly.fromPort),
      connectorPortKey(relation.toDeviceUid, relation.assembly.toPort),
    ].map((id) => part.ports.find((p) => p.id === id)?.point);
    const paths = node.children
      .filter((n) => n.name === "path")
      .map((n) => byNode.get(n));
    if (
      paths.some((g) => {
        if (!g || !paintedStroke(g)) return false;
        const points = conductorEndpoints(g.node.attrs.d ?? "");
        return (
          points.length === 2 &&
          points.every((p, i) => {
            const ink = project({ ...p, w: 0, h: 0 }, g.matrix),
              target = ends[i];
            return (
              target &&
              inside(ink, g.clip) &&
              Math.hypot(ink.x - target.x, ink.y - target.y) <= 0.02
            );
          })
        );
      })
    )
      drawn.add(relation.uid);
  }
  return drawn;
}

function inventoryAssemblyRows(documents: readonly IssuedDocument[]) {
  return documents
    .filter((d) => d.kind === "assemblies")
    .flatMap((d) => d.rows)
    .filter((row) =>
      ["identity", "endpoints", "status", "pin-map"].every((column) =>
        row.columns.some((c) => c === column),
      ),
    );
}

function attachmentEntries(
  part: Part,
  {
    parts,
    inventory,
    drawn,
    rows,
  }: {
    parts: readonly Part[];
    inventory: Geometry["inventory"];
    drawn: ReadonlyMap<number, ReadonlySet<string>>;
    rows: ReturnType<typeof inventoryAssemblyRows>;
  },
) {
  return part.ports.flatMap((port): PeerReference[] => {
    const native = inventory.ports.find(
      (p) => p.deviceUid === port.deviceUid && p.key === port.portKey,
    );
    const assembly = inventory.assemblies.find(
      (a) => a.uid === native?.assemblyUid,
    );
    if (!assembly || !native) return [];
    const local = drawn.get(part.sheet)?.has(assembly.uid) ?? false;
    const remote = parts
      .filter(
        (p) =>
          p.sheet !== part.sheet &&
          drawn.get(p.sheet)?.has(assembly.uid) !== local,
      )
      .flatMap((p) =>
        p.ports.filter((candidate) => candidate.id === port.id),
      )[0];
    const assemblyName = assembly.designation ?? assembly.uid;
    const names = `${native.designation}.${native.key} · ${assemblyName}`;
    const identity = [port.deviceUid, port.portKey, assembly.uid];
    if (remote)
      return [
        {
          kind: "attachment",
          identity,
          owner: port.point,
          value: `${names} → ${destinationToken(remote)}`,
          compact: `→ ${assemblyName} ${destinationToken(remote)}`,
          destination: destinationToken(remote),
        },
      ];
    if (local || [...drawn.values()].some((ids) => ids.has(assembly.uid)))
      return [];
    const row = rows.find((r) => r.nativeKey === assembly.uid);
    return row
      ? [
          {
            kind: "assembly-inventory",
            identity,
            owner: port.point,
            value: `${names} inventory → ${destinationToken(row)}`,
            compact: `→ ${assemblyName} inventory ${destinationToken(row)}`,
            destination: destinationToken(row),
          },
        ]
      : [];
  });
}

export function assemblyPeerReferences(
  ir: Readonly<ElectricalIr>,
  drafts: readonly Draft[],
  sheets: readonly RenderedSheet[],
  page: PaperPage,
  documents: readonly IssuedDocument[],
) {
  if (
    !sheets.some(
      (s) => "kind" in s.view && s.view.kind === "connector-assembly",
    )
  )
    return [...sheets];
  const { parts, inventory } = assemblyPortGeometry(ir, drafts, sheets, page);
  const drawn = new Map(
    parts.map((part) => [
      part.sheet,
      drawnAttachments(
        required(sheets[part.sheet - 1], "Missing issued connector drawing")
          .svg,
        part,
        inventory,
      ),
    ]),
  );
  const rows = inventoryAssemblyRows(documents);
  return sheets.map((sheet) => {
    const part = parts.find((p) => p.sheet === sheet.number);
    if (!part) return sheet;
    const entries = attachmentEntries(part, { parts, inventory, drawn, rows });
    return emitPeerReferences(sheet, part.field, entries);
  });
}
