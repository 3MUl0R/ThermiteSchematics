import { isTextLegibilityRole, type TextLegibilityRole } from "../text-role.js";

const NON_PRINTABLE_TAGS = new Set([
  "style",
  "script",
  "title",
  "desc",
  "metadata",
]);

interface OpenFrame {
  readonly localName: string;
  readonly effectiveRole: TextLegibilityRole | undefined;
  readonly nonPrintable: boolean;
  readonly inForeignObject: boolean;
}

function localTagName(rawName: string): string {
  const colon = rawName.indexOf(":");
  return colon >= 0 ? rawName.slice(colon + 1) : rawName;
}

function decodeXmlEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (match, body: string) => {
      if (body === "amp") return "&";
      if (body === "lt") return "<";
      if (body === "gt") return ">";
      if (body === "quot") return '"';
      if (body === "apos") return "'";
      const code = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    },
  );
}

function checkTextChunk(chunk: string, stack: readonly OpenFrame[]): void {
  if (decodeXmlEntities(chunk).trim().length === 0) return;
  const top = stack.at(-1);
  if (!top || top.nonPrintable) return;
  if (top.inForeignObject) {
    throw new Error(
      "SVG emitter rejected <foreignObject> with printable text.",
    );
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (!frame) continue;
    if (frame.localName === "text" || frame.localName === "tspan") {
      if (!frame.effectiveRole) {
        throw new Error(
          `SVG emitter rejected <${frame.localName}> without valid data-text-role.`,
        );
      }
      return;
    }
  }
}

function readAttrValue(
  svg: string,
  start: number,
  localName: string,
): { value: string; next: number } {
  let i = start;
  while (i < svg.length && /\s/.test(svg.charAt(i))) i += 1;
  const quote = svg.charAt(i);
  if (quote === '"' || quote === "'") {
    const close = svg.indexOf(quote, i + 1);
    if (close < 0) {
      throw new Error(
        `SVG emitter rejected unterminated attribute in <${localName}>.`,
      );
    }
    return {
      value: decodeXmlEntities(svg.slice(i + 1, close)),
      next: close + 1,
    };
  }
  const valStart = i;
  while (i < svg.length && !/[\s/>]/.test(svg.charAt(i))) i += 1;
  return { value: decodeXmlEntities(svg.slice(valStart, i)), next: i };
}

function parseTagEndAndRole(
  svg: string,
  start: number,
  localName: string,
): { end: number; selfClosing: boolean; roleAttr: string | undefined } {
  let i = start;
  let roleAttr: string | undefined;
  while (i < svg.length) {
    while (i < svg.length && /\s/.test(svg.charAt(i))) i += 1;
    if (svg.charAt(i) === ">") {
      return { end: i + 1, selfClosing: false, roleAttr };
    }
    if (svg.charAt(i) === "/" && svg.charAt(i + 1) === ">") {
      return { end: i + 2, selfClosing: true, roleAttr };
    }
    const nameStart = i;
    while (i < svg.length && !/[\s=/>]/.test(svg.charAt(i))) i += 1;
    if (i === nameStart) {
      throw new Error(`SVG emitter rejected malformed <${localName}> tag.`);
    }
    const attrName = svg.slice(nameStart, i);
    while (i < svg.length && /\s/.test(svg.charAt(i))) i += 1;
    if (svg.charAt(i) !== "=") continue;
    const parsed = readAttrValue(svg, i + 1, localName);
    i = parsed.next;
    if (attrName === "data-text-role") {
      if (!isTextLegibilityRole(parsed.value)) {
        throw new Error(
          `SVG emitter rejected <${localName}> with invalid data-text-role (${parsed.value}).`,
        );
      }
      roleAttr = parsed.value;
    }
  }
  throw new Error(`SVG emitter rejected unterminated <${localName}> tag.`);
}

function resolveFrameRole(
  localName: string,
  roleAttr: string | undefined,
  stack: readonly OpenFrame[],
): TextLegibilityRole | undefined {
  if (roleAttr !== undefined) {
    if (!isTextLegibilityRole(roleAttr)) {
      throw new Error(
        `SVG emitter rejected <${localName}> with invalid data-text-role (${roleAttr}).`,
      );
    }
    return roleAttr;
  }
  if (localName !== "tspan") return undefined;
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame && (frame.localName === "text" || frame.localName === "tspan")) {
      return frame.effectiveRole;
    }
  }
  return undefined;
}

function popClosingTag(stack: OpenFrame[], localName: string): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]?.localName === localName) {
      stack.length = i;
      return;
    }
  }
}

function advanceSpecialMarkup(
  svg: string,
  lt: number,
  stack: readonly OpenFrame[],
): number | null {
  if (svg.startsWith("<!--", lt)) {
    const close = svg.indexOf("-->", lt + 4);
    return close < 0 ? svg.length : close + 3;
  }
  if (svg.startsWith("<![CDATA[", lt)) {
    const close = svg.indexOf("]]>", lt + 9);
    const body = close < 0 ? svg.slice(lt + 9) : svg.slice(lt + 9, close);
    checkTextChunk(body, stack);
    return close < 0 ? svg.length : close + 3;
  }
  if (svg.startsWith("<?", lt)) {
    const close = svg.indexOf("?>", lt + 2);
    return close < 0 ? svg.length : close + 2;
  }
  if (svg.startsWith("<!", lt)) {
    const close = svg.indexOf(">", lt + 2);
    return close < 0 ? svg.length : close + 1;
  }
  return null;
}

export function validateSvgTextRoles(svg: string): void {
  const stack: OpenFrame[] = [];
  let i = 0;
  while (i < svg.length) {
    const lt = svg.indexOf("<", i);
    checkTextChunk(svg.slice(i, lt < 0 ? svg.length : lt), stack);
    if (lt < 0) break;
    const specialEnd = advanceSpecialMarkup(svg, lt, stack);
    if (specialEnd !== null) {
      i = specialEnd;
      continue;
    }
    if (svg.charAt(lt + 1) === "/") {
      const gt = svg.indexOf(">", lt + 2);
      if (gt < 0) break;
      popClosingTag(stack, localTagName(svg.slice(lt + 2, gt).trim()));
      i = gt + 1;
      continue;
    }
    let nameEnd = lt + 1;
    while (nameEnd < svg.length && !/[\s/>]/.test(svg.charAt(nameEnd))) {
      nameEnd += 1;
    }
    const localName = localTagName(svg.slice(lt + 1, nameEnd));
    const parsed = parseTagEndAndRole(svg, nameEnd, localName);
    const effectiveRole = resolveFrameRole(localName, parsed.roleAttr, stack);
    if (!parsed.selfClosing) {
      const parent = stack.at(-1);
      stack.push({
        localName,
        effectiveRole,
        nonPrintable:
          (parent?.nonPrintable ?? false) || NON_PRINTABLE_TAGS.has(localName),
        inForeignObject:
          (parent?.inForeignObject ?? false) || localName === "foreignObject",
      });
    }
    i = parsed.end;
  }
}
