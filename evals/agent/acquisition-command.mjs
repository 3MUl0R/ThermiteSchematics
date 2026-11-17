import { posix } from "node:path";
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
function fetchOption(words, index, client) {
  const word = words[index],
    value = words[index + 1];
  if (client === "curl" && ["-o", "--output"].includes(word))
    return value ? { count: 2, output: value } : null;
  if (client === "curl" && word.startsWith("--output="))
    return word.length > 9 ? { count: 1, output: word.slice(9) } : null;
  if (["-X", "--method", "--request"].includes(word))
    return value?.toUpperCase() === "GET" ? { count: 2 } : null;
  if (/^(?:--method|--request)=GET$/i.test(word)) return { count: 1 };
  if (["-H", "--header"].includes(word))
    return /^Accept:/i.test(value ?? "") ? { count: 2 } : null;
  if (client === "gh" && ["-q", "--jq"].includes(word))
    return value !== undefined ? { count: 2 } : null;
  if (
    client === "curl" &&
    (/^-+[fsSL]+$/.test(word) ||
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--compressed",
      ].includes(word))
  )
    return { count: 1 };
  if (client === "gh" && word === "--paginate") return { count: 1 };
  return null;
}
function fetchArguments(words) {
  const client = words[0];
  if (client !== "curl" && !(client === "gh" && words[1] === "api"))
    return null;
  let url, output;
  for (let i = client === "curl" ? 1 : 2; i < words.length;) {
    const word = words[i];
    if (word === ">" && i === words.length - 2 && output === undefined) {
      output = words[i + 1];
      i += 2;
      continue;
    }
    if (/^(?:https:\/\/|repos\/)/.test(word) && url === undefined) {
      url = word;
      i++;
      continue;
    }
    const option = fetchOption(words, i, client);
    if (!option) return null;
    if (option.output !== undefined) {
      if (output !== undefined) return null;
      output = option.output;
    }
    i += option.count;
  }
  return url ? { url, output } : null;
}
export function literalShellBody(input) {
  return input
    .trim()
    .replace(
      /^(?:\/[\w/.-]+\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+(['"])([\s\S]*)\1$/,
      "$2",
    );
}
export function acquisitionParts(input) {
  const text = literalShellBody(input);
  if (/^https:\/\/\S+$/.test(text)) return { url: text, tail: null };
  const words = shellWords(text);
  if (!words) return null;
  const split = words.indexOf("&&");
  const request = fetchArguments(split < 0 ? words : words.slice(0, split));
  if (!request) return null;
  return { ...request, tail: split < 0 ? null : words.slice(split + 1) };
}
export function acquisitionRequest(input) {
  const parts = acquisitionParts(input);
  if (!parts) return null;
  const { tail: original, ...request } = parts;
  if (original !== null) {
    const tail = [...original];
    if (tail[1] === "--") tail.splice(1, 1);
    if (tail.length !== 2 || tail[0] !== "cat" || !request.output) return null;
    if (posix.normalize(tail[1]) !== posix.normalize(request.output))
      return null;
  }
  return request;
}
