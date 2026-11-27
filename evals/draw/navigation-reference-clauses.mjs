// Join visual wraps inside a measured annotation, but stop at a completed
// pointer or a fresh printed subject. A missing pointer must not borrow the
// next element's destination. Semicolons/newlines remain explicit boundaries.
const SOURCE_TOKEN_RE = /^(?:P(\d+)\s*\/\s*)?S?(\d+)[. :]([A-Z]+\d+)$/u;
const LOCAL_COLON_RE = /^:(?:\s+|$)/u;
const TRAILING_SOURCE_RE = /^\s+\(\s*([^()\n]+?)\s*\):(?:\s+|$)/u;
const FALLBACK_SOURCE_RE =
  /^([^:;\n]+?)\s+\(\s*((?:P\d+\s*\/\s*)?S?\d+[. :][A-Z]+\d+)\s*\):(?:\s+|$)/u;

function parseTrailingToken(designation, rawToken, body, header) {
  const token = SOURCE_TOKEN_RE.exec(rawToken);
  if (!token) return null;
  if (token[1])
    return {
      present: true,
      validToken: false,
      designation,
      rawToken,
      header,
      body,
    };
  return {
    present: true,
    validToken: true,
    designation,
    sheet: Number(token[2]),
    zone: token[3],
    header,
    body,
  };
}

// Match the complete opaque device designation first (longest exact match
// against known sheet designations), then interpret only a trailing
// " (SS.ZN)" sheet-zone token as a self-location source prefix.
export function parseSourceHeader(text, designations = []) {
  const raw = String(text ?? "").trimStart();
  const known = [
    ...new Set(
      (designations ?? []).filter((d) => typeof d === "string" && d.length > 0),
    ),
  ].sort((a, b) => b.length - a.length);
  for (const tag of known) {
    if (!raw.startsWith(tag)) continue;
    const rest = raw.slice(tag.length);
    const local = LOCAL_COLON_RE.exec(rest);
    if (local)
      return {
        present: false,
        designation: tag,
        header: tag,
        body: rest.slice(local[0].length),
      };
    const trailing = TRAILING_SOURCE_RE.exec(rest);
    if (trailing) {
      const rawToken = trailing[1].trim();
      const parsed = parseTrailingToken(
        tag,
        rawToken,
        rest.slice(trailing[0].length),
        `${tag} (${rawToken})`,
      );
      if (parsed) return parsed;
    }
  }
  const fallback = FALLBACK_SOURCE_RE.exec(raw);
  if (fallback) {
    const designation = fallback[1].trim();
    const rawToken = fallback[2].trim();
    return parseTrailingToken(
      designation,
      rawToken,
      raw.slice(fallback[0].length),
      `${designation} (${rawToken})`,
    );
  }
  return { present: false, body: text };
}

const DESTINATION_TOKEN_SRC = "(?:P\\d+\\s*\\/\\s*)?S?\\d+[. :][A-Z]+\\d+";
const DESTINATION_LIST_LINE_RE = new RegExp(
  `^\\s*${DESTINATION_TOKEN_SRC}(?:\\s*,\\s*${DESTINATION_TOKEN_SRC})*\\s*,?\\s*$`,
  "u",
);

function rowY(row) {
  return row?.anchor?.y ?? row?.bbox?.y;
}

function rowLineHeight(a, b) {
  return Math.max(
    a?.fontSize ?? 0,
    a?.bbox?.h ?? 0,
    b?.fontSize ?? 0,
    b?.bbox?.h ?? 0,
  );
}

function consistentWrapPitch(pending, next) {
  const prev = pending.at(-1);
  const yPrev = rowY(prev),
    yNext = rowY(next);
  if (yPrev == null || yNext == null) return true;
  const dy = yNext - yPrev;
  const lineH = rowLineHeight(prev, next) || 3.5;
  const maxPitch = Math.max(lineH * 2.2, 1.5);
  if (dy <= 0 || dy > maxPitch) return false;
  if (pending.length >= 2) {
    const yBefore = rowY(pending.at(-2));
    if (yBefore != null) {
      const priorPitch = yPrev - yBefore;
      if (
        priorPitch > 0.17 &&
        Math.abs(dy - priorPitch) > Math.max(priorPitch * 0.5, 1)
      )
        return false;
    }
  }
  if (prev.bbox && next.bbox) {
    const horizClose =
      Math.max(prev.bbox.x, next.bbox.x) <=
      Math.min(prev.bbox.x + prev.bbox.w, next.bbox.x + next.bbox.w) + maxPitch;
    if (!horizClose) return false;
  }
  return true;
}

function isCommaDestinationPending(pending, tokens, designations) {
  if (!pending.length) return false;
  const last = pending.at(-1);
  const parsed = parseSourceHeader(last.text, designations);
  const body = parsed.header ? parsed.body : last.text;
  return tokens(body).length > 0 && /,\s*$/u.test(last.text);
}

function isDestinationContinuation(pending, row, text, tokens, designations) {
  return (
    isCommaDestinationPending(pending, tokens, designations) &&
    DESTINATION_LIST_LINE_RE.test(text) &&
    consistentWrapPitch(pending, row)
  );
}

export function referenceClauses(rows, tokens, designations = []) {
  const clauses = [];
  let pending = [],
    header;
  const flush = () => {
    if (!pending.length) return;
    const sourceText = pending.map((r) => r.text).join(" ");
    const parsed = parseSourceHeader(sourceText, designations);
    const ownHeader = parsed.header ?? sourceText.match(/^([^:;\n]+):\s/u)?.[1];
    if (ownHeader) header = ownHeader;
    clauses.push({
      element: pending[0].element,
      text: header && !ownHeader ? `${header}: ${sourceText}` : sourceText,
      sourceText,
      groupHeader: header,
    });
    pending = [];
  };
  for (const row of rows) {
    const fragments = row.text.split(/;|\n/u);
    for (const [i, text] of fragments.entries()) {
      if (isCommaDestinationPending(pending, tokens, designations)) {
        if (
          i ||
          !isDestinationContinuation(pending, row, text, tokens, designations)
        )
          flush();
      } else if (
        i ||
        (pending.length &&
          ((!rolePrefix(pending, designations) && startsSubject(text)) ||
            (/→|->/u.test(text) && pending.some((r) => /→|->/u.test(r.text)))))
      )
        flush();
      if (!text.trim()) continue;
      pending.push({ ...row, text });
      const parsed = parseSourceHeader(text, designations);
      if (
        tokens(parsed.header ? parsed.body : text).length &&
        !/,\s*$/u.test(text)
      )
        flush();
    }
  }
  flush();
  return clauses;
}
function rolePrefix(rows, designations = []) {
  const raw = rows.map((r) => r.text).join(" ");
  const parsed = parseSourceHeader(raw, designations);
  const text = (
    parsed.header ? parsed.body : raw.replace(/^[^:]+:\s*/u, "")
  ).trim();
  return /^(?:(?:NC|NO)(?:\s+contact)?|(?:overload|breaker|fuse)(?:\s+element)?|coil|contact)?$/iu.test(
    text,
  );
}
function startsSubject(text) {
  return (
    /^(?:[^:;]+:\s*)?(?:overload|breaker|fuse|NC|NO|contact|coil)\b/iu.test(
      text,
    ) || /^\S+\.\S+\s*(?:→|->)/u.test(text)
  );
}
