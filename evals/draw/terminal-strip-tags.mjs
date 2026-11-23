import { INK_ACCURACY_MM, distance, inside } from "./checks.mjs";

// Numerical/serialization epsilon only (<= 0.01 mm; stroke ink extent is measured directly).
export const STRIP_FRAME_EPSILON_MM = 0.01;

function pointGapToBox(p, box) {
  return Math.hypot(
    Math.max(box.x - p.x, 0, p.x - box.x - box.w),
    Math.max(box.y - p.y, 0, p.y - box.y - box.h),
  );
}

function segmentGapToBox(a, b, box) {
  const gA = pointGapToBox(a, box),
    gB = pointGapToBox(b, box);
  if (gA === 0 || gB === 0) return 0;
  const minX = Math.min(a.x, b.x),
    maxX = Math.max(a.x, b.x),
    minY = Math.min(a.y, b.y),
    maxY = Math.max(a.y, b.y);
  if (
    (a.x === b.x &&
      a.x >= box.x &&
      a.x <= box.x + box.w &&
      maxY >= box.y &&
      minY <= box.y + box.h) ||
    (a.y === b.y &&
      a.y >= box.y &&
      a.y <= box.y + box.h &&
      maxX >= box.x &&
      minX <= box.x + box.w)
  )
    return 0;
  return Math.min(
    gA,
    gB,
    distance({ x: box.x, y: box.y }, a, b),
    distance({ x: box.x + box.w, y: box.y }, a, b),
    distance({ x: box.x, y: box.y + box.h }, a, b),
    distance({ x: box.x + box.w, y: box.y + box.h }, a, b),
  );
}

function boxToPolylineDistance(box, points) {
  if (!box || !points?.length) return Infinity;
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    best = Math.min(best, segmentGapToBox(points[i - 1], points[i], box));
    if (best === 0) return 0;
  }
  return best;
}

function expectedBridgeKeys(native) {
  const keys = new Map();
  const counts = new Map();
  for (const j of native?.bridges ?? []) {
    let deviceUid = "";
    try {
      deviceUid = JSON.parse(j.ends[0])[0] ?? "";
    } catch {
      deviceUid = "";
    }
    const number = (counts.get(deviceUid) ?? 0) + 1;
    counts.set(deviceUid, number);
    keys.set(j.uid, `B${number}`);
  }
  return keys;
}

function resolveBridgeTag(b, expectedKey, ink, findings) {
  const tags = ink.bridgeTags.filter(
    (t) =>
      t.uid === b.uid &&
      t.sheet === b.sheet &&
      t.painted &&
      t.inkVisible !== false,
  );
  if (
    tags.length !== 1 ||
    (expectedKey
      ? tags[0].text.trim() !== expectedKey
      : !/^B\d+$/u.test(tags[0].text.trim()))
  ) {
    findings.push({
      kind: "strip-bridge-tag-missing",
      uid: b.uid,
      sourceSheet: b.sheet,
      ...(expectedKey ? { expected: expectedKey } : {}),
      ...(tags[0] ? { printed: tags[0].text.trim() } : {}),
    });
    return null;
  }
  return tags[0];
}

function inspectBridgeTag(b, expectedKey, localBridges, ink, findings) {
  const tag = resolveBridgeTag(b, expectedKey, ink, findings);
  if (!tag) return;
  const ownDist = Math.max(0, boxToPolylineDistance(tag.bbox, b.points) - 0.25);
  const stubs = ink.incidences.filter(
    (s) => s.sheet === b.sheet && s.painted && s.points?.length > 1,
  );
  const stubDist = stubs.length
    ? Math.max(
        0,
        Math.min(
          ...stubs.map((s) => boxToPolylineDistance(tag.bbox, s.points)),
        ) - 0.2,
      )
    : Infinity;
  const others = localBridges.filter(
    (o) => o.sheet === b.sheet && o.uid !== b.uid && o.points?.length > 1,
  );
  const foreignDist = others.length
    ? Math.max(
        0,
        Math.min(
          ...others.map((o) => boxToPolylineDistance(tag.bbox, o.points)),
        ) - 0.25,
      )
    : Infinity;
  if (stubDist < 0.5 - INK_ACCURACY_MM)
    findings.push({
      kind: "strip-bridge-tag-stub-overlap",
      uid: b.uid,
      text: tag.text,
      sourceSheet: b.sheet,
      stubDistMm: stubDist,
      bbox: tag.bbox,
    });
  else if (
    ownDist > 2.0 + INK_ACCURACY_MM ||
    stubDist + INK_ACCURACY_MM <= ownDist ||
    foreignDist + INK_ACCURACY_MM <= ownDist
  )
    findings.push({
      kind: "strip-bridge-tag-ownership",
      uid: b.uid,
      text: tag.text,
      sourceSheet: b.sheet,
      ownDistMm: ownDist,
      stubDistMm: Number.isFinite(stubDist) ? stubDist : null,
      foreignBridgeDistMm: Number.isFinite(foreignDist) ? foreignDist : null,
      bbox: tag.bbox,
    });
}

export function bridgeTagCheck(native, ink, findings) {
  const localBridges = ink.bridges.filter((b) => !b.end && b.painted);
  if (!localBridges.length) return;
  if (
    !ink.notes.some(
      (t) => /\bBn\b/u.test(t) && /\b(?:bridge|jumper)\b/iu.test(t),
    )
  )
    findings.push({ kind: "strip-bridge-note-missing" });
  if (!Array.isArray(ink.bridgeTags)) return;
  const keys = expectedBridgeKeys(native);
  for (const b of localBridges)
    inspectBridgeTag(b, keys.get(b.uid), localBridges, ink, findings);
}

function expandStroke(box, strokeWidth) {
  if (!box) return null;
  const half = (strokeWidth ?? 0) / 2;
  if (!(half > 0)) return box;
  return {
    x: box.x - half,
    y: box.y - half,
    w: box.w + 2 * half,
    h: box.h + 2 * half,
  };
}

function pointsBox(points, strokeWidth = 0) {
  if (!points?.length) return null;
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return expandStroke(
    { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y },
    strokeWidth,
  );
}

export function stripFrameCheck(ink, findings) {
  const frames = new Map((ink.frames ?? []).map((f) => [f.sheet, f.bbox]));
  const checkBox = (sheet, box, detail) => {
    if (sheet === undefined || !box) return;
    const frame = frames.get(sheet);
    if (!frame) return;
    if (!inside(box, frame, STRIP_FRAME_EPSILON_MM))
      findings.push({
        kind: "strip-ink-outside-frame",
        sourceSheet: sheet,
        bbox: box,
        frame,
        ...detail,
      });
  };
  for (const t of ink.terminals)
    checkBox(t.sheet, expandStroke(t.rect, t.strokeWidth), { terminal: t.key });
  for (const b of ink.bridges)
    if (b.painted)
      checkBox(b.sheet, pointsBox(b.points, b.strokeWidth), { uid: b.uid });
  for (const i of ink.incidences)
    if (i.painted)
      checkBox(i.sheet, pointsBox(i.points, i.strokeWidth), {
        id: i.id,
        terminal: i.at,
      });
  for (const c of ink.continuations)
    if (c.painted) checkBox(c.sheet, c.bbox, { terminal: c.at });
  for (const t of ink.bridgeTags ?? [])
    if (t.painted) checkBox(t.sheet, t.bbox, { uid: t.uid, text: t.text });
  for (const t of ink.texts)
    if (t.painted && t.sheet !== undefined)
      checkBox(t.sheet, t.bbox, { text: t.text });
}
