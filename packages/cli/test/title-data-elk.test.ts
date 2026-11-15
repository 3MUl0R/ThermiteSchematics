import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { auditTitleDataSurface } from "./title-data-surface.js";
const path = "packages/render/src/layout/elk-runtime.ts";
const source = readFileSync(path, "utf8");
const audit = (text: string) =>
  auditTitleDataSurface(new Map([[path, text]]), true);
it("pins only the loader: current module and harmless outside edits pass", () => {
  expect(audit(source)).toEqual([]);
  expect(audit(source + "\nconst harmlessAuditControl = 1;\n")).toEqual([]);
  expect(audit(source.replaceAll("\n", "\r\n"))).toEqual([]);
});
it("rejects an edited loader even if the dynamic constructor disappears", () => {
  expect(
    audit(
      source.replace(
        "if (fauxWorker !== undefined) return fauxWorker;",
        "if (fauxWorker !== undefined) return fauxWorker;\n  void 1;",
      ),
    ),
  ).toEqual(
    expect.arrayContaining([expect.stringContaining("loader pin mismatch")]),
  );
  expect(audit(source.replace("new Function(", "SomeConstructor("))).toEqual(
    expect.arrayContaining([expect.stringContaining("loader pin mismatch")]),
  );
});
it.each([
  "const access = process.env.SECRET;",
  "const access = Bun.env.SECRET;",
  'readFileSync("/tmp/forbidden");',
  'import * as fs from "node:fs";',
  'import {platform} from "node:os"; platform();',
  'import {execFileSync} from "node:child_process"; execFileSync("git",["status"]);',
  'await fetch("https://example.invalid");',
  'await import("node:net");',
  'globalThis["fetch"]("https://example.invalid");',
])("statically rejects outside-loader access: %s", (text) => {
  expect(audit(source + "\n" + text)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("forbidden ELK capability"),
    ]),
  );
});
it("audits the closed loader bindings outside the pinned text", () => {
  expect(
    audit(
      source.replace('"elkjs/lib/elk-worker.min.js"', '"node:child_process"'),
    ),
  ).not.toEqual([]);
  expect(audit(source + "\nfauxWorker = undefined;")).not.toEqual([]);
});
