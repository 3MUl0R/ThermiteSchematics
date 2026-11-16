import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpus, totalmem, loadavg, platform, arch } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const workloads = { "machine-demo": 12, "conveyor-line": 4 };
export const operations = ["compile", "packet"];
export function machineClass() {
  return {
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    bun: process.versions.bun,
  };
}
export function median(values) {
  assert(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function comparison(base, head) {
  assert(Number.isFinite(base) && base > 0, "Invalid base median");
  assert(Number.isFinite(head) && head > 0, "Invalid head median");
  const ratio = head / base;
  return { baseMedianMs: base, headMedianMs: head, ratio, pass: ratio <= 1.2 };
}
export function startWorker(engine) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("worker.mjs", import.meta.url)), engine],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let pending,
    stderr = "",
    failure;
  const reject = (error) => {
    failure = error;
    pending?.reject(error);
    pending = undefined;
  };
  child.on("error", reject);
  child.stdin.on("error", reject);
  child.on("exit", (code, signal) =>
    reject(new Error(`Perf worker exited ${signal ?? code}: ${stderr}`)),
  );
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-8000);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const value = JSON.parse(line);
      if (value.error) throw new Error(value.error);
      assert(pending, "Unsolicited perf worker output");
      const recipient = pending;
      pending = undefined;
      recipient.resolve(value);
    } catch (error) {
      reject(error);
    }
  });
  async function receive(request) {
    if (failure) throw failure;
    assert(!pending, "Concurrent requests to one perf worker");
    let timeout;
    try {
      return await new Promise((resolve, reject) => {
        pending = { resolve, reject };
        timeout = setTimeout(
          () => reject(new Error("Perf worker timeout")),
          120000,
        );
        if (request) child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  const ready = receive();
  return {
    sample: async (request) => {
      assert((await ready).ready);
      return receive(request);
    },
    close: () => child.kill(),
  };
}
export async function measurePair(base, head, samples = 5) {
  assert(Number.isInteger(samples) && samples >= 3 && samples <= 100);
  const rows = [];
  for (const [name, views] of Object.entries(workloads)) {
    for (const operation of operations) {
      const observations = { base: [], head: [] };
      // Separate compile/packet loops, one warmup per operation and engine.
      // AB then BA cancels steady drift without concurrent benchmark work.
      for (let round = 0; round <= samples; round++) {
        for (const side of round % 2 ? ["head", "base"] : ["base", "head"]) {
          const loadBefore = loadavg();
          const result = await (side === "base" ? base : head).sample({
            name,
            operation,
          });
          assert(Number.isFinite(result.ms) && result.ms > 0);
          assert.equal(result.views, views);
          observations[side].push({
            ...result,
            warmup: round === 0,
            loadBefore,
            loadAfter: loadavg(),
          });
        }
      }
      for (const side of ["base", "head"]) {
        assert.equal(
          new Set(observations[side].map((r) => r.sha256)).size,
          1,
          `${name}/${operation}/${side}: nondeterministic output`,
        );
        assert.equal(
          new Set(observations[side].map((r) => r.inputSha256)).size,
          1,
        );
      }
      assert.equal(
        observations.base[0].inputSha256,
        observations.head[0].inputSha256,
        `${name}: workload changed; review the baseline explicitly`,
      );
      rows.push({
        name,
        views,
        operation,
        ...comparison(
          median(observations.base.slice(1).map((r) => r.ms)),
          median(observations.head.slice(1).map((r) => r.ms)),
        ),
        observations,
      });
    }
  }
  return { samples, warmup: 1, rows, pass: rows.every((r) => r.pass) };
}
