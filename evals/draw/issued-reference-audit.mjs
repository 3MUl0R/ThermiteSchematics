import { assemblyAppearances } from "./assembly-appearances.mjs";
import { portId } from "./assembly-note-source.mjs";
import { issuedRows } from "./m3-documents.mjs";
import { nativeRows } from "./m3-native.mjs";
import { sufficient } from "./document-dependencies.mjs";
import { finding, painted } from "./review-geometry.mjs";
import { terminalPeerObligations } from "./terminal-peer-oracle.mjs";

const address = (n) => String(n).padStart(2, "0");
const at = (s, zone) => `${address(s)}.${zone}`;
function assemblyObligations(packet, geometries, ir, rows, native) {
  const { ports, links } = assemblyAppearances(packet, geometries, ir);
  return ir.relations
    .filter((r) => r.assembly)
    .flatMap((r) =>
      [
        [r.fromDeviceUid, r.assembly.fromPort],
        [r.toDeviceUid, r.assembly.toPort],
      ].flatMap(([uid, key]) => {
        const landings = ports.get(portId(uid, key)) ?? [];
        const drawn = new Set((links.get(r.uid) ?? []).map((a) => a.sheet));
        const expected = native.find(
          (n) => n.kind === "assemblies" && n.key === r.uid,
        );
        const row =
          expected &&
          rows.find(
            (candidate) =>
              candidate.visible &&
              candidate.zone &&
              sufficient(candidate, expected),
          );
        const label = `${ir.devices.find((d) => d.uid === uid)?.designation}.${key} · ${r.designation ?? r.uid}`;
        return landings.flatMap((src) => {
          const target = landings.find(
            (a) =>
              drawn.has(a.sheet) !== drawn.has(src.sheet) && a.zones.length,
          );
          if (target)
            return [
              {
                sheet: src.sheet,
                kind: "attachment",
                source: [uid, key, r.uid],
                values: target.zones.map(
                  (z) => `${label} → ${at(target.sheet, z)}`,
                ),
              },
            ];
          return !drawn.size && row
            ? [
                {
                  sheet: src.sheet,
                  kind: "assembly-inventory",
                  source: [uid, key, r.uid],
                  values: [`${label} inventory → ${at(row.sheet, row.zone)}`],
                },
              ]
            : [];
        });
      }),
    );
}

export function peerReferenceFindings(sheet, g, expected) {
  const obligations = [...expected];
  const result = [];
  for (const t of g.texts.filter((x) => x.peerReference && painted(x))) {
    let index = -1;
    try {
      const identity = JSON.parse(t.peerSource);
      index = obligations.findIndex(
        (o) =>
          o.kind === t.peerReference &&
          JSON.stringify(o.source) === JSON.stringify(identity) &&
          o.values.includes(t.text),
      );
    } catch {
      /* An unparseable source cannot establish a reference. */
    }
    if (index === -1)
      result.push(
        finding("issued-peer-reference-unbound", t, { sheet, printed: t.text }),
      );
    else obligations.splice(index, 1);
  }
  return result.concat(
    obligations.map((o) => ({
      ...finding(
        "issued-peer-reference-missing",
        {},
        {
          sheet,
          referenceKind: o.kind,
          source: o.source,
          expected: o.values,
        },
      ),
      designation: o.values[0],
    })),
  );
}

export function footerReferenceFindings(sheet, g, target) {
  if (sheet.view.kind !== "circuit") return [];
  const ink = g.texts
    .filter((t) => t.sheetText && painted(t) && t.bbox?.y >= g.height - 35)
    .map((t) => t.text)
    .join(" ");
  const measured = [...ink.matchAll(/Device and function references S(\d+)/gu)];
  if (
    /device\/function references in index/iu.test(ink) ||
    (target === undefined
      ? measured.length
      : measured.length !== 1 || Number(measured[0]?.[1]) !== target)
  )
    return [
      finding(
        "circuit-footer-reference-disagrees",
        {},
        { sheet: sheet.number, target, printed: ink },
      ),
    ];
  return [];
}

function inventorySheetMatches(sheet, geometry, scope, terminal, rows) {
  const ink = geometry.terminalStripInk;
  if (!ink || !ink.viewKeys.some((k) => scope.includes(k))) return false;
  const visible = rows.filter(
    (row) =>
      row.visible &&
      row.kind === "terminals" &&
      row.key === terminal.key &&
      row.sheet === sheet.number,
  );
  const keys = ink.references.filter(
    (r) => r.key === terminal.key && r.text === terminal.ref,
  );
  return visible.length === 1 && keys.length === 1;
}

export function stripInventoryFindings(packet, geometries, rows, i) {
  const sheet = packet.sheets[i],
    ink = geometries[i].terminalStripInk;
  if (sheet.view.kind !== "terminal-strip" || !ink) return [];
  return ink.terminals.flatMap((terminal) => {
    if (!terminal.rect) return [];
    const targets = packet.sheets.filter(
      (s, index) =>
        s.view.kind === "terminals" &&
        inventorySheetMatches(
          s,
          geometries[index],
          ink.viewKeys,
          terminal,
          rows,
        ),
    );
    const read = terminal.texts.filter(
      (t) => painted(t) && /^S\d+$/u.test(t.text),
    );
    if (
      targets.length === 1 &&
      read.length === 1 &&
      read[0].text === `S${address(targets[0].number)}`
    )
      return [];
    return [
      finding(
        "strip-inventory-sheet-disagrees",
        { bbox: terminal.rect, designation: terminal.ref },
        {
          sheet: sheet.number,
          terminal: terminal.key,
          read: read.map((t) => t.text),
          expectedSheets: targets.map((s) => s.number),
        },
      ),
    ];
  });
}

export function issuedReferenceAudit(packet, geometries, ir) {
  const rows = issuedRows(packet, geometries),
    sources = nativeRows(ir);
  const obligations = [
    ...assemblyObligations(packet, geometries, ir, rows, sources),
    ...terminalPeerObligations(packet, geometries, ir, sources),
  ];
  const target = packet.sheets.find(
    (s, i) =>
      s.view.kind === "references" &&
      geometries[i].texts.some(
        (t) => painted(t) && t.text === "Device and function references",
      ),
  )?.number;
  return packet.sheets.flatMap((sheet, i) => [
    ...peerReferenceFindings(
      sheet.number,
      geometries[i],
      obligations.filter((o) => o.sheet === sheet.number),
    ),
    ...footerReferenceFindings(sheet, geometries[i], target),
    ...stripInventoryFindings(packet, geometries, rows, i),
  ]);
}
