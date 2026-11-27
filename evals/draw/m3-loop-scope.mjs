import { terminalKey } from "./m3-facts.mjs";

const resolveDevice = (ir, spec) =>
  (ir.devices ?? []).find((d) => d.uid === spec || d.designation === spec);

const resolveLoopFunction = (ir, spec) => {
  if (!spec?.device || !spec?.function) return null;
  const dev = resolveDevice(ir, spec.device);
  if (!dev) return null;
  return (ir.functions ?? []).find(
    (f) => f.id.deviceUid === dev.uid && f.id.functionKey === spec.function,
  );
};

function physicalAdjacency(catalog) {
  const adj = new Map();
  for (const row of catalog) {
    if (row.kind !== "wires" || !row.ends?.[0] || !row.ends?.[1]) continue;
    for (const end of row.ends) {
      const k = terminalKey(end);
      let list = adj.get(k);
      if (!list) {
        list = [];
        adj.set(k, list);
      }
      list.push(row);
    }
  }
  return adj;
}

function pathCables(start, target, adj) {
  const startKey = terminalKey(start);
  const targetKey = terminalKey(target);
  const queue = [{ key: startKey, cables: [] }];
  const visited = new Set([startKey]);
  for (const item of queue) {
    if (item.key === targetKey) return item.cables;
    for (const row of adj.get(item.key) ?? []) {
      const other = row.ends.find((e) => terminalKey(e) !== item.key);
      if (!other) continue;
      const nextKey = terminalKey(other);
      if (visited.has(nextKey)) continue;
      visited.add(nextKey);
      queue.push({
        key: nextKey,
        cables: row.element?.cableUid
          ? [...item.cables, row.element.cableUid]
          : item.cables,
      });
    }
  }
  return null;
}

function seriesLegPairs(ir, view, netOf) {
  const fns = [view.from, view.to, view.loopPower].map((s) =>
    resolveLoopFunction(ir, s),
  );
  if (fns.some((f) => !f?.terminals?.length)) return null;
  const byNet = new Map();
  fns.forEach((fn, owner) => {
    for (const t of fn.terminals) {
      const net = netOf.get(terminalKey(t));
      if (!net) continue;
      const group = byNet.get(net) ?? [];
      group.push({ terminal: t, owner });
      byNet.set(net, group);
    }
  });
  const pairs = [];
  for (const group of byNet.values()) {
    if (group.length !== 2 || group[0].owner === group[1].owner) return null;
    pairs.push([group[0].terminal, group[1].terminal]);
  }
  return pairs.length === 3 ? pairs : null;
}

function directLegPairs(ir, view, netOf) {
  const specs = [
    [view.from, view.to],
    ...(view.auxiliary ?? []).map((a) => [a.from, a.to]),
  ];
  const pairs = [];
  for (const [fromSpec, toSpec] of specs) {
    const fromFn = resolveLoopFunction(ir, fromSpec);
    const toFn = resolveLoopFunction(ir, toSpec);
    if (!fromFn?.terminals?.length || !toFn?.terminals?.length) return null;
    for (const start of fromFn.terminals) {
      const net = netOf.get(terminalKey(start));
      const targets = toFn.terminals.filter(
        (t) => net && netOf.get(terminalKey(t)) === net,
      );
      if (targets.length !== 1) return null;
      pairs.push([start, targets[0]]);
    }
  }
  return pairs.length ? pairs : null;
}

function ownDeviceCables(catalog, own) {
  return new Set(
    catalog
      .filter(
        (r) =>
          r.kind === "wires" &&
          r.element?.cableUid &&
          r.ends?.some((e) => e && own.has(e.deviceUid)),
      )
      .map((r) => r.element.cableUid),
  );
}

/** Reconstruct expected signal-loop cable membership from native IR and request scope. */
export function nativeLoopScopeCables(ir, view, catalog, own) {
  if (!view || !ir.functions?.length || !ir.nets?.length)
    return ownDeviceCables(catalog, own);
  const netOf = new Map(
    ir.nets.flatMap((n) =>
      (n.terminalIds ?? []).map((t) => [terminalKey(t), n.id]),
    ),
  );
  const pairs = view.loopPower
    ? seriesLegPairs(ir, view, netOf)
    : directLegPairs(ir, view, netOf);
  if (!pairs) return ownDeviceCables(catalog, own);
  const adj = physicalAdjacency(catalog);
  const cables = new Set();
  for (const [start, target] of pairs) {
    const found = pathCables(start, target, adj);
    if (!found) return ownDeviceCables(catalog, own);
    for (const uid of found) cables.add(uid);
  }
  return cables;
}
