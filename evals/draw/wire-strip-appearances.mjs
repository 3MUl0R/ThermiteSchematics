import {
  hasStripApproach,
  stripBridge,
  stripStub,
  stripTerminalBody,
} from "./terminal-strip-landing.mjs";

const key = (terminal) =>
  JSON.stringify([terminal.deviceUid, terminal.terminalKey]);

export function measuredStripAppearances(packet, geometries, ir, rows) {
  const strips = packet.sheets.flatMap((sheet, index) => {
    const ink = geometries[index]?.terminalStripInk;
    return ink?.terminals.length ? [{ sheet: sheet.number, ink }] : [];
  });
  const result = new Map();
  if (!strips.length) return result;
  const devices = new Map(
    ir.devices.map((device) => [device.uid, device.designation]),
  );
  const jumperNames = new Map(
    (ir.jumpers ?? []).map((j) => [j.uid, j.designation ?? `Jumper ${j.uid}`]),
  );
  for (const row of rows)
    for (const [end, terminal] of row.ends.entries()) {
      if (!terminal) continue;
      const label =
        row.element.kind === "jumper" ? jumperNames.get(row.key) : row.name;
      const appearances = stripLandings(
        strips,
        devices,
        row,
        end,
        terminal,
        label,
      );
      if (appearances.length)
        result.set(JSON.stringify([row.key, end]), appearances);
    }
  return result;
}

function stripLandings(strips, devices, row, end, endpoint, label) {
  const terminalKey = key(endpoint);
  const peer = row.ends[1 - end];
  const nameOf = (t) => `${devices.get(t.deviceUid)}.${t.terminalKey}`;
  return strips.flatMap(({ sheet, ink }) => {
    const terminal = stripTerminalBody(
      ink,
      terminalKey,
      endpoint.terminalKey,
      devices.get(endpoint.deviceUid),
    );
    if (!terminal?.zone || terminal.sheet !== sheet) return [];
    const stub = stripStub(
      ink,
      terminal,
      row.key,
      label,
      peer ? nameOf(peer) : "Unterminated",
    );
    const bridge =
      row.element.kind === "jumper" && peer?.deviceUid === endpoint.deviceUid
        ? stripBridge(
            ink,
            terminal,
            {
              uid: row.key,
              ends: row.ends.map(key),
              name: label,
              peers: row.ends.map(nameOf),
            },
            end,
          )
        : null;
    const path = stub ?? bridge;
    if (!hasStripApproach(path, terminal)) return [];
    return [
      {
        sheet,
        zones: [terminal.zone],
        bbox: terminal.rect,
        kind: "strip",
        conductor: row.key,
        terminal: [endpoint.deviceUid, endpoint.terminalKey],
        printedIncidence:
          stub?.visibleText ??
          ink.bridgeLabels.find(
            (b) =>
              b.uid === row.key && b.at === terminalKey && b.sheet === sheet,
          )?.visibleText,
        vertices: path.vertices,
      },
    ];
  });
}
