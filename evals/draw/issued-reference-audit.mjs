import { nativeRelationReference } from "./relation-reference.mjs";
import { assemblyAppearances } from "./assembly-appearances.mjs";
import { portId } from "./assembly-note-source.mjs";
import { issuedRows } from "./m3-documents.mjs";
import { nativeRows } from "./m3-native.mjs";
import { sufficient } from "./document-dependencies.mjs";
import { extent, finding, groupBy, painted } from "./review-geometry.mjs";
import { terminalPeerObligations } from "./terminal-peer-oracle.mjs";
import { boxGap, inOwnerReach, noteOwnerGap } from "./peer-owner-ink.mjs";
import { measuredZone } from "./repeat-appearances.mjs";
import { printedZones } from "./printed-zones.mjs";
import { INK_ACCURACY_MM } from "./checks.mjs";

const PEER_STACK_GAP_MM = 1.5;
const address = (n) => String(n).padStart(2, "0");
const at = (s, zone) => `${address(s)}.${zone}`;

function endpointZone(packet, geometries, row, name) {
  if (!row) return;
  const g = geometries[packet.sheets.findIndex((s) => s.number === row.sheet)];
  const endpoint = row.texts.find(
    (t) => [2, 3].includes(t.columnIndex) && painted(t) && t.text === name,
  );
  if (!endpoint) return;
  const cell = g.reportCells.find(
    (c) =>
      c.reportRowScope === endpoint.reportRowScope &&
      c.columnIndex === endpoint.columnIndex &&
      c.regionVisible !== false,
  );
  const b = cell?.bbox;
  return b && measuredZone(g, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
}

function assemblyObligations(packet, geometries, ir, rows, native) {
  const { ports, links } = assemblyAppearances(packet, geometries, ir);
  const portsBySheet = new Map();
  for (const [id, list] of ports)
    for (const p of list) {
      if (!portsBySheet.has(p.sheet)) portsBySheet.set(p.sheet, []);
      portsBySheet.get(p.sheet).push({ id, box: p.circleBox ?? p.bbox });
    }
  return ir.relations
    .filter((r) => r.assembly)
    .flatMap((r) =>
      [
        [r.fromDeviceUid, r.assembly.fromPort],
        [r.toDeviceUid, r.assembly.toPort],
      ].flatMap(([uid, key]) => {
        const selfId = portId(uid, key);
        const landings = ports.get(selfId) ?? [];
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
        const assembly = nativeRelationReference(ir, r).text;
        const ownerLabel = `${ir.devices.find((d) => d.uid === uid)?.designation}.${key}`;
        const label = `${ownerLabel} · ${assembly}`;
        const rowZone = endpointZone(packet, geometries, row, ownerLabel);
        return landings.flatMap((src) => {
          const ownerBox = src.circleBox ?? src.bbox;
          const foreignOwners = (portsBySheet.get(src.sheet) ?? [])
            .filter((p) => p.id !== selfId)
            .map((p) => p.box);
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
                ownerLabel,
                owners: [ownerBox],
                foreignOwners,
                values: target.zones.map(
                  (z) => `${label} → ${at(target.sheet, z)}`,
                ),
                compactValues: target.zones.map(
                  (z) => `→ ${assembly} ${at(target.sheet, z)}`,
                ),
              },
            ];
          return !drawn.size && rowZone
            ? [
                {
                  sheet: src.sheet,
                  kind: "assembly-inventory",
                  source: [uid, key, r.uid],
                  ownerLabel,
                  owners: [ownerBox],
                  foreignOwners,
                  values: [`${label} inventory → ${at(row.sheet, rowZone)}`],
                  compactValues: [
                    `→ ${assembly} inventory ${at(row.sheet, rowZone)}`,
                  ],
                },
              ]
            : [];
        });
      }),
    );
}

const noteAddress = (value) =>
  / (\d+\.[A-D][1-6](?: \(also shown \d+\.[A-D][1-6](?:, \d+\.[A-D][1-6])*\))?)$/u.exec(
    value,
  )?.[1];

