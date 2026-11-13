import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import {
  launch,
  displaySheet,
  measureSheet,
  drawingContextOptions,
} from "./browser.mjs";
import { conductorLengths } from "./conductor-lengths.mjs";
const { values } = parseArgs({
  options: {
    current: { type: "string" },
    reference: { type: "string" },
    output: { type: "string" },
  },
});
assert(
  values.current && values.reference && values.output,
  "Use --current <checkpoint> --reference <checkpoint> --output <json>",
);
const browser = await launch(),
  context = await browser.newContext(drawingContextOptions),
  page = await context.newPage();
const read = (p) => readFile(p, "utf8").then(JSON.parse);
const current = resolve(values.current),
  reference = resolve(values.reference),
  cases = [];
async function capture(directory, prior) {
  const packet = await read(join(directory, "packet.json")),
    ir = await read(join(directory, "ir.json")),
    gs = [];
  for (const s of packet.sheets) {
    await displaySheet(
      page,
      await readFile(
        join(directory, `sheet-${String(s.number).padStart(3, "0")}.svg`),
        "utf8",
      ),
    );
    gs.push(
      await page.evaluate(
        (source) => (0, eval)(`(${source})`)({ routesOnly: true }),
        measureSheet.toString(),
      ),
    );
  }
  return conductorLengths(packet, gs, ir, prior?.conductors);
}
try {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(join(current, entry.name, "packet.json"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const base = await capture(join(reference, entry.name)),
      target = await capture(join(current, entry.name), base);
    cases.push({ case: entry.name, reference: base, current: target });
    process.stdout.write(
      `${entry.name}: ${target.conductors.length} conductors\n`,
    );
  }
  await writeFile(
    values.output,
    JSON.stringify(
      { format: "thermite-route-comparison/1", reportOnly: true, cases },
      null,
      2,
    ) + "\n",
  );
} finally {
  await context.close();
  await browser.close();
}
