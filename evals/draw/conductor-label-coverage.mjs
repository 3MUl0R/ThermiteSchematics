import {
  wirePlacement,
  wirePlacementCoverage,
  routePoints,
} from "./checks.mjs";
import {
  connectorRows,
  printedConductor,
  identityMatches,
} from "./continuation-labels.mjs";
import {
  finding,
  painted,
  pointDistance,
  segmentPointDistance,
} from "./review-geometry.mjs";
import { conductorIdentity } from "./tranche3-identities.mjs";
import { nativeLabelIdentity } from "./wire-label-source.mjs";
import {
  conductorCaptionBlockKey,
  isNetLabelText,
} from "./wire-plate-leader.mjs";

const viewKey = (s) => JSON.stringify(s.view);
const nativeKey = (native) =>
  native
    ? (native.uid ??
      (native.cableUid !== undefined
        ? JSON.stringify([native.cableUid, native.conductorId])
        : native.text))
    : undefined;

function wireSource(wire, ir) {
  const id = conductorIdentity(wire);
  if (!id) return null;
  try {
    const parsed = JSON.parse(id);
    if (Array.isArray(parsed) && parsed.length === 2)
      return printedConductor(
        {
          sourceElement: {
            kind: "core",
            cableUid: parsed[0],
            conductorId: parsed[1],
          },
        },
        ir,
      );
  } catch {}
  return printedConductor({ conductor: id }, ir);
}

function routeIdentity(s, ir) {
  const wire = conductorIdentity(s.wire);
  const k = s.edgeOwnerKey;
  if (k?.[0] === "wire" || k?.[0] === "jumper") {
    const id = conductorIdentity(k[1]);
    if (id?.startsWith("[")) return wireSource(id, ir);
    return (
      printedConductor(
        { conductor: wire, sourceElement: { kind: k[0], uid: id } },
        ir,
      ) ?? (id ? wireSource(id, ir) : null)
    );
  }
  if (k?.[0] === "cable-conductor")
    return printedConductor(
      {
        conductor: wire,
        sourceElement: { kind: "core", cableUid: k[1], conductorId: k[2] },
      },
      ir,
    );
  return wire ? wireSource(wire, ir) : null;
}

function collectNamedFromLabels(q, ir, strictPlacement, named) {
  const blocks = new Map();
  for (const t of q.texts.filter(
    (t) => t.wire && !isNetLabelText(t) && painted(t),
  )) {
    const wire = conductorIdentity(t.wire);
    if (!wire) continue;
    const key = JSON.stringify([
      t.appearanceScope ?? null,
      wire,
      conductorCaptionBlockKey(t),
    ]);
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push({ ...t, wire });
  }
  for (const ts of blocks.values()) {
    if (ts.some((t) => t.conductorIdentityConflict)) continue;
    const wire = ts[0].wire;
    const r = q.shapes.filter(
      (s) => s.conductor && conductorIdentity(s.wire) === wire,
    );
    if (!r.length) continue;
    if (strictPlacement && wirePlacement({ ...q, texts: ts }).length) continue;
    const source = wireSource(wire, ir);
    if (!source) continue;
    const matchesText =
      nativeLabelIdentity(ts, ir) ||
      ts.some((t) => t.text === source.text || t.text === source.uid);
    if (matchesText) named.add(nativeKey(source));
  }
}

function anchorTouchesRouteEnd(anchor, points, viewport) {
  if (!anchor || !points?.length) return false;
  if ([points[0], points.at(-1)].some((p) => pointDistance(p, anchor) <= 0.01))
    return true;
  if (!viewport) return false;
  const onClipEdge =
    anchor.x >= viewport.x - 0.05 &&
    anchor.x <= viewport.x + viewport.w + 0.05 &&
    anchor.y >= viewport.y - 0.05 &&
    anchor.y <= viewport.y + viewport.h + 0.05 &&
    (Math.abs(anchor.x - viewport.x) <= 0.05 ||
      Math.abs(anchor.x - (viewport.x + viewport.w)) <= 0.05 ||
      Math.abs(anchor.y - viewport.y) <= 0.05 ||
      Math.abs(anchor.y - (viewport.y + viewport.h)) <= 0.05);
  return (
    onClipEdge &&
    points
      .slice(1)
      .some((b, i) => segmentPointDistance(anchor, points[i], b) <= 0.01)
  );
}