function addressUses(expected, named = false) {
  const counts = new Map();
  for (const { values, ownerLabel } of expected)
    for (const addr of new Set(values.map(noteAddress).filter(Boolean))) {
      const key = named ? JSON.stringify([ownerLabel, addr]) : addr;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  return counts;
}

function measuredNote(lines) {
  if (lines.some((t) => !painted(t) || (t.fontSize ?? 2.5) < 2.499)) return;
  const [first, second] = lines;
  if (!first.peerGroup) return lines.length === 1 ? first.text : undefined;
  if (lines.length !== 2 || !first.anchor || !second.anchor) return;
  const [top, bottom] = [first, second].sort((a, b) => a.anchor.y - b.anchor.y);
  if (
    Math.abs(top.anchor.x - bottom.anchor.x) > 0.02 ||
    Math.abs(bottom.anchor.y - top.anchor.y - 3.5) > 0.02 ||
    !top.bbox ||
    !bottom.bbox ||
    top.bbox.y + top.bbox.h > bottom.bbox.y
  )
    return;
  return top.text + " " + bottom.text;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function cardCarriesDestination(obligation) {
  const { card, label, peerName, destinations = [] } = obligation;
  if (!card || !destinations.length) return false;
  const prefix = `${label} → ${peerName}`;
  const idx = card.text.indexOf(prefix);
  if (idx < 0) return false;
  const tail = card.text.slice(idx + prefix.length);
  const [primary, ...alternates] = destinations;
  const primaryPattern = primary.zones
    .map((z) => escapeRegExp(at(primary.sheet, z)))
    .join("|");
  if (!alternates.length)
    return new RegExp(`^\\s+(?:${primaryPattern})(?:\\s|$)`, "u").test(tail);
  const altPatterns = alternates.map(
    (alt) => `(?:${alt.zones.map((z) => escapeRegExp(at(alt.sheet, z))).join("|")})`,
  );
  const pattern = new RegExp(
    `^\\s+(?:${primaryPattern})\\s+(?:\\(\\s*)?also shown\\s+${altPatterns.join("\\s*,\\s*")}\\)?(?:\\s|$)`,
    "u",
  );
  return pattern.test(tail);
}

function nameForm(obligation, note, value, namedCounts) {
  if (
    !value ||
    obligation.kind !== note.peerReference ||
    JSON.stringify(obligation.source) !== note.peerSource
  )
    return;
  const { ownerLabel, values, compactValues = [] } = obligation;
  if (values.includes(value)) return "named";
  if (ownerLabel && compactValues.some((v) => value === `${ownerLabel} ${v}`))
    return "named";
  if (!note.peerGroup && compactValues.includes(value)) return "bare";
  const addr = noteAddress(value);
  if (
    addr &&
    ownerLabel &&
    values.some((v) => noteAddress(v) === addr) &&
    namedCounts.get(JSON.stringify([ownerLabel, addr])) === 1 &&
    value === `${ownerLabel} → ${addr}`
  )
    return "named";
}

function measuredFieldHorizontalBounds(g) {
  if (!g?.frame || !g?.headerRule) return;
  const { numbers } = printedZones(g);
  if (numbers.length < 2) return;
  const colW = numbers[1].anchor.x - numbers[0].anchor.x;
  if (!(colW > 0)) return;
  return {
    left: numbers[0].anchor.x - colW / 2,
    right: numbers.at(-1).anchor.x + colW / 2,
  };
}

function noteRegion(lines) {
  return extent(
    lines.flatMap(({ bbox: b }) => [b, { x: b.x + b.w, y: b.y + b.h }]),
  );
}

function checkPeerStackGaps(sheet, regions, result) {
  for (let i = 0; i < regions.length; i++)
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i],
        b = regions[j];
      const horizontalOverlap =
        Math.min(a.box.x + a.box.w, b.box.x + b.box.w) -
          Math.max(a.box.x, b.box.x) >
        -INK_ACCURACY_MM;
      if (!horizontalOverlap) continue;
      const dy = Math.max(
        0,
        a.box.y - (b.box.y + b.box.h),
        b.box.y - (a.box.y + a.box.h),
      );
      if (dy < PEER_STACK_GAP_MM - INK_ACCURACY_MM)
        result.push(
          finding("issued-peer-reference-stack-gap", a.first, {
            sheet,
            printed: a.text,
            otherText: b.text,
            gapMm: dy,
            minimumMm: PEER_STACK_GAP_MM,
          }),
        );
    }
}

