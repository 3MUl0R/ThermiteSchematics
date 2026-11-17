// Runs inside Chromium; no renderer geometry fields, success flags or coverage lists.
function stripInkHelpers() {
  const root = document.querySelector("svg"),
    inverse = root.getScreenCTM().inverse();
  const all = (s) => [...root.querySelectorAll(s)];
  const attr = (e, s) => e?.getAttribute(s);
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
  return { root, all, attr, painted, box, texts, path };
}
export function measureStripInk(createHelpers) {
  const { root, all, attr, painted, box, texts, path } = createHelpers();
  const terminals = all("[data-strip-terminal]").map((e) => ({
    key: attr(e, "data-strip-terminal"),
    ref: attr(e, "data-strip-ref"),
    inventory: attr(e, "data-inventory-row"),
    rect:
      e.querySelector("rect") && painted(e.querySelector("rect"))
        ? box(e.querySelector("rect"))
        : null,
    texts: texts(e),
  }));
  const bridges = all("[data-strip-jumper] path").map((e) => ({
    uid: attr(e.closest("[data-strip-jumper]"), "data-strip-jumper"),
    ...path(e),
  }));
  const incidences = all("[data-strip-incidence]").flatMap((e) =>
    [...e.querySelectorAll("path,line,polyline")].map((p) => ({
      id: attr(e, "data-strip-incidence"),
      at: attr(e, "data-strip-at"),
      text: texts(e)
        .filter((t) => t.painted)
        .map((t) => t.text)
        .join(" "),
      ...path(p),
    })),
  );
  const unclaimed = all(
    "[data-terminal-strip] rect,[data-terminal-strip] path,[data-terminal-strip] line,[data-strip-accessory]",
  )
    .filter(
      (e) =>
        painted(e) &&
        !e.closest(
          "[data-strip-terminal],[data-strip-jumper],[data-strip-incidence]",
        ),
    )
    .map((e) => ({ tag: e.tagName, bbox: box(e) }));
  return {
    terminals,
    bridges,
    incidences,
    unclaimed,
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
      })),
    ),
    notes: texts(root)
      .filter((t) => t.painted)
      .map((t) => t.text),
    texts: all("[data-terminal-strip]").flatMap(texts),
  };
}

export const stripInkScript = `(${measureStripInk.toString()})(${stripInkHelpers.toString()})`;
