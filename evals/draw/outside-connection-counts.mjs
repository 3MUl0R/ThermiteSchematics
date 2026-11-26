import {
  attachmentLeadEnds,
  boxGap,
  conductorInk,
  paintedToBothEnds,
} from "./peer-owner-ink.mjs";
import { conductorIdentity } from "./tranche3-identities.mjs";
import { elementKey, routeKey } from "./tranche4-source.mjs";

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

function sameEndpointPair(declared, nativeEnds) {
  if (!Array.isArray(declared) || declared.length !== 2) return false;
  const norm = (ends) =>
    ends
      .map((e) =>
        Array.isArray(e)
          ? terminalPairKey(e[0], e[1])
          : terminalPairKey(e?.deviceUid, e?.terminalKey),
      )
      .sort();
  return JSON.stringify(norm(declared)) === JSON.stringify(norm(nativeEnds));
}

function validatedCollapsedAssemblies(g, native) {
  const byBodyTerminal = new Map();
  const add = (bodyScope, deviceUid, terminalKey, cid) => {
    const k = JSON.stringify([bodyScope, deviceUid, terminalKey]);
    let set = byBodyTerminal.get(k);
    if (!set) {
      set = new Set();
      byBodyTerminal.set(k, set);
    }
    set.add(cid);
  };
  for (const asm of g.collapsedCableAssemblies ?? []) {
    if (!asm?.cableUid || asm.ends?.length !== 2) continue;
    const [endA, endB] = asm.ends;
    if (
      !endA?.bodyScope ||
      !endB?.bodyScope ||
      endA.bodyScope === endB.bodyScope ||
      endA.deviceUid === endB.deviceUid
    )
      continue;
    if (
      !paintedToBothEnds(
        { runs: asm.runs ?? [], tips: asm.tips ?? [] },
        [endA.portBox],
        [endB.portBox],
      )
    )
      continue;
    const nativeCores = native.byCable.get(asm.cableUid);
    if (!nativeCores?.size) continue;
    for (const member of asm.members ?? []) {
      const cid = conductorIdentity(member?.id);
      if (!cid || !nativeCores.has(cid)) continue;
      const cond = native.conductors.get(cid);
      if (!cond || cond.ends.length !== 2) continue;
      const onA = cond.ends.find(([u]) => u === endA.deviceUid);
      const onB = cond.ends.find(([u]) => u === endB.deviceUid);
      if (!onA || !onB) continue;
      if (member.ends && !sameEndpointPair(member.ends, cond.ends)) continue;
      add(endA.bodyScope, onA[0], onA[1], cid);
      add(endB.bodyScope, onB[0], onB[1], cid);
    }
  }
  return byBodyTerminal;
}

