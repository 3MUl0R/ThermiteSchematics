import { literalShellBody, shellWords } from "./acquisition-command.mjs";
import { posix } from "node:path";
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
  let repo, number;
  for (let i = 3; i < words.length; i++) {
    const word = words[i];
    if (["-R", "--repo"].includes(word)) {
      if (repo) return null;
      repo = words[++i];
    } else if (word.startsWith("--repo=")) {
      if (repo) return null;
      repo = word.slice(7);
    } else if (word === "--json") {
      const fields = words[++i]?.split(",");
      if (
        !fields?.length ||
        !fields.every((field) => conversationFields.has(field))
      )
        return null;
    } else if (["--jq", "-q"].includes(word)) {
      if (words[++i] === undefined) return null;
    } else if (word === "--comments") continue;
    else if (/^[1-9][0-9]*$/.test(word) && !number) number = word;
    else return null;
  }
  return repo && number
    ? `https://github.com/${repo}/${words[1] === "pr" ? "pull" : "issues"}/${number}`
    : null;
}
export function shellRequest(input) {
  const text = literalShellBody(input),
    words = shellWords(text);
  if (!words) return { text };
  const github = words.some(
    (word, i) =>
      posix.basename(word) === "gh" &&
      words[i + 1] &&
      !/^[&|;]$|^&&$|^\|\|$/.test(words[i + 1]),
  );
  words[0] = posix.basename(words[0] ?? "");
  const view = issueView(words);
  if (view) return { text, target: view, headers: [], rest: "", safe: true };
  const client = words[0];
  if (
    !["curl", "wget"].includes(client) &&
    !(client === "gh" && words[1] === "api")
  )
    return { text, github };
  const headers = [];
  let target,
    output,
    safe = true,
    rest = "";
  for (let i = client === "gh" ? 2 : 1; i < words.length;) {
    const word = words[i];
    if (word === "&&") {
      rest = words.slice(i + 1).join(" ");
      const tail = words.slice(i + 1).filter((w) => w !== "--");
      safe &&=
        (tail.length === 2 &&
          tail[0] === "cat" &&
          !!output &&
          posix.normalize(tail[1]) === posix.normalize(output)) ||
        (tail[0] === "bun" && tail[1] === "-e");
      break;
    }
    if (word === ">" && words[i + 1] && output === undefined) {
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
    if (!parsed) {
      safe = false;
      i++;
      continue;
    }
    if (parsed.header !== undefined) headers.push(parsed.header);
    if (parsed.output !== undefined) {
      if (output !== undefined) safe = false;
      output = parsed.output;
    }
    i += parsed.count;
  }
  if (target?.startsWith("repos/")) target = `https://api.github.com/${target}`;
  return {
    text,
    target,
    headers,
    rest: `${output ?? ""} ${rest}`,
    safe,
    github,
  };
}
