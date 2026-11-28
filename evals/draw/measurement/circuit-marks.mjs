export function circuitRouteFields(e, endpoints, conductor, attr, ownerKey, h) {
  return {
    endpoints,
    circuitFanIn: endpoints
      ? (e.getAttribute("data-circuit-fan-in") ?? undefined)
      : undefined,
    ...(h && conductor
      ? h.routePortFields(e, conductor, attr, ownerKey, h)
      : {}),
  };
}

export function circuitCaptionFallbacks({ root, identity, visible }) {
  const selector = "[data-circuit-caption-fallback]";
  const markers = [...root.querySelectorAll(selector)];
  if (root.matches(selector)) markers.unshift(root);
  return markers.map((e) => ({
    ...identity(e),
    bbox: visible(e)?.b,
    fallback: e.getAttribute("data-circuit-caption-fallback"),
    text: e.textContent.trim(),
  }));
}

export function fanInPhysicalTerminal(c) {
  const { all, anchor, anchorElement, deviceUid, e, h, scope, terminal } = c;
  const port = anchorElement?.getAttribute("data-circuit-landing-for");
  if (!port) return anchor;
  const group = e.closest("[data-circuit-group]");
  const candidates = all.filter(
    (element) =>
      element.getAttribute("data-layout-port") === port &&
      element.closest("svg") === scope &&
      element.closest("[data-circuit-group]") === group,
  );
  const physical = { ...c, candidates };
  h.measureLandingAnchor(physical);
  if (physical.deviceUid === deviceUid && physical.terminal === terminal)
    return physical.anchor;
}

export function circuitPrimitiveFunctionId(e, attr) {
  const raw = attr(e, "data-function-id");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        typeof parsed[0] === "string" &&
        typeof parsed[1] === "string"
      )
        return parsed;
    } catch {}
  }
  const uid = attr(e, "data-device-uid"),
    fk = attr(e, "data-function-key");
  return uid && fk ? [uid, fk] : null;
}

export function isExcludedSheetInkElement(e) {
  const cls = e.getAttribute("class") ?? "";
  return Boolean(
    e.closest("defs,clipPath,mask,symbol,pattern,marker") ||
    e.closest(
      '[data-tag-kind="reference"],.off-view-annotation,[data-navigation-annotation],[data-report-row]',
    ) ||
    e.hasAttribute("data-terminal-marker") ||
    cls.includes("terminal-marker") ||
    cls.includes("junction-dot") ||
    cls.includes("label-background") ||
    e.hasAttribute("data-circuit-junction") ||
    e.hasAttribute("data-wiring-junction") ||
    (e.closest("[data-symbol-id]") && !e.closest("[data-circuit-mark]")),
  );
}

export function isNativeConductorElement(e) {
  const cls = e.getAttribute("class") ?? "";
  return Boolean(
    cls.includes("net-path") ||
    cls.includes("boundary-path") ||
    e.closest(
      "[data-circuit-conductor],[data-wiring-conductor],[data-wire-uid],[data-loop-conductor],[data-terminal-feed-through]",
    ),
  );
}

export function isCircuitPrimitiveElement(e, h) {
  if (h.isExcludedSheetInkElement(e) || h.isNativeConductorElement(e))
    return false;
  const cls = e.getAttribute("class") ?? "";
  return Boolean(
    e.hasAttribute("data-electrical-role") ||
    cls.includes("circuit-device-frame") ||
    e.closest(
      "[data-circuit-group],[data-circuit-mark],[data-function-interface],[data-terminal-attachment],[data-magnetic-association],[data-mechanical-association],[data-source-enclosure],[data-function-id],[data-function-key],[data-circuit-functions]",
    ),
  );
}

