import type { PaperPage } from "./types.js";

// No public export or input switch. Only the internal benchmark entry can attach
// a compact profile to a normalized page. Page identity survives draft cloning.
const compactPages = new WeakSet<PaperPage>();
export function useCompactFrame(page: PaperPage): void {
  compactPages.add(page);
}
export const hasCompactFrame = (page: PaperPage): boolean =>
  compactPages.has(page);
