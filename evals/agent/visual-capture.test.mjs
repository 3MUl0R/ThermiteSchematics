import { afterEach, expect, it, vi } from "vitest";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { chromium } from "playwright-core";
import { captureHtml, captureInput, visualBroker } from "./visual-capture.mjs";
import { sha256 } from "./snapshot.mjs";

// Race hooks run between the broker's pathname checks and its reads or
// writes. Wrapping node:fs and Playwright's screenshot puts them at the same
// point in any implementation, including the pre-fix broker.
// - A write race swaps `path` once, just before the first write to it.
// - A read race acts like an agent toggling a link: every realpath check of
//   `path` sees the project entry, and the link is back right after it.
const race = vi.hoisted(() => {
  const state = {
    pending: null,
    swapped: false,
    fired: 0,
    swapError: null,
    fds: new Map(),
  };
  const matches = (op, path) =>
    state.pending?.op === op && state.pending.path === path;
  return {
    state,
    arm(op, path, swap, restore) {
      Object.assign(state, {
        pending: { op, path, swap, restore },
        swapped: false,
        fired: 0,
        swapError: null,
      });
    },
    beforeCheck(path) {
      if (!matches("read", path) || !state.swapped) return;
      state.pending.restore();
      state.swapped = false;
    },
    afterCheck(path) {
      if (!matches("read", path)) return;
      state.pending.swap();
      state.swapped = true;
      state.fired++;
    },
    beforeWrite(path) {
      if (!matches("write", path)) return;
      const { swap } = state.pending;
      state.pending = null;
      state.fired++;
      try {
        swap();
      } catch (error) {
        // Windows refuses to rename a directory holding open files.
        state.swapError = error;
      }
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal();
  const realpathSync = Object.assign(
    (path, ...rest) => {
      race.beforeCheck(String(path));
      const result = fs.realpathSync(path, ...rest);
      race.afterCheck(String(path));
      return result;
    },
    { native: fs.realpathSync.native },
  );
  const hooked = {
    realpathSync,
    openSync(path, ...rest) {
      const fd = fs.openSync(path, ...rest);
      race.state.fds.set(fd, String(path));
      return fd;
    },
    closeSync(fd) {
      race.state.fds.delete(fd);
      return fs.closeSync(fd);
    },
    ftruncateSync(fd, ...rest) {
      race.beforeWrite(race.state.fds.get(fd));
      return fs.ftruncateSync(fd, ...rest);
    },
    writeFileSync(path, ...rest) {
      race.beforeWrite(
        typeof path === "number" ? race.state.fds.get(path) : String(path),
      );
      return fs.writeFileSync(path, ...rest);
    },
  };
  return { ...fs, ...hooked, default: { ...fs.default, ...hooked } };
});

const work = [];
afterEach(() => {
  race.state.pending = null;
  vi.restoreAllMocks();
  for (const root of work.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const red = "<!doctype html><body style='margin:0;background:#ff0000'>";
const blue = "<!doctype html><body style='margin:0;background:#0000ff'>";

function fixture(html = "<p>Capture fixture</p>") {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "thermite-visual-test-")),
  );
  work.push(root);
  const project = join(root, "project");
  const evidence = join(root, "evidence");
  const outside = join(root, "outside");
  mkdirSync(project);
  mkdirSync(evidence);
  mkdirSync(outside);
  writeFileSync(join(project, "index.html"), html);
  writeFileSync(join(outside, "sentinel"), "untouched");
  // A harness-readable page the agent must not be able to capture.
  writeFileSync(join(outside, "index.html"), blue);
  writeFileSync(join(outside, "page.html"), blue);
  return {
    project,
    evidence,
    outside,
    outputs: join(project, "visual-captures"),
    sentinel: join(outside, "sentinel"),
  };
}

const link = (target, path) =>
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
// Replace `path` with a link to `target`, keeping the project entry aside.
function toggle(path, target, linkTo = link) {
  const aside = path + ".aside";
  return [
    () => {
      renameSync(path, aside);
      linkTo(target, path);
    },
    () => {
      unlinkSync(path);
      renameSync(aside, path);
    },
  ];
}

// Real Chromium; only screenshot({ path }) is wrapped so a write that
// Playwright performs by pathname gets the same race hook.
function hookScreenshots() {
  const wrapContext = (context) => {
    const newPage = context.newPage.bind(context);
    context.newPage = async (...args) => {
      const page = await newPage(...args);
      const screenshot = page.screenshot.bind(page);
      page.screenshot = async (options = {}) => {
        if (options.path) race.beforeWrite(options.path);
        return screenshot(options);
      };
      return page;
    };
    return context;
  };
  const persistent = chromium.launchPersistentContext.bind(chromium);
  vi.spyOn(chromium, "launchPersistentContext").mockImplementation(
    async (...args) => wrapContext(await persistent(...args)),
  );
  const launch = chromium.launch.bind(chromium);
  vi.spyOn(chromium, "launch").mockImplementation(async (...args) => {
    const browser = await launch(...args);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...rest) =>
      wrapContext(await newContext(...rest));
    return browser;
  });
}

function stubScreenshot(duringScreenshot = () => {}) {
  const screenshot = vi.fn(async () => {
    duringScreenshot();
    return Buffer.from("synthetic PNG bytes");
  });
  const context = {
    route: async () => {},
    newPage: async () => ({
      goto: async () => {},
      screenshot,
      close: async () => {},
    }),
    close: async () => {},
  };
  vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
  vi.spyOn(chromium, "launch").mockResolvedValue({
    newContext: async () => context,
    close: async () => {},
  });
  return screenshot;
}

const outsideEntries = (outside) => readdirSync(outside).sort();
// Windows needs privileges for file symlinks; a hard link redirects a
// pathname write or read just as well there.
const fileLink =
  process.platform === "win32"
    ? linkSync
    : (target, path) => symlinkSync(target, path, "file");
// Move the output aside (it may not exist yet for the pre-fix broker) and
// link its name to `target`. Windows allows renaming a file held open.
const replaceWithLink = (target, path) => {
  if (existsSync(path)) renameSync(path, path + ".aside");
  fileLink(target, path);
};

it.each([
  [
    "output directory",
    ({ project, outputs, outside }) => {
      renameSync(outputs, join(project, "moved-captures"));
      link(outside, outputs);
    },
  ],
  [
    "PNG",
    ({ outputs, sentinel }) =>
      replaceWithLink(sentinel, join(outputs, "01.png")),
  ],
])(
  "a %s swapped for a symlink between check and write receives nothing",
  async (_, swap) => {
    const paths = fixture(red);
    hookScreenshots();
    race.arm("write", join(paths.outputs, "01.png"), () => swap(paths));
    const error = await captureHtml(paths.project, {
      html: ["index.html"],
    }).catch((e) => e);
    expect(race.state.fired).toBe(1);
    expect(outsideEntries(paths.outside)).toEqual([
      "index.html",
      "page.html",
      "sentinel",
    ]);
    expect(readFileSync(paths.sentinel, "utf8")).toBe("untouched");
    if (race.state.swapError) {
      // The broker's open output files already block a directory rename.
      expect(process.platform).toBe("win32");
      return;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^Capture (directory|output)/);
  },
);

function readReceipt(path) {
  return vi.waitFor(() => JSON.parse(readFileSync(path, "utf8")), {
    timeout: 15000,
  });
}

it("a project receipt swapped for a symlink between check and write receives nothing", async () => {
  const { project, evidence, outputs, sentinel } = fixture(red);
  hookScreenshots();
  const receipt = join(outputs, "result.json");
  const stop = await visualBroker({ visualCapture: true }, project, evidence);
  try {
    race.arm("write", receipt, () => replaceWithLink(sentinel, receipt));
    writeFileSync(
      join(project, "visual-capture.request.json"),
      '{"html":["index.html"]}',
    );
    const recorded = await readReceipt(join(evidence, "visual-capture.json"));
    expect(race.state.fired).toBe(1);
    expect(race.state.swapError).toBeNull();
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(recorded).toEqual({ error: "Capture output changed" });
  } finally {
    await stop();
  }
});

async function color(png, x) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return Array.from(ctx.getImageData(x, 5, 1, 1).data);
}

