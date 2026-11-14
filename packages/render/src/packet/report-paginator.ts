/** Shared by allocation scoring and painted report emission. Keep absolute
 * coordinates: rounding at a page boundary must make the same decision. */
export function reportPaginator(
  top: number,
  height: number,
  headerHeight: number,
  noteLines: number,
) {
  const bottom = top + height - noteLines * 3.5 - 5;
  const start = top + 9 + headerHeight;
  let y = start,
    pages = 1;
  return {
    headerFits: headerHeight + 9 <= bottom - top,
    get pages() {
      return pages;
    },
    place(rowHeight: number) {
      if (rowHeight + headerHeight + 9 > bottom - top)
        return { kind: "overflow" as const, y };
      const newPage = y + rowHeight > bottom;
      if (newPage) {
        pages++;
        y = start;
      }
      const position = y;
      y += rowHeight;
      return {
        kind: newPage ? ("new-page" as const) : ("row" as const),
        y: position,
      };
    },
  };
}
