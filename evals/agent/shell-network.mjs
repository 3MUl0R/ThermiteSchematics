import { posix } from "node:path";
const clients = new Set(["curl", "wget", "gh", "git"]);
const interpreter = /^(?:bun|node|python[\d.]*|ruby|perl|deno|(?:ba|z)?sh)$/;
export function knownLocalCommand(words) {
  if (
    !words ||
    !words.length ||
    words.some((word) => ["(", ")", "<", "<<"].includes(word))
  )
    return false;
  const split = words.findIndex((word) =>
    ["&&", "||", ";", "|", "&"].includes(word),
  );
  if (split >= 0)
    return (
      knownLocalCommand(words.slice(0, split)) &&
      knownLocalCommand(words.slice(split + 1))
    );
  const command = posix.basename(words[0] ?? "");
  return (
    [
      "echo",
      "printf",
      "which",
      "type",
      "cat",
      "pwd",
      "ls",
      "rg",
      "uname",
    ].includes(command) ||
    (command === "command" && ["-v", "-V"].includes(words[1])) ||
    (["bun", "node"].includes(command) &&
      (posix.basename(words[1] ?? "") === "thermite.mjs" ||
        (words.length === 2 &&
          ["--version", "--help", "-v"].includes(words[1]))))
  );
}
function segmentNetwork(words) {
  let i = 0;
  if (words[i] === "env") i++;
  while (/^[A-Za-z_]\w*=/.test(words[i] ?? "")) i++;
  if (words[i] === "command") {
    if (["-v", "-V"].includes(words[i + 1])) return false;
    i++;
  }
  const command = posix.basename(words[i] ?? ""),
    args = words.slice(i + 1);
  if (
    ["echo", "printf", "which", "type", "cat", "pwd", "ls", "rg"].includes(
      command,
    )
  )
    return false;
  if (clients.has(command)) return true;
  if (interpreter.test(command))
    return (
      args.some(
        (arg) =>
          /^(?:-[a-z]*[ecp][a-z]*|--(?:eval|command|print)(?:=.*)?)$/i.test(
            arg,
          ) ||
          (arg === "<<" && (args[0] === "-" || args[0] === "<<")),
      ) ||
      (command === "deno" && args[0] === "eval")
    );
  // Unknown wrappers can run the named clients; no exemption is inferred.
  return words
    .slice(i)
    .some((word) => clients.has(posix.basename(word)) || /\$|`/.test(word));
}
// A bounded set of network-capable command forms, not program analysis.
export function couldNetwork(text, words) {
  if (!words) {
    const visible = text.replace(/['"]/g, "");
    return (
      /^\s*\$/.test(visible) ||
      /\b(?:curl|wget|gh|git)\b/i.test(visible) ||
      /\bdeno\s+eval\b/i.test(visible) ||
      /\b(?:bun|node|python[\d.]*|ruby|perl|deno|(?:ba|z)?sh)\b[^\n]*(?:\s-[a-z]*[ecp]|--eval|--command)|\b(?:bun|node|python[\d.]*|ruby|perl|deno|(?:ba|z)?sh)\s+-?\s*<</i.test(
        visible,
      )
    );
  }
  let start = 0;
  for (let i = 0; i <= words.length; i++) {
    if (
      i === words.length ||
      ["&&", "||", ";", "|", "&", "(", ")"].includes(words[i])
    ) {
      if (segmentNetwork(words.slice(start, i))) return true;
      start = i + 1;
    }
  }
  return false;
}