// Colours at x of every non-empty PNG the broker left in the project.
async function capturedColors(outputs, x) {
  const colors = [];
  for (const name of existsSync(outputs) ? readdirSync(outputs) : [])
    if (name.endsWith(".png")) {
      const png = readFileSync(join(outputs, name));
      if (png.length) colors.push(await color(png, x));
    }
  return colors;
}
const outsideBlue = [0, 0, 255, 255];

it.each([
  ["HTML input", "index.html", "index.html", fileLink],
  ["input ancestor directory", "drawings/page.html", "drawings", link],
])(
  "an %s swapped for a symlink between check and read is never read",
  async (_, input, entry, linkTo) => {
    const paths = fixture(red);
    mkdirSync(join(paths.project, "drawings"));
    writeFileSync(join(paths.project, "drawings/page.html"), red);
    hookScreenshots();
    const target =
      entry === "drawings" ? paths.outside : join(paths.outside, entry);
    race.arm(
      "read",
      join(paths.project, input),
      ...toggle(join(paths.project, entry), target, linkTo),
    );
    const result = await captureHtml(paths.project, { html: [input] }).catch(
      (e) => e,
    );
    expect(race.state.fired).toBeGreaterThan(0);
    expect(await capturedColors(paths.outputs, 5)).not.toContainEqual(
      outsideBlue,
    );
    expect(JSON.stringify(result.files ?? [])).not.toContain(sha256(blue));
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(
      "Capture input must be an ordinary file inside project",
    );
  },
);

