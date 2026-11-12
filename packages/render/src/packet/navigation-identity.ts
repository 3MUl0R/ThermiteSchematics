import { createHash } from "node:crypto";
import type { ElectricalIr } from "@thermite/compiler";
export const navigationHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** UID-resolve selections; presentation wording and layout are deliberately absent. */
export function navigationViewKey(
  ir: Readonly<ElectricalIr>,
  selection: unknown,
  duplicateOrdinal: number,
): string {
  const clean = (v: unknown, field = ""): unknown => {
    if (typeof v === "string" && ["device", "devices"].includes(field))
      return (
        ir.devices.find((d) => d.uid === v || d.designation === v)?.uid ?? v
      );
    if (Array.isArray(v)) return v.map((value) => clean(value, field));
    if (!v || typeof v !== "object") return v;
    if ("by" in v && "value" in v) {
      const selector = v as { by: unknown; value: unknown };
      return { by: "uid", value: clean(selector.value, "device") };
    }
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([k]) =>
            ![
              "title",
              "notes",
              "description",
              "designation",
              "typeId",
              "layout",
              "page",
              "spacingProfile",
              "columns",
              "label",
            ].includes(k),
        )
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, value]) => [k, clean(value, k)]),
    );
  };
  return `view/1/${navigationHash([clean(selection), duplicateOrdinal])}`;
}
