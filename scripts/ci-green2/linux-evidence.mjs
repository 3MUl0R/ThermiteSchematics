import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpus } from "node:os";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import {
  uncutFixture,
  uncutLabelVariant,
  uncutReferenceKey,
} from "../../packages/render/test/continuation-uncut-fixtures.ts";
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const hash = (x) => createHash("sha256").update(x).digest("hex");
const path = "packages/render/test/snapshots/continuation-uncut.json";
const original = readFileSync(path),
  packets = [];
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
try {
  execFileSync(
    process.execPath,
    ["scripts/update-continuation-uncut-goldens.mjs", "--write"],
    { stdio: "inherit" },
  );
  const updated = readFileSync(path),
    reference = JSON.parse(updated);
  writeFileSync(join(out, "continuation-uncut.json"), updated);
  for (const name of ["init-starter", "motor-starter"]) {
    const input = await uncutFixture(name),
      base = await renderSchematicPacket(
        input.ir,
        input.request,
        input.presentation,
      );
    assert(base.ok);
    const crossed = new Set(
      base.value.sheets.flatMap((s) =>
        s.continuations.map((l) =>
          l.provenance && "uid" in l.provenance ? l.provenance.uid : undefined,
        ),
      ),
    );
    for (const [index, label] of ["", "   ", "A\nB"].entries()) {
      const { ir } = uncutLabelVariant(input.ir, crossed, name, label),
        r = await renderSchematicPacket(ir, input.request, input.presentation);
      assert(r.ok);
      const sha256 = hash(JSON.stringify(r.value));
      assert.equal(sha256, reference[uncutReferenceKey(name)][index]);
      const file = `${name}-${index}.packet.json`;
      writeFileSync(join(out, file), JSON.stringify(r.value) + "\n");
      packets.push({
        name,
        index,
        label,
        file,
        sha256,
        sheets: r.value.sheets.length,
      });
    }
  }
  writeFileSync(
    join(out, "metadata.json"),
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        bun: process.versions.bun,
        cpu: cpus()[0].model,
        gitHead: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        prHead: process.env.CI_GREEN2_HEAD,
        updater: "bun scripts/update-continuation-uncut-goldens.mjs --write",
        snapshotSha256: hash(updated),
        originalSnapshotSha256: hash(original),
        packets,
        complete: true,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  // The first matrix must still check the committed snapshot, not a CI repair.
  writeFileSync(path, original);
  assert(readFileSync(path).equals(original));
}
