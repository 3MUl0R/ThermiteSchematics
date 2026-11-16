import { expect, it } from "vitest";
import { createTerminalIr } from "../../query/test/fixtures.js";
import { appendPinRows } from "../src/signal-loop/pin-rows.js";
import { measureText, wrapText } from "../src/text-metrics.js";

it("keeps the authored slash qualifier with its caption without adding height", () => {
  const ir = createTerminalIr([
    { uid: "caption-owner", designation: "PT1", terminalKeys: ["2"] },
  ]);
  const type = ir.deviceTypes[0];
  if (!type?.terminals[0]) throw Error("Missing fixture terminal");
  type.terminals[0].key = "2";
  type.terminals[0].description = "Loop return / I";
  const value = "2: Loop return / I";
  const width = measureText("2: Loop return /", 2.7).width + 0.01;
  const original = wrapText(value, width, 2.7);
  expect(original.at(-1)?.trim()).toBe("I");
  const caption: string[] = [];
  const rows = appendPinRows(caption, type, ["2"], "caption-owner", width);
  expect(caption.at(-1)?.trim()).toBe("return / I");
  expect(caption.join(" ").replace(/\s+/gu, " ")).toBe(value);
  expect(caption.length).toBeLessThanOrEqual(original.length);
  expect(caption.every((line) => measureText(line, 2.7).width <= width)).toBe(
    true,
  );
  expect([...rows]).toEqual([[0, '["caption-owner","2"]']]);
});
