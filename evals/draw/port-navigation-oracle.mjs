import {
  portNavigationPopulation,
  visibleNativePort,
} from "./port-navigation-source.mjs";
import { device } from "./tranche4-source.mjs";
import { referenceTokens } from "./navigation-reference-ink.mjs";
import { namedPortSubjects } from "./port-reference-ink.mjs";
import { rowZones } from "./m3-zones.mjs";
import { finding, painted } from "./review-geometry.mjs";
function portClauses(part, source, ir, selected) {
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
        .flatMap((t) => t.text.split(/;|\n/u))
        .map((text) => ({ ...r, text })),
    )
    .filter((r) =>
      namedPortSubjects(r.text, selected, ir, part.view).includes(source),
    );
}
function checkBodyAndPortLineSeparation(part, ir, selected, findings) {
  const refs = (part.geometry.tranche4?.partRefs ?? []).filter(
    (r) =>
      r.kind === "communication" &&
      r.part === part.part &&
      r.view === part.view + 1,
  );
  for (const r of refs) {
    const paintedRuns = (r.texts ?? []).filter(painted);
    const bodyRuns = paintedRuns.filter(
      (t) =>
        /(?:->|→)/u.test(t.text) &&
        namedPortSubjects(t.text, selected, ir, part.view).length === 0,
    );
    const portRuns = paintedRuns.filter(
      (t) => namedPortSubjects(t.text, selected, ir, part.view).length > 0,
    );
    for (const body of bodyRuns) {
      const bodyY = body.anchor?.y ?? body.bbox?.y;
      if (!Number.isFinite(bodyY)) continue;
      const sameLine = portRuns.find((p) => {
        const portY = p.anchor?.y ?? p.bbox?.y;
        return Number.isFinite(portY) && Math.abs(portY - bodyY) < 1.0;
      });
      if (sameLine)
        findings.push({
          ...finding("port-navigation-same-line-as-body-pointer", sameLine, {
            deviceUid: r.uid,
            bodyText: body.text,
            portText: sameLine.text,
            deltaYMm: Math.abs((sameLine.anchor?.y ?? sameLine.bbox.y) - bodyY),
          }),
          sheet: part.sheet,
        });
    }
  }
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
    checkBodyAndPortLineSeparation(part, ir, selected, findings);
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
    clauses = portClauses(part, source, ir, selected);
  const expected = {
    sheet: part.sheet,
    view: part.view,
    sourcePart: part.part,
    deviceUid: source.deviceUid,
    designation: device(ir, source.deviceUid)?.designation,
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
    named = namedPortSubjects(c.text, selected, ir, part.view);
  const valid = (token) =>
    named.every((p) =>
      p.targets.some(
        (q) =>
          (token.part === undefined || token.part === q.part) &&
          token.sheet === q.sheet &&
          rowZones(q.geometry, visibleNativePort(q, p, ir).bbox).includes(
            token.zone,
          ),
      ),
    );
  return (
    named.length > 0 &&
    named.includes(source) &&
    named.every((p) => p.deviceUid === source.deviceUid) &&
    tokens.filter(
      (t) =>
        (t.part === undefined || t.part === target.part) &&
        t.sheet === target.sheet &&
        zones.includes(t.zone),
    ).length === 1 &&
    tokens.every(valid)
  );
}
