import { distance } from "./checks.mjs";
import {
  circuitMark,
  circuitMarkName,
} from "../../packages/render/dist/symbols/circuit.js";
import { usesCircuitInterface } from "../../packages/render/dist/symbols/circuit-interface.js";
import { PRINTABLE_SYMBOL_POLICY } from "../../packages/render/dist/symbols/printable-policy.js";

export const TOUCH_EPSILON_MM = 0.03;
export const terminalKey = (uid, key) => JSON.stringify([uid, key]);

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/iu.exec(String(hex ?? "").trim());
  if (!m) throw new Error(`Invalid hex colour constant: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const ENCLOSURE_GREY_RGB = Object.freeze(
  hexToRgb(PRINTABLE_SYMBOL_POLICY.deviceOutlineColor),
);

export function isDashedStroke(dash) {
  const raw = String(dash ?? "")
    .trim()
    .toLowerCase();
  if (!raw || raw === "none") return false;
  const nums = raw.split(/[\s,]+/u).map(parseFloat);
  if (!nums.length || nums.some((v) => !Number.isFinite(v) || v < 0))
    return false;
  const pattern = nums.length % 2 === 1 ? [...nums, ...nums] : nums;
  return (
    pattern.some((v, i) => i % 2 === 0 && v > 0) &&
    pattern.some((v, i) => i % 2 === 1 && v > 0)
  );
}

export function isEnclosureGrey(p) {
  const c = p.strokeColor;
  if (!Array.isArray(c) || c.length < 3) return false;
  return (
    Math.abs(c[0] - ENCLOSURE_GREY_RGB[0]) <= 1 &&
    Math.abs(c[1] - ENCLOSURE_GREY_RGB[1]) <= 1 &&
    Math.abs(c[2] - ENCLOSURE_GREY_RGB[2]) <= 1
  );
}

export function isNonElectricalEnclosure(p) {
  if (p.filled) return false;
  const isEnclosure =
    Boolean(p.deviceFrame || p.sourceEnclosure) ||
    (p.electricalRole === "functional-boundary" &&
      p.shapeTag === "rect" &&
      !p.mark &&
      !p.functionInterface);
  if (!isEnclosure) return false;
  return isDashedStroke(p.dash) || isEnclosureGrey(p);
}

export const CONTACT_BLADE_MARKS = new Set([
  "disconnector",
  "breaker",
  "contact-no",
  "contact-nc",
  "pushbutton-no",
  "pushbutton-nc",
  "switch-no",
  "switch-nc",
  "estop-no",
  "estop-nc",
  "selector-no",
  "selector-nc",
  "pressure-no",
  "pressure-nc",
  "level-no",
  "level-nc",
]);

export function normalizeIrForMarkSelection(ir) {
  return {
    ...ir,
    potentials: ir.potentials ?? [],
    terminals: ir.terminals ?? [],
    deviceTypes: ir.deviceTypes ?? [],
  };
}

export function computeExpectedMark(fn, ctx) {
  if (!fn) return null;
  const device = ctx.deviceByUid.get(fn.id.deviceUid);
  if (!device) return null;
  const type = ctx.typeById.get(device.typeId);
  if (!type) return null;
  try {
    const raw = circuitMark(type, fn, { ir: ctx.normalizedIr });
    return { raw, name: circuitMarkName(raw) };
  } catch {
    return null;
  }
}

export function expectedInterfaceValid(fn, expected) {
  return Boolean(fn && expected && usesCircuitInterface(fn.kind, expected.raw));
}

export function parseAttachmentKey(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    )
      return terminalKey(parsed[0], parsed[1]);
  } catch {}
  return null;
}

function bboxCenter(b) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function nearestTerminal(p, terminals, key) {
  const c = bboxCenter(p.bbox);
  let best = null,
    bestDist = Infinity;
  for (const t of terminals) {
    if (t.appearanceScope !== p.appearanceScope || t.terminalKey !== key)
      continue;
    const d = Math.hypot(t.point.x - c.x, t.point.y - c.y);
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

export function functionPortContext(p, fn, ctx) {
  if (!fn || fn.terminals.length !== 2) return null;
  const k0 = terminalKey(
    fn.terminals[0].deviceUid,
    fn.terminals[0].terminalKey,
  );
  const k1 = terminalKey(
    fn.terminals[1].deviceUid,
    fn.terminals[1].terminalKey,
  );
  const t0 = nearestTerminal(p, ctx.terminals, k0);
  const t1 = nearestTerminal(p, ctx.terminals, k1);
  if (!t0 || !t1) return null;
  const fnKey = terminalKey(fn.id.deviceUid, fn.id.functionKey);
  const attachments = ctx.primitives.filter(
    (q) =>
      q.appearanceScope === p.appearanceScope &&
      q.attachment &&
      ((Array.isArray(q.functionId) &&
        terminalKey(q.functionId[0], q.functionId[1]) === fnKey) ||
        [k0, k1].includes(parseAttachmentKey(q.attachment))),
  );
  const leads = ctx.primitives.filter(
    (q) =>
      q !== p &&
      q.markScope &&
      q.markScope === p.markScope &&
      q.electricalRole === "terminal-lead",
  );
  return { t0, t1, attachments, leads };
}

function segmentLiesOnPrimitive(seg, other, reach) {
  const [a, b] = seg;
  const near = (pt) =>
    other.segments.some(([r, s]) => distance(pt, r, s) <= reach);
  return near(a) && near(b);
}

function bladeBetweenPorts(p, t0, t1) {
  const dx = t1.point.x - t0.point.x;
  const dy = t1.point.y - t0.point.y;
  const span = Math.hypot(dx, dy);
  if (!(span > 1)) return false;
  const ux = dx / span,
    uy = dy / span;
  const margin = Math.min(0.5, span * 0.05);
  const pts = p.segments.flatMap(([a, b]) => [a, b]);
  if (!pts.length) return false;
  return pts.every((q) => {
    const proj = (q.x - t0.point.x) * ux + (q.y - t0.point.y) * uy;
    return proj >= margin && proj <= span - margin;
  });
}

export function contactRolePortConflict(
  p,
  fn,
  expectedMark,
  ctx,
  touchesPrim,
  touchesTerm,
) {
  if (!CONTACT_BLADE_MARKS.has(expectedMark)) return null;
  const role = p.electricalRole;
  if (role !== "contact-blade" && role !== "terminal-lead") return null;
  if (!fn || fn.kind !== "contact" || fn.terminals.length !== 2)
    return {
      kind: "forged",
      reason: `Role "${role}" requires a 2-terminal native contact function`,
    };
  const ports = functionPortContext(p, fn, ctx);
  if (!ports)
    return { kind: "not-measured", reason: "native-ports-unavailable" };
  const { t0, t1, attachments, leads } = ports;
  const hitsPort =
    touchesTerm(p, t0) ||
    touchesTerm(p, t1) ||
    attachments.some((att) => touchesPrim(p, att));
  if (role === "contact-blade") {
    if (hitsPort)
      return {
        kind: "forged",
        reason: `contact-blade coincides with a declared terminal port or attachment on ${fn.id.functionKey}`,
      };
    if (!bladeBetweenPorts(p, t0, t1))
      return {
        kind: "forged",
        reason: `contact-blade does not lie between declared terminal ports of ${fn.id.functionKey}`,
      };
    const coincidesWithLead = leads.some((lead) => {
      const reach = (p.stroke + lead.stroke) / 2 + TOUCH_EPSILON_MM;
      return (
        p.segments.length > 0 &&
        p.segments.every((seg) => segmentLiesOnPrimitive(seg, lead, reach))
      );
    });
    if (coincidesWithLead)
      return {
        kind: "forged",
        reason: `contact-blade coincides with a terminal-lead on ${fn.id.functionKey}`,
      };
    return null;
  }
  if (!hitsPort)
    return {
      kind: "forged",
      reason: `terminal-lead inside contact mark ${expectedMark} does not reach a declared terminal port or attachment`,
    };
  return null;
}
