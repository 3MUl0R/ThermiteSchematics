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
export function executedOutput(header, tail) {
  const words = shellWords(header),
    index = words?.findIndex((word) => word === ">" || word === ">>");
  if (index === undefined || index < 0) return false;
  const file = words[index + 1]
    ?.replace(/^\.\//, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    !!file &&
    new RegExp(
      `(?:^|[;&|\\n])\\s*(?:(?:[^\\s]+/)?(?:bash|sh|zsh|python[\\d.]*|node|bun|source|\\.)\\s+(?:(?:--|-e)\\s+)?(?:<\\s*)?["']?(?:\\./)?|(?:(?:exec|command)\\s+)?["']?\\./)${file}(?:["'\\s]|$)`,
    ).test(tail)
  );
}
export function shellParts(input) {
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
      executed: executedOutput(head, lines.slice(end + 1).join("\n")),
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
