import { posix } from "node:path";
import { canonicalUrl } from "./github-canonical.mjs";

// These are mutation verbs, independent of any tool result. Shell text that
// looks like an argument to a data tool does not establish a command.
const ghWrites = {
  issue: [
    "create",
    "comment",
    "edit",
    "close",
    "reopen",
    "delete",
    "lock",
    "unlock",
    "transfer",
    "pin",
    "unpin",
  ],
  pr: [
    "create",
    "comment",
    "edit",
    "close",
    "reopen",
    "merge",
    "review",
    "ready",
    "update-branch",
    "lock",
    "unlock",
  ],
  release: ["create", "edit", "delete", "upload", "delete-asset"],
  repo: ["create", "delete", "edit", "fork", "rename", "archive", "unarchive"],
  gist: ["create", "delete", "edit", "rename"],
};
const dataLong = {
  gh: ["field", "raw-field", "input"],
  curl: [
    "data",
    "data-raw",
    "data-binary",
    "data-urlencode",
    "data-ascii",
    "json",
    "form",
    "form-string",
    "upload-file",
  ],
  wget: ["post-data", "post-file", "body-data", "body-file"],
};
const valueLong = {
  gh: ["header", "hostname", "jq", "template", "cache"],
  curl: [
    "header",
    "output",
    "dump-header",
    "write-out",
    "user",
    "user-agent",
    "referer",
    "max-time",
    "retry",
    "retry-delay",
    "retry-max-time",
    "connect-timeout",
    "cookie",
    "cookie-jar",
    "proxy",
  ],
  wget: [
    "header",
    "output-document",
    "output-file",
    "user",
    "password",
    "user-agent",
    "referer",
    "timeout",
    "tries",
  ],
};
const dataShort = { gh: "fF", curl: "dFT", wget: "" };
const valueShort = { gh: "Hqt", curl: "HowDuAebcxm", wget: "OoUt" };

function githubTarget(value) {
  if (!value) return false;
  const input = /^https?:/i.test(value) ? value : "https://" + value;
  const { url, valid } = canonicalUrl(input);
  return valid && ["github.com", "api.github.com"].includes(url?.hostname);
}

function mutationArguments(words, client, start) {
  let mutation = false,
    target = false;
  const method = (value) =>
    client === "gh"
      ? !!value && value.toUpperCase() !== "GET"
      : /^(?:POST|PATCH|PUT|DELETE)$/i.test(value ?? "");
  for (let i = start; i < words.length; i++) {
    const word = words[i];
    if (word === "--") {
      target ||= words.slice(i + 1).some(githubTarget);
      break;
    }
    if (word.startsWith("--")) {
      const [key, ...attached] = word.slice(2).split("=");
      const next = () => (attached.length ? attached.join("=") : words[++i]);
      if (key === (client === "curl" ? "request" : "method"))
        mutation = method(next()) || mutation;
      else if (dataLong[client].includes(key)) {
        mutation = true;
        next();
      } else if (key === "url" && client === "curl") {
        target = githubTarget(next()) || target;
      } else if (valueLong[client].includes(key)) next();
    } else if (word.startsWith("-") && word.length > 1) {
      for (let j = 1; j < word.length; j++) {
        const flag = word[j];
        const next = () => word.slice(j + 1) || words[++i];
        if (flag === "X" && client !== "wget") {
          mutation = method(next()) || mutation;
          break;
        }
        if (dataShort[client].includes(flag)) {
          mutation = true;
          next();
          break;
        }
        if (valueShort[client].includes(flag)) {
          next();
          break;
        }
      }
    } else target ||= githubTarget(word);
  }
  return mutation && (client === "gh" || target);
}

export function shellGitHubWrite(tokens) {
  if (!tokens?.length) return false;
  const words = tokens
    .filter((token) => !token.control)
    .map((token) => token.value);
  let i = 0;
  for (;;) {
    if (/^[A-Za-z_]\w*=/.test(words[i] ?? "")) {
      i++;
      continue;
    }
    const prefix = posix.basename(words[i] ?? "");
    if (prefix === "command") {
      i++;
    } else if (prefix === "env") {
      i++;
      while (["-i", "--ignore-environment", "--"].includes(words[i])) i++;
    } else break;
  }
  const client = posix.basename(words[i] ?? "");
  const args = words.slice(i + 1);
  if (client === "gh") {
    if (["--help", "-h"].some((flag) => args.includes(flag))) return false;
    if (["-R", "--repo"].includes(args[0])) args.splice(0, 2);
    else if (args[0]?.startsWith("--repo=")) args.shift();
    if (args[0] === "api") return mutationArguments(args, client, 1);
    return ghWrites[args[0]]?.includes(args[1]) ?? false;
  }
  if (!["curl", "wget"].includes(client) || args.includes("--help"))
    return false;
  return mutationArguments(words, client, i + 1);
}