export function isExactNonCircuitBox(
  e,
  strokeInfo,
  filled,
  strokeColor,
  fillColor,
  localStroke,
  dash,
  clipError,
) {
  if (
    clipError ||
    e.hasAttribute("data-electrical-role") ||
    e.closest("[data-circuit-mark],[data-source-enclosure]")
  )
    return false;
  const cls = e.getAttribute("class") ?? "";
  const alphaOk = Math.abs(strokeInfo.alpha - 1) <= 1e-3;
  const rgb = (c, r, g, b) =>
    Array.isArray(c) && c[0] === r && c[1] === g && c[2] === b;
  if (
    !filled &&
    cls.includes("wire-label-leader") &&
    alphaOk &&
    rgb(strokeColor, 71, 84, 103) &&
    Math.abs(localStroke - 0.15) <= 1e-3
  )
    return true;
  if (e.tagName.toLowerCase() !== "rect" || e.closest("[data-circuit-group]"))
    return false;
  const parent = e.parentElement;
  if (
    !filled &&
    parent?.hasAttribute("data-terminal-body") &&
    parent.hasAttribute("data-device-uid") &&
    e.getAttribute("rx") === "1" &&
    alphaOk &&
    rgb(strokeColor, 52, 64, 84) &&
    Math.abs(localStroke - 0.35) <= 1e-3 &&
    (!dash || dash.trim().toLowerCase() === "none")
  )
    return true;
  const dashNums = String(dash ?? "")
    .trim()
    .split(/[\s,]+/u)
    .map(parseFloat);
  return Boolean(
    parent?.hasAttribute("data-enclosure") &&
    parent.hasAttribute("data-member-uids") &&
    e.getAttribute("rx") === "1.5" &&
    alphaOk &&
    rgb(fillColor, 247, 249, 252) &&
    rgb(strokeColor, 123, 137, 154) &&
    Math.abs(localStroke - 0.4) <= 1e-3 &&
    dashNums.length === 2 &&
    Math.abs(dashNums[0] - 3) <= 1e-3 &&
    Math.abs(dashNums[1] - 2) <= 1e-3,
  );
}

export function circuitPrimitiveFillPoints(
  e,
  filled,
  scale,
  m,
  point,
  clips,
  clip,
  contains,
) {
  if (!filled || clips === null || typeof e.getTotalLength !== "function")
    return [];
  const len = e.getTotalLength();
  const n = Math.min(200, Math.max(4, Math.ceil((len * scale) / 0.5)));
  const boxes = [clip, ...(clips ?? [])].filter(Boolean);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const q = e.getPointAtLength((len * i) / n).matrixTransform(m);
    const p = point(q.x, q.y);
    if (!boxes.length || boxes.every((b) => contains(b, p))) pts.push(p);
  }
  return pts;
}

export function circuitPrimitiveMeta(e, owner, inkScope, c) {
  const { attr, h, ids } = c;
  const cls = owner.getAttribute("class") ?? "";
  return {
    electricalRole:
      e.getAttribute("data-electrical-role") ??
      owner.getAttribute("data-electrical-role"),
    electricalRoleDeclared:
      e.hasAttribute("data-electrical-role") ||
      owner.hasAttribute("data-electrical-role"),
    mark: attr(owner, "data-circuit-mark"),
    markScope: ids.get(owner.closest("[data-circuit-mark]")),
    functionInterface: attr(owner, "data-function-interface"),
    attachment: attr(owner, "data-terminal-attachment"),
    sourceEnclosure: !!owner.closest("[data-source-enclosure]"),
    deviceFrame: cls.includes("circuit-device-frame"),
    magneticAssociation: attr(owner, "data-magnetic-association"),
    mechanicalAssociation: attr(owner, "data-mechanical-association"),
    circuitRole:
      e.getAttribute("data-circuit-role") ??
      owner.getAttribute("data-circuit-role"),
    functionId: h.circuitPrimitiveFunctionId(owner, attr),
    deviceUid: attr(owner, "data-device-uid"),
    designation: attr(owner, "data-designation"),
    circuitGroup: attr(owner, "data-circuit-group"),
    appearanceScope: ids.get(owner.closest("svg")),
    conductorNet:
      inkScope === "conductor" ? (attr(owner, "data-net-id") ?? null) : null,
    conductorId:
      inkScope === "conductor"
        ? (attr(owner, "data-circuit-conductor") ??
          attr(owner, "data-loop-conductor") ??
          attr(owner, "data-wiring-conductor") ??
          attr(owner, "data-wire-uid") ??
          attr(owner, "data-terminal-feed-through") ??
          null)
        : null,
    feedThrough:
      inkScope === "conductor"
        ? (attr(owner, "data-terminal-feed-through") ?? null)
        : null,
  };
}

