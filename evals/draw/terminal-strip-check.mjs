// Attributes locate ink. Native IR defines obligations; measured shapes discharge them.
const close = (a, b, t = 0.3) => Math.abs(a - b) <= t;
const pointAt = (p, b) =>
  p &&
  p.x >= b.x - 0.3 &&
  p.x <= b.x + b.w + 0.3 &&
  p.y >= b.y - 0.3 &&
  p.y <= b.y + b.h + 0.3;
const compact = (s) => String(s ?? "").replace(/\s+/gu, "");
function terminalCoverage(native, ink, findings) {
  for (const t of native.terminals) {
    const shapes = ink.terminals.filter((x) => x.key === t.key);
    if (
      shapes.length !== 1 ||
      !shapes[0].rect ||
      shapes[0].rect.w < 4 ||
      shapes[0].rect.h < 4 ||
      !shapes[0].texts.some(
        (x) => x.text === t.label && pointAt(x.center, shapes[0].rect),
      )
    )
      findings.push({
        kind: "strip-terminal-coverage",
        terminal: t.key,
        count: shapes.length,
      });
    const row = ink.rows.filter((r) => r.key === t.key);
    if (
      row.length !== 1 ||
      row[0].ref !== t.ref ||
      shapes[0]?.inventory !== t.key ||
      shapes[0]?.ref !== t.ref ||
      !shapes[0]?.texts.some((x) => x.text === t.ref) ||
      !ink.references.some((r) => r.key === t.key && r.text === t.ref)
    )
      findings.push({ kind: "strip-row-reference", terminal: t.key });
  }
  for (const t of ink.terminals)
    if (!native.terminals.some((n) => n.key === t.key))
      findings.push({ kind: "strip-extra-terminal", terminal: t.key });
  for (const group of native.groups) {
    const drawn = group.terminals.map((t) =>
      ink.terminals.find((x) => x.key === t.key),
    );
    if (drawn.some((t) => !t?.rect)) continue;
    if (
      drawn.some(
        (t, i) =>
          i > 0 &&
          (!close(t.rect.x, drawn[i - 1].rect.x) ||
            t.rect.y <= drawn[i - 1].rect.y),
      )
    )
      findings.push({ kind: "strip-wrong-order", device: group.uid });
    const heading = ink.headings
      .filter((h) => h.uid === group.uid)
      .map((h) => h.text)
      .join(" ");
    if (!group.ordered && !heading.includes("order unspecified"))
      findings.push({
        kind: "strip-unspecified-order-hidden",
        device: group.uid,
      });
  }
}
function bridgeCoverage(native, ink, findings) {
  for (const j of native.bridges) {
    const paths = ink.bridges.filter((b) => b.uid === j.uid);
    const ends = j.ends.map(
      (k) => ink.terminals.find((t) => t.key === k)?.rect,
    );
    if (
      paths.length !== 1 ||
      ends.some((e) => !e) ||
      paths[0].points.length < 3 ||
      !pointAt(paths[0].points[0], ends[0]) ||
      !pointAt(paths[0].points.at(-1), ends[1]) ||
      !paths[0].painted ||
      paths[0].length < 3
    )
      findings.push({ kind: "strip-bridge-geometry", uid: j.uid });
  }
  for (const b of ink.bridges)
    if (!native.bridges.some((j) => j.uid === b.uid))
      findings.push({ kind: "strip-extra-bridge", uid: b.uid });
}
function incidenceCoverage(native, ink, findings) {
  const expected = new Map();
  for (const i of native.incidences) {
    const key = JSON.stringify([i.id, i.at]);
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  for (const i of native.incidences) {
    const key = JSON.stringify([i.id, i.at]);
    const rows = ink.incidences.filter((x) => x.id === i.id && x.at === i.at);
    const terminal = ink.terminals.find((t) => t.key === i.at)?.rect;
    if (
      rows.length !== expected.get(key) ||
      !terminal ||
      rows.some(
        (r) =>
          !r.painted ||
          r.length < 3 ||
          !pointAt(r.points[0], terminal) ||
          !compact(r.text).includes(compact(i.label)) ||
          !compact(r.text).includes(compact(i.peer)),
      )
    )
      findings.push({
        kind: "strip-conductor-incidence",
        id: i.id,
        terminal: i.at,
      });
  }
  for (const i of ink.incidences)
    if (!expected.has(JSON.stringify([i.id, i.at])))
      findings.push({
        kind: "strip-extra-conductor",
        id: i.id,
        terminal: i.at,
      });
}
export function checkTerminalStrip(native, ink) {
  const findings = [];
  terminalCoverage(native, ink, findings);
  bridgeCoverage(native, ink, findings);
  incidenceCoverage(native, ink, findings);
  for (const s of ink.unclaimed)
    findings.push({ kind: "strip-invented-hardware-or-bridge", shape: s });
  if (!ink.notes.some((t) => t.includes("hardware unspecified")))
    findings.push({ kind: "strip-hardware-facts-unqualified" });
  for (const t of ink.texts)
    if (t.size < 2.499 || !t.painted)
      findings.push({ kind: "strip-unprintable-text", text: t.text });
  return {
    dq: "DQ-23",
    owner: "#336",
    strict: false,
    repinNow: false,
    assessment: findings.length ? "fail" : "pass",
    findings,
    obligations: {
      terminals: native.terminals.length,
      bridges: native.bridges.length,
      incidences: native.incidences.length,
    },
  };
}
