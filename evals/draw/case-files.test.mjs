import { expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveCaseFiles,
  CASE_FILES_FILENAME,
  readCheckpointCaseFiles,
} from "./case-files.mjs";
import { outputCost } from "./output.mjs";

it("archives exact case bytes, keeps media loose and counts the stored archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "draw-case-files-"));
  try {
    const id = "case-one",
      dir = join(root, id),
      packet = Buffer.from('\uFEFF{\r\n  "name": "λ"\r\n}\r\n'),
      svg = Buffer.from("<svg/>"),
      refusal = Buffer.from('{"error":{"code":"R006"}}\n');
    await mkdir(dir);
    await mkdir(join(root, "case-refused"));
    await writeFile(join(dir, "packet.json"), packet);
    await writeFile(join(dir, "sheet-001.svg"), svg);
    await writeFile(join(root, "case-refused", "cli.log"), refusal);
    const readLoose = await readCheckpointCaseFiles(root);
    expect(await readLoose(id, "packet.json")).toEqual(packet);

    await archiveCaseFiles(root);
    const archive = await readFile(join(root, CASE_FILES_FILENAME));
    const read = await readCheckpointCaseFiles(root);
    expect(await read(id, "packet.json")).toEqual(packet);
    expect(await read(id, "sheet-001.svg")).toEqual(svg);
    expect(await read("case-refused", "cli.log")).toEqual(refusal);
    await expect(read("case-refused", "packet.json")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(dir, "packet.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const cost = await outputCost(root);
    expect(cost.outputBytes).toBe(
      archive.length +
        svg.length +
        (await readFile(join(root, "cost.json"))).length,
    );

    archive[archive.length - 1] ^= 1;
    await writeFile(join(root, CASE_FILES_FILENAME), archive);
    await expect(readCheckpointCaseFiles(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
