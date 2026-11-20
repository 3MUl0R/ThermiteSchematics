import { literalShellBody, shellWords } from "./acquisition-command.mjs";
import { decodedShellBody, executedOutput } from "./shell-parts.mjs";
// Quoted Markdown here-docs are authored report data, not source requests.
export function sourceScanInput(
  name,
  values,
  completed = false,
  laterShell = "",
) {
  if (!/^(?:command_execution|bash|shell|exec_command)$/i.test(name))
    return values.join("\n");
  return values
    .map((input) => withoutMarkdownBodies(input, completed, laterShell))
    .join("\n");
}
// A recognized report header must start in plain command context. This line
// check is deliberately coarse: shellWords already rejects open quotes,
// command substitution and continuations, and these constructs can also carry
// a header across lines in bash or zsh: ANSI-C quotes, `${`, `$[`,
// arithmetic `((` and array `=(` groups. Any paren or brace drops the
// exemption, so the whole command is scanned as before.
function plainCommand(line) {
  return (
    !!shellWords(line) && !line.endsWith("\\") && !/[(){}]|\$['[]/.test(line)
  );
}
function withoutMarkdownBodies(input, completed, laterShell) {
  const original = literalShellBody(input);
  const decoded = decodedShellBody(input);
  const lines = decoded.split("\n");
  let removed = false,
    recognized = false;
  for (let i = 0; i < lines.length; i++) {
    const header =
      /^\s*cat\s+(>>?)\s*(?:'([^']+\.md)'|"([^"]+\.md)"|([^\s<>;&|]+\.md))\s+<<\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\5\s*$/.exec(
        lines[i],
      );
    if (!header || (header[1] === ">>" && !completed)) {
      if (lines[i].includes("<<")) {
        // Never mistake lines in somebody else's heredoc for a new command.
        const marker = /<<\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1\s*$/.exec(
          lines[i],
        );
        if (
          !marker ||
          lines[i].indexOf("<<") !== marker.index ||
          lines[i][marker.index - 1] === "<" ||
          !plainCommand(lines[i].slice(0, marker.index))
        )
          return original;
        const end = lines.indexOf(marker[2], i + 1);
        if (end < 0) return original;
        i = end;
      } else if (!plainCommand(lines[i])) {
        return original;
      }
      continue;
    }
    const output = header[2] ?? header[3] ?? header[4],
      delimiter = header[6];
    let end = i + 1;
    while (end < lines.length && lines[end] !== delimiter) end++;
    if (end === lines.length) continue;
    recognized = true;
    if (
      executedOutput(
        lines[i],
        lines
          .slice(end + 1)
          .concat(laterShell)
          .join("\n"),
      )
    ) {
      i = end;
      continue;
    }
    removed = true;
    lines[i] = `cat > ${JSON.stringify(output)}`;
    for (let j = i + 1; j <= end; j++) lines[j] = "";
    i = end;
  }
  return removed || recognized ? lines.filter(Boolean).join("\n") : original;
}
