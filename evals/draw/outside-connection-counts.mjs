import {
  attachmentLeadEnds,
  conductorInk,
  paintedToBothEnds,
} from "./peer-owner-ink.mjs";

const normalizeCaption = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();

const netLabel = (t) =>
  t.labelRole ? t.labelRole === "net" : t.role?.includes("label-net");

const terminalPairKey = (deviceUid, terminalKey) =>
  JSON.stringify([deviceUid, terminalKey]);

function nativeTerminalIncidences(ir) {
  const byTerminal = new Map();
  const byCable = new Map();
  const conductors = new Map();
  const add = (id, element, rawEnds) => {
    const ends = [];
    const seen = new Set();
    for (const ep of rawEnds ?? []) {
      const t = ep?.terminal ?? ep;
      if (!t?.deviceUid || !t?.terminalKey) continue;
      ends.push([t.deviceUid, t.terminalKey]);
      const k = terminalPairKey(t.deviceUid, t.terminalKey);
      if (seen.has(k)) continue;
      seen.add(k);
      let set = byTerminal.get(k);
      if (!set) {
        set = new Set();
        byTerminal.set(k, set);
      }
      set.add(id);
    }
    conductors.set(id, { id, element, ends });
  };
  for (const w of ir.wires)
    add(w.uid, { kind: "wire", uid: w.uid }, w.endpoints);
  for (const j of ir.jumpers)
    add(j.uid, { kind: "jumper", uid: j.uid }, j.endpoints);
  for (const c of ir.cableConductors) {
    const id = JSON.stringify([c.id.cableUid, c.id.conductorId]);
    add(
      id,
      {
        kind: "cable-conductor",
        cableUid: c.id.cableUid,
        conductorId: c.id.conductorId,
      },
      c.endpoints,
    );
    let set = byCable.get(c.cableUid);
    if (!set) {
      set = new Set();
      byCable.set(c.cableUid, set);
    }
    set.add(id);
  }
  return { byTerminal, byCable, conductors };
}

function isValidPinBase(base, key) {
  return (
    base === key ||
    base === `${key} (+)` ||
    base === `${key} (-)` ||
    base === `${key} (OUT)`
  );
}

export function parsePrintedOutsideCount(rawText, terminalKey) {
  const norm = normalizeCaption(rawText);
  const key = normalizeCaption(terminalKey);
  if (isValidPinBase(norm, key))
    return { count: 0, explicitZero: false, validBase: true };
  const suffix = norm.match(/^(.*?)\s+\[\s*\+(\d+)\s*\]$/u);
  if (suffix) {
    const count = Number(suffix[2]);
    return {
      count,
      explicitZero: count === 0,
      validBase: isValidPinBase(suffix[1], key),
    };
  }
  const standalone = norm.match(/^\[\s*\+(\d+)\s*\]$/u);
  if (standalone) {
    const count = Number(standalone[1]);
    return { count, explicitZero: count === 0, validBase: false };
  }
  return { count: 0, explicitZero: false, validBase: false };
}

function buildScopeIndex(g) {
  const scopes = g.outsideRouteScopes ?? {};
  const bySelection = new Map();
  const byView = new Map();
  const push = (map, key, value) => {
    if (!key) return;
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(value);
  };
  for (const s of g.shapes ?? []) {
    const sc = scopes[s.element];
    if (!sc) continue;
    push(bySelection, sc.selectionScope, s);
    push(byView, sc.viewScope, s);
  }
  const viewTerminals = new Map();
  for (const body of g.terminalOutsideBodies ?? []) {
    const viewKey = body.viewScope ?? body.selectionScope;
    let map = viewTerminals.get(viewKey);
    if (!map) {
      map = new Map();
      viewTerminals.set(viewKey, map);
    }
    const tk = terminalPairKey(body.deviceUid, body.terminal);
    let boxes = map.get(tk);
    if (!boxes) {
      boxes = [];
      map.set(tk, boxes);
    }
    const markers = body.markerBoxes?.length ? body.markerBoxes : [body.bbox];
    boxes.push(...markers.filter(Boolean));
  }
  const viewLeads = new Map();
  for (const [viewKey, map] of viewTerminals) {
    const regions = new Map(
      [...map.entries()].map(([tk, boxes]) => [tk, { boxes }]),
    );
    const viewShapes = byView.get(viewKey) ?? [];
    const leads = attachmentLeadEnds({ ...g, shapes: viewShapes }, regions);
    for (const [tk, ends] of leads) map.get(tk)?.push(...ends);
    viewLeads.set(viewKey, leads);
  }
  return { bySelection, byView, viewTerminals, viewLeads };
}

