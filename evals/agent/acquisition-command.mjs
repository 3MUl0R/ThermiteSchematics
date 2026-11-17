// Recognize literal read-only fetches, not arbitrary shell programs.
export function shellWords(text, { literal = false } = {}) {
  const words = [];
  let word = "",
    quote = null,
    escaped = false,
    active = false,
    start = 0;
  const flush = (end) => {
    if (active) {
      words.push(
        literal ? { value: word, literal: text.slice(start, end) } : word,
      );
      word = "";
      active = false;
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!active && !/\s/.test(c)) start = i;
    if (escaped) {
      word += c;
      escaped = false;
      active = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') escaped = true;
      else {
        if (quote === '"' && /[`$]/.test(c)) return null;
        word += c;
      }
      continue;
    }
    if (/[\r\n`$]/.test(c)) return null;
    if (c === "\\") {
      escaped = true;
      active = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      active = true;
      continue;
    }
    if (/\s/.test(c)) {
      flush(i);
      continue;
    }
    if (/[&|;<>()]/.test(c)) {
      flush(i);
      const value = c + (text[i + 1] === c ? text[++i] : "");
      words.push(literal ? { value, literal: value, control: true } : value);
      continue;
    }
    word += c;
    active = true;
  }
  if (quote || escaped) return null;
  flush(text.length);
  return words;
}
export function literalShellBody(input) {
  return input
    .trim()
    .replace(
      /^(?:\/[\w/.-]+\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+(['"])([\s\S]*)\1$/,
      "$2",
    )
    .replace(
      /^(?:\/[\w/.-]+\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+([\w./-]+)$/,
      "$1",
    );
}
