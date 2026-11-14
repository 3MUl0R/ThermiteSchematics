// Native IR and Chromium ink only. Never imports the renderer's locator planner.
import { nativeRows } from "./m3-native.mjs";
import { issuedRows } from "./m3-documents.mjs";
import { rowZones } from "./m3-zones.mjs";
import { painted, extent, finding } from "./review-geometry.mjs";
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
        // Labels in this painted core row independently identify the native
        // ends. Match each label to its nearest measured circle; array/DOM
        // order and exported endpoint slots supply no identity.
        const markers = (g.wireTerminals ?? []).filter(
          (m) => m.cableScope && m.cableScope === item.cableScope,
        );
        const candidates = (row?.ends ?? []).filter(Boolean).filter((end) => {
          const device = ir.devices.find((d) => d.uid === end.deviceUid),
            expected = compact(`${device?.designation}.${end.terminalKey}`);
          const labels = g.texts.filter(
            (t) =>
              painted(t) && t.cableScope && t.cableScope === item.cableScope,
          );
          return labels.some((first) => {
            let value = "";
            const lines = labels
              .filter(
                (t) =>
                  Math.abs(
                    (t.anchor?.x ?? t.bbox.x) -
                      (first.anchor?.x ?? first.bbox.x),
                  ) < 0.05 && t.bbox.y >= first.bbox.y,
              )
              .sort((a, b) => a.bbox.y - b.bbox.y);
            for (const line of lines) {
              value += compact(line.text);
              if (value === expected) {
                const distance = (m) =>
                  Math.hypot(
                    Math.max(
                      0,
                      first.bbox.x - m.bbox.x - m.bbox.w,
                      m.bbox.x - first.bbox.x - first.bbox.w,
                    ),
                    Math.max(
                      0,
                      first.bbox.y - m.bbox.y - m.bbox.h,
                      m.bbox.y - first.bbox.y - first.bbox.h,
                    ),
                  );
                const d = distance(item);
                return !markers.some(
                  (m) => m !== item && distance(m) <= d + 0.01,
                );
              }
              if (!expected.startsWith(value)) break;
            }
            return false;
          });
        });
        if (candidates.length === 1)
          terminal = [candidates[0].deviceUid, candidates[0].terminalKey];
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
  const inventory = issuedRows(packet, geometries).filter(
    (r) => r.kind === "wires",
  );
  // Continuation-only and other non-inventory evaluations may contain only
  // conductor identities. They do not require native endpoint reconstruction.
  if (!inventory.length) return { findings: [], measurements: [] };
  const gap = (row, reason) =>
    finding("wire-locator-measurement-gap", row.texts[0], {
      sheet: row.sheet,
      row: row.key,
      reason,
    });
  const terminal = (t) =>
    typeof t?.deviceUid === "string" &&
    t.deviceUid.length > 0 &&
    typeof t?.terminalKey === "string" &&
    t.terminalKey.length > 0;
  let native;
  try {
    for (const w of [...(ir.wires ?? []), ...(ir.jumpers ?? [])])
      if (
        !Array.isArray(w.endpoints) ||
        w.endpoints.length !== 2 ||
        ![0, 1].every((i) => terminal(w.endpoints[i]?.terminal))
      )
        throw Error(`Native conductor ${w.uid} has incomplete endpoints`);
    native = nativeRows(ir).filter((r) => r.kind === "wires");
    if (native.some((r) => r.ends.some((t) => t != null && !terminal(t))))
      throw Error("Native conductor has incomplete terminal identity");
  } catch (error) {
    return {
      findings: inventory.map((row) => gap(row, error.message)),
      measurements: [],
    };
  }
  const rows = new Map(native.map((r) => [r.key, r]));
  const drawn = measuredWireAppearances(packet, geometries, ir, native);
  const findings = [],
    measurements = [];
  for (const row of inventory) {
    const source = rows.get(row.key);
    if (!source) {
      findings.push(gap(row, "Issued wire row has no native endpoint source"));
      continue;
    }
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
