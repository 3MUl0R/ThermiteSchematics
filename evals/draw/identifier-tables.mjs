// Index/reference tables are packet-owned; public query tables cover all other
// reports. Values below come from packet references and IR, never printed text.
export function identifierTable(sheet, packet, g, ir, tables) {
  const kind = sheet.view.kind;
  const table = tables.find((table) => table.kind === kind);
  if (table) return table;
  if (!["index", "references"].includes(kind)) {
    if (g.reportRows.length)
      throw Error(`Identifier measurement: source table missing for ${kind}`);
    return null;
  }
  const content = packet.sheets.filter(
    (s) => !["index", "references"].includes(s.view.kind),
  );
  const columns =
    kind === "index"
      ? ["Sheet", "View", "Devices"]
      : ["Device", "Function / representation", "Sheet / zone"];
  const rows =
    kind === "index"
      ? content.map((s) => ({
          key: String(s.number),
          cells: [
            String(s.number),
            "",
            [...new Set(s.references.map((r) => r.designation))].join(", "),
          ],
          deviceUids: [...new Set(s.references.map((r) => r.deviceUid))],
        }))
      : g.reportRows.map((key) => {
          const [uid, functions, representation] = JSON.parse(key);
          const device = ir.devices.find((d) => d.uid === uid);
          if (!device)
            throw Error(
              `Identifier measurement: unknown reference device ${uid}`,
            );
          const entries = content.flatMap((s) =>
            s.references
              .filter(
                (r) =>
                  r.deviceUid === uid &&
                  JSON.stringify(r.functions) === JSON.stringify(functions) &&
                  r.representation === representation,
              )
              .map((r) => `${s.number} / ${r.zone}`),
          );
          if (!entries.length)
            throw Error(
              `Identifier measurement: reference source missing for ${key}`,
            );
          return {
            key,
            cells: [device.designation, "", [...new Set(entries)].join("; ")],
            deviceUids: [uid],
          };
        });
  return { kind, columns, rows };
}