const DASH_NUM_RE = /^[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?(?:px)?$/i;
const DASH_POS_RE = /^(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?(?:px)?$/i;

function parseDashPattern(dashRaw, offsetRaw) {
  const raw = typeof dashRaw === "string" ? dashRaw.trim().toLowerCase() : "";
  if (!raw || raw === "none") return null;
  const tokens = raw.split(/[\s,]+/u).filter(Boolean);
  if (!tokens.length || tokens.some((t) => !DASH_POS_RE.test(t))) return null;
  const parts = tokens.map((t) => Number.parseFloat(t));
  if (parts.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const total = parts.reduce((sum, v) => sum + v, 0);
  if (!(total > 0)) return null;
  const seq = parts.length % 2 === 1 ? [...parts, ...parts] : parts;
  if (!seq.some((v, i) => i % 2 === 1 && v > 0)) return null;
  let offset = 0;
  if (typeof offsetRaw === "number") {
    if (!Number.isFinite(offsetRaw)) return null;
    offset = offsetRaw;
  } else if (typeof offsetRaw === "string" && offsetRaw.trim()) {
    const trimmed = offsetRaw.trim();
    if (!DASH_NUM_RE.test(trimmed)) return null;
    offset = Number.parseFloat(trimmed);
    if (!Number.isFinite(offset)) return null;
  }
  const period = seq.reduce((sum, v) => sum + v, 0);
  return { seq, period, offset };
}

function projectPoint(m, x, y) {
  return m
    ? { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
    : { x, y };
}

function parseLinearPathGeometry(d, m) {
  const tokens =
    d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/gu) ?? [];
  const segs = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let u = 0;
  let totalMm = 0;
  let hasSubpath = false;
  const push = (x0, y0, x1, y1) => {
    const du = Math.hypot(x1 - x0, y1 - y0);
    if (!(du > 1e-9)) return;
    const a = projectPoint(m, x0, y0);
    const b = projectPoint(m, x1, y1);
    const lenMm = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, u0: u, u1: u + du, du, lenMm });
    u += du;
    totalMm += lenMm;
  };
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[a-z]$/iu.test(tokens[i])) cmd = tokens[i++];
    const kind = cmd.toUpperCase();
    const rel = cmd !== kind;
    const ox = x;
    const oy = y;
    if (kind === "Z") {
      push(ox, oy, sx, sy);
      x = sx;
      y = sy;
      cmd = "";
    } else if (kind === "M" || kind === "L") {
      if (i + 1 >= tokens.length) return null;
      x = num() + (rel ? ox : 0);
      y = num() + (rel ? oy : 0);
      if (kind === "M") {
        if (hasSubpath) {
          const prev = projectPoint(m, ox, oy);
          const next = projectPoint(m, x, y);
          if (Math.hypot(next.x - prev.x, next.y - prev.y) > 0.05) return null;
        }
        hasSubpath = true;
        sx = x;
        sy = y;
        cmd = rel ? "l" : "L";
      } else push(ox, oy, x, y);
    } else if (kind === "H" || kind === "V") {
      if (i >= tokens.length) return null;
      if (kind === "H") x = num() + (rel ? ox : 0);
      else y = num() + (rel ? oy : 0);
      push(ox, oy, x, y);
    } else return null;
  }
  return segs.length && u > 0 ? { segs, totalLocal: u, totalMm } : null;
}

function pointsPathGeometry(points, m) {
  const segs = [];
  const det = m ? m[0] * m[3] - m[1] * m[2] : 1;
  const inv = Math.abs(det) > 1e-12 && m;
  let u = 0;
  let totalMm = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenMm = Math.hypot(dx, dy);
    if (!(lenMm > 1e-9)) continue;
    const du = inv
      ? Math.hypot(
          (m[3] * dx - m[2] * dy) / det,
          (-m[1] * dx + m[0] * dy) / det,
        )
      : lenMm;
    segs.push({ a, b, u0: u, u1: u + du, du, lenMm });
    u += du;
    totalMm += lenMm;
  }
  return segs.length && u > 0 ? { segs, totalLocal: u, totalMm } : null;
}

function routeGeometryForShape(s) {
  const parsed =
    typeof s.routePath === "string"
      ? parseLinearPathGeometry(s.routePath, s.routeMatrix)
      : null;
  const geom =
    parsed ??
    (s.points?.length >= 2
      ? pointsPathGeometry(s.points, s.routeMatrix)
      : null);
  if (!geom) return null;
  const m = s.routeMatrix;
  const scale = m
    ? Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]))
    : geom.totalMm / geom.totalLocal;
  return { ...geom, scale: scale > 0 ? scale : 1 };
}

function clipSegmentToRectRange(a, b, rect) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p, q) => {
    if (Math.abs(p) <= 1e-12) return q >= -1e-9;
    const r = q / p;
    if (p < 0) {
      if (r > t1 + 1e-9) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0 - 1e-9) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (
    !clip(-dx, a.x - rect.x) ||
    !clip(dx, rect.x + rect.w - a.x) ||
    !clip(-dy, a.y - rect.y) ||
    !clip(dy, rect.y + rect.h - a.y)
  )
    return null;
  return [Math.max(0, Math.min(1, t0)), Math.max(0, Math.min(1, t1))];
}

