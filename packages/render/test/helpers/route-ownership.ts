/** Preserve reviewed drawing-byte hashes across additive route ownership exports. */
export function withoutRouteOwnershipMetadata(svg: string): string {
  return svg.replace(
    / data-(?:layout-(?:source-port|target-port|port)|terminal-ends|loop-terminal)="[^"]*"/gu,
    "",
  );
}

/** Preserve reviewed drawing-byte hashes across additive terminal-caption ownership exports (#565). */
export function withoutTerminalCaptionOwnership(svg: string): string {
  return svg.replace(/<text\b[^>]*>/gu, (tag) => {
    if (!tag.includes(' data-terminal-caption-body="')) return tag;
    return tag
      .replace(/ data-terminal-key="[^"]*"/gu, "")
      .replace(/ data-terminal-caption-body="[^"]*"/gu, "")
      .replace(/ data-outside-connections="[^"]*"/gu, "");
  });
}