export function peerReferenceFindings(sheet, g, expected) {
  const result = [];
  const cardOwnedSources = new Set();
  const obligations = [];
  for (const o of expected) {
    if (o.card) {
      cardOwnedSources.add(JSON.stringify(o.source));
      if (!cardCarriesDestination(o))
        result.push({
          ...finding("issued-peer-reference-missing", o.card, {
            sheet,
            referenceKind: o.kind,
            source: o.source,
            expected: o.values,
            cardText: o.card.text,
          }),
          designation: o.values[0],
        });
    } else obligations.push(o);
  }
  const namedCounts = addressUses(obligations, true);
  const fieldBounds = measuredFieldHorizontalBounds(g);
  const seenFreeSources = new Set();
  const paintedRegions = [];
  const notes = groupBy(
    (g.texts ?? []).filter((t) => t.peerReference),
    (t) => t.peerGroup ?? t,
  );
  for (const lines of notes.values()) {
    const first = lines[0];
    const printed = lines.map((t) => t.text).join(" ");
    const value = measuredNote(lines);
    if (lines.every((t) => painted(t) && t.bbox)) {
      const box = noteRegion(lines);
      paintedRegions.push({ first, text: printed, box });
      if (
        fieldBounds &&
        (box.x < fieldBounds.left - INK_ACCURACY_MM ||
          box.x + box.w > fieldBounds.right + INK_ACCURACY_MM)
      )
        result.push(
          finding("issued-peer-reference-outside-drawing-bounds", first, {
            sheet,
            printed,
            noteLeftMm: box.x,
            fieldLeftMm: fieldBounds.left,
            fieldRightMm: fieldBounds.right,
          }),
        );
    }
    if (
      first.peerReference === "conductor-peer" &&
      cardOwnedSources.has(first.peerSource)
    ) {
      result.push(
        finding("issued-peer-reference-duplicate-card-note", first, {
          sheet,
          printed,
          source: first.peerSource,
        }),
      );
      continue;
    }
    if (value && /^→\s*\d+\.[A-D][1-6]$/u.test(value)) {
      result.push(
        finding("issued-peer-reference-subjectless", first, {
          sheet,
          printed: value,
        }),
      );
      continue;
    }
    const sourceKey = JSON.stringify([first.peerReference, first.peerSource]);
    if (seenFreeSources.has(sourceKey)) {
      result.push(
        finding("issued-peer-reference-duplicate", first, {
          sheet,
          printed,
          source: first.peerSource,
        }),
      );
      continue;
    }
    let form;
    const index = obligations.findIndex(
      (o) => (form = nameForm(o, first, value, namedCounts)),
    );
    if (index === -1) {
      result.push(
        finding("issued-peer-reference-unbound", first, {
          sheet,
          printed,
        }),
      );
      continue;
    }
    seenFreeSources.add(sourceKey);
    const [obligation] = obligations.splice(index, 1);
    if (obligation.owners) {
      const named = form === "named";
      const gap = noteOwnerGap(lines, obligation, named);
      if (!inOwnerReach(gap, named))
        result.push(
          finding("issued-peer-reference-owner-distance", first, {
            sheet,
            printed: value,
            source: obligation.source,
            gapMm: gap,
            named,
          }),
        );
      if (obligation.foreignOwners?.length && lines.every((t) => t.bbox)) {
        const box = noteRegion(lines);
        const foreignGap = Math.min(
          ...obligation.foreignOwners.map((owner) => boxGap(box, owner)),
        );
        if (foreignGap + INK_ACCURACY_MM < gap)
          result.push(
            finding("issued-peer-reference-foreign-owner", first, {
              sheet,
              printed: value,
              source: obligation.source,
              ownerGapMm: gap,
              foreignGapMm: foreignGap,
            }),
          );
      }
    }
  }
  checkPeerStackGaps(sheet, paintedRegions, result);
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
