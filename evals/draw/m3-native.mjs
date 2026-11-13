// Independent issued-documents/1 adapter. Only native IR and measured source
// appearances enter this module; exported facts and planner code never do.
import { createHash } from "node:crypto";
import { painted } from "./review-geometry.mjs";
export const M3_FORMAT = "issued-documents/1";
export const sha = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const terminalKey = (t) =>
  JSON.stringify([t?.deviceUid, t?.terminalKey]);
export const compact = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .replace(/\s/gu, "");
const device = (ir, uid) => ir.devices?.find((d) => d.uid === uid);
const endName = (ir, t) =>
  t
    ? `${device(ir, t.deviceUid)?.designation}.${t.terminalKey}`
    : "Unterminated";
const nativePortText = (ir, uid, key, network = true) => {
  const d = device(ir, uid),
    description = ir.deviceTypes
      ?.find((t) => t.id === d?.typeId)
      ?.ports?.[key]?.description?.trim();
  const identity = network
    ? `${d?.designation}: ${key}${description && description !== key ? ` — ${description}` : ""}`
    : `${d?.designation}.${key}`;
  return [identity, d?.location].filter(Boolean).join("\n");
};
const inc = (element, end, terminal) => ({
  kind: "conductor-incidence",
  element,
  end,
  terminal,
});
export const semanticColumns = {
  "conductor-incidence": ["identity", "endpoints", "status"],
  "terminal-inventory": ["identity", "connections", "status"],
  "port-link-status": ["identity", "endpoints", "protocol", "status"],
  "core-inventory": ["identity", "endpoints", "status"],
  "assembly-pin-map": ["identity", "endpoints", "status", "pin-map"],
};
const exactKeys = (o, keys) =>
  o &&
  JSON.stringify(Object.keys(o).sort()) === JSON.stringify(keys.slice().sort());
