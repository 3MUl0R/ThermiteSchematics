import { identifyZones } from "./zones.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { imageCanvas } = await import(
  pathToFileURL(process.cwd() + "/evals/draw/pdf.mjs")
);
const S = 300 / 25.4;
export async function extendedInk(
  page,
  svg,
  { artifactDir, tag = "sheet", onlyBottom = false } = {},
) {
  await page.setContent(
    "<style>body{margin:0}</style>" + svg.replace(/<\?xml[^>]*>/, ""),
  );
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(identifyZones);
  const p = await page.evaluate(() => {
    const root = document.querySelector("body>svg"),
      rr = root.getBoundingClientRect(),
      W = root.viewBox.baseVal.width,
      H = root.viewBox.baseVal.height,
      k = W / rr.width;
    const all = [
      ...root.querySelectorAll(
        "text,path,line,rect,circle,ellipse,polygon,polyline,use,image",
      ),
    ];
    all.forEach((e, i) => e.setAttribute("data-ext-id", i));
    const box = (e) => {
        const b = e.getBoundingClientRect();
        return {
          x: (b.x - rr.x) * k,
          y: (b.y - rr.y) * k,
          w: b.width * k,
          h: b.height * k,
        };
      },
      inter = (a, b) => {
        const x = Math.max(a.x, b.x),
          y = Math.max(a.y, b.y),
          r = Math.min(a.x + a.w, b.x + b.w),
          d = Math.min(a.y + a.h, b.y + b.h);
        return r > x && d > y ? { x, y, w: r - x, h: d - y } : null;
      };
    const border = [...root.children].find(
        (e) => e.tagName === "rect" && e.getAttribute("fill") === "none",
      ),
      m = box(border).x,
      T = Math.max(
        ...[...root.children]
          .filter((e) => e.tagName === "path")
          .map(box)
          .filter((b) => b.h < 0.02 && b.w > box(border).w * 0.8)
          .map((b) => b.y),
      );
    function visible(e, stroke = false) {
      if (e.closest("defs,clipPath,mask,symbol,pattern")) return null;
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility !== "visible") return null;
      for (let a = e; a && a !== root.parentElement; a = a.parentElement)
        if (
          +getComputedStyle(a).opacity === 0 ||
          getComputedStyle(a).display === "none"
        )
          return null;
      let b = box(e);
      if (stroke && cs.stroke !== "none") {
        const a = e.getScreenCTM(),
          s =
            (parseFloat(cs.strokeWidth) *
              Math.max(Math.hypot(a.a, a.b), Math.hypot(a.c, a.d)) *
              k) /
            2;
        b = { x: b.x - s, y: b.y - s, w: b.w + 2 * s, h: b.h + 2 * s };
      }
      if (!b.w || !b.h) return null;
      for (let a = e.parentElement; a && a !== root; a = a.parentElement)
        if (a.tagName === "svg" && getComputedStyle(a).overflow !== "visible") {
          const parent = a.parentElement.getScreenCTM(),
            own = a.transform?.baseVal?.consolidate()?.matrix,
            ctm = own ? parent.multiply(own) : parent;
          const x = a.x.baseVal.value,
            y = a.y.baseVal.value,
            w = a.width.baseVal.value,
            h = a.height.baseVal.value,
            pts = [
              [x, y],
              [x + w, y],
              [x, y + h],
              [x + w, y + h],
            ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(ctm)),
            xs = pts.map((q) => (q.x - rr.x) * k),
            ys = pts.map((q) => (q.y - rr.y) * k);
          b = inter(b, {
            x: Math.min(...xs),
            y: Math.min(...ys),
            w: Math.max(...xs) - Math.min(...xs),
            h: Math.max(...ys) - Math.min(...ys),
          });
          if (!b) return null;
        }
      return b;
    }
    const id = (e) => +e.getAttribute("data-ext-id"),
      zoneEls = all.filter(
        (e) =>
          e.hasAttribute("data-oracle-zone-text") ||
          e.hasAttribute("data-oracle-zone-tick"),
      ),
      zoneSet = new Set(zoneEls),
      zones = zoneEls
        .map((e) => ({
          id: id(e),
          side:
            e.getAttribute("data-oracle-zone-text") ||
            e.getAttribute("data-oracle-zone-tick"),
          text: e.textContent || "tick",
          bbox: visible(e, e.tagName !== "text"),
        }))
        .filter((z) => z.bbox);
    const shapes = [];
    for (const e of all) {
      if (e.tagName === "text" || zoneSet.has(e) || e === border) continue;
      const cs = getComputedStyle(e),
        raw = box(e);
      if (
        e.parentElement === root &&
        (raw.w > W - 2 * m - 0.1 || raw.y >= T - 0.01)
      )
        continue;
      const b = visible(e, true);
      if (!b || b.y >= T || (cs.stroke === "none" && cs.fill === "none"))
        continue;
      const rgb = cs.fill.match(/[\d.]+/g)?.map(Number) ?? [],
        white = rgb.length >= 3 && rgb.slice(0, 3).every((v) => v >= 245);
      shapes.push({
        id: id(e),
        tag: e.tagName,
        bbox: b,
        preserveFill: white,
        wire:
          ["path", "line", "polyline"].includes(e.tagName) &&
          cs.stroke !== "none",
        stub: !!e.closest("a[data-continuation-id]"),
      });
    }
    const labels = [];
    for (const a of root.querySelectorAll("a[data-continuation-id]")) {
      const path = [...a.children].find((e) => e.tagName === "path"),
        nums = path
          ?.getAttribute("d")
          .match(/[-+]?(?:\d*\.)?\d+/g)
          ?.map(Number);
      if (!nums || nums.length !== 4) continue;
      const [x, y, X, Y] = nums,
        side =
          Math.abs(y - Y) < 0.001
            ? X > x
              ? "right"
              : "left"
            : Y > y
              ? "bottom"
              : "top";
      for (const e of a.querySelectorAll("text")) {
        const b = visible(e);
        if (b)
          labels.push({
            id: id(e),
            text: e.textContent,
            bbox: b,
            side,
            cut: { x, y },
            stubTip: { x: X, y: Y },
            bank:
              side +
              ":" +
              (side === "left" || side === "right" ? x : y).toFixed(3),
            anchorX: +e.getAttribute("x"),
            anchorY: +e.getAttribute("y"),
            cid: a.getAttribute("data-continuation-id"),
            end: a.getAttribute("data-continuation-end"),
          });
      }
    }
    const near = (a, b, g = 0.2) =>
      a.x < b.x + b.w + g &&
      b.x < a.x + a.w + g &&
      a.y < b.y + b.h + g &&
      b.y < a.y + a.h + g;
    const zoneShape = zones.flatMap((z) =>
        shapes.filter((s) => near(z.bbox, s.bbox)).map((s) => ({ a: z, b: s })),
      ),
      labelWire = labels.flatMap((t) =>
        shapes
          .filter((s) => s.wire && near(t.bbox, s.bbox))
          .map((s) => ({ a: t, b: s })),
      );
    const bottom = zones.filter(
        (z) => z.side === "bottom" && z.text !== "tick",
      ),
      ruleEls = [...root.children].filter(
        (e) =>
          e.tagName === "path" &&
          Math.abs(box(e).y - T) < 0.002 &&
          box(e).w > W - 2 * m - 0.1,
      );
    return {
      W,
      H,
      m,
      T,
      zones,
      shapes,
      labels,
      zoneShape,
      labelWire,
      bottom,
      ruleIds: ruleEls.map(id),
      styles: all.map((e) => ({ id: id(e), css: e.getAttribute("style") })),
    };
  });
  const restore = async () =>
    page.evaluate((styles) => {
      for (const s of styles) {
        const e = document.querySelector(`[data-ext-id="${s.id}"]`);
        if (s.css === null) e.removeAttribute("style");
        else e.setAttribute("style", s.css);
      }
    }, p.styles);
  async function hide(ids, shapeIds = [], hideRule = false) {
    await restore();
    await page.evaluate(
      ({ ids, shapes, ruleIds, hideRule }) => {
        for (const id of ids) {
          const e = document.querySelector(`[data-ext-id="${id}"]`);
          e.style.setProperty("opacity", "0", "important");
        }
        for (const s of shapes) {
          const e = document.querySelector(`[data-ext-id="${s.id}"]`);
          e.style.setProperty("stroke", "transparent", "important");
          if (!s.preserveFill)
            e.style.setProperty("fill", "transparent", "important");
        }
        if (hideRule)
          for (const id of ruleIds)
            document
              .querySelector(`[data-ext-id="${id}"]`)
              .style.setProperty("opacity", "0", "important");
      },
      {
        ids,
        shapes: shapeIds.map((id) => p.shapes.find((s) => s.id === id)),
        ruleIds: p.ruleIds,
        hideRule,
      },
    );
  }
  const crop = (b, g = 0.35) => {
    const x = Math.max(0, b.x - g),
      y = Math.max(0, b.y - g),
      r = Math.min(p.W, b.x + b.w + g),
      d = Math.min(p.H, b.y + b.h + g);
    return { x, y, w: r - x, h: d - y };
  };
  const shot = async (r) =>
    page.screenshot({
      clip: {
        x: (r.x * 96) / 25.4,
        y: (r.y * 96) / 25.4,
        width: (r.w * 96) / 25.4,
        height: (r.h * 96) / 25.4,
      },
    });
  async function pixels(r) {
    const c = await imageCanvas(await shot(r));
    return {
      w: c.width,
      h: c.height,
      d: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
      buf: c.toBuffer("image/png"),
    };
  }
  const mask = (a, b) => {
    if (a.w !== b.w || a.h !== b.h) throw Error("Raster phase changed");
    const m = new Uint8Array(a.w * a.h);
    for (let i = 0; i < m.length; i++) {
      const j = i * 4,
        d = a.d;
      if (
        (d[j] + d[j + 1] + d[j + 2]) / 3 < 245 &&
        Math.max(...[0, 1, 2].map((k) => Math.abs(d[j + k] - b.d[j + k]))) > 8
      )
        m[i] = 1;
    }
    return m;
  };
  async function pairHit(pair, kind) {
    const r = crop(pair.a.bbox);
    const a = pair.a.id,
      bs = pair.bs.map((s) => s.id);
    await hide([a]);
    const A = await pixels(r);
    await hide([a], bs);
    const B = await pixels(r);
    await hide([], bs);
    const C = await pixels(r),
      s = mask(A, B),
      t = mask(C, B);
    let n = 0;
    for (let i = 0; i < s.length; i++) n += s[i] && t[i] ? 1 : 0;
    if (!n) return null;
    const result = {
      kind,
      target: pair.a.text,
      shapes: pair.bs.map((s) => ({ tag: s.tag, stub: s.stub, id: s.id })),
      paintedOverlapPixels: n,
      cropMm: r,
      ...(pair.a.cid ? { cid: pair.a.cid, end: pair.a.end } : {}),
      side: pair.a.side,
    };
    if (artifactDir) {
      await restore();
      await mkdir(artifactDir, { recursive: true });
      const path = artifactDir + "/" + tag + "-" + kind + "-" + a + ".png";
      await writeFile(path, await shot(r));
      result.crop = path;
    }
    return result;
  }
  const grouped = (pairs) => {
    const m = new Map();
    for (const { a, b } of pairs) {
      if (!m.has(a.id)) m.set(a.id, { a, bs: [] });
      m.get(a.id).bs.push(b);
    }
    return [...m.values()];
  };
  const zoneShapeHits = [],
    labelWireHits = [];
  for (const pair of grouped(onlyBottom ? [] : p.zoneShape)) {
    const h = await pairHit(pair, "zone-shape");
    if (h) zoneShapeHits.push(h);
  }
  for (const pair of grouped(onlyBottom ? [] : p.labelWire)) {
    const h = await pairHit(pair, "label-wire");
    if (h) labelWireHits.push(h);
  }
  // Bottom digits: expose the glyph even if the title rule would overpaint it.
  const b = p.bottom,
    band = {
      x: Math.min(...b.map((z) => z.bbox.x)) - 0.3,
      y: Math.min(...b.map((z) => z.bbox.y)) - 0.3,
      w: 0,
      h: 0,
    };
  band.w = Math.max(...b.map((z) => z.bbox.x + z.bbox.w)) + 0.3 - band.x;
  band.h = p.T + 0.3 - band.y;
  await hide([], [], true);
  const A = await pixels(band);
  await hide(
    b.map((z) => z.id),
    [],
    true,
  );
  const B = await pixels(band),
    bm = mask(A, B);
  let max = -1,
    rawMax = -1,
    outside = 0;
  for (let i = 0; i < bm.length; i++)
    if (bm[i]) {
      rawMax = Math.max(rawMax, Math.floor(i / A.w));
      const x = band.x + ((i % A.w) + 0.5) / S,
        y = band.y + (Math.floor(i / A.w) + 0.5) / S;
      if (
        b.some(
          (z) =>
            x >= z.bbox.x - 1 / S &&
            x <= z.bbox.x + z.bbox.w + 1 / S &&
            y >= z.bbox.y - 1 / S &&
            y <= z.bbox.y + z.bbox.h + 1 / S,
        )
      )
        max = Math.max(max, Math.floor(i / A.w));
      else outside++;
    }
  if (max < 0) throw Error("Bottom digits do not paint");
  const inkBottom = band.y + (max + 1) / S,
    bottomRuleClearanceMm = p.T - 0.15 - inkBottom;
  if (bottomRuleClearanceMm < 0.5 && artifactDir) {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(artifactDir + "/" + tag + "-bottom-A.png", A.buf);
    await writeFile(artifactDir + "/" + tag + "-bottom-B.png", B.buf);
    await writeFile(
      artifactDir + "/" + tag + "-bottom-debug.json",
      JSON.stringify(
        { titleTop: p.T, band, max, inkBottom, bottom: b },
        null,
        2,
      ),
    );
  }
  await restore();
  return {
    zoneShapeCandidates: p.zoneShape.length,
    labelWireCandidates: p.labelWire.length,
    zoneShapeCollisions: zoneShapeHits,
    labelWireCollisions: labelWireHits,
    bottomRuleClearanceMm,
    rawBottomRuleClearanceMm: p.T - 0.15 - (band.y + (rawMax + 1) / S),
    bottomMaskOutsideBBoxPixels: outside,
    labels: p.labels,
    bottomDigits: b.length,
  };
}