export function circuitPrimitiveRecord(e, c, opts = {}) {
  const { colour, contains, h, ids, point, sx, sy, visible } = c;
  const owner = opts.ownerEl ?? e;
  const inkScope = opts.inkScope ?? "symbol";
  const v = visible(e);
  if (!v) return null;
  const css = getComputedStyle(e),
    m = e.getScreenCTM();
  if (!m) return null;
  const ink = h.circuitStrokeInk(e, v.clip, m, c, opts.order);
  if (!ink.clipError && !ink.segments.length && !ink.filled) return null;
  const scale = Math.max(
    Math.hypot(m.a * sx, m.b * sy),
    Math.hypot(m.c * sx, m.d * sy),
  );
  const localStroke = ink.strokePainted ? ink.strokeInfo.width : 0;
  const stroke = localStroke * scale;
  const strokeAlpha = ink.strokePainted ? ink.strokeInfo.alpha : 0;
  const strokeColor = ink.strokePainted ? colour(css.stroke) : null;
  const fillColor = ink.filled ? colour(css.fill) : null;
  if (
    inkScope !== "conductor" &&
    h.isExactNonCircuitBox(
      e,
      ink.strokeInfo,
      ink.filled,
      strokeColor,
      fillColor,
      localStroke,
      css.strokeDasharray,
      ink.clipError,
    )
  )
    return null;
  return {
    element: opts.elementId ?? ids.get(owner),
    inkScope,
    shapeTag: e.tagName.toLowerCase(),
    bbox: v.b,
    stroke,
    localStroke,
    scale,
    strokeAlpha,
    strokeColor,
    dash: css.strokeDasharray,
    segments: ink.segments,
    filled: ink.filled,
    clipError: ink.clipError,
    points: h.circuitPrimitiveFillPoints(
      e,
      ink.filled,
      scale,
      m,
      point,
      ink.clips,
      v.clip,
      contains,
    ),
    ...h.circuitPrimitiveMeta(e, owner, inkScope, c),
  };
}

export function createUseCloneWrapper(useEl, target) {
  const ns =
    useEl.ownerSVGElement?.namespaceURI ?? "http://www.w3.org/2000/svg";
  const wrapper = document.createElementNS(ns, "g");
  for (const { name, value } of Array.from(useEl.attributes)) {
    if (
      [
        "id",
        "href",
        "xlink:href",
        "x",
        "y",
        "width",
        "height",
        "transform",
      ].includes(name)
    )
      continue;
    wrapper.setAttribute(name, value);
  }
  const ux = useEl.x?.baseVal?.value ?? 0,
    uy = useEl.y?.baseVal?.value ?? 0;
  const origTransform = useEl.getAttribute("transform") ?? "";
  const extra = ux || uy ? `translate(${ux} ${uy})` : "";
  const combined = [origTransform, extra].filter(Boolean).join(" ").trim();
  if (combined) wrapper.setAttribute("transform", combined);
  const clone =
    target.tagName.toLowerCase() === "symbol"
      ? (() => {
          const svg = document.createElementNS(ns, "svg");
          for (const k of ["viewBox", "preserveAspectRatio"])
            if (target.hasAttribute(k))
              svg.setAttribute(k, target.getAttribute(k));
          for (const k of ["width", "height"])
            if (useEl.hasAttribute(k))
              svg.setAttribute(k, useEl.getAttribute(k));
          for (const ch of Array.from(target.childNodes))
            svg.append(ch.cloneNode(true));
          return svg;
        })()
      : target.cloneNode(true);
  if (clone.removeAttribute) clone.removeAttribute("id");
  for (const n of clone.querySelectorAll?.("[id]") ?? [])
    n.removeAttribute("id");
  wrapper.append(clone);
  return wrapper;
}

