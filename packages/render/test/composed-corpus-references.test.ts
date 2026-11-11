import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileProject } from "@thermite/compiler";
import { renderSchematicPacket } from "../src/sheets.js";
import { scopedReferenceOracle } from "./helpers/local-reference-oracle.js";
import { cases, prepare } from "../../../evals/draw/corpus.mjs";
import { command } from "../../../evals/draw/support.mjs";

const corpus = cases();
const compiled = new Map<string, ReturnType<typeof compileProject>>();
const composed = new Set<string>();
const refusals = new Set([
  "sweep-report-filtering-letter-portrait-standard-left-to-right",
  "sweep-report-filtering-letter-portrait-standard-top-to-bottom",
  "sweep-report-filtering-letter-portrait-compact-left-to-right",
  "sweep-report-filtering-letter-portrait-compact-top-to-bottom",
]);
let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(
    join(await realpath(tmpdir()), "thermite-composed-corpus-"),
  );
});
afterAll(async () => {
  try {
    for (const id of [
      "machine-demo-top-to-bottom",
      "conveyor-line-top-to-bottom",
      "motor-starter-top-to-bottom",
    ])
      expect(composed.has(id), `No composed sheets inspected for ${id}`).toBe(
        true,
      );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
it.each(corpus)(
  "keeps every composed local resource scoped in $id",
  async (spec) => {
    const fixture = await prepare(
      spec,
      process.cwd(),
      join(scratch, spec.id),
      (args: string[]) =>
        command(process.cwd(), "bun", ["thermite.mjs", ...args]),
    );
    let project = compiled.get(fixture.project);
    if (!project) {
      project = compileProject(fixture.project);
      compiled.set(fixture.project, project);
    }
    const c = await project;
    if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
    const packet = await renderSchematicPacket(
      c.ir,
      fixture.request,
      c.presentation,
    );
    if (!packet.ok) {
      expect(refusals.has(spec.id), JSON.stringify(packet.error)).toBe(true);
      expect(packet.error.code).toBe("R006");
      return;
    }
    expect(refusals.has(spec.id)).toBe(false);
    for (const sheet of packet.value.sheets) {
      const inspected = scopedReferenceOracle(sheet.svg);
      if (inspected.sections) {
        composed.add(spec.id);
        expect(
          inspected.references,
          `${spec.id} sheet ${sheet.number}: empty guard`,
        ).toBeGreaterThan(0);
      }
    }
  },
  30000,
);
