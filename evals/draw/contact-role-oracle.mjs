import { finding, painted, groupBy } from "./review-geometry.mjs";
export function nativeContactRole(ir, fn) {
  const d = ir.devices?.find((d) => d.uid === fn.id.deviceUid),
    type = ir.deviceTypes?.find((t) => t.id === d?.typeId);
  if (!type) return { reason: "Native type missing" };
  const mark = type.circuitSymbols?.[fn.id.functionKey];
  if (["breaker", "overload", "fuse"].includes(mark)) return { role: mark };
  if (
    mark &&
    /(?:contact|switch|pushbutton|estop|selector)-(?:no|nc)$/.test(mark)
  )
    return { role: "contact", state: mark.endsWith("-nc") ? "NC" : "NO" };
  const power =
    fn.terminals?.length === 2 &&
    fn.terminals.every((e) =>
      type.terminals?.some(
        (t) =>
          t.key === e.terminalKey &&
          /^power_(input|output)$/.test(t.role ?? ""),
      ),
    );
  const protection = {
    "iec:circuit-breaker": "breaker",
    "thermite:breaker": "breaker",
    "iec:overload-relay": "overload",
    "thermite:overload": "overload",
    "iec:fuse": "fuse",
    "thermite:fuse": "fuse",
  }[type.symbol];
  if (power && protection) return { role: protection };
  if (
    protection &&
    !power &&
    !(fn.terminals ?? []).every((e) =>
      type.terminals?.some((t) => t.key === e.terminalKey && t.role),
    )
  )
    return { reason: "Protection function role is unspecified" };
  return fn.kind === "contact"
    ? {
        role: "contact",
        state:
          fn.normal_state === "closed"
            ? "NC"
            : fn.normal_state === "open"
              ? "NO"
              : undefined,
      }
    : { role: fn.kind };
}
function findFunction(ir, deviceUid, functionKey) {
  return ir.functions?.find(
    (f) => f.id.deviceUid === deviceUid && f.id.functionKey === functionKey,
  );
}
function measuredFunctionOwner(t, ir) {
  return t.deviceUid && t.functionKey
    ? findFunction(ir, t.deviceUid, t.functionKey)
    : undefined;
}
function labelFunctionOwner(t, ir) {
  return Array.isArray(t.labelOwnerKey) &&
    t.labelOwnerKey.length === 3 &&
    t.labelOwnerKey[0] === "function"
    ? findFunction(ir, t.labelOwnerKey[1], t.labelOwnerKey[2])
    : undefined;
}
function owners(t, ir) {
  if (t.row != null && t.columnIndex === 1) {
    try {
      const [uid, keys] = JSON.parse(t.row);
      if (Array.isArray(keys))
        return keys.map((key) => findFunction(ir, uid, key));
    } catch {}
    return [];
  }
  const measured = measuredFunctionOwner(t, ir);
  if (measured?.kind === "contact") return [measured];
  if (t.labelOwnerKey?.[0] === "function") return [labelFunctionOwner(t, ir)];
  if (t.functionKey) return [measured];
  return [];
}
const normalSpace = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();

function authoredChannelSignal(t, ir) {
  if (t.channelLine !== "signal" || t.row != null) return null;
  let fn;
  if (t.deviceUid || t.functionKey) {
    fn = measuredFunctionOwner(t, ir);
    if (!fn || fn.kind !== "channel") return null;
    if (
      t.labelOwnerKey != null &&
      (!Array.isArray(t.labelOwnerKey) ||
        t.labelOwnerKey.length !== 3 ||
        t.labelOwnerKey[0] !== "function" ||
        t.labelOwnerKey[1] !== fn.id.deviceUid ||
        t.labelOwnerKey[2] !== fn.id.functionKey)
    )
      return null;
  } else if (t.labelOwnerKey?.[0] === "function") {
    fn = labelFunctionOwner(t, ir);
    if (!fn || fn.kind !== "channel") return null;
  } else return null;
  const d = ir.devices?.find((dev) => dev.uid === fn.id.deviceUid);
  const channels = d?.io?.channels;
  const signal =
    channels && Object.hasOwn(channels, fn.id.functionKey)
      ? channels[fn.id.functionKey]?.signal
      : undefined;
  return typeof signal === "string" && signal.trim() ? signal : null;
}

function readingPos(t) {
  return t.anchor ?? t.bbox ?? { x: 0, y: 0 };
}