export function factKey(f) {
  if (!f || !semanticColumns[f.kind]) throw Error("Unknown M3 fact kind");
  if (f.kind === "conductor-incidence") {
    if (
      !exactKeys(f, ["kind", "element", "end", "terminal"]) ||
      ![0, 1].includes(f.end) ||
      !exactKeys(f.terminal, ["deviceUid", "terminalKey"])
    )
      throw Error("Invalid M3 incidence");
    const e = f.element,
      core = e?.kind === "cable_conductor";
    if (
      !exactKeys(
        e,
        core ? ["kind", "cableUid", "conductorId"] : ["kind", "uid"],
      ) ||
      !["wire", "jumper", "cable_conductor"].includes(e.kind)
    )
      throw Error("Invalid M3 element");
    return JSON.stringify([
      f.kind,
      e.kind,
      core ? [e.cableUid, e.conductorId] : e.uid,
      f.end,
      f.terminal.deviceUid,
      f.terminal.terminalKey,
    ]);
  }
  if (f.kind === "terminal-inventory") {
    if (
      !exactKeys(f, ["kind", "terminal"]) ||
      !exactKeys(f.terminal, ["deviceUid", "terminalKey"])
    )
      throw Error("Invalid M3 terminal");
    return JSON.stringify([
      f.kind,
      f.terminal.deviceUid,
      f.terminal.terminalKey,
    ]);
  }
  const fields =
    f.kind === "port-link-status"
      ? ["deviceUid", "portKey"]
      : f.kind === "core-inventory"
        ? ["cableUid", "conductorId"]
        : ["relationUid"];
  if (
    !exactKeys(f, ["kind", ...fields]) ||
    fields.some((k) => typeof f[k] !== "string")
  )
    throw Error("Invalid M3 fact fields");
  return JSON.stringify([f.kind, ...fields.map((k) => f[k])]);
}
export function factKeys(facts) {
  try {
    const keys = facts.map(factKey);
    return new Set(keys).size === keys.length ? keys.sort() : null;
  } catch {
    return null;
  }
}
const port = (deviceUid, portKey) => ({
  kind: "port-link-status",
  deviceUid,
  portKey,
});
export function nativeRows(ir) {
  const rows = [];
  for (const kind of ["wire", "jumper"])
    for (const w of ir[kind === "wire" ? "wires" : "jumpers"] ?? []) {
      const element = { kind, uid: w.uid },
        ends = w.endpoints.map((e) => e.terminal);
      rows.push({
        kind: "wires",
        key: w.uid,
        name: w.designation ?? "Jumper",
        ends,
        element,
        facts: ends.map((t, i) => inc(element, i, t)),
        required: {
          0: [
            [
              w.designation ?? "Jumper",
              w.properties?.label && w.properties.label !== w.designation
                ? w.properties.label
                : null,
            ]
              .filter(Boolean)
              .join(" / "),
          ],
          1: [endName(ir, ends[0])],
          2: [endName(ir, ends[1])],
          4: ["Connected"],
        },
        exactColumns: [0, 1, 2, 4],
      });
    }
  for (const cable of ir.cables ?? []) {
    const connected = (ir.cableConductors ?? []).filter(
      (c) => c.id.cableUid === cable.uid,
    );
    const defs =
      ir.cableTypes?.find((t) => t.id === cable.typeId)?.conductors ??
      connected.map((c) => ({ id: c.id.conductorId }));
    for (const def of defs) {
      const assignment = cable.assignments?.find((a) => a.id === def.id),
        physical = connected.find((c) => c.id.conductorId === def.id);
      const sourceEnds = assignment?.endpoints ?? physical?.endpoints,
        ends = [0, 1].map((i) => sourceEnds?.[i]?.terminal);
      const count = ends.filter(Boolean).length,
        usage =
          assignment?.usage ?? (sourceEnds ? "unspecified" : "unassigned");
      const status = !sourceEnds
        ? "unassigned"
        : count === 2
          ? "connected"
          : count === 1
            ? "partially-terminated"
            : "unterminated";
      const element = {
        kind: "cable_conductor",
        cableUid: cable.uid,
        conductorId: def.id,
      };
      rows.push({
        kind: "wires",
        key: JSON.stringify([cable.uid, def.id]),
        name: `${cable.designation}/${def.id}`,
        ends,
        element,
        facts: [
          ...ends.flatMap((t, i) => (t ? [inc(element, i, t)] : [])),
          { kind: "core-inventory", cableUid: cable.uid, conductorId: def.id },
        ],
        required: {
          0: [`${cable.designation}/${def.id}`],
          1: [endName(ir, ends[0])],
          2: [endName(ir, ends[1])],
          4: [`${usage}; ${status}`],
        },
        exactColumns: [0, 1, 2, 4],
      });
    }
  }
  for (const t of ir.terminals ?? []) {
    const id = t.id,
      connections = rows.filter((w) =>
        w.ends?.some((e) => e && terminalKey(e) === terminalKey(id)),
      );
    const peers = connections.flatMap((w) =>
      w.ends.flatMap((end, i) =>
        end && terminalKey(end) === terminalKey(id)
          ? [{ name: w.name, peer: w.ends[1 - i] }]
          : [],
      ),
    );
    const ownLocation = device(ir, id.deviceUid)?.location;
    const local = peers.filter(
      (p) =>
        p.peer &&
        ownLocation !== undefined &&
        device(ir, p.peer.deviceUid)?.location === ownLocation,
    );
    const connectionText = (ps) =>
      ps
        .map((p) => `${p.name} -> ${endName(ir, p.peer)}`)
        .sort()
        .join("; ") || "None";
    rows.push({
      kind: "terminals",
      key: terminalKey(id),
      name: endName(ir, id),
      facts: [{ kind: "terminal-inventory", terminal: id }],
      required: {
        0: [device(ir, id.deviceUid)?.designation],
        2: [id.terminalKey],
        4: [connectionText(local)],
        5: [connectionText(peers.filter((p) => !local.includes(p)))],
        6: [connections.length ? "Terminated" : "Unconnected"],
      },
      exactColumns: [0, 2, 4, 5, 6],
      connections: connections.map((w) => ({
        name: w.name,
        peers: w.ends
          .filter((e) => e && terminalKey(e) !== terminalKey(id))
          .map((e) => endName(ir, e)),
      })),
    });
  }
  for (const r of ir.relations ?? []) {
    const c = r.connection ?? r.assembly;
    if (!c) continue;
    const network = !!r.connection;
    rows.push({
      kind: network ? "network" : "assemblies",
      key: r.uid,
      name: r.designation ?? r.uid,
      facts: network
        ? [port(r.fromDeviceUid, c.fromPort), port(r.toDeviceUid, c.toPort)]
        : [{ kind: "assembly-pin-map", relationUid: r.uid }],
      ownerUid: r.fromDeviceUid,
      required: {
        0: [r.designation ?? r.uid],
        1: network
          ? [
              [
                c.protocol,
                c.cable?.specification,
                c.cable?.lengthM === undefined
                  ? undefined
                  : `${c.cable.lengthM} m`,
                c.cable?.route,
              ]
                .filter(Boolean)
                .join("\n"),
            ]
          : [c.kind].filter(Boolean),
        2: [nativePortText(ir, r.fromDeviceUid, c.fromPort, network)],
        3: [nativePortText(ir, r.toDeviceUid, c.toPort, network)],
        4: [
          network
            ? (c.status ?? "Unspecified")
            : `${c.status ?? "Unspecified"}\nPin mapping: ${c.pinMapping?.status}\n${c.pinMapping?.reason}`,
        ],
      },
      exactColumns: network ? [0, 1, 2, 3, 4] : [0, 2, 3, 4],
      ports: [
        {
          column: 2,
          designation: device(ir, r.fromDeviceUid)?.designation,
          key: c.fromPort,
        },
        {
          column: 3,
          designation: device(ir, r.toDeviceUid)?.designation,
          key: c.toPort,
        },
      ],
    });
  }
  for (const d of ir.devices ?? [])
    for (const [key, p] of Object.entries(
      ir.deviceTypes?.find((t) => t.id === d.typeId)?.ports ?? {},
    )) {
      if (p.kind && p.kind !== "communication") continue;
      if (
        (ir.relations ?? []).some(
          (r) =>
            r.connection &&
            ((r.fromDeviceUid === d.uid && r.connection.fromPort === key) ||
              (r.toDeviceUid === d.uid && r.connection.toPort === key)),
        )
      )
        continue;
      rows.push({
        kind: "network",
        key: JSON.stringify([d.uid, key]),
        name: `${d.designation}: ${key}`,
        facts: [port(d.uid, key)],
        required: {
          0: ["--"],
          1: [p.medium ?? "Unspecified"],
          2: [nativePortText(ir, d.uid, key)],
          3: ["Unconnected"],
          4: ["Unspecified"],
        },
        exactColumns: [0, 1, 2, 3, 4],
        ports: [{ column: 2, designation: d.designation, key }],
      });
    }
  for (const d of ir.devices ?? [])
    for (const [key, definition] of Object.entries(
      ir.deviceTypes?.find((t) => t.id === d.typeId)?.connectorPorts ?? {},
    )) {
      const occupied = (ir.relations ?? []).some(
        (r) =>
          r.assembly &&
          ((r.fromDeviceUid === d.uid && r.assembly.fromPort === key) ||
            (r.toDeviceUid === d.uid && r.assembly.toPort === key)),
      );
      if (occupied) continue;
      rows.push({
        kind: "assemblies",
        key: JSON.stringify([d.uid, key]),
        name: `${d.designation} / ${key}`,
        facts: [],
        columns: ["identity", "endpoints", "status", "pin-map"],
        required: {
          0: ["--"],
          1: [definition.connector],
          2: [nativePortText(ir, d.uid, key, false)],
          3: ["Unoccupied"],
          4: ["No assembly declared"],
        },
        exactColumns: [0, 1, 2, 3, 4],
      });
    }
  return rows;
}
const distinct = (values) => [...new Set(values)];
// Source appearance + native endpoint incidence partition. Dropping a caption or
// an exported dependency does not remove the independently expected need.
export function nativeNeeds(sheet, g, ir, catalog = nativeRows(ir), request) {
  const kind = nativeProducerKind(request, sheet),
    needs = [],
    uids = distinct(
      [
        ...(g.devices ?? []).map((d) => d.deviceUid),
        ...(g.terminals ?? []).map((t) => t.deviceUid),
      ].filter((uid) => device(ir, uid)),
    ),
    own = new Set(uids);
  const add = (need, noteId, facts, extra = {}) => {
    const unique = [...new Map(facts.map((f) => [factKey(f), f])).values()];
    if (unique.length) needs.push({ need, noteId, facts: unique, ...extra });
  };
  if (kind === "wiring") {
    const authored = (request?.views ?? []).filter(
      (v) =>
        v.format === "wiring-view-request/0.1" &&
        (!v.title || sheet.view.title?.startsWith(v.title)),
    );
    const sourceRows =
      authored.length === 1
        ? catalog.filter(
            (r) =>
              r.kind === "wires" &&
              (authored[0].conductors ?? []).some(
                (key) => key === r.key || key === r.name,
              ),
          )
        : [];
    const sourceTerminals = sourceRows
      .flatMap((r) => r.ends ?? [])
      .filter(Boolean);
    const terminals = [
      ...new Map(
        [
          ...(g.terminals ?? []).map((t) => ({
            deviceUid: t.deviceUid,
            terminalKey: t.terminal,
          })),
          ...sourceTerminals,
        ].map((t) => [terminalKey(t), t]),
      ).values(),
    ];
    for (const t of sourceTerminals)
      if (!own.has(t.deviceUid)) {
        uids.push(t.deviceUid);
        own.add(t.deviceUid);
      }
    const selected = new Set(
      (g.shapes ?? [])
        .filter(
          (s) => s.conductor && s.nativeBodyPainted !== false && painted(s),
        )
        .map((s) => s.wire),
    );
    for (const id of terminals) {
      const hidden = catalog.filter(
        (r) => r.kind === "wires" && !selected.has(r.key),
      );
      add(
        "conductor-incidence",
        `wiring-incidence/${terminalKey(id)}`,
        hidden.flatMap((r) =>
          r.facts.filter(
            (f) =>
              f.kind === "conductor-incidence" &&
              terminalKey(f.terminal) === terminalKey(id),
          ),
        ),
        { subject: endName(ir, id) },
      );
    }
    for (const uid of uids) {
      const drawn = new Set(
        terminals.filter((t) => t.deviceUid === uid).map((t) => t.terminalKey),
      );
      add(
        "terminal-inventory",
        `wiring-terminals/${uid}`,
        catalog
          .filter(
            (r) =>
              r.kind === "terminals" &&
              r.facts[0].terminal.deviceUid === uid &&
              !drawn.has(r.facts[0].terminal.terminalKey),
          )
          .flatMap((r) => r.facts),
        { subject: device(ir, uid)?.designation },
      );
    }
  }
  if (["communication", "topology"].includes(kind)) {
    const candidates = (request?.views ?? []).filter(
      (v) =>
        v.format === "communication-view-request/0.1" &&
        (!v.title || sheet.view.title?.startsWith(v.title)),
    );
    const single =
      request?.views?.length === 1 &&
      request.views[0].format === "communication-view-request/0.1"
        ? request.views[0]
        : undefined;
    const view =
      single ?? (candidates.length === 1 ? candidates[0] : undefined);
    const scopedLinks = (ir.relations ?? []).filter(
      (r) =>
        r.connection && (!view?.medium || r.connection.medium === view.medium),
    );
    const allowed = new Set(
      view?.devices
        ? ir.devices
            .filter(
              (d) =>
                view.devices.includes(d.uid) ||
                view.devices.includes(d.designation),
            )
            .map((d) => d.uid)
        : ir.devices
            .filter(
              (d) =>
                !view?.medium ||
                Object.values(
                  ir.deviceTypes?.find((t) => t.id === d.typeId)?.ports ?? {},
                ).some((p) => p.medium === view.medium),
            )
            .map((d) => d.uid),
    );
    if (!view?.devices)
      for (const r of scopedLinks) {
        allowed.add(r.fromDeviceUid);
        allowed.add(r.toDeviceUid);
      }
    for (let changed = true; changed;) {
      changed = false;
      for (const r of scopedLinks)
        if (allowed.has(r.fromDeviceUid) || allowed.has(r.toDeviceUid))
          for (const uid of [r.fromDeviceUid, r.toDeviceUid])
            if (!allowed.has(uid)) {
              allowed.add(uid);
              changed = true;
            }
    }
    const ordered = uids.slice().sort((a, b) => {
      const an = device(ir, a)?.designation ?? a,
        bn = device(ir, b)?.designation ?? b;
      return an < bn ? -1 : an > bn ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
    const links = (ir.relations ?? [])
      .filter(
        (r) =>
          r.connection &&
          own.has(r.fromDeviceUid) &&
          own.has(r.toDeviceUid) &&
          (!view?.medium || r.connection.medium === view.medium),
      )
      .sort((a, b) =>
        (a.designation ?? a.uid) < (b.designation ?? b.uid)
          ? -1
          : (a.designation ?? a.uid) > (b.designation ?? b.uid)
            ? 1
            : 0,
      );
    const facts = catalog
      .filter((r) => r.kind === "network")
      .flatMap((r) =>
        r.facts.filter(
          (f) =>
            own.has(f.deviceUid) &&
            (!view?.medium ||
              ir.deviceTypes?.find(
                (t) => t.id === device(ir, f.deviceUid)?.typeId,
              )?.ports?.[f.portKey]?.medium === view.medium),
        ),
      );
    for (const r of links)
      facts.push(
        port(r.fromDeviceUid, r.connection.fromPort),
        port(r.toDeviceUid, r.connection.toPort),
      );
    add(
      "port-link-status",
      `communication-status/${sha([ordered, links.map((r) => r.uid)])}`,
      facts,
      { scopeMismatch: uids.filter((uid) => !allowed.has(uid)) },
    );
  }
  if (["signal-loop", "analog-output"].includes(kind)) {
    const cableUids = new Set(
      catalog
        .filter(
          (r) =>
            r.kind === "wires" &&
            r.ends?.some((t) => t && own.has(t.deviceUid)),
        )
        .map((r) => r.element?.cableUid)
        .filter(Boolean),
    );
    add(
      "core-inventory",
      "loop-core-details",
      catalog
        .filter((r) => r.kind === "wires")
        .flatMap((r) =>
          r.facts.filter(
            (f) => f.kind === "core-inventory" && cableUids.has(f.cableUid),
          ),
        ),
    );
    const rels = new Set(
      (ir.relations ?? [])
        .filter(
          (r) =>
            r.assembly && (own.has(r.fromDeviceUid) || own.has(r.toDeviceUid)),
        )
        .map((r) => r.uid),
    );
    add(
      "assembly-pin-map",
      "loop-assembly-pin-maps",
      catalog
        .filter((r) => r.kind === "assemblies" && rels.has(r.key))
        .flatMap((r) => r.facts),
    );
  }
  return [...new Map(needs.map((n) => [n.noteId, n])).values()];
}

export function nativeProducerKind(request, sheet) {
  const v = request?.views?.length === 1 ? request.views[0] : null;
  if (!v || request?.m3AutomaticDocument) return sheet.view.kind;
  return (
    {
      "wiring-view-request/0.1": "wiring",
      "communication-view-request/0.1": "communication",
      "signal-loop-view-request/0.1": "signal-loop",
    }[v.format] ??
    v.kind ??
    "other-selected-view"
  );
}
export function nativeRequestForSheet(packet, geometries, request, sheet) {
  const views = request?.views ?? (request ? [request] : []),
    ordered = [];
  const own = geometries[packet.sheets.indexOf(sheet)];
  if (own?.texts?.some((t) => t.documentOrigin === "auto"))
    return { ...request, m3AutomaticDocument: true };
  for (const [i, s] of packet.sheets.entries()) {
    if (
      ["index", "references"].includes(s.view.kind) ||
      geometries[i]?.texts?.some((t) => t.documentOrigin === "auto")
    )
      continue;
    for (const key of geometries[i]?.navigationViews ?? [])
      if (!ordered.includes(key)) ordered.push(key);
  }
  const keys = own?.navigationViews ?? [],
    order = keys.length === 1 ? ordered.indexOf(keys[0]) : -1;
  return ordered.length === views.length && order >= 0
    ? { ...request, views: [views[order]], m3AuthoredViewIndex: order }
    : {
        ...request,
        m3ViewScopeGap: {
          expectedViews: views.length,
          issuedViews: ordered.length,
          ownerKeys: keys,
        },
      };
}
