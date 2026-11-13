// Native IR and Chromium ink only. Never imports the renderer's locator planner.
import { nativeRows } from "./m3-native.mjs";
import { issuedRows } from "./m3-documents.mjs";
import { rowZones } from "./m3-zones.mjs";
import { painted, extent, finding } from "./review-geometry.mjs";
import { documentationTableKinds } from "./identifier-tables.mjs";
const compact = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .replace(/\s+/gu, "");
const terminalKey = (t) => JSON.stringify([t.deviceUid, t.terminalKey]);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Old output has no pin-row keys. Native pin text within its device supplies
 * the identity; a key or arbitrary device/net appearance supplies no fact. */
export function pinListAppearances(g, ir) {
  const result = [],
    texts = g.texts.filter((t) => painted(t) && t.deviceUid && t.anchor);
  for (const device of ir.devices ?? []) {
    const type = ir.deviceTypes?.find((t) => t.id === device.typeId);
    for (const terminal of type?.terminals ?? []) {
      if (!terminal.description) {
        for (const first of texts.filter((t) => t.deviceUid === device.uid))
          if (
            first.pinTerminal === JSON.stringify([device.uid, terminal.key]) &&
            compact(first.text) === compact(terminal.key)
          )
            result.push({
              terminal: [device.uid, terminal.key],
              bbox: first.bbox,
              element: first.element,
              kind: "pin-list",
            });
        continue;
      }
      const expected = compact(terminal.description);
      const prefix = new RegExp(`^${escape(terminal.key)}:?\\s+(.+)$`, "u");
      for (const first of texts.filter((t) => t.deviceUid === device.uid)) {
        const start = prefix.exec(first.text);
        if (!start) continue;
        const lines = [first];
        let value = compact(start[1]);
        const following = texts
          .filter(
            (t) =>
              t !== first &&
              t.deviceUid === device.uid &&
              t.textContainer === first.textContainer &&
              Math.abs(t.anchor.x - first.anchor.x) < 0.05 &&
              t.anchor.y > first.anchor.y,
          )
          .sort((a, b) => a.anchor.y - b.anchor.y);
        for (const next of following) {
          if (
            value === expected ||
            !expected.startsWith(value) ||
            next.anchor.y - lines.at(-1).anchor.y > 4.2
          )
            break;
          value += compact(next.text);
          lines.push(next);
        }
        if (value !== expected) continue;
        const bbox = extent(
          lines.flatMap((t) => [
            t.bbox,
            { x: t.bbox.x + t.bbox.w, y: t.bbox.y + t.bbox.h },
          ]),
        );
        result.push({
          terminal: [device.uid, terminal.key],
          bbox,
          element: first.element,
          kind: "pin-list",
        });
      }
    }
  }
  return result;
}

export function measuredWireAppearances(packet, geometries, ir, rows) {
  const drawn = new Map();
  const needed = new Set(
    rows.flatMap((r) => r.ends.filter(Boolean).map(terminalKey)),
  );
  const cores = new Map(
    rows
      .filter((r) => r.element.kind === "cable_conductor")
      .map((r) => [r.key, r]),
  );
  for (const [index, sheet] of packet.sheets.entries()) {
    if (documentationTableKinds.includes(sheet.view.kind)) continue;
    const g = geometries[index];
    if (!g) continue;
    for (const item of [
      ...(g.wireTerminals ?? []),
      ...pinListAppearances(g, ir),
    ]) {
      let terminal = item.terminal;
      if (!terminal && item.cableUid) {
        const row = cores.get(
          JSON.stringify([item.cableUid, item.conductorId]),
        );
        const ends = row?.ends.filter(Boolean);
        if (ends?.length === item.markerCount) {
          const end = ends[item.slot];
          if (end) terminal = [end.deviceUid, end.terminalKey];
        }
      }
      const key = JSON.stringify(terminal);
      if (!needed.has(key)) continue;
      const zones = rowZones(g, item.bbox);
      if (!zones.length)
        throw Error("Wire locator: drawn terminal has no measured zone grid");
      if (!drawn.has(key)) drawn.set(key, []);
      drawn.get(key).push({
        sheet: sheet.number,
        zones,
        bbox: item.bbox,
        element: item.element,
        kind: item.kind ?? "marker",
      });
    }
  }
  return drawn;
}

export function wireLocatorAudit(packet, geometries, ir) {
  const native = nativeRows(ir).filter((r) => r.kind === "wires");
  const rows = new Map(native.map((r) => [r.key, r]));
  const drawn = measuredWireAppearances(packet, geometries, ir, native);
  const findings = [],
    measurements = [];
  for (const row of issuedRows(packet, geometries).filter(
    (r) => r.kind === "wires",
  )) {
    const source = rows.get(row.key);
    if (!source) continue;
    for (const end of [0, 1]) {
      const endpoint = source.ends[end],
        appearances = endpoint ? (drawn.get(terminalKey(endpoint)) ?? []) : [];
      const value = row.texts
        .filter((t) => t.columnIndex === end + 5 && painted(t))
        .sort(
          (a, b) =>
            (a.anchor?.y ?? a.bbox.y) - (b.anchor?.y ?? b.bbox.y) ||
            a.bbox.x - b.bbox.x,
        )
        .map((t) => t.text)
        .join(" ")
        .trim();
      const allowed = [
        ...new Set(
          appearances.flatMap((a) =>
            a.zones.map((z) => `${String(a.sheet).padStart(2, "0")}.${z}`),
          ),
        ),
      ];
      const kind = !value
        ? "wire-locator-missing"
        : value === "not drawn"
          ? allowed.length
            ? "wire-locator-undrawn-claim"
            : null
          : !allowed.length
            ? "wire-locator-without-appearance"
            : !allowed.includes(value)
              ? "wire-locator-mismatch"
              : null;
      const cell =
        row.texts.find((t) => t.columnIndex === end + 5) ?? row.texts[0];
      measurements.push({
        sheet: row.sheet,
        row: row.key,
        end,
        endpoint,
        printed: value,
        allowed,
        appearances,
      });
      if (kind)
        findings.push(
          finding(kind, cell, {
            sheet: row.sheet,
            row: row.key,
            end,
            endpoint,
            printed: value,
            allowed,
          }),
        );
    }
  }
  return { findings, measurements };
}
