import { literalShellBody, shellWords } from "./acquisition-command.mjs";
const separators = new Set(["&&", "||", ";", "|", "&", "\n"]);
function split(text) {
  const tokens = shellWords(text, { literal: true });
  if (!tokens || tokens.some((t) => t.control && ["<<", "("].includes(t.value)))
    return null;
  const parts = [];
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    if (
      i === tokens.length ||
      (tokens[i].control && separators.has(tokens[i].value))
    ) {
      if (i > start) {
        const selected = tokens.slice(start, i);
        parts.push({
          tokens: selected,
          text: selected.map((t) => t.literal).join(" "),
        });
      }
      start = i + 1;
    }
  }
  return parts;
}
const readOnlyFileTools = new Set([
  "cat",
  "head",
  "tail",
  "rg",
  "grep",
  "wc",
  "stat",
  "ls",
  "test",
]);

export function decodedShellBody(input) {
  if (!/[\\$]/.test(input)) {
    const words = shellWords(input);
    if (
      words?.length === 3 &&
      /^(?:\/[\w/.-]+\/)?(?:zsh|bash|sh)$/.test(words[0]) &&
      ["-lc", "-c"].includes(words[1])
    )
      return words[2];
  }
  return literalShellBody(input);
}

// Only a plain file inspection is safe when a subsequent shell command names
// the output. Pipelines, copies and wrapped interpreters can consume its code.
export function executedOutput(header, tail) {
  const words = shellWords(header);
  const index = words?.findIndex((word) => word === ">" || word === ">>");
  if (index === undefined || index < 0 || !words[index + 1]) return false;
  const file = words[index + 1]
    .replace(/^\.\//, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentions = new RegExp(`(?:^|[\\s"'=/<>])${file}(?=$|[\\s"';&|<>),])`);
  const lines = tail.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (mentions.test(line)) {
      const parts = split(line);
      if (!parts || /[|<>]/.test(line)) return true;
      if (
        parts.some(
          (part) =>
            mentions.test(part.text) &&
            !readOnlyFileTools.has(part.tokens[0].value.split("/").at(-1)),
        )
      )
        return true;
    }
    const here = /<<\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*$/.exec(line);
    if (here) {
      const end = lines.indexOf(here[2], i + 1);
      if (end < 0) continue;
      const body = lines.slice(i + 1, end).join("\n");
      if (
        mentions.test(body) &&
        /\b(?:exec|eval|source|system|spawn|subprocess)\b/.test(body)
      )
        return true;
      i = end;
    }
  }
  return false;
}
export function shellParts(input, laterShell = "") {
  const text = literalShellBody(input),
    lines = text.split("\n"),
    parts = [];
  let pending = [];
  for (let i = 0; i < lines.length; i++) {
    const header = shellWords(lines[i], { literal: true });
    const index = header?.findIndex((t) => t.control && t.value === "<<");
    if (index === undefined || index < 0) {
      pending.push(lines[i]);
      continue;
    }
    const delimiter = header[index + 1];
    if (!delimiter) return null;
    let end = i + 1;
    while (end < lines.length && lines[end] !== delimiter.value) end++;
    if (end === lines.length) return null;
    const head = header
      .filter((_, j) => j !== index && j !== index + 1)
      .map((t) => t.literal)
      .join(" ");
    pending.push(head);
    const selected = split(pending.join("\n"));
    if (!selected?.length) return null;
    selected.at(-1).heredoc = {
      body: lines.slice(i + 1, end).join("\n"),
      quoted: /^["']/.test(delimiter.literal),
      executed: executedOutput(
        head,
        lines
          .slice(end + 1)
          .concat(laterShell)
          .join("\n"),
      ),
    };
    parts.push(...selected);
    pending = [];
    i = end;
  }
  const final = split(pending.join("\n"));
  return final ? [...parts, ...final] : null;
}
export function aggregateParts(results) {
  if (results.some((result) => result.class === "source-read"))
    return { class: "source-read" };
  return {
    class: results.some((result) => result.class === "issue-lookup")
      ? "issue-lookup"
      : "other",
    ...(results.some((result) => result.libraryAcquisition)
      ? { libraryAcquisition: true }
      : {}),
  };
}