export function unsupportedUseRecord(ownerEl, inkScope, bbox, ids) {
  return {
    element: ids.get(ownerEl),
    inkScope,
    shapeTag: "use",
    bbox,
    stroke: 0,
    localStroke: 0,
    scale: 1,
    strokeAlpha: 0,
    strokeColor: null,
    dash: "none",
    segments: [],
    filled: false,
    clipError: "unsupported-use-href",
    points: [],
    appearanceScope: ids.get(ownerEl.closest("svg")),
  };
}

export function collectUseRecords(
  useEl,
  c,
  inkScope,
  ownerEl,
  order,
  depth,
  seen,
) {
  const { h, ids, root, visible } = c;
  if (depth > 6 || h.isExcludedSheetInkElement(useEl)) return [];
  const v = visible(useEl);
  if (!v) return [];
  const href =
    useEl.getAttribute("href") ??
    useEl.getAttributeNS("http://www.w3.org/1999/xlink", "href");
  if (!href) return [];
  if (!href.startsWith("#"))
    return [h.unsupportedUseRecord(ownerEl, inkScope, v.b, ids)];
  if (seen.has(href)) return [];
  const target = root.querySelector(`#${CSS.escape(href.slice(1))}`);
  if (!target || !useEl.parentNode) return [];
  const wrapper = h.createUseCloneWrapper(useEl, target);
  useEl.parentNode.insertBefore(wrapper, useEl.nextSibling);
  const out = [];
  const nextSeen = new Set([...seen, href]);
  try {
    const shapes = Array.from(
      wrapper.querySelectorAll(
        "path,line,polyline,polygon,rect,circle,ellipse",
      ),
    );
    shapes.forEach((shape, i) => {
      const rec = h.circuitPrimitiveRecord(shape, c, {
        ownerEl,
        elementId: `${ids.get(ownerEl)}/use-${depth}-${i}`,
        inkScope,
        order,
      });
      if (rec) out.push(rec);
    });
    for (const nested of Array.from(wrapper.querySelectorAll("use")))
      out.push(
        ...h.collectUseRecords(
          nested,
          c,
          inkScope,
          ownerEl,
          order,
          depth + 1,
          nextSeen,
        ),
      );
  } finally {
    wrapper.remove();
  }
  return out;
}

export function collectCircuitInk(c) {
  const { h, orders, root } = c;
  if (!root.querySelector("[data-circuit-mark]"))
    return {
      circuitPrimitives: [],
      circuitSheetInk: [],
      circuitConductors: [],
    };
  const circuitPrimitives = [],
    circuitSheetInk = [],
    circuitConductors = [];
  const push = (rec) => {
    if (!rec) return;
    if (rec.inkScope === "symbol") circuitPrimitives.push(rec);
    else if (rec.inkScope === "conductor") circuitConductors.push(rec);
    else circuitSheetInk.push(rec);
  };
  const scopeOf = (e) =>
    h.isNativeConductorElement(e)
      ? "conductor"
      : h.isCircuitPrimitiveElement(e, h)
        ? "symbol"
        : "sheet";
  const shapes = Array.from(
    root.querySelectorAll("path,line,polyline,polygon,rect,circle,ellipse"),
  );
  for (const e of shapes) {
    if (h.isExcludedSheetInkElement(e)) continue;
    push(h.circuitPrimitiveRecord(e, c, { inkScope: scopeOf(e) }));
  }
  for (const useEl of Array.from(root.querySelectorAll("use"))) {
    if (h.isExcludedSheetInkElement(useEl)) continue;
    const records = h.collectUseRecords(
      useEl,
      c,
      scopeOf(useEl),
      useEl,
      orders.get(useEl),
      0,
      new Set(),
    );
    for (const rec of records) push(rec);
  }
  return { circuitPrimitives, circuitSheetInk, circuitConductors };
}

export function collectCircuitPrimitives(c) {
  return c.h.collectCircuitInk(c).circuitPrimitives;
}
