import { conductorIdentity } from "./tranche3-identities.mjs";

const normalizeCaption = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();

const netLabel = (t) =>
  t.labelRole ? t.labelRole === "net" : t.role?.includes("label-net");

function nativeTerminalIncidences(ir) {
  const byTerminal = new Map();
  const byCable = new Map();
  const add = (id, ends) => {
    const seen = new Set();
    for (const ep of ends ?? []) {
      const t = ep?.terminal ?? ep;
      if (!t?.deviceUid || !t?.terminalKey) continue;
      const k = JSON.stringify([t.deviceUid, t.terminalKey]);
      if (seen.has(k)) continue;
      seen.add(k);
      let set = byTerminal.get(k);
      if (!set) {
        set = new Set();
        byTerminal.set(k, set);
      }
      set.add(id);
    }
  };
  for (const w of ir.wires) add(w.uid, w.endpoints);
  for (const j of ir.jumpers) add(j.uid, j.endpoints);
  for (const c of ir.cableConductors) {
    const id = JSON.stringify([c.id.cableUid, c.id.conductorId]);
    add(id, c.endpoints);
    let set = byCable.get(c.cableUid);
    if (!set) {
      set = new Set();
      byCable.set(c.cableUid, set);
    }
    set.add(id);
  }
  return { byTerminal, byCable };
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

function expectedOutsideForBody(body, native) {
  const selected = new Set();
  for (const raw of body.selectedConductors ?? []) {
    const cid = conductorIdentity(raw);
    if (cid) selected.add(cid);
  }
  for (const cableUid of body.selectedCables ?? []) {
    for (const cid of native.byCable.get(cableUid) ?? []) selected.add(cid);
  }
  const incident =
    native.byTerminal.get(JSON.stringify([body.deviceUid, body.terminal])) ??
    new Set();
  let expected = 0;
  for (const cid of incident) if (!selected.has(cid)) expected++;
  return expected;
}

function checkBodyOutsideCount(body, expected, captions, issue, out) {
  if (expected > 0 && !captions.length) {
    out.push(
      issue("missing-outside-connection-count", body, {
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
  const out = [];
  for (const body of g.terminalOutsideBodies) {
    const expected = expectedOutsideForBody(body, native);
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
