import { expect, it } from "vitest";
import { outcome, compare, summary } from "./results.mjs";
it("pins positive-to-refusal, every R-code and page growth without exemptions", () => {
  const success = outcome({
      ok: true,
      value: { sheets: [{ number: 1, svg: "<svg/>" }] },
    }),
    refused = outcome({
      ok: false,
      error: { code: "R006", reason: "unprintable-layout" },
    }),
    growth = outcome({
      ok: true,
      value: {
        sheets: [
          { number: 1, svg: "<svg/>" },
          { number: 2, svg: "<svg/>" },
        ],
      },
    });
  expect(compare(success, refused)).toEqual({
    positiveToRefusal: true,
    pageGrowth: false,
    identical: false,
  });
  expect(compare(success, growth)).toEqual({
    positiveToRefusal: false,
    pageGrowth: true,
    identical: false,
  });
  expect(compare(refused, success)).toEqual({
    positiveToRefusal: false,
    pageGrowth: true,
    identical: false,
  });
  expect(() => outcome({ ok: false, error: { code: "E001" } })).toThrow(
    "Every render refusal needs an R-code",
  );
  const report = summary(
    [
      {
        id: "one",
        before: success,
        after: refused,
        ...compare(success, refused),
      },
    ],
    2,
  );
  expect(report.complete).toBe(false);
  expect(report.positiveToRefusal).toEqual(["one"]);
  expect(report.refusals).toEqual([
    {
      id: "one",
      side: "after",
      code: "R006",
      error: { code: "R006", reason: "unprintable-layout" },
    },
  ]);
});
