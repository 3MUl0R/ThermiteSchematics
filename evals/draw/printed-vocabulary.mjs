// Independent visible projection oracle. Never import renderer/query formatters.
// Metadata identifies a candidate owner, not an exemption. Resolve it to source
// and require the complete measured field to equal independently derived facts.
const compact = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .replace(/\s/gu, "");
const normal = (s) =>
  String(s ?? "")
    .replace(/\s+/gu, " ")
    .trim();
const parts = (key) => {
  try {
    return JSON.parse(key);
  } catch {
    return [];
  }
};
function functionCaption(fn) {
  const kind =
    fn.kind === "contact"
      ? `${fn.normal_state === "open" ? "NO" : "NC"} contact`
      : fn.kind === "channel"
        ? `${fn.direction === "input" ? "Input" : "Output"} channel`
        : fn.kind[0].toUpperCase() + fn.kind.slice(1);
  const terminals = fn.terminals.map((t) => t.terminalKey);
  return [
    kind,
    terminals.join(terminals.some((t) => t.includes("–")) ? ", " : "–"),
  ]
    .filter(Boolean)
    .join(" ");
}
function device(ir, uid) {
  return ir.devices.find((d) => d.uid === uid);
}
function portCaption(ir, uid, key) {
  const d = device(ir, uid),
    type = ir.deviceTypes?.find((t) => t.id === d?.typeId),
    p = type?.ports?.[key];
  return (
    p?.description?.trim() ||
    p?.connector?.trim() ||
    "Port identity not specified"
  );
}
function portEnd(ir, uid, key) {
  return `${device(ir, uid)?.designation}: ${portCaption(ir, uid, key)}`;
}
function referenceSource(ir, row, packet) {
  const [uid, keys, representation] = parts(row);
  if (!Array.isArray(keys) || !device(ir, uid)) return undefined;
  if (
    packet &&
    !packet.sheets.some((s) =>
      s.references?.some(
        (r) =>
          r.deviceUid === uid &&
          JSON.stringify(r.functions) === JSON.stringify(keys) &&
          r.representation === representation,
      ),
    )
  )
    return undefined;
  if (representation === "terminal")
    return "Terminal context (coil outside view)";
  if (!keys.length) return undefined; // no function-key cell
  const functions = keys.map((key) =>
    ir.functions.find(
      (f) => f.id.deviceUid === uid && f.id.functionKey === key,
    ),
  );
  return functions.every(Boolean)
    ? functions.map(functionCaption).join(", ")
    : undefined;
}
function ownedCell(ir, row, column, context) {
  const kind = context.sheet?.view.kind;
  if (kind === "references" && column === 1) {
    const expected = referenceSource(ir, row, context.packet);
    return expected === undefined
      ? null
      : { expected, mechanism: "function-reference", family: "function" };
  }
  if (kind === "io" && column === 1) {
    const [uid, key] = parts(row),
      fn = ir.functions.find(
        (f) =>
          f.id.deviceUid === uid &&
          f.id.functionKey === key &&
          f.kind === "channel",
      );
    if (!fn) return null;
    return {
      expected:
        device(ir, uid)?.io?.channels?.[key]?.address ??
        (fn.terminals.map((t) => t.terminalKey).join(", ") ||
          "Channel identity not specified"),
      mechanism: "io-channel",
      family: "function",
    };
  }
  if (kind === "network" && [2, 3].includes(column)) {
    const link = ir.relations?.find((r) => r.uid === row && r.connection);
    if (link) {
      const uid = column === 2 ? link.fromDeviceUid : link.toDeviceUid;
      return {
        expected: [
          portEnd(
            ir,
            uid,
            column === 2 ? link.connection.fromPort : link.connection.toPort,
          ),
          device(ir, uid)?.location,
        ]
          .filter(Boolean)
          .join("\n"),
        mechanism: "communication-schedule",
        family: "function",
      };
    }
    const [uid, key] = parts(row);
    if (
      column === 2 &&
      device(ir, uid) &&
      ir.deviceTypes?.find((t) => t.id === device(ir, uid).typeId)?.ports?.[key]
    )
      return {
        expected: [portEnd(ir, uid, key), device(ir, uid)?.location]
          .filter(Boolean)
          .join("\n"),
        mechanism: "communication-schedule",
        family: "function",
      };
  }
  if (kind === "bom" && column === 5) {
    const cable = ir.cables?.find((c) => c.uid === row);
    const [typeId] = parts(row);
    const type = cable
      ? ir.cableTypes?.find((t) => t.id === cable.typeId)
      : ir.deviceTypes?.find((t) => t.id === typeId);
    if (type && !type.description?.trim())
      return {
        expected: "Type description not specified",
        mechanism: "type-description-fallback",
        family: "internal",
      };
  }
  return null;
}
function combined(texts) {
  return texts
    .slice()
    .sort(
      (a, b) =>
        (a.anchor?.y ?? a.bbox?.y ?? 0) - (b.anchor?.y ?? b.bbox?.y ?? 0) ||
        (a.anchor?.x ?? a.bbox?.x ?? 0) - (b.anchor?.x ?? b.bbox?.x ?? 0),
    )
    .map((t) => t.text)
    .join(" ");
}
function fieldIssue(issue, source, texts) {
  return issue(
    source.family === "function"
      ? "printed-function-key"
      : "printed-internal-vocabulary",
    texts[0],
    {
      text: combined(texts),
      expected: source.expected,
      mechanism: source.mechanism,
      elements: texts.map((t) => t.element),
    },
  );
}
function terminalNoteVocabulary(g, context, issue) {
  if (context.sheet?.view.kind !== "terminals")
    return { findings: [], handled: [] };
  const expected =
    "Terminals follow the authored order where specified. Location groups do not assert installation sides.";
  const texts = g.texts.filter(
    (t) => t.reportNote === "1" && !t.row && !t.deviceUid,
  );
  if (texts.length)
    return {
      handled: texts,
      findings:
        compact(combined(texts)) === compact(expected)
          ? []
          : [
              fieldIssue(
                issue,
                {
                  family: "internal",
                  mechanism: "schema-identifier",
                  expected,
                },
                texts,
              ),
            ],
    };
  // The old engine has no note provenance. Retain its known legacy witness;
  // otherwise missing provenance is itself a failure, never an exemption.
  const legacy = g.texts.find(
    (t) => !t.row && !t.deviceUid && t.text.includes("terminalOrder"),
  );
  return {
    handled: legacy ? [legacy] : [],
    findings: [
      issue("printed-internal-vocabulary", legacy ?? { element: "sheet" }, {
        text: legacy?.text ?? "Terminal-order note provenance missing",
        expected,
        mechanism: legacy
          ? "schema-identifier"
          : "missing-report-note-provenance",
      }),
    ],
  };
}
export function ownedVocabulary(g, ir, context, issue) {
  const findings = [],
    handled = new Set(),
    cells = new Map();
  for (const t of g.texts)
    if (t.row != null && Number.isInteger(t.columnIndex)) {
      const key = JSON.stringify([t.row, t.columnIndex]);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(t);
    }
  for (const texts of cells.values()) {
    const source = ownedCell(ir, texts[0].row, texts[0].columnIndex, context);
    if (!source) continue;
    texts.forEach((t) => handled.add(t));
    if (compact(combined(texts)) !== compact(source.expected))
      findings.push(fieldIssue(issue, source, texts));
  }
  const ports = new Map();
  for (const t of g.texts)
    if (t.communicationPort != null) {
      const uid = t.deviceUid,
        key = t.communicationPort;
      const d = device(ir, uid),
        port = ir.deviceTypes?.find((type) => type.id === d?.typeId)?.ports?.[
          key
        ];
      if (!port) {
        handled.add(t);
        findings.push(
          fieldIssue(
            issue,
            {
              family: "function",
              mechanism: "communication-caption-owner",
              expected: "Resolved authored port owner",
            },
            [t],
          ),
        );
        continue;
      }
      const id = JSON.stringify([t.appearanceScope, uid, key]);
      if (!ports.has(id)) ports.set(id, []);
      ports.get(id).push(t);
    }
  for (const texts of ports.values()) {
    const t = texts[0];
    texts.forEach((t) => handled.add(t));
    const source = {
      expected: portCaption(ir, t.deviceUid, t.communicationPort),
      mechanism: "communication-caption",
      family: "function",
    };
    if (compact(combined(texts)) !== compact(source.expected))
      findings.push(fieldIssue(issue, source, texts));
  }
  const cable = ir.cables?.find(
    (c) => c.uid === context.sheet?.view.root?.cableUid,
  );
  if (cable) {
    const heading = g.texts.findIndex(
      (t) => t.text === `CABLE ${cable.designation}`,
    );
    const caption = heading >= 0 ? g.texts[heading + 1] : undefined;
    if (caption) {
      const source = {
        expected:
          ir.cableTypes
            ?.find((t) => t.id === cable.typeId)
            ?.description?.trim() || "Cable type description not specified",
        mechanism: "cable-type-caption",
        family: "internal",
      };
      handled.add(caption);
      if (compact(caption.text) !== compact(source.expected))
        findings.push(fieldIssue(issue, source, [caption]));
    }
  }
  const notes = terminalNoteVocabulary(g, context, issue);
  findings.push(...notes.findings);
  notes.handled.forEach((t) => handled.add(t));
  return { findings, handled };
}
function sourceProse(ir, t, context, g) {
  // Owner resolution and source equality are required; a marker alone proves nothing.
  if (
    t.authoredText === "request-note" &&
    !t.row &&
    !/label-(function|aggregate)/u.test(t.role ?? "")
  ) {
    const view = context.request?.views?.find(
      (v) =>
        (v.title ??
          (v.format === "signal-loop-view-request/0.1"
            ? `${device(ir, v.from?.device)?.designation ?? v.from?.device} - signal loop`
            : undefined)) === context.sheet?.view.title &&
        (v.format?.replace("-request", "") === context.sheet?.view.format ||
          v.format === `${context.sheet?.view.kind}-view-request/0.1`),
    );
    const fragments = g.texts.filter(
      (p) =>
        p.authoredText === "request-note" &&
        p.appearanceScope === t.appearanceScope &&
        !p.row &&
        !p.deviceUid,
    );
    if (
      view?.notes?.some((n) => compact(n).includes(compact(t.text))) &&
      compact(fragments.map((p) => p.text).join("")) ===
        compact(view.notes.join(""))
    )
      return true;
  }
  if (
    context.sheet?.view.kind === "circuit" &&
    t.circuitHeading &&
    !t.deviceUid &&
    !t.functionKey
  ) {
    const group = context.request?.views
      ?.find((v) => v.title === context.sheet.view.title)
      ?.groups?.find((group) => group.id === t.circuitHeading);
    if (group) {
      const expected = [
        group.lineReference ? `Ref. ${group.lineReference}` : undefined,
        group.label ?? group.id,
      ]
        .filter(Boolean)
        .join(" · ");
      const fragments = g.texts.filter(
        (p) =>
          p.circuitHeading === group.id &&
          p.appearanceScope === t.appearanceScope,
      );
      if (compact(fragments.map((p) => p.text).join("")) === compact(expected))
        return true;
    }
  }
  const d = device(ir, t.tagOwnershipValid ? t.tagOwnerUid : t.deviceUid),
    type = ir.deviceTypes?.find((v) => v.id === d?.typeId);
  if (
    !/label-(function|aggregate)/u.test(t.role ?? "") &&
    !t.functionKey &&
    !t.row
  ) {
    const description = d?.description?.trim()
      ? d.description
      : type?.description;
    if (
      t.tagField === "description" &&
      t.tagOwnershipValid === true &&
      (!t.deviceUid || t.deviceUid === t.tagOwnerUid) &&
      description &&
      compact(description).includes(compact(t.text))
    )
      return true;
    const terminalDescription = type?.terminals?.find(
      (p) => p.key === t.terminalDescriptionKey,
    )?.description;
    if (
      terminalDescription &&
      [
        terminalDescription,
        `${t.terminalDescriptionKey}: ${terminalDescription}`,
      ].some((source) => compact(source).includes(compact(t.text)))
    )
      return true;
  }
  // Authored report fields are selected explicitly by table kind and column.
  const free = {
    bom: [2, 3, 4, 5, 6],
    io: [3, 4, 5],
    terminals: [1, 3],
    network: [1],
    "io-ports": [3, 4, 6, 7],
    assemblies: [1, 4],
    wires: [0, 3, 4],
  };
  const table = context.tables?.find(
    (t) => t.kind === context.sheet?.view.kind,
  );
  if (table && free[table.kind]?.includes(t.columnIndex)) {
    const source = table.rows.find((r) => r.key === t.row)?.cells[
      t.columnIndex
    ];
    if (source && compact(source).includes(compact(t.text))) return true;
  }
  return false;
}
function semanticCaption(ir, t) {
  const label =
    t.labelOwnerKind === "symbol" && t.labelOwnerKey?.[0] === "function"
      ? t.labelOwnerKey
      : null;
  const uid = label?.[1] ?? t.deviceUid;
  const key = label?.[2] ?? t.functionKey;
  const fn = ir.functions.find(
    (f) => f.id.deviceUid === uid && (!key || f.id.functionKey === key),
  );
  if (!fn) return false;
  const expected =
    fn.kind === "contact"
      ? fn.normal_state === "open"
        ? "NO"
        : "NC"
      : ["coil", "source", "load"].includes(fn.kind)
        ? fn.kind
        : undefined;
  return expected && normal(t.text) === expected;
}
// Qualified selectors remain measurable in arbitrary generated prose. Bare keys
// are measured only in owned caption fields; ordinary English is not an oracle.
function logicalTexts(texts) {
  const result = [];
  for (const t of texts) {
    const previous = result.at(-1);
    const gap =
      t.bbox && previous?.bbox
        ? t.bbox.x - previous.bbox.x - previous.bbox.w
        : Infinity;
    if (
      previous &&
      !t.row &&
      !previous.row &&
      t.appearanceScope === previous.appearanceScope &&
      t.deviceUid === previous.deviceUid &&
      t.role === previous.role &&
      t.authoredText === previous.authoredText &&
      Math.abs(t.anchor?.y - previous.anchor?.y) < 0.05 &&
      gap >= -0.17 &&
      gap < 0.4
    ) {
      previous.text += (gap > 0.17 ? " " : "") + t.text;
      previous.elements.push(t.element);
      previous.bbox.w = t.bbox.x + t.bbox.w - previous.bbox.x;
    } else
      result.push({
        ...t,
        bbox: t.bbox && { ...t.bbox },
        elements: [t.element],
      });
  }
  return result;
}
export function vocabularyFindings(g, ir, context = {}, issue) {
  const owned = ownedVocabulary(g, ir, context, issue),
    functions = owned.findings.filter((f) => f.kind === "printed-function-key"),
    internal = owned.findings.filter(
      (f) => f.kind === "printed-internal-vocabulary",
    );
  const typeIds = [...(ir.deviceTypes ?? []), ...(ir.cableTypes ?? [])].map(
    (t) => t.id,
  );
  for (const t of logicalTexts(g.texts.filter((t) => !owned.handled.has(t)))) {
    if (sourceProse(ir, t, context, g)) continue;
    const qualified = [];
    for (const f of ir.functions) {
      const d = device(ir, f.id.deviceUid);
      if (
        !d ||
        ir.terminals?.some(
          (p) =>
            p.id.deviceUid === d.uid && p.id.terminalKey === f.id.functionKey,
        )
      )
        continue;
      qualified.push(`${d.designation}.${f.id.functionKey}`);
    }
    for (const d of ir.devices) {
      const type = ir.deviceTypes?.find((t) => t.id === d.typeId);
      for (const key of Object.keys(type?.ports ?? {}))
        qualified.push(`${d.designation}.${key}`);
    }
    const matches = [];
    for (const key of new Set(qualified)) {
      let at = t.text.indexOf(key);
      while (at >= 0) {
        const before = t.text[at - 1],
          after = t.text[at + key.length];
        if (
          (!before || !/[\p{L}\p{N}_.-]/u.test(before)) &&
          (!after || !/[\p{L}\p{N}_-]/u.test(after))
        )
          matches.push({ key, keyOffset: at });
        at = t.text.indexOf(key, at + key.length);
      }
    }
    const terminal = ir.terminals?.some(
      (p) => p.id.deviceUid === t.deviceUid && p.id.terminalKey === t.text,
    );
    if (!terminal && !semanticCaption(ir, t)) {
      const ownerFunctions = t.functionKey
        ? ir.functions.filter(
            (f) =>
              f.id.deviceUid === t.deviceUid &&
              f.id.functionKey === t.functionKey,
          )
        : ir.functions;
      for (const f of ownerFunctions) {
        const key = f.id.functionKey;
        if (
          key &&
          (t.text === key || t.text.startsWith(key + " ")) &&
          !matches.some((m) => m.key === key)
        )
          matches.push({ key, keyOffset: 0 });
      }
    }
    matches.sort(
      (a, b) => a.keyOffset - b.keyOffset || (a.key < b.key ? -1 : 1),
    );
    functions.push(
      ...matches.map((m) =>
        issue("printed-function-key", t, { text: t.text, ...m }),
      ),
    );
    const cable = ir.cables?.find(
      (c) => c.uid === context.sheet?.view.root?.cableUid,
    );
    if (cable && typeIds.includes(t.text))
      internal.push(
        issue("printed-internal-vocabulary", t, {
          text: t.text,
          mechanism: "cable-type-caption",
          expected:
            ir.cableTypes
              ?.find((c) => c.id === cable.typeId)
              ?.description?.trim() || "Cable type description not specified",
        }),
      );
    else if (typeIds.some((id) => t.text.includes(id)))
      internal.push(
        issue("printed-internal-vocabulary", t, {
          text: t.text,
          mechanism: "type-identifier",
        }),
      );
  }
  return { functions, internal };
}
