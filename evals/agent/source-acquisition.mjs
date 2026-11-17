import { acquisitionParts } from "./acquisition-command.mjs";
import { allowedLibraryAcquisition } from "./library-acquisition.mjs";
import { approvedIssueLookup } from "./issue-lookup.mjs";
// Remove only the approved request URL. Every other token still gets V8 scanning.
export function scopeAcquisition(input, allowedPaths) {
  const request = acquisitionParts(input);
  if (!request) return { input };
  const target = request.url.startsWith("repos/")
    ? "https://api.github.com/" + request.url
    : request.url;
  const library = allowedLibraryAcquisition(target, allowedPaths);
  const issue = approvedIssueLookup(target);
  return library || issue
    ? { input: input.replace(request.url, ""), library, issue }
    : { input };
}
