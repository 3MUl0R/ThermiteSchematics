import { measuredRows } from "./tranche4-data.mjs";
import { nativePortInk } from "./native-port-ink.mjs";
import {
  assemblySelection,
  omittedPortNeeds,
  portsOf,
} from "./assembly-note-source.mjs";
import { nativeRows } from "./m3-native.mjs";
import { issuedRows } from "./m3-documents.mjs";
import { logicalPointerNotes, sufficient } from "./document-dependencies.mjs";
import { finding, painted } from "./review-geometry.mjs";
import { inView, viewBindings } from "./tranche4-views.mjs";
const tokens = (text) =>
  [...text.matchAll(/\b(?:S)?(\d{1,3})[.]([A-Z]+\d+)\b/gu)].map((m) => ({
    sheet: Number(m[1]),
    zone: m[2],
  }));
function deliveryFindings(note, needs, rows, sheet) {
  const refs = tokens(note.text),
    findings = [];
  for (const need of needs) {
    const candidates =
      need && rows.filter((r) => r.visible && sufficient(r, need));
    if (
      !candidates?.some((r) =>
        refs.some((p) => p.sheet === r.sheet && r.zones.includes(p.zone)),
      )
    )
      findings.push({
        ...finding("assembly-note-native-row-target-unavailable", note, {
          nativeRow: need?.key ?? null,
          printedTargets: refs,
        }),
        sheet,
      });
  }
  return findings;
}
function notesForSheet(s, g, selection, ir, catalog, rows) {
  const omitted = omittedPortNeeds(g, selection, ir, catalog),
    findings = [];
  const own = (g.tranche4?.assemblies ?? [])
    .map((a) => selection.links.find((r) => r.uid === a.uid))
    .filter(Boolean);
  const notes = logicalPointerNotes(g.texts ?? []).filter(
    (t) =>
      !t.row &&
      painted(t) &&
      !t.furniture &&
      /(?:\bother ports\b|\bauthored (?:cap )?assembl(?:y|ies)\b|\bsee\b.*\b(?:assembly|schedule)\b|\bassembl(?:y|ies)\b.*\bS?\d+[.][A-Z]+\d+\b)/iu.test(
        t.text,
      ),
  );
  const used = new Set();
  for (const note of notes) {
    const portNote = /\bother ports\b/iu.test(note.text);
    const needs = portNote
      ? omitted.filter((n) => n.uid === note.deviceUid).map((n) => n.row)
      : [
          ...new Map(
            [
              ...own.map((r) =>
                catalog.find((n) => n.kind === "assemblies" && n.key === r.uid),
              ),
              ...omitted.map((n) => n.row),
            ].map((r) => [r?.key, r]),
          ).values(),
        ];
    const count = note.text.match(/\b(\d+)\s+other ports\b/iu)?.[1];
    const nativeCount = new Set(
      omitted.filter((n) => n.uid === note.deviceUid).map((n) => n.key),
    ).size;
    if (!needs.length)
      findings.push({
        ...finding("assembly-note-without-native-need", note),
        sheet: s.number,
      });
    if (count !== undefined && Number(count) !== nativeCount)
      findings.push({
        ...finding("assembly-note-omitted-port-count-disagrees", note, {
          actual: Number(count),
          expected: nativeCount,
        }),
        sheet: s.number,
      });
    for (const need of needs) used.add(need?.key);
    findings.push(...deliveryFindings(note, needs, rows, s.number));
  }
  const required = [
    ...omitted.map((n) => n.row),
    ...own.map((r) =>
      catalog.find((n) => n.kind === "assemblies" && n.key === r.uid),
    ),
  ];
  for (const need of required)
    if (!need || !used.has(need.key))
      findings.push({
        ...finding(
          "assembly-native-need-without-note",
          {},
          { nativeRow: need?.key ?? null },
        ),
        sheet: s.number,
      });
  return { findings, eligible: notes.length + required.length };
}
function nativeInkFindings(s, g, selection, ir, seen) {
  const findings = [];
  if (!g.tranche4)
    return [
      { ...finding("assembly-measurement-unavailable"), sheet: s.number },
    ];
  for (const p of g.tranche4.ports.filter((p) => p.kind === "assembly"))
    if (
      !portsOf(ir, p.deviceUid)?.[p.key] ||
      !p.point ||
      !p.texts.some((t) => painted(t) && t.text.trim() === p.key)
    )
      findings.push({
        ...finding("assembly-port-native-geometry-disagrees", p),
        sheet: s.number,
      });
  for (const a of g.tranche4.assemblies) {
    const r = selection.links.find((r) => r.uid === a.uid),
      ends = r && [
        { deviceUid: r.fromDeviceUid, portKey: r.assembly.fromPort },
        { deviceUid: r.toDeviceUid, portKey: r.assembly.toPort },
      ];
    if (
      !r ||
      JSON.stringify(a.ends) !== JSON.stringify(ends) ||
      !nativePortInk(a, g.tranche4.ports, "assembly")
    )
      findings.push({
        ...finding("assembly-native-link-geometry-disagrees", a),
        sheet: s.number,
      });
    seen.set(a.uid, (seen.get(a.uid) ?? 0) + 1);
  }
  return findings;
}
export function assemblyNoteAudit(packet, geometries, ir, request) {
  if (!measuredRows(geometries))
    return {
      eligible: 1,
      findings: [
        {
          ...finding("assembly-measurement-unavailable"),
          sheet: packet.sheets[0]?.number,
        },
      ],
    };
  const findings = [],
    catalog = nativeRows(ir),
    rows = issuedRows(packet, geometries);
  let eligible = 0;
  if (!Array.isArray(request?.views) || !Array.isArray(ir?.relations))
    return {
      eligible: 1,
      findings: [
        {
          ...finding("assembly-source-unavailable"),
          sheet: packet.sheets[0]?.number,
        },
      ],
    };
  const keys = viewBindings(request, ir);
  for (const [view, v] of request.views.entries()) {
    if (v.format !== "connector-assembly-view-request/0.1") continue;
    let selection;
    try {
      selection = assemblySelection(v, ir);
    } catch (e) {
      findings.push({
        ...finding(
          "assembly-source-selection-unavailable",
          {},
          { reason: e.message },
        ),
        sheet: packet.sheets[0]?.number,
      });
      continue;
    }
    const seen = new Map();
    for (const [i, s] of packet.sheets.entries()) {
      const g = geometries[i];
      if (s.view.kind !== "connector-assembly" || !inView(g, keys[view]))
        continue;
      const a = notesForSheet(s, g, selection, ir, catalog, rows);
      eligible += a.eligible;
      findings.push(
        ...nativeInkFindings(s, g, selection, ir, seen),
        ...a.findings,
      );
    }
    for (const r of selection.links)
      if (seen.get(r.uid) !== 1)
        findings.push({
          ...finding(
            "assembly-selected-link-not-once",
            {},
            { relation: r.uid, appearances: seen.get(r.uid) ?? 0 },
          ),
          sheet: packet.sheets[0]?.number,
        });
  }
  return { findings, eligible };
}
