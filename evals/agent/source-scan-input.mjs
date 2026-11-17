import { literalShellBody } from "./acquisition-command.mjs";
// Quoted Markdown here-docs are authored report data, not source requests.
export function sourceScanInput(name, values) {
  if (!/^(?:command_execution|bash|shell)$/i.test(name))
    return values.join("\n");
  return values.map(withoutMarkdownBodies).join("\n");
}
function withoutMarkdownBodies(input) {
  const lines = literalShellBody(input).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const header =
      /^\s*cat\s+>\s*(?:'([^']+\.md)'|"([^"]+\.md)"|([^\s<>;&|]+\.md))\s+<<\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\4\s*$/.exec(
        lines[i],
      );
    if (!header) continue;
    const output = header[1] ?? header[2] ?? header[3],
      delimiter = header[5];
    let end = i + 1;
    while (end < lines.length && lines[end] !== delimiter) end++;
    if (end === lines.length) continue;
    const escaped = output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const executes = new RegExp(
      "(?:^|[;&|\\n])\\s*(?:[^\\s]+/)?(?:bash|sh|zsh|python3?|node|bun|source|\\.)\\s+(?:--\\s+)?[\"']?(?:\\./)?" +
        escaped +
        "[\"']?(?:\\s|$)",
    );
    if (executes.test(lines.slice(end + 1).join("\n"))) continue;
    for (let j = i + 1; j < end; j++) lines[j] = "";
    i = end;
  }
  return lines.join("\n");
}
