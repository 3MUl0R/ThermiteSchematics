// Temporary cross-platform evidence for CI-GREEN; never updates expectations.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderSchematicPacket } from "../dist/index.js";
import {
  uncutFixture,
  uncutLabelVariant,
} from "./continuation-uncut-fixtures.ts";

const output = process.argv[2] ?? "coverage/ci-layout";
await mkdir(output, { recursive: true });
const summary = {
  platform: process.platform,
  arch: process.arch,
  bun: Bun.version,
  packets: [],
};
for (const name of ["init-starter", "motor-starter"]) {
  const input = await uncutFixture(name);
  const base = await renderSchematicPacket(
    input.ir,
    input.request,
    input.presentation,
  );
  if (!base.ok) throw Error(JSON.stringify(base.error));
  const crossed = new Set(
    base.value.sheets.flatMap((sheet) =>
      sheet.continuations.map((line) =>
        line.provenance && "uid" in line.provenance
          ? line.provenance.uid
          : undefined,
      ),
    ),
  );
  for (const [index, label] of ["", "   ", "A\nB"].entries()) {
    const { ir } = uncutLabelVariant(input.ir, crossed, name, label);
    const result = await renderSchematicPacket(
      ir,
      input.request,
      input.presentation,
    );
    if (!result.ok) throw Error(JSON.stringify(result.error));
    const bytes = JSON.stringify(result.value);
    const file = `${name}-${index}.json`;
    await writeFile(join(output, file), bytes);
    summary.packets.push({
      name,
      index,
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}
await writeFile(
  join(output, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