function collectNamedFromContinuations(s, q, packet, ir, named) {
  const occurrences = new Map();
  for (const c of s.continuations ?? []) {
    const key = JSON.stringify([c.id, c.toSheet]),
      occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const { source, rows } = connectorRows(
        { ...q, texts: q.texts.filter(painted) },
        c,
        occurrence,
      ),
      native = printedConductor(c, ir);
    const peer = packet.sheets.find((p) => p.number === c.toSheet);
    if (
      source &&
      identityMatches(rows, c, native) &&
      q.shapes.some((r) => {
        const identity = routeIdentity(r, ir),
          points = routePoints(r);
        return (
          r.conductor &&
          identity &&
          nativeKey(identity) === nativeKey(native) &&
          anchorTouchesRouteEnd(source.anchor, points, r.viewport)
        );
      }) &&
      peer?.continuations?.some((p) => {
        if (
          p === c ||
          p.id !== c.id ||
          p.toSheet !== s.number ||
          p.conductor !== c.conductor
        )
          return false;
        if (!(p.provenance ?? p.sourceElement)) return true;
        const peerNative = printedConductor(p, ir);
        return Boolean(
          peerNative && nativeKey(peerNative) === nativeKey(native),
        );
      })
    )
      named.add(nativeKey(native));
  }
}

export function conductorLabelCoverage(sheet, packet, g, geometries, ir) {
  const previous = wirePlacementCoverage(g);
  if (previous.reasonCode === "label-identity-unavailable")
    return { findings: [], extra: previous };
  const routes = g.shapes.filter((s) => s.conductor);
  if (!routes.length) return { findings: [], extra: {} };
  const hasIrConductors = Boolean(
    ir?.wires?.length || ir?.jumpers?.length || ir?.cableConductors?.length,
  );
  if (!hasIrConductors && !previous.status) return { findings: [], extra: {} };
  const findings = [],
    measurements = [];
  const peers = packet.sheets.flatMap((s, i) =>
    viewKey(s) === viewKey(sheet)
      ? [
          {
            sheet: s,
            g: (s.number === sheet.number ? g : geometries[i]) ?? {
              texts: [],
              shapes: [],
            },
          },
        ]
      : [],
  );
  const named = new Set();
  const strictPlacement = Boolean(previous.status);
  for (const { sheet: s, g: q } of peers) {
    collectNamedFromLabels(q, ir, strictPlacement, named);
    collectNamedFromContinuations(s, q, packet, ir, named);
  }
  for (const route of routes) {
    const native = routeIdentity(route, ir);
    if (!native) {
      findings.push(
        finding("conductor-label-source-unresolved", route, {
          wire: route.wire,
          edgeOwnerKey: route.edgeOwnerKey,
        }),
      );
      continue;
    }
    const isNamed = named.has(nativeKey(native));
    if (!isNamed)
      findings.push(
        finding("conductor-fragment-without-visible-identity", route, {
          conductor: native.text,
          reason: "no-owned-visible-label-in-logical-view",
        }),
      );
    measurements.push({
      element: route.element,
      conductor: native.text,
      visibleIdentityInView: isNamed,
    });
  }
  const extra = previous.status
    ? {
        scope:
          "Label-free fragments: native conductor identity must be visibly and verifiably labelled on a continuation or another fragment of this same logical view.",
        evidence: { findingCount: findings.length, findings, measurements },
      }
    : findings.length
      ? { evidence: { findingCount: findings.length, findings, measurements } }
      : {};
  return { findings, extra };
}
