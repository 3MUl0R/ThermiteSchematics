import { outsideConnectionFindings } from "./outside-connection-counts.mjs";
export { outsideConnectionFindings };

export function terminalBodyFindings(g, ir, issue) {
  const ownership = (g.texts ?? [])
    .filter((t) => t.terminalCaptionBodyError)
    .map((t) =>
      issue("invalid-terminal-caption-ownership", t, {
        text: t.text,
        reason: t.terminalCaptionBodyError,
        terminalCaptionBody: t.terminalCaptionBody,
      }),
    );
  return [...ownership, ...outsideConnectionFindings(g, ir, issue)];
}
const normalizeCaption = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();

function repeatsKey(value, key) {
  if (!key || value.length <= key.length) return false;
  let rest = value,
    count = 0;
  while (rest.startsWith(key)) {
    count++;
    rest = rest.slice(key.length);
    if (!rest) return count >= 2;
    if (!rest.startsWith(" ")) return false;
    rest = rest.slice(1);
  }
  return false;
}

// Judge single-element terminal caption duplication against the resolved
// physical terminal key so legal keys with spaces or punctuation (e.g. "A A",
// "[1] [1]", "+ +", "A[+1].B-2") are handled exactly rather than tokenized.
export function duplicateTerminalCaption(a) {
  const text = normalizeCaption(a.text);
  if (!a.terminal) return /^(\S+)\s+\1$/.test(text);
  const key = normalizeCaption(a.terminal);
  if (
    !key ||
    text === key ||
    (a.outsideConnections &&
      (text === `${key} [+${a.outsideConnections}]` ||
        text === `${key} [ +${a.outsideConnections} ]`))
  )
    return false;
  const base = text.replace(/\s+\[\s*\+\d+\s*\]$/, "");
  // Any other repeated-token caption (e.g. "2 2" owned by terminal "1") is
  // still a duplicate, exactly as the unresolved-terminal rule judges it.
  return (
    repeatsKey(text, key) ||
    repeatsKey(base, key) ||
    /^(\S+)\s+\1$/.test(text) ||
    (base !== key && /^(\S+)\s+\1$/.test(base))
  );
}
