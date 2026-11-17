// Recognize literal read-only fetches, not arbitrary shell programs.
export function shellWords(text) {
  const words = [];
  let word = "",
    quote = null,
    escaped = false,
    active = false;
  const flush = () => {
    if (active) {
      words.push(word);
      word = "";
      active = false;
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
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
      flush();
      continue;
    }
    if (/[&|;<>]/.test(c)) {
      flush();
      words.push(c + (text[i + 1] === c ? text[++i] : ""));
      continue;
    }
    word += c;
    active = true;
  }
  if (quote || escaped) return null;
  flush();
  return words;
}
export function literalShellBody(input) {
  return input
    .trim()
    .replace(
      /^(?:\/[\w/.-]+\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+(['"])([\s\S]*)\1$/,
      "$2",
    );
}
