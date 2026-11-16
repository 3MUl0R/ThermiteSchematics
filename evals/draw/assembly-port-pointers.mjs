import { compact } from "./tranche4-source.mjs";
// A semicolon separates subjects; commas may list several targets of ONE subject.
function segments(note) {
  return note.text.split(/[;\n]/u).map((text) => ({
    ...note,
    text: text.replace(/^.*?\bother (?:ports|parts)\s*:\s*/iu, "").trim(),
  }));
}
function subjects(note, needs) {
  if (note.text.split(/->|→/u).length !== 2) return [];
  const prefix = compact(note.text.split(/->|→/u)[0].replace(/^Port\s+/iu, ""));
  return needs.filter((n) => {
    const qualified = [
      compact(n.owner + "." + n.key),
      compact(n.owner + ":" + n.key),
    ];
    return note.deviceUid === undefined
      ? qualified.includes(prefix)
      : n.uid === note.deviceUid &&
          [compact(n.key), ...qualified].includes(prefix);
  });
}
export const namedPortNeeds = (note, needs) => [
  ...new Set(segments(note).flatMap((s) => subjects(s, needs))),
];
export const portPointerText = (note, need) =>
  segments(note)
    .filter((s) => subjects(s, [need]).length)
    .map((s) => s.text)
    .join(";");
