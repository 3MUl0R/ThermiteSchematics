// Port of the reviewed round-3 counterfactual paint census. Browser boxes are
// broad phase only; clipping, occlusion and stroke contributions are rasterized.
import { identifyZones } from "./zones.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.cwd(),
  imp = (p) => import(pathToFileURL(p));
const { launch } = await imp(root + "/evals/draw/browser.mjs"),
  { imageCanvas } = await imp(root + "/evals/draw/pdf.mjs"),
  { embedPrintableFont } = await imp(
    root + "/packages/cli/dist/printable-font.js",
  );
const SCALE = 300 / 25.4;
export async function startCensus() {
  const browser = await launch(),
    context = await browser.newContext({
      viewport: { width: 1800, height: 1800 },
      deviceScaleFactor: 300 / 96,
      offline: true,
      serviceWorkers: "block",
      javaScriptEnabled: false,
    }),
    page = await context.newPage();
  const measure = async (
    svg,
    {
      artifactDir,
      tag = "sheet",
      cropPositives = true,
      lanes = true,
      title = true,
    } = {},
  ) => {
    await page.setContent(
      "<style>body{margin:0}</style>" +
        (svg.includes("data-thermite-font")
          ? svg
          : embedPrintableFont(svg)
        ).replace(/<\?xml[^>]*>/, ""),
    );
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(identifyZones);
    const broad = await page.evaluate(() => {
      const root = document.querySelector("body>svg"),
        rr = root.getBoundingClientRect(),
        W = root.viewBox.baseVal.width,
        H = root.viewBox.baseVal.height,
        k = W / rr.width;
      const box = (e) => {
        const r = e.getBoundingClientRect();
        return {
          x: (r.x - rr.x) * k,
          y: (r.y - rr.y) * k,
          w: r.width * k,
          h: r.height * k,
        };
      };
      const inter = (a, b) => {
        const x = Math.max(a.x, b.x),
          y = Math.max(a.y, b.y),
          r = Math.min(a.x + a.w, b.x + b.w),
          d = Math.min(a.y + a.h, b.y + b.h);
        return r > x && d > y ? { x, y, w: r - x, h: d - y } : null;
      };
      const frame = [...root.children].find(
          (e) => e.tagName === "rect" && e.getAttribute("fill") === "none",
        ),
        fb = box(frame),
        m = fb.x;
      const rules = [...root.children]
          .filter((e) => e.tagName === "path")
          .map((e) => ({ e, b: box(e) }))
          .filter((v) => v.b.h < 0.02 && v.b.w > fb.w * 0.8)
          .sort((a, b) => a.b.y - b.b.y),
        top = rules.at(-1).b.y;
      const all = [...root.querySelectorAll("text,path,rect")];
      all.forEach((e, i) => e.setAttribute("data-census-id", i));
      const direct = [...root.children],
        ztexts = direct.filter((e) => e.hasAttribute("data-oracle-zone-text"));
      const zticks = direct.filter((e) =>
        e.hasAttribute("data-oracle-zone-tick"),
      );
      const zones = [...ztexts, ...zticks].map((e) => ({
        id: +e.getAttribute("data-census-id"),
        text: e.textContent || "tick",
        kind: e.tagName,
        side: /^\d+$/.test(e.textContent)
          ? box(e).y < H / 2
            ? "top"
            : "bottom"
          : /^[A-Z]$/.test(e.textContent)
            ? box(e).x < W / 2
              ? "left"
              : "right"
            : box(e).w < 0.02
              ? box(e).y < H / 2
                ? "top"
                : "bottom"
              : box(e).x < W / 2
                ? "left"
                : "right",
        bbox: box(e),
      }));
      const zset = new Set([...ztexts, ...zticks]),
        clipped = [],
        texts = [];
      function visible(e) {
        if (e.closest("defs,clipPath,mask,symbol,pattern")) return null;
        const cs = getComputedStyle(e);
        if (
          cs.visibility !== "visible" ||
          cs.display === "none" ||
          (cs.fill === "none" && cs.stroke === "none")
        )
          return null;
        for (let p = e; p && p !== root.parentElement; p = p.parentElement)
          if (
            +getComputedStyle(p).opacity === 0 ||
            getComputedStyle(p).display === "none"
          )
            return null;
        let b = box(e);
        if (!b.w || !b.h) return null;
        for (let p = e.parentElement; p && p !== root; p = p.parentElement) {
          if (
            p.tagName === "svg" &&
            getComputedStyle(p).overflow !== "visible"
          ) {
            const a = p.parentElement.getScreenCTM(),
              own = p.transform?.baseVal?.consolidate()?.matrix,
              mx = own ? a.multiply(own) : a;
            const x = p.x.baseVal.value,
              y = p.y.baseVal.value,
              w = p.width.baseVal.value,
              h = p.height.baseVal.value;
            const pts = [
              [x, y],
              [x + w, y],
              [x, y + h],
              [x + w, y + h],
            ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(mx));
            const xs = pts.map((q) => (q.x - rr.x) * k),
              ys = pts.map((q) => (q.y - rr.y) * k),
              clip = {
                x: Math.min(...xs),
                y: Math.min(...ys),
                w: Math.max(...xs) - Math.min(...xs),
                h: Math.max(...ys) - Math.min(...ys),
              };
            b = inter(b, clip);
            if (!b) {
              clipped.push({
                id: +e.getAttribute("data-census-id"),
                text: e.textContent,
                reason: "nested-viewport",
              });
              return null;
            }
          }
        }
        return b;
      }
      for (const e of root.querySelectorAll("text")) {
        if (zset.has(e)) continue;
        const b = visible(e);
        if (b)
          texts.push({
            id: +e.getAttribute("data-census-id"),
            text: e.textContent,
            baseline:
              ((e.y.baseVal.numberOfItems
                ? new DOMPoint(
                    e.x.baseVal.getItem(0).value,
                    e.y.baseVal.getItem(0).value,
                  ).matrixTransform(e.getScreenCTM()).y
                : NaN) -
                rr.y) *
              k,
            bbox: b,
            continuation: !!e.closest("a[data-continuation-id]"),
          });
      }
      const near = (a, b, g = 0.55) =>
        a.x < b.x + b.w + g &&
        b.x < a.x + a.w + g &&
        a.y < b.y + b.h + g &&
        b.y < a.y + a.h + g;
      const pairs = zones.flatMap((z) =>
        texts
          .filter((t) => near(z.bbox, t.bbox))
          .map((t) => ({ zone: z, text: t })),
      );
      const laneRects = [
        { side: "left", x: m, y: m + 13, w: 2.6, h: top - 3 - m - 13 },
        {
          side: "right",
          x: W - m - 2.6,
          y: m + 13,
          w: 2.6,
          h: top - 3 - m - 13,
        },
        { side: "top", x: m, y: m + 7.8, w: W - 2 * m, h: 5.2 },
        { side: "bottom", x: m, y: top - 3, w: W - 2 * m, h: 3 },
      ];
      const lanePairs = laneRects.flatMap((l) =>
        texts
          .filter((t) => near(l, t.bbox, 0))
          .map((t) => ({ lane: l, text: t })),
      );
      const titleRules = direct.flatMap((e) => {
        if (e.tagName === "rect" && e.getAttribute("stroke-width") === "0.25") {
          const b = box(e);
          return [
            {
              id: +e.getAttribute("data-census-id"),
              x: b.x,
              y: b.y,
              w: b.w,
              h: 0.25,
            },
            {
              id: +e.getAttribute("data-census-id"),
              x: b.x,
              y: b.y + b.h,
              w: b.w,
              h: 0.25,
            },
          ];
        }
        return [];
      });
      const titleHits = texts
        .filter((t) => t.bbox.y >= top)
        .flatMap((t) =>
          titleRules
            .filter((r) => near(r, t.bbox, 0))
            .map((r) => ({ text: t, rule: r })),
        );
      return {
        W,
        H,
        m,
        titleTop: top,
        zones,
        texts,
        pairs,
        lanePairs,
        laneRects,
        titleHits,
        titleRuleIds: [...new Set(titleRules.map((r) => r.id))],
        clipped,
      };
    });
    const originalOpacity = await page.evaluate(() =>
      [...document.querySelectorAll("[data-census-id]")].map((e) => ({
        id: +e.getAttribute("data-census-id"),
        value: e.style.getPropertyValue("opacity"),
        priority: e.style.getPropertyPriority("opacity"),
      })),
    );
    const zoneIds = broad.zones.map((z) => z.id);
    async function state(hiddenTarget, visibleZone, hiddenRules = []) {
      await page.evaluate(
        ({
          zoneIds,
          hiddenTarget,
          visibleZone,
          originalOpacity,
          hiddenRules,
        }) => {
          const reset = new Map(originalOpacity.map((x) => [x.id, x]));
          for (const e of document.querySelectorAll(
            "[data-census-rule-hidden]",
          )) {
            const o = reset.get(+e.getAttribute("data-census-id"));
            if (o.value) e.style.setProperty("opacity", o.value, o.priority);
            else e.style.removeProperty("opacity");
            e.removeAttribute("data-census-rule-hidden");
          }
          for (const id of hiddenRules) {
            const e = document.querySelector(`[data-census-id="${id}"]`);
            e.setAttribute("data-census-rule-hidden", "true");
            e.style.setProperty("opacity", "0", "important");
          }
          for (const id of zoneIds) {
            const e = document.querySelector(`[data-census-id="${id}"]`),
              o = reset.get(id);
            if (id === visibleZone) {
              if (o.value) e.style.setProperty("opacity", o.value, o.priority);
              else e.style.removeProperty("opacity");
            } else e.style.setProperty("opacity", "0", "important");
          }
          const was = document.querySelector("[data-census-hidden-target]");
          if (was) {
            const o = reset.get(+was.getAttribute("data-census-id"));
            if (o.value) was.style.setProperty("opacity", o.value, o.priority);
            else was.style.removeProperty("opacity");
            was.removeAttribute("data-census-hidden-target");
          }
          if (hiddenTarget != null) {
            const e = document.querySelector(
              `[data-census-id="${hiddenTarget}"]`,
            );
            e.setAttribute("data-census-hidden-target", "true");
            e.style.setProperty("opacity", "0", "important");
          }
        },
        { zoneIds, hiddenTarget, visibleZone, originalOpacity, hiddenRules },
      );
    }
    const rectangle = (a, b, g = 0.65) => {
      const x = Math.max(0, Math.min(a.x, b.x) - g),
        y = Math.max(0, Math.min(a.y, b.y) - g),
        r = Math.min(broad.W, Math.max(a.x + a.w, b.x + b.w) + g),
        d = Math.min(broad.H, Math.max(a.y + a.h, b.y + b.h) + g);
      return { x, y, w: r - x, h: d - y };
    };
    async function shot(r) {
      return page.screenshot({
        clip: {
          x: (r.x * 96) / 25.4,
          y: (r.y * 96) / 25.4,
          width: (r.w * 96) / 25.4,
          height: (r.h * 96) / 25.4,
        },
      });
    }
    async function pixels(buf) {
      const c = await imageCanvas(buf);
      return {
        w: c.width,
        h: c.height,
        data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
      };
    }
    const diff = (a, b) => {
      if (a.w !== b.w || a.h !== b.h) throw Error("Raster phase changed");
      const m = new Uint8Array(a.w * a.h);
      for (let i = 0; i < m.length; i++)
        m[i] =
          Math.max(
            ...[0, 1, 2, 3].map((c) =>
              Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]),
            ),
          ) > 8
            ? 1
            : 0;
      return m;
    };
    const hits = [],
      nearHits = [],
      laneHits = [],
      titleHits = [];
    for (const pair of broad.pairs) {
      const crop = rectangle(pair.zone.bbox, pair.text.bbox);
      await state(null, null);
      const A = await pixels(await shot(crop));
      await state(pair.text.id, null);
      const B = await pixels(await shot(crop));
      await state(pair.text.id, pair.zone.id);
      const C = await pixels(await shot(crop));
      const t = diff(A, B),
        z = diff(C, B);
      let overlap = 0,
        dist = Infinity;
      const radius = Math.ceil(0.5 * SCALE);
      for (let i = 0; i < z.length; i++) {
        if (!z[i]) continue;
        if (t[i]) overlap++;
        const x = i % A.w,
          y = Math.floor(i / A.w);
        for (let dy = -radius; dy <= radius; dy++)
          for (let dx = -radius; dx <= radius; dx++) {
            const X = x + dx,
              Y = y + dy;
            if (
              X < 0 ||
              Y < 0 ||
              X >= A.w ||
              Y >= A.h ||
              dx * dx + dy * dy > radius * radius
            )
              continue;
            if (t[Y * A.w + X])
              dist = Math.min(dist, Math.hypot(dx, dy) / SCALE);
          }
      }
      const result = {
        zone: pair.zone.text,
        side: pair.zone.side,
        text: pair.text.text,
        overlapPixels: overlap,
        nearestInkMm: dist === Infinity ? null : dist,
        bbox: crop,
      };
      if (overlap) hits.push(result);
      else if (dist <= 0.5) nearHits.push(result);
      if (artifactDir && cropPositives && (overlap || dist <= 0.5)) {
        await page.evaluate(
          ({ originalOpacity }) => {
            for (const o of originalOpacity) {
              const e = document.querySelector(`[data-census-id="${o.id}"]`);
              if (o.value) e.style.setProperty("opacity", o.value, o.priority);
              else e.style.removeProperty("opacity");
            }
          },
          { originalOpacity },
        );
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
          artifactDir +
            "/" +
            tag +
            "-" +
            (hits.length + nearHits.length) +
            ".png",
          await shot(crop),
        );
      }
    }
    if (lanes)
      for (const pair of broad.lanePairs) {
        const cut = {
          x: Math.max(pair.lane.x, pair.text.bbox.x),
          y: Math.max(pair.lane.y, pair.text.bbox.y),
          w: 0,
          h: 0,
        };
        cut.w =
          Math.min(
            pair.lane.x + pair.lane.w,
            pair.text.bbox.x + pair.text.bbox.w,
          ) - cut.x;
        cut.h =
          Math.min(
            pair.lane.y + pair.lane.h,
            pair.text.bbox.y + pair.text.bbox.h,
          ) - cut.y;
        if (cut.w <= 0 || cut.h <= 0) continue;
        const crop = {
          x: Math.max(0, cut.x - 0.1),
          y: Math.max(0, cut.y - 0.1),
          w: cut.w + 0.2,
          h: cut.h + 0.2,
        };
        await state(null, null);
        const A = await pixels(await shot(crop));
        await state(pair.text.id, null);
        const B = await pixels(await shot(crop)),
          mask = diff(A, B);
        let painted = 0;
        for (let i = 0; i < mask.length; i++) {
          const x = crop.x + ((i % A.w) + 0.5) / SCALE,
            y = crop.y + (Math.floor(i / A.w) + 0.5) / SCALE;
          if (
            mask[i] &&
            x >= cut.x &&
            x <= cut.x + cut.w &&
            y >= cut.y &&
            y <= cut.y + cut.h
          )
            painted++;
        }
        if (painted)
          laneHits.push({
            side: pair.lane.side,
            text: pair.text.text,
            paintedPixels: painted,
            bbox: cut,
          });
      }
    // Title rules: geometric broad phase is followed by the same counterfactual
    // painted-text mask intersecting the actual 0.25 mm rule envelope.
    if (title)
      for (const pair of broad.titleHits) {
        const crop = rectangle(pair.rule, pair.text.bbox, 0.3);
        await state(null, null, broad.titleRuleIds);
        const A = await pixels(await shot(crop));
        await state(pair.text.id, null, broad.titleRuleIds);
        const B = await pixels(await shot(crop)),
          mask = diff(A, B);
        let painted = 0;
        for (let i = 0; i < mask.length; i++) {
          const x = crop.x + ((i % A.w) + 0.5) / SCALE,
            y = crop.y + (Math.floor(i / A.w) + 0.5) / SCALE;
          if (
            mask[i] &&
            x >= pair.rule.x &&
            x <= pair.rule.x + pair.rule.w &&
            Math.abs(y - pair.rule.y) <= 0.125
          )
            painted++;
        }
        const baselineStruck =
          Math.abs(pair.text.baseline - pair.rule.y) <= 0.126;
        if (painted || baselineStruck)
          titleHits.push({
            text: pair.text.text,
            paintedPixels: painted,
            baselineStruck,
            rule: pair.rule,
          });
      }
    return {
      zones: broad.zones.length,
      texts: broad.texts.length,
      clippedTexts: broad.clipped.length,
      clippedExamples: broad.clipped.slice(0, 4),
      broadPairs: broad.pairs.length,
      inkCollisions: hits,
      nearInk: nearHits,
      laneViolations: laneHits,
      titleRuleCollisions: titleHits,
      dimensions: { w: broad.W, h: broad.H },
      titleTop: broad.titleTop,
    };
  };
  return { measure, page, browser, close: () => browser.close() };
}
