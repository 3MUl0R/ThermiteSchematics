import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { sha256 } from "./snapshot.mjs";

export function captureInput(project, name) {
  assert(
    typeof name === "string" && name.endsWith(".html"),
    "Expected project HTML",
  );
  const root = realpathSync(project),
    path = realpathSync(resolve(root, name));
  const rel = relative(root, path);
  assert(
    rel && !rel.startsWith("..") && !isAbsolute(rel),
    "HTML must stay inside project",
  );
  return path;
}
function captureDirectory(project) {
  const directory = join(project, "visual-captures");
  mkdirSync(directory, { recursive: true });
  assert(
    !lstatSync(directory).isSymbolicLink(),
    "Capture directory must be ordinary",
  );
  for (const name of ["result.json", "01.png", "02.png", "03.png", "04.png"])
    if (existsSync(join(directory, name)))
      assert(
        !lstatSync(join(directory, name)).isSymbolicLink(),
        "Capture output must be ordinary",
      );
  return directory;
}
async function capturePage(context, project, input, name, index) {
  const inputSha256 = sha256(readFileSync(input));
  const page = await context.newPage();
  await page.goto(pathToFileURL(input).href, {
    waitUntil: "load",
    timeout: 15000,
  });
  const output = `visual-captures/${String(index + 1).padStart(2, "0")}.png`;
  captureDirectory(project);
  const png = await page.screenshot({
    path: join(project, output),
    fullPage: true,
    timeout: 15000,
  });
  assert.equal(
    sha256(readFileSync(input)),
    inputSha256,
    "HTML changed during capture; request again",
  );
  await page.close();
  return {
    input: name,
    inputSha256,
    output,
    sha256: sha256(png),
    bytes: png.length,
  };
}
export async function captureHtml(project, request) {
  assert(
    Array.isArray(request.html) &&
      request.html.length >= 1 &&
      request.html.length <= 4,
    "Request 1–4 HTML outputs",
  );
  const inputs = request.html.map((name) => captureInput(project, name));
  const directory = captureDirectory(project);
  const browser = await chromium.launch({
    executablePath:
      process.env.THERMITE_TEST_BROWSER || chromium.executablePath(),
    headless: true,
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
  });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1600, height: 1200 },
      deviceScaleFactor: 1,
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      try {
        if (
          url.protocol === "data:" ||
          (url.protocol === "file:" &&
            captureInput(project, relative(project, fileURLToPath(url))))
        )
          return await route.continue();
      } catch {}
      await route.abort();
    });
    const files = [];
    for (const [index, input] of inputs.entries()) {
      files.push(
        await capturePage(context, project, input, request.html[index], index),
      );
    }
    return { format: "thermite-agent-visual-capture/1", files };
  } finally {
    await browser.close();
  }
}
export async function visualBroker(task, project, evidence) {
  if (!task.visualCapture) return async () => {};
  const directory = join(project, "visual-captures");
  mkdirSync(directory, { recursive: true });
  let previous,
    pending = Promise.resolve();
  const tick = async () => {
    const path = join(project, "visual-capture.request.json");
    if (!existsSync(path)) return;
    assert(
      !lstatSync(path).isSymbolicLink(),
      "Capture request must be ordinary",
    );
    const bytes = readFileSync(path, "utf8");
    if (bytes === previous) return;
    previous = bytes;
    let result;
    try {
      result = await captureHtml(project, JSON.parse(bytes));
    } catch (error) {
      result = { error: error.message };
    }
    const text = JSON.stringify(result, null, 2) + "\n";
    captureDirectory(project);
    writeFileSync(join(directory, "result.json"), text);
    writeFileSync(join(evidence, "visual-capture.json"), text);
  };
  const timer = setInterval(() => {
    pending = pending.then(tick).catch((error) => {
      writeFileSync(
        join(evidence, "visual-capture.json"),
        JSON.stringify({ error: error.message }),
      );
    });
  }, 250);
  return async () => {
    clearInterval(timer);
    await pending;
  };
}
