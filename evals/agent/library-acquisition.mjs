// An explicit task permission, never a repository-wide source-read exemption.
export function allowedLibraryAcquisition(input, allowedPaths = []) {
  input = input
    .trim()
    .replace(
      /^(?:\/[\w/.-]+\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+(['"])([\s\S]*)\1$/,
      "$2",
    );
  if (!allowedPaths.length || /[;`|&\n]|\$\(/.test(input)) return false;
  if (!/^(?:gh\s+api\s+|curl\s+|https:\/\/)/i.test(input.trim())) return false;
  if (
    /(?:^|\s)(?:--method|--request|-X|--input|--field|-F|-f|--data|-d)(?:=|\s)|\bgraphql\b/.test(
      input,
    )
  )
    return false;
  const targets =
    input.match(/(?:https:\/\/[^\s'"<>]+|repos\/[^\s'"<>]+)/g) ?? [];
  if (!targets.length) return false;
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
