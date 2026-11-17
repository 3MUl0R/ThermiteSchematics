import { literalShellBody, shellWords } from "./acquisition-command.mjs";
import { posix } from "node:path";
import { couldNetwork, knownLocalCommand } from "./shell-network.mjs";
import { downloadedJson } from "./downloaded-json.mjs";
const conversationFields = new Set([
  "title",
  "body",
  "comments",
  "author",
  "url",
  "number",
  "state",
  "labels",
  "assignees",
  "createdAt",
  "updatedAt",
  "closedAt",
  "milestone",
  "isDraft",
]);

function option(words, index, client) {
  const value = words[index],
    next = words[index + 1];
  if (["-H", "--header"].includes(value))
    return next ? { count: 2, header: next } : null;
  if (value.startsWith("--header="))
    return { count: 1, header: value.slice(9) };
  if (value.startsWith("-H") && value.length > 2)
    return { count: 1, header: value.slice(2) };
  if (["-X", "--method", "--request"].includes(value))
    return next === "GET" ? { count: 2 } : null;
  if (/^--(?:method|request)=GET$/.test(value)) return { count: 1 };
  if (
    (client === "curl" && ["-o", "--output"].includes(value)) ||
    (client === "wget" && ["-O", "--output-document"].includes(value))
  )
    return next ? { count: 2, output: next } : null;
  if (/^--(?:output|output-document)=.+$/.test(value))
    return { count: 1, output: value.slice(value.indexOf("=") + 1) };
  if (client === "gh" && ["-q", "--jq"].includes(value))
    return next !== undefined ? { count: 2 } : null;
  if (client === "gh" && value === "--paginate") return { count: 1 };
  if (
    client === "curl" &&
    (/^-+[fsSL]+$/.test(value) ||
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--compressed",
      ].includes(value))
  )
    return { count: 1 };
  if (client === "wget" && ["-q", "--quiet"].includes(value))
    return { count: 1 };
  return null;
}
function issueView(words) {
  if (
    words[0] !== "gh" ||
    !["issue", "pr"].includes(words[1]) ||
    words[2] !== "view"
  )
    return null;
  let repo, number, target;
  for (let i = 3; i < words.length; i++) {
    const word = words[i];
    if (["-R", "--repo"].includes(word)) {
      if (repo) return null;
      repo = words[++i];
    } else if (word.startsWith("--repo=")) {
      if (repo) return null;
      repo = word.slice(7);
    } else if (word === "--json" || word.startsWith("--json=")) {
      const fields = (word === "--json" ? words[++i] : word.slice(7))?.split(
        ",",
      );
      if (
        !fields?.length ||
        !fields.every((field) => conversationFields.has(field))
      )
        return null;
    } else if (["--jq", "-q"].includes(word)) {
      if (words[++i] === undefined) return null;
    } else if (word === "--comments") continue;
    else if (/^https?:\/\//i.test(word) && !target && !number) target = word;
    else if (/^[1-9][0-9]*$/.test(word) && !number && !target) number = word;
    else return null;
  }
  if (target) return repo ? null : target;
  return repo && number
    ? `https://github.com/${repo}/${words[1] === "pr" ? "pull" : "issues"}/${number}`
    : null;
}
function fetchArguments(words) {
  const client = words[0],
    headers = [];
  let target, output;
  for (let i = client === "gh" ? 2 : 1; i < words.length;) {
    const word = words[i];
    if (word === ">" && i === words.length - 2 && output === undefined) {
      output = words[i + 1];
      i += 2;
      continue;
    }
    if (/^(?:[a-z]+:|repos\/)/i.test(word) && !target) {
      target = word;
      i++;
      continue;
    }
    const parsed = option(words, i, client);
    if (!parsed) return null;
    if (parsed.header !== undefined) headers.push(parsed.header);
    if (parsed.output !== undefined) {
      if (output !== undefined) return null;
      output = parsed.output;
    }
    i += parsed.count;
  }
  if (target?.startsWith("repos/")) target = `https://api.github.com/${target}`;
  return target ? { target, headers, output } : null;
}
function literalTarget(token) {
  if (token.value.startsWith("-") || !/[/:.]/.test(token.value)) return true;
  return (
    token.literal === token.value ||
    ["'", '"'].some((q) => token.literal === q + token.value + q)
  );
}
export function shellRequest(input, scanned = input) {
  const text = literalShellBody(input),
    tokens = shellWords(text, { literal: true });
  const words = tokens?.map((t) => t.value),
    wrapper = /^\s*(?:\/[\w/.-]+\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s/.test(input),
    network =
      couldNetwork(scanned, words) ||
      (wrapper && !knownLocalCommand(shellWords(scanned.trim())));
  const refused = { text, network, safe: false };
  if (!tokens || /[\r\n$`]/.test(text) || !tokens.every(literalTarget))
    return refused;
  const split = tokens.findIndex((t) => t.control && t.value === "&&");
  const prefix = split < 0 ? tokens : tokens.slice(0, split);
  // A plain file output redirection is part of one command; all other control
  // syntax is refused. The single && exception must match the entire formatter.
  if (prefix.some((t) => t.control && t.value !== ">")) return refused;
  const head = prefix.map((t) => t.value);
  head[0] = posix.basename(head[0] ?? "");
  const view = split < 0 && issueView(head);
  if (view) return { text, target: view, headers: [], safe: true, network };
  if (
    !["curl", "wget"].includes(head[0]) &&
    !(head[0] === "gh" && head[1] === "api")
  )
    return refused;
  const fetch = fetchArguments(head);
  if (
    !fetch ||
    (split >= 0 && !downloadedJson(words.slice(split + 1), fetch.output))
  )
    return refused;
  return { text, ...fetch, safe: true, network };
}