function markerExitLocal(geom, mark, fromEnd) {
  let walked = 0;
  let exitDist = 0;
  const list = fromEnd ? [...geom.segs].reverse() : geom.segs;
  for (const seg of list) {
    const a = fromEnd ? seg.b : seg.a;
    const b = fromEnd ? seg.a : seg.b;
    const range = clipSegmentToRectRange(a, b, mark);
    if (!range || range[0] > 1e-6) break;
    exitDist = walked + range[1] * seg.du;
    if (range[1] < 1 - 1e-6) break;
    walked += seg.du;
  }
  const u = fromEnd ? geom.totalLocal - exitDist : exitDist;
  return Math.max(0, Math.min(geom.totalLocal, u));
}

function pointAtLocal(geom, u) {
  if (u <= 0) return geom.segs[0].a;
  if (u >= geom.totalLocal) return geom.segs.at(-1).b;
  for (const seg of geom.segs) {
    if (u <= seg.u1 + 1e-9) {
      const f =
        seg.du > 0 ? Math.max(0, Math.min(1, (u - seg.u0) / seg.du)) : 0;
      return {
        x: seg.a.x + (seg.b.x - seg.a.x) * f,
        y: seg.a.y + (seg.b.y - seg.a.y) * f,
      };
    }
  }
  return geom.segs.at(-1).b;
}

function mergeIntervals(raw) {
  if (!raw.length) return [];
  raw.sort((a, b) => a[0] - b[0]);
  const out = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const last = out.at(-1);
    if (raw[i][0] <= last[1] + 1e-6) last[1] = Math.max(last[1], raw[i][1]);
    else out.push(raw[i]);
  }
  return out;
}

function predictedDashStarts(geom, pattern, capLocal, uExit, fromEnd) {
  const L = geom.totalLocal;
  const { seq, period, offset } = pattern;
  const loBound = fromEnd ? 0 : uExit;
  const hiBound = fromEnd ? uExit : L;
  if (!(hiBound > loBound + 1e-6)) return [];
  const k0 = Math.floor((uExit + offset) / period);
  const kStart = fromEnd ? k0 - 2 : k0 - 1;
  const kEnd = fromEnd ? k0 + 1 : k0 + 2;
  const raw = [];
  for (let k = kStart; k <= kEnd; k++) {
    let pos = k * period - offset;
    for (let i = 0; i < seq.length; i += 2) {
      const d0 = pos;
      const d1 = pos + seq[i];
      pos = d1 + seq[i + 1];
      const c0 = Math.max(0, d0);
      const c1 = Math.min(L, d1);
      if (c1 < c0 || (c1 === c0 && !(capLocal > 0))) continue;
      const e0 = Math.max(loBound, Math.max(0, c0 - capLocal));
      const e1 = Math.min(hiBound, Math.min(L, c1 + capLocal));
      if (e1 > e0 + 1e-6) raw.push([e0, e1]);
    }
  }
  const merged = mergeIntervals(raw);
  if (!merged.length) return [];
  const ordered = fromEnd ? merged.reverse() : merged;
  const first = ordered[0];
  const starts = [fromEnd ? first[1] : first[0]];
  const count = Math.min(20000, Math.max(1, Math.ceil(geom.totalMm / 0.2)));
  const stepMm = geom.totalMm / count;
  const minLocal = (2 * stepMm + 0.02) / geom.scale;
  const touchesExit = fromEnd
    ? Math.abs(first[1] - uExit) <= 1e-6
    : Math.abs(first[0] - uExit) <= 1e-6;
  if (touchesExit && first[1] - first[0] <= minLocal && ordered.length > 1)
    starts.push(fromEnd ? ordered[1][1] : ordered[1][0]);
  return starts;
}