it("a local HTML subresource swapped for a symlink between check and read is never read", async () => {
  const html = `<!doctype html><style>
    body{margin:0;background:#ff0000}
    iframe{position:absolute;top:0;left:20px;width:12px;height:12px;border:0}
  </style><iframe src="frame.html"></iframe>`;
  const paths = fixture(html);
  const frame = join(paths.project, "frame.html");
  writeFileSync(frame, '<body style="margin:0;background:#00ff00">');
  hookScreenshots();
  race.arm(
    "read",
    frame,
    ...toggle(frame, join(paths.outside, "page.html"), fileLink),
  );
  const result = await captureHtml(paths.project, {
    html: ["index.html"],
  }).catch((e) => e);
  expect(race.state.fired).toBeGreaterThan(0);
  expect(await capturedColors(paths.outputs, 25)).not.toContainEqual(
    outsideBlue,
  );
  expect(result).not.toBeInstanceOf(Error);
  expect(await color(readFileSync(join(paths.outputs, "01.png")), 5)).toEqual([
    255, 0, 0, 255,
  ]);
});

it("refreshes the reserved outputs, empties unused slots and writes the receipt last", async () => {
  const { project, evidence, outputs } = fixture();
  const screenshot = stubScreenshot();
  for (const bytes of ["first page", "first second page", "second"])
    screenshot.mockResolvedValueOnce(Buffer.from(bytes));
  const stop = await visualBroker({ visualCapture: true }, project, evidence);
  try {
    const slots = ["01.png", "02.png", "03.png", "04.png"];
    expect(readdirSync(outputs).sort()).toEqual([...slots, "result.json"]);
    for (const name of [...slots, "result.json"])
      expect(readFileSync(join(outputs, name), "utf8")).toBe("");
    const request = join(project, "visual-capture.request.json");
    const receipt = join(outputs, "result.json");
    for (const [nonce, expected] of [
      ["first page", "first second page"],
      ["second"],
    ].entries()) {
      writeFileSync(
        request,
        JSON.stringify({ html: expected.map(() => "index.html"), nonce }),
      );
      await vi.waitFor(
        () => {
          const result = JSON.parse(readFileSync(receipt, "utf8"));
          expect(result.files.map((file) => file.sha256)).toEqual(
            expected.map(sha256),
          );
          for (const [index, name] of slots.entries())
            expect(readFileSync(join(outputs, name), "utf8")).toBe(
              expected[index] ?? "",
            );
          expect(
            JSON.parse(
              readFileSync(join(evidence, "visual-capture.json"), "utf8"),
            ),
          ).toEqual(result);
        },
        { timeout: 5000 },
      );
    }
  } finally {
    await stop();
  }
});

it("refuses existing output slots and nonexclusive input files", async () => {
  const { project, outputs, sentinel } = fixture();
  mkdirSync(outputs);
  writeFileSync(join(outputs, "01.png"), "existing");
  await expect(captureHtml(project, { html: ["index.html"] })).rejects.toThrow(
    "Capture output already exists",
  );
  linkSync(sentinel, join(project, "alias.html"));
  expect(() => captureInput(project, "alias.html")).toThrow("ordinary file");
  expect(readFileSync(join(outputs, "01.png"), "utf8")).toBe("existing");
  expect(readFileSync(sentinel, "utf8")).toBe("untouched");
});

it("renders the hashed HTML snapshot, local HTML and data URLs with CSS files blocked", async () => {
  const data =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="#ffff00"/></svg>',
    );
  const html = `<!doctype html><style>
    body{background:#ff0000}
    iframe,img{position:absolute;top:0;width:12px;height:12px;border:0}
    iframe{left:20px} img{left:40px}
  </style><link rel="stylesheet" href="outside.css">
  <iframe src="frame.html"></iframe><img src="${data}">`;
  const { project } = fixture(html);
  writeFileSync(
    join(project, "frame.html"),
    '<body style="background:#00ff00">',
  );
  writeFileSync(
    join(project, "outside.css"),
    "body{background:blue !important}",
  );
  for (const method of ["launchPersistentContext", "launch"]) {
    const launch = chromium[method].bind(chromium);
    vi.spyOn(chromium, method).mockImplementationOnce((...args) => {
      writeFileSync(join(project, "index.html"), "<p>New HTML</p>");
      return launch(...args);
    });
  }
  const {
    files: [capture],
  } = await captureHtml(project, { html: ["index.html"] });
  expect(capture.inputSha256).toBe(sha256(html));
  const png = readFileSync(join(project, capture.output));
  expect(capture.sha256).toBe(sha256(png));
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const pixel = (x) => Array.from(ctx.getImageData(x, 5, 1, 1).data);
  expect(pixel(5)).toEqual([255, 0, 0, 255]);
  expect(pixel(25)).toEqual([0, 255, 0, 255]);
  expect(pixel(45)).toEqual([255, 255, 0, 255]);
});
