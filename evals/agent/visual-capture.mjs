import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { chromium } from "playwright-core";
import { projectReader, reserveCaptureFiles } from "./capture-files.mjs";
import { sha256 } from "./snapshot.mjs";

const requestName = "visual-capture.request.json";
const evidenceName = "visual-capture.json";
const outputNames = ["01.png", "02.png", "03.png", "04.png"];
const origin = "https://thermite-capture.invalid";
const receiptBytes = (result) =>
  Buffer.from(JSON.stringify(result, null, 2) + "\n");

function htmlPath(source, name) {
  assert(
    typeof name === "string" && name.endsWith(".html"),
    "Expected project HTML",
  );
  return source.path(name);
}

export function captureInput(project, name) {
  const source = projectReader(project);
  try {
    return source.read(htmlPath(source, name));
  } finally {
    source.close();
  }
}

async function renderHtml(source, request) {
  assert(
    Array.isArray(request.html) &&
      request.html.length >= 1 &&
      request.html.length <= outputNames.length,
    "Request 1–4 HTML outputs",
  );
  const inputs = request.html.map((name) => htmlPath(source, name));
  const snapshots = new Map();
  const snapshot = (path) => {
    if (!snapshots.has(path)) snapshots.set(path, source.read(path));
    return snapshots.get(path);
  };
  for (const input of inputs) snapshot(input);

  // The runner's temporary workspace is writable by the agent. Keep Chromium's
  // profile, artifacts and process temp files outside that workspace.
  const scratch = mkdtempSync(
    join(realpathSync(homedir()), ".thermite-visual-"),
  );
  let context;
  try {
    context = await chromium.launchPersistentContext(join(scratch, "profile"), {
      executablePath:
        process.env.THERMITE_TEST_BROWSER || chromium.executablePath(),
      headless: true,
      artifactsDir: scratch,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        HOME: scratch,
        USERPROFILE: scratch,
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
      },
      acceptDownloads: false,
      offline: true,
      javaScriptEnabled: false,
      serviceWorkers: "block",
      viewport: { width: 1600, height: 1200 },
      deviceScaleFactor: 1,
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === "data:") return route.continue();
      let body;
      if (url.origin === origin) {
        try {
          const name = decodeURIComponent(url.pathname.slice(1));
          body = snapshot(htmlPath(source, name));
        } catch {}
      }
      if (body) return route.fulfill({ body, contentType: "text/html" });
      return route.abort();
    });
    const captures = [];
    for (const [index, input] of inputs.entries()) {
      const page = await context.newPage();
      const url =
        origin + "/" + input.split(sep).map(encodeURIComponent).join("/");
      try {
        await page.goto(url, { waitUntil: "load", timeout: 15000 });
        const png = await page.screenshot({ fullPage: true, timeout: 15000 });
        captures.push({
          png,
          file: {
            input: request.html[index],
            inputSha256: sha256(snapshot(input)),
            output: "visual-captures/" + outputNames[index],
            sha256: sha256(png),
            bytes: png.length,
          },
        });
      } finally {
        await page.close();
      }
    }
    return captures;
  } finally {
    try {
      await context?.close();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

function captureSession(project) {
  const root = realpathSync(project);
  const source = projectReader(root);
  let outputs;
  try {
    outputs = reserveCaptureFiles(join(root, "visual-captures"), [
      ...outputNames,
      "result.json",
    ]);
  } catch (error) {
    source.close();
    throw error;
  }
  return {
    request() {
      if (source.has(requestName))
        return source.read(requestName).toString("utf8");
    },
    async capture(request) {
      const captures = await renderHtml(source, request);
      // Unused slots are emptied so an older image never outlives its receipt.
      for (const [index, name] of outputNames.entries())
        outputs.write(name, captures[index]?.png ?? Buffer.alloc(0));
      return {
        format: "thermite-agent-visual-capture/1",
        files: captures.map(({ file }) => file),
      };
    },
    receipt(bytes) {
      outputs.write("result.json", bytes);
    },
    close() {
      outputs.close();
      source.close();
    },
  };
}

export async function captureHtml(project, request) {
  const session = captureSession(project);
  try {
    return await session.capture(request);
  } finally {
    session.close();
  }
}

export async function visualBroker(task, project, evidence) {
  if (!task.visualCapture) return async () => {};
  const session = captureSession(project);
  let evidenceOutput;
  try {
    evidenceOutput = reserveCaptureFiles(realpathSync(evidence), [
      evidenceName,
    ]);
  } catch (error) {
    session.close();
    throw error;
  }

  let previous, pending;
  const tick = async () => {
    try {
      const bytes = session.request();
      if (bytes === undefined || bytes === previous) return;
      previous = bytes;
      let result;
      try {
        result = await session.capture(JSON.parse(bytes));
      } catch (error) {
        result = { error: error.message };
      }
      const receipt = receiptBytes(result);
      session.receipt(receipt);
      evidenceOutput.write(evidenceName, receipt);
    } catch (error) {
      evidenceOutput.write(
        evidenceName,
        receiptBytes({ error: error.message }),
      );
    }
  };
  let failure;
  const timer = setInterval(() => {
    if (!pending && !failure)
      pending = tick()
        .catch((error) => {
          failure = error;
        })
        .finally(() => {
          pending = undefined;
        });
  }, 250);
  return async () => {
    clearInterval(timer);
    try {
      await pending;
      if (failure) throw failure;
    } finally {
      session.close();
      evidenceOutput.close();
    }
  };
}