function runGapToPoint(a, b, strokeWidth, pt) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 > 1e-12
      ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2))
      : 0;
  const d = Math.hypot(pt.x - (a.x + dx * t), pt.y - (a.y + dy * t));
  const half = strokeWidth > 0 ? strokeWidth / 2 : 0;
  return len2 > 1e-12 && t > 0 && t < 1 ? Math.max(0, d - half) : d;
}

function endLandsSolid(ink, marks) {
  return Boolean(
    marks?.some(
      (m) =>
        ink.tips.some((p) => boxGap({ ...p, w: 0, h: 0 }, m) <= 0.05) &&
        ink.boxes.some((stroke) => boxGap(stroke, m) <= 0.25),
    ),
  );
}

function endLandsDashed(viewG, element, marks) {
  if (!marks?.length) return false;
  const key = elementKey(element);
  for (const s of viewG.shapes ?? []) {
    const runs = viewG.tranche3?.routeInk?.[s.element];
    if (routeKey(s) !== key || !runs?.length) continue;
    const scope = viewG.outsideRouteScopes?.[s.element];
    const pattern = parseDashPattern(s.dash, scope?.dashOffset ?? s.dashOffset);
    if (!pattern) continue;
    const geom = routeGeometryForShape(s);
    if (!geom) continue;
    const cap = scope?.lineCap ?? s.lineCap;
    const capLocal =
      (cap === "round" || cap === "square") && s.stroke > 0
        ? s.stroke / (2 * geom.scale)
        : 0;
    const ends = [
      { pt: geom.segs[0].a, fromEnd: false },
      { pt: geom.segs.at(-1).b, fromEnd: true },
    ];
    for (const m of marks) {
      for (const { pt, fromEnd } of ends) {
        if (boxGap({ ...pt, w: 0, h: 0 }, m) > 0.05) continue;
        const uExit = markerExitLocal(geom, m, fromEnd);
        const starts = predictedDashStarts(
          geom,
          pattern,
          capLocal,
          uExit,
          fromEnd,
        );
        if (
          starts.some((uPred) => {
            const predPt = pointAtLocal(geom, uPred);
            return runs.some(
              ([a, b]) => runGapToPoint(a, b, s.stroke, predPt) <= 0.25,
            );
          })
        )
          return true;
      }
    }
  }
  return false;
}

function landsAtBothEnds(viewG, element, ink, bodyMarks, mateMarks) {
  if (paintedToBothEnds(ink, bodyMarks, mateMarks)) return true;
  return [bodyMarks, mateMarks].every(
    (marks) =>
      endLandsSolid(ink, marks) || endLandsDashed(viewG, element, marks),
  );
}

function expectedOutsideForBody(body, native, g, index) {
  const tk = terminalPairKey(body.deviceUid, body.terminal);
  const incident = native.byTerminal.get(tk) ?? new Set();
  if (!incident.size) return 0;
  const selected = new Set(
    index.collapsedByBodyTerminal.get(
      JSON.stringify([body.bodyScope, body.deviceUid, body.terminal]),
    ) ?? [],
  );
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
      if (landsAtBothEnds(viewG, cond.element, ink, bodyMarks, mateMarks))
        selected.add(cid);
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
      if (caption.outsideCountPainted === false) {
        out.push(
          issue("missing-outside-connection-count", caption, {
            deviceUid: body.deviceUid,
            text: caption.text,
            terminal: body.terminal,
            expectedOutside: expected,
            printedOutside: 0,
            reason: "unpainted-outside-count-suffix",
          }),
        );
        continue;
      }
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
  const index = {
    ...buildScopeIndex(g),
    collapsedByBodyTerminal: validatedCollapsedAssemblies(g, native),
  };
  const out = [];
  for (const body of g.terminalOutsideBodies) {
    const expected = expectedOutsideForBody(body, native, g, index);
    const captions = (g.texts ?? []).filter(
      (t) =>
        t.painted !== false &&
        t.reviewPainted !== false &&
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
