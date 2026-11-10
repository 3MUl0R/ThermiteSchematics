export const measure = (s: string, size = 2.5) =>
  [...s].reduce(
    (sum, c) =>
      sum +
      (/[ilI1 .,:;'|!]/u.test(c)
        ? 0.35
        : /[MW@%]/u.test(c)
          ? 1
          : (c.codePointAt(0) ?? 0) > 127
            ? 1.2
            : 0.64) *
        size,
    0,
  );
export function circuitTextLines(
  value: string,
  width: number,
  size = 2.5,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/u)) {
    if (line && measure(`${line} ${word}`, size) > width) {
      lines.push(line);
      line = "";
    }
    if (measure(word, size) > width) {
      for (const c of word) {
        if (measure(line + c, size) > width) {
          lines.push(line);
          line = "";
        }
        line += c;
      }
    } else line += (line ? " " : "") + word;
  }
  if (line) lines.push(line);
  return lines;
}