function adjacentSignalLines(siblings, allTexts) {
  for (let i = 1; i < siblings.length; i++) {
    const prev = siblings[i - 1],
      next = siblings[i];
    if (!prev.bbox || !next.bbox) return false;
    const lineH = Math.max(
      prev.fontSize ?? 0,
      prev.bbox.h ?? 0,
      next.fontSize ?? 0,
      next.bbox.h ?? 0,
      2,
    );
    const dy = readingPos(next).y - readingPos(prev).y;
    if (dy <= 0 || dy > lineH * 2.2) return false;
    const horizClose =
      Math.max(prev.bbox.x, next.bbox.x) <=
      Math.min(prev.bbox.x + prev.bbox.w, next.bbox.x + next.bbox.w) + lineH;
    if (!horizClose) return false;
    const intervening = (allTexts ?? []).some(
      (other) =>
        painted(other) &&
        other !== prev &&
        other !== next &&
        other.appearanceScope === prev.appearanceScope &&
        other.functionScope === prev.functionScope &&
        other.channelLineGroup === prev.channelLineGroup &&
        other.bbox &&
        readingPos(other).y > readingPos(prev).y + 0.17 &&
        readingPos(other).y < readingPos(next).y - 0.17,
    );
    if (intervening) return false;
  }
  return true;
}

function isAuthoredChannelSignal(t, ir, g) {
  const signal = authoredChannelSignal(t, ir);
  if (!signal) return false;
  const expected = normalSpace(signal);
  if (!g?.texts) return normalSpace(t.text) === expected;
  const siblings = g.texts
    .filter(
      (s) =>
        painted(s) &&
        s.channelLine === "signal" &&
        s.row == null &&
        s.appearanceScope === t.appearanceScope &&
        s.functionScope === t.functionScope &&
        s.channelLineGroup === t.channelLineGroup &&
        s.deviceUid === t.deviceUid &&
        s.functionKey === t.functionKey &&
        JSON.stringify(s.labelOwnerKey) === JSON.stringify(t.labelOwnerKey),
    )
    .slice()
    .sort((a, b) => {
      const pa = readingPos(a);
      const pb = readingPos(b);
      return pa.y - pb.y || pa.x - pb.x;
    });
  if (siblings.length > 1 && !adjacentSignalLines(siblings, g.texts))
    return false;
  const parts = siblings.map((s) => normalSpace(s.text));
  return (
    parts.length > 0 && parts.every(Boolean) && parts.join(" ") === expected
  );
}

export function isContactCaptionScope(t) {
  const scope =
    (t.columnIndex === 1 && t.reportRowScope) ||
    t.functionKey ||
    t.labelOwnerKey?.[0] === "function" ||
    t.labelRole === "function";
  return Boolean(painted(t) && scope && !t.terminal);
}

export function isContactCaptionCandidate(t, ir) {
  return (
    isContactCaptionScope(t) &&
    (owners(t, ir).some((f) => f && f.kind === "contact") ||
      /\b(?:NC|NO)\b/.test(t.text))
  );
}

export function isContactCaptionMediaField(t, ir) {
  if (isContactCaptionCandidate(t, ir)) return true;
  if (!painted(t) || t.terminal || t.channelLine !== "signal" || t.row != null)
    return false;
  const signal = authoredChannelSignal(t, ir);
  return Boolean(signal && /\b(?:NC|NO)\b/.test(signal));
}

export function isContactCaptionField(t, ir, g) {
  return isContactCaptionCandidate(t, ir) && !isAuthoredChannelSignal(t, ir, g);
}
function claimRoles(text, match, fs, ir) {
  if (fs.length === 1) return fs.map((f) => nativeContactRole(ir, f));
  const clause = text
    .slice(match.index + match[0].length)
    .split(/,\s+(?=[A-Za-z])/)[0];
  const matches = fs.filter(
    (f) =>
      f.terminals.length &&
      f.terminals.every((t) => {
        const at = clause.indexOf(t.terminalKey),
          before = clause[at - 1],
          after = clause[at + t.terminalKey.length];
        return (
          at >= 0 &&
          (!before || !/[\p{L}\p{N}]/u.test(before)) &&
          (!after || !/[\p{L}\p{N}]/u.test(after))
        );
      }),
  );
  return (matches.length ? matches : fs).map((f) => nativeContactRole(ir, f));
}
export function contactCaptionAudit(g, ir) {
  const out = [];
  let eligible = 0;
  const candidates = g.texts.filter((t) => isContactCaptionField(t, ir, g));
  for (const ts of groupBy(candidates, (t) =>
    JSON.stringify([
      t.documentId,
      t.row,
      t.columnIndex,
      t.functionScope,
      t.labelOwnerKey,
      t.deviceUid,
      t.functionKey,
    ]),
  ).values()) {
    const text = ts.map((t) => t.text).join(" "),
      states = [...text.matchAll(/\b(NC|NO)\b/g)];
    eligible++;
    if (!states.length) continue;
    const fs = owners(ts[0], ir);
    if (!fs.length || fs.some((f) => !f)) {
      out.push(finding("contact-caption-owner-unavailable", ts[0], { text }));
      continue;
    }
    const roles = states.map((m) => claimRoles(text, m, fs, ir));
    if (
      roles.some((list) =>
        list.some((r) => r.role !== "contact" || !r.state),
      ) ||
      states.some((m, i) => !roles[i].every((r) => r.state === (m[1] ?? m[2])))
    )
      out.push(
        finding("contact-caption-contradicts-native-role", ts[0], {
          text,
          functions: fs.map((f) => f.id),
          nativeRoles: roles,
        }),
      );
  }
  return { findings: out, eligible };
}
