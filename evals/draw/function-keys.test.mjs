import { expect, it } from "vitest";
import { functionKeys } from "./checks.mjs";

const ir = {
  devices: [
    { uid: "ai", designation: "AI1" },
    { uid: "pt", designation: "PT1" },
  ],
  functions: [
    { id: { deviceUid: "ai", functionKey: "ch0" } },
    { id: { deviceUid: "pt", functionKey: "signal" } },
  ],
  terminals: [],
};
const findings = (text, data = ir) =>
  functionKeys({ texts: [{ element: "note", text }] }, data);

it.each(["AI1.ch0", "PT1.signal"])(
  "DQ-05 measures a qualified key embedded in an engine note: %s",
  (key) => {
    expect(findings(`polarity not verified: ${key}.`)).toMatchObject([
      { kind: "printed-function-key", key },
    ]);
  },
);

it("DQ-05 accepts terminal bindings and designation-only fallback", () => {
  for (const note of [
    "polarity not verified: AI1 terminals 9/13, PT1 terminals 1/2.",
    "polarity not verified: AI1, PT1.",
  ])
    expect(findings(note)).toEqual([]);
});

it("does not mistake longer identifiers or authored terminals for function keys", () => {
  expect(findings("polarity not verified: XAI1.ch0, AI1.ch01.")).toEqual([]);
  expect(
    findings("Landed on PT1.signal.", {
      ...ir,
      terminals: [{ id: { deviceUid: "pt", terminalKey: "signal" } }],
    }),
  ).toEqual([]);
});

it("matches qualified designations and keys literally", () => {
  const data = {
    ...ir,
    devices: [{ uid: "ai", designation: "AI(1)+" }],
    functions: [{ id: { deviceUid: "ai", functionKey: "ch[0]" } }],
  };
  expect(findings("polarity not verified: AI(1)+.ch[0].", data)).toHaveLength(
    1,
  );
  expect(findings("polarity not verified: AI1.ch0.", data)).toEqual([]);
});
