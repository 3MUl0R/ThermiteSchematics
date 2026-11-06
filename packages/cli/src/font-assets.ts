/** Resolve the existing render package export in checkouts and staged runtimes. */
const renderFonts = new URL(
  "../assets/fonts/",
  import.meta.resolve("@thermite/render"),
);
export function bundledFontUrl(name: string): URL {
  return name === "NotoSansMono-Regular"
    ? new URL(`../assets/fonts/${name}.ttf`, import.meta.url)
    : new URL(`${name}.ttf`, renderFonts);
}
