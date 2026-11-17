// Browser measurement of visible SVG, never renderer geometry/coverage fields.
function stripInkHelpers() {
  const root = document.querySelector("svg"),
    inverse = root.getScreenCTM().inverse();
  const all = (s) => [...root.querySelectorAll(s)],
    attr = (e, s) => e?.getAttribute(s);
  const painted = (e) => {
    for (let p = e; p && p !== root; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === "none" || s.visibility === "hidden" || +s.opacity < 0.2)
        return false;
    }
    const s = getComputedStyle(e);
    return (
      (s.fill !== "none" && +s.fillOpacity >= 0.2) ||
      (s.stroke !== "none" && +s.strokeOpacity >= 0.2)
    );
  };
  const point = (e, p) =>
    new DOMPoint(p.x, p.y).matrixTransform(inverse.multiply(e.getScreenCTM()));
  const box = (e) => {
    const b = e.getBBox(),
      a = point(e, b),
      z = point(e, { x: b.x + b.width, y: b.y + b.height });
    return { x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y };
  };
  const texts = (e) =>
    [...e.querySelectorAll("text")].map((t) => {
      const b = box(t),
        m = inverse.multiply(t.getScreenCTM());
      return {
        text: t.textContent,
        center: { x: b.x + b.w / 2, y: b.y + b.h / 2 },
        bbox: b,
        anchor: point(t, {
          x: t.x.baseVal[0]?.value ?? 0,
          y: t.y.baseVal[0]?.value ?? 0,
        }),
        size:
          parseFloat(getComputedStyle(t).fontSize) *
          Math.min(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d)),
        painted: painted(t),
      };
    });
  const path = (e) => {
    const length = e.getTotalLength(),
      count = Math.max(2, Math.ceil(length / 0.5));
    return {
      points: Array.from({ length: count + 1 }, (_, i) =>
        point(e, e.getPointAtLength((length * i) / count)),
      ),
      length,
      painted: painted(e),
    };
  };
  const chunk = (e) => {
    const owner = e.closest("[data-terminal-strip]");
    return owner ? box(owner) : null;
  };
  const sheet = Number(root.getAttribute("data-sheet"));
  return { root, all, attr, painted, point, box, texts, path, chunk, sheet };
}
function stripGrid(h) {
  const top = h
    .all("text")
    .filter(
      (t) =>
        !t.closest("[data-terminal-strip]") &&
        /^[1-6]$/u.test(t.textContent) &&
        h.painted(t),
    )
    .map((t) => ({
      text: t.textContent,
      p: h.point(t, {
        x: t.x.baseVal[0]?.value ?? 0,
        y: t.y.baseVal[0]?.value ?? 0,
      }),
    }))
    .sort((a, b) => a.p.y - b.p.y)
    .slice(0, 6)
    .sort((a, b) => Number(a.text) - Number(b.text));
  const letters = h
    .all("text")
    .filter(
      (t) =>
        !t.closest("[data-terminal-strip]") &&
        /^[A-D]$/u.test(t.textContent) &&
        h.painted(t),
    );
  const left = ["A", "B", "C", "D"].map(
    (letter) =>
      letters
        .filter((t) => t.textContent === letter)
        .map((t) =>
          h.point(t, {
            x: t.x.baseVal[0]?.value ?? 0,
            y: t.y.baseVal[0]?.value ?? 0,
          }),
        )
        .sort((a, b) => a.x - b.x)[0],
  );
  return (p) => {
    if (top.length !== 6 || left.some((p) => !p)) return null;
    const col = top
      .slice(1)
      .filter((t, i) => p.x >= (top[i].p.x + t.p.x) / 2).length;
    const row = left
      .slice(1)
      .filter((t, i) => p.y >= (left[i].y + t.y) / 2).length;
    return "ABCD"[row] + (col + 1);
  };
}
function stripShapes(h) {
  const { all, attr, painted, box, texts, path, chunk, sheet } = h;
  const terminals = all("[data-strip-terminal]").map((e) => ({
    key: attr(e, "data-strip-terminal"),
    ref: attr(e, "data-strip-ref"),
    inventory: attr(e, "data-inventory-row"),
    rect:
      e.querySelector("rect") && painted(e.querySelector("rect"))
        ? box(e.querySelector("rect"))
        : null,
    texts: texts(e),
    chunk: chunk(e),
    sheet,
  }));
  const bridges = all("[data-strip-jumper] path").map((e) => {
    const p = e.closest("[data-strip-jumper]");
    return {
      uid: attr(p, "data-strip-jumper"),
      end: attr(p, "data-strip-jumper-end"),
      at: attr(p, "data-strip-at"),
      peer: attr(p, "data-strip-peer"),
      text: texts(p)
        .filter((t) => t.painted)
        .map((t) => t.text)
        .join(" "),
      ...path(e),
      sheet,
      chunk: chunk(e),
    };
  });
  const incidences = all("[data-strip-incidence]").flatMap((e) =>
    [...e.querySelectorAll("path,line,polyline")].map((p) => ({
      id: attr(e, "data-strip-incidence"),
      at: attr(e, "data-strip-at"),
      text: texts(e)
        .filter((t) => t.painted)
        .map((t) => t.text)
        .join(" "),
      ...path(p),
      sheet,
    })),
  );
  const rectangles = new Set(
    all("[data-strip-terminal]").map((e) => e.querySelector("rect")),
  );
  const unclaimed = all(
    '[data-sheet-kind="terminal-strip"] :is(rect,path,line,polyline,polygon,circle,ellipse),[data-strip-accessory]',
  )
    .filter(
      (e) =>
        painted(e) &&
        !rectangles.has(e) &&
        !(
          e.matches("path,line,polyline") &&
          e.closest("[data-strip-jumper],[data-strip-incidence]")
        ),
    )
    .map((e) => ({ tag: e.tagName, bbox: box(e), sheet }));
  return { terminals, bridges, incidences, unclaimed };
}
function stripDetails(h) {
  const { root, all, attr, painted, texts, box, chunk, sheet } = h;
  const value = (e) =>
    texts(e)
      .filter((t) => t.painted)
      .map((t) => t.text)
      .join(" ");
  return {
    rows: all("[data-report-row]").map((e) => ({
      key: attr(e, "data-report-row"),
      ref: attr(e, "data-strip-ref"),
    })),
    references: all("[data-strip-row]")
      .filter(painted)
      .map((e) => ({ key: attr(e, "data-strip-row"), text: e.textContent })),
    headings: all("[data-terminal-strip]").flatMap((e) =>
      texts(e).map((t) => ({
        uid: attr(e, "data-terminal-strip"),
        text: t.text,
        sheet,
      })),
    ),
    notes: texts(root)
      .filter((t) => t.painted)
      .map((t) => t.text),
    texts: all('[data-sheet-kind="terminal-strip"]').flatMap(texts),
    continuations: all("[data-strip-continuation]").map((e) => ({
      direction: attr(e, "data-strip-continuation"),
      at: attr(e, "data-strip-at"),
      target: attr(e, "data-strip-target"),
      text: value(e),
      painted: painted(e),
      bbox: box(e),
      chunk: chunk(e),
      sheet,
    })),
    bridgeLabels: all(
      "[data-strip-bridge-label],[data-strip-jumper][data-strip-jumper-end]",
    ).map((e) => ({
      uid: attr(e, "data-strip-bridge-label") ?? attr(e, "data-strip-jumper"),
      at: attr(e, "data-strip-at"),
      text: value(e),
      sheet,
    })),
  };
}
export const stripInkScript = `(()=>{const h=(${stripInkHelpers.toString()})();const zone=(${stripGrid.toString()})(h);const shapes=(${stripShapes.toString()})(h);for(const t of shapes.terminals)t.zone=t.rect?zone({x:t.rect.x+t.rect.w/2,y:t.rect.y+t.rect.h/2}):null;return{...shapes,...(${stripDetails.toString()})(h)};})()`;
