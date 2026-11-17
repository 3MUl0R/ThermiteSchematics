import {
  portNavigationPopulation,
  visibleNativePort,
  portId,
} from "./port-navigation-source.mjs";
import { device } from "./tranche4-source.mjs";
import {
  referenceTokens,
  hasReferenceName,
} from "./navigation-reference-ink.mjs";
import { rowZones } from "./m3-zones.mjs";
import { finding, painted } from "./review-geometry.mjs";
function portClauses(part, source, ir) {
  const tag = device(ir, source.deviceUid)?.designation;
  const refs = (part.geometry.tranche4.partRefs ?? []).filter(
    (r) =>
      r.kind === "communication" &&
      r.uid === source.deviceUid &&
      r.part === part.part &&
      r.view === part.view + 1,
  );
  // Native subject names delimit clauses BEFORE pointer matching. A correct
  // device zone in another port's clause cannot discharge this port's need.
  return refs
    .flatMap((r) =>
      r.texts
        .filter(painted)
        .map((t) => t.text)
        .join(" ")
        .split(/;|\n/u)
        .map((text) => ({ ...r, text })),
    )
    .filter((r) => hasReferenceName(r.text, tag + "." + source.portKey));
}
export function portNavigationAudit(packet, geometries, ir, request) {
  const { parts, failures, selected } = portNavigationPopulation(
      packet,
      geometries,
      ir,
      request,
    ),
    findings = [],
    obligations = [];
  for (const part of parts) {
    const uids = new Set([
      ...part.ports.map((p) => p.deviceUid),
      ...(part.geometry.devices ?? []).map((d) => d.deviceUid),
    ]);
    for (const source of selected.filter(
      (p) => p.view === part.view && uids.has(p.deviceUid),
    )) {
      if (visibleNativePort(part, source, ir)) continue;
      for (const target of source.targets.filter((q) => q !== part)) {
        inspectPortTarget(
          part,
          source,
          target,
          ir,
          selected,
          findings,
          failures,
          obligations,
        );
      }
    }
  }
  return { findings, failures, obligations, eligible: obligations.length };
}

function inspectPortTarget(
  part,
  source,
  target,
  ir,
  selected,
  findings,
  failures,
  obligations,
) {
  const ink = visibleNativePort(target, source, ir),
    zones = rowZones(target.geometry, ink.bbox),
    clauses = portClauses(part, source, ir);
  const expected = {
    sheet: part.sheet,
    view: part.view,
    sourcePart: part.part,
    deviceUid: source.deviceUid,
    portKey: source.portKey,
    targetPart: target.part,
    targetSheet: target.sheet,
    allowedZones: zones,
  };
  obligations.push(expected);
  const correct = clauses.filter((c) =>
    correctPortClause(c, part, source, target, selected, ir, zones),
  );
  if (!zones.length)
    failures.push({
      ...finding("port-navigation-target-zone-unavailable", ink, expected),
      sheet: part.sheet,
    });
  else if (correct.length !== 1)
    findings.push({
      ...finding("omitted-port-reference-missing-or-wrong", clauses[0], {
        ...expected,
        matches: correct.length,
        printed: clauses.map((c) => c.text),
      }),
      sheet: part.sheet,
    });
}

function correctPortClause(c, part, source, target, selected, ir, zones) {
  const tokens = referenceTokens(c.text),
    named = selected.filter(
      (p) =>
        p.view === part.view &&
        hasReferenceName(
          c.text,
          device(ir, p.deviceUid)?.designation + "." + p.portKey,
        ),
    );
  const valid = (token) =>
    source.targets.some(
      (q) =>
        token.part === q.part &&
        token.sheet === q.sheet &&
        rowZones(q.geometry, visibleNativePort(q, source, ir).bbox).includes(
          token.zone,
        ),
    );
  return (
    named.length > 0 &&
    named.every((p) => portId(p) === portId(source)) &&
    tokens.filter(
      (t) =>
        t.part === target.part &&
        t.sheet === target.sheet &&
        zones.includes(t.zone),
    ).length === 1 &&
    tokens.every(valid)
  );
}
