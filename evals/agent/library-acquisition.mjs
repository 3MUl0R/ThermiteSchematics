import { acquisitionRequest } from "./acquisition-command.mjs";
// An explicit task permission, never a repository-wide source-read exemption.
export function allowedLibraryAcquisition(input, allowedPaths = []) {
  if (!allowedPaths.length) return false;
  const request = acquisitionRequest(input);
  if (!request) return false;
  const targets = [request.url];
  return targets.every((target) => {
    let path;
    try {
      const url = new URL(
        target.startsWith("repos/")
          ? `https://api.github.com/${target}`
          : target,
      );
      if (url.username || url.password || url.hash) return false;
      const patterns = {
        "github.com":
          /^\/(?:BlackettApplied|3MUl0R)\/ThermiteSchematics\/(?:blob|tree)\/[^/]+\/(.+)$/i,
        "api.github.com":
          /^\/repos\/(?:BlackettApplied|3MUl0R)\/ThermiteSchematics\/contents\/(.+)$/i,
        "raw.githubusercontent.com":
          /^\/(?:BlackettApplied|3MUl0R)\/ThermiteSchematics\/[^/]+\/(.+)$/i,
      };
      const match = patterns[url.hostname]?.exec(url.pathname);
      if (!match) return false;
      path = decodeURIComponent(match[1]);
      if (
        /[\\%]/.test(path) ||
        path.split("/").some((p) => p === "." || p === "..")
      )
        return false;
    } catch {
      return false;
    }
    return allowedPaths.some(
      (prefix) => path === prefix || path.startsWith(prefix + "/"),
    );
  });
}