function bodyRouteMarks(body, index, g) {
  const base = (
    body.markerBoxes?.length ? body.markerBoxes : [body.bbox]
  ).filter(Boolean);
  const viewKey = body.viewScope ?? body.selectionScope;
  const viewShapes = index.byView.get(viewKey) ?? [];
  const tk = terminalPairKey(body.deviceUid, body.terminal);
  const localLeads = attachmentLeadEnds(
    { ...g, shapes: viewShapes },
    new Map([[tk, { boxes: base }]]),
  );
  return [...base, ...(localLeads.get(tk) ?? [])];
}

function mateEndpoint(ends, deviceUid, terminalKey) {
  const other = ends.find(
    ([uid, key]) => uid !== deviceUid || key !== terminalKey,
  );
  return other ?? ends[0];
}

function expectedOutsideForBody(body, native, g, index) {
  const tk = terminalPairKey(body.deviceUid, body.terminal);
  const incident = native.byTerminal.get(tk) ?? new Set();
  if (!incident.size) return 0;
  const selected = new Set();
  for (const cableUid of body.selectedCables ?? []) {
    for (const cid of native.byCable.get(cableUid) ?? []) selected.add(cid);
  }
  if (body.kind === "circuit") {
    const scopeG = {
      ...g,
      shapes: index.bySelection.get(body.selectionScope) ?? [],
    };
    for (const cid of incident) {
      const cond = native.conductors.get(cid);
      if (cond && conductorInk(scopeG, cond.element).runs.length > 0)
        selected.add(cid);
    }
  } else {
    const viewKey = body.viewScope ?? body.selectionScope;
    const viewG = { ...g, shapes: index.byView.get(viewKey) ?? [] };
    const bodyMarks = bodyRouteMarks(body, index, g);
    const terminals = index.viewTerminals.get(viewKey);
    for (const cid of incident) {
      const cond = native.conductors.get(cid);
      if (!cond) continue;
      const ink = conductorInk(viewG, cond.element);
      if (!ink.runs.length) continue;
      const mate = mateEndpoint(cond.ends, body.deviceUid, body.terminal);
      const mateMarks = mate
        ? terminals?.get(terminalPairKey(mate[0], mate[1]))
        : undefined;
      if (paintedToBothEnds(ink, bodyMarks, mateMarks)) selected.add(cid);
    }
  }
  let expected = 0;
  for (const cid of incident) if (!selected.has(cid)) expected++;
  return expected;
}

function checkBodyOutsideCount(body, expected, captions, issue, out) {
  if (expected > 0 && !captions.length) {
    out.push(
      issue("missing-outside-connection-count", body, {
        deviceUid: body.deviceUid,
        terminal: body.terminal,
        expectedOutside: expected,
        printedOutside: null,
        reason: "missing-terminal-caption",
      }),
    );
    return;
  }
  for (const caption of captions) {
    const parsed = parsePrintedOutsideCount(caption.text, body.terminal);
    if (expected > 0) {
      if (parsed.count === expected && !parsed.explicitZero && parsed.validBase)
        continue;
      out.push(
        issue(
          parsed.count === 0 && !parsed.explicitZero
            ? "missing-outside-connection-count"
            : "mismatched-outside-connection-count",
          caption,
          {
            deviceUid: body.deviceUid,
            text: caption.text,
            terminal: body.terminal,
            expectedOutside: expected,
            printedOutside: parsed.count,
          },
        ),
      );
    } else if (parsed.count > 0 || parsed.explicitZero) {
      out.push(
        issue("mismatched-outside-connection-count", caption, {
          deviceUid: body.deviceUid,
          text: caption.text,
          terminal: body.terminal,
          expectedOutside: 0,
          printedOutside: parsed.count,
        }),
      );
    }
  }
}

export function outsideConnectionFindings(g, ir, issue) {
  if (
    !ir ||
    !Array.isArray(ir.wires) ||
    !Array.isArray(ir.jumpers) ||
    !Array.isArray(ir.cableConductors) ||
    !Array.isArray(g.terminalOutsideBodies) ||
    !g.terminalOutsideBodies.length
  )
    return [];
  const native = nativeTerminalIncidences(ir);
  const index = buildScopeIndex(g);
  const out = [];
  for (const body of g.terminalOutsideBodies) {
    const expected = expectedOutsideForBody(body, native, g, index);
    const captions = (g.texts ?? []).filter(
      (t) =>
        t.painted !== false &&
        !netLabel(t) &&
        t.tagKind !== "reference" &&
        t.deviceUid === body.deviceUid &&
        t.terminal === body.terminal &&
        (t.nativeFunctionScope ?? t.terminalBodyScope) === body.bodyScope,
    );
    checkBodyOutsideCount(body, expected, captions, issue, out);
  }
  return out;
}
