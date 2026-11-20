import { literalShellBody, shellWords } from "./acquisition-command.mjs";
import { decodedShellBody, executedOutput } from "./shell-parts.mjs";
// Quoted Markdown here-docs are authored report data, not source requests.
export function sourceScanInput(
  name,
  values,
  completed = false,
  laterShell = "",
) {
  return sourceScanInputs(name, values, completed, laterShell).text;
}
// `alternate` is the decoded command without the report exemption. It is set
// when an exempted report header follows a construct that can carry it into
// an earlier word or group in bash or zsh (ANSI-C quotes, `$[`, parentheses,
// braces, or one of these or an open quote before another here-doc marker).
// Callers classify
// both texts and keep the stronger result, so no read in `text` is lost.
export function sourceScanInputs(
  name,
  values,
  completed = false,
  laterShell = "",
) {
  if (!/^(?:command_execution|bash|shell|exec_command)$/i.test(name))
    return { text: values.join("\n") };
  const scans = values.map((input) =>
    withoutMarkdownBodies(input, completed, laterShell),
  );
  const text = scans.map((scan) => scan.text).join("\n");
  return scans.some((scan) => scan.hidden)
    ? { text, alternate: values.map(decodedShellBody).join("\n") }
    : { text };
}
const opener = /[(){}]|\$['[]/;
function withoutMarkdownBodies(input, completed, laterShell) {
  const original = literalShellBody(input);
  const decoded = decodedShellBody(input);
  const lines = decoded.split("\n");
  let removed = false,
    recognized = false,
    opened = false,
    hidden = false;
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
          lines[i][marker.index - 1] === "<"
        )
          return { text: original };
        const prefix = lines[i].slice(0, marker.index);
        opened ||= opener.test(prefix) || !shellWords(prefix);
        const end = lines.indexOf(marker[2], i + 1);
        if (end < 0) return { text: original };
        i = end;
      } else if (!shellWords(lines[i]) || lines[i].endsWith("\\")) {
        return { text: original };
      } else opened ||= opener.test(lines[i]);
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
    hidden ||= opened;
    lines[i] = `cat > ${JSON.stringify(output)}`;
    for (let j = i + 1; j <= end; j++) lines[j] = "";
    i = end;
  }
  return removed || recognized
    ? { text: lines.filter(Boolean).join("\n"), hidden }
    : { text: original };
}
