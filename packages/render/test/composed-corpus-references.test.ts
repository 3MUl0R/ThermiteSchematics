import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileProject, lockProject } from "@thermite/compiler";
import { renderSchematicPacket } from "../src/sheets.js";
import { scopedReferenceOracle } from "./helpers/local-reference-oracle.js";
import {
  cases,
  prepareProject,
  prepareRequest,
} from "../../../evals/draw/corpus.mjs";

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
const root = process.cwd();

async function lockFixture([, project]: [string, string]) {
  const result = await lockProject(project);
  return {
    code: result.ok ? 0 : 1,
    stderr: JSON.stringify(result.diagnostics),
  };
}

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
for (const entry of corpus)
  it.each([entry])(
    "keeps every composed local resource scoped in $id",
    async (spec) => {
      // Flow, page and layout variants only alter the request. Compile and
      // lock one copy per project recipe, then render every request separately.
      const key = JSON.stringify([spec.project, spec.recipe]);
      let project = compiled.get(key);
      if (!project) {
        project = prepareProject(
          spec,
          root,
          join(scratch, spec.id),
          lockFixture,
        ).then((path: string) => compileProject(path));
        compiled.set(key, project);
      }
      const c = await project;
      if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
      const packet = await renderSchematicPacket(
        c.ir,
        await prepareRequest(spec, root),
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
    // Compact-frame cases still perform a complete ELK render. One took
    // 30.13 s on macOS CI, and the letter-landscape motor sweep took 22.36 s.
    entry.recipe === "compact-frame" ||
      (entry.sweep?.project === "motor-starter" &&
        entry.sweep.size === "letter" &&
        entry.sweep.orientation === "landscape")
      ? 60_000
      : 30_000,
  );
