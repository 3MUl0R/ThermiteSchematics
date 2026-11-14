import type { PaperPage } from "../../packet/types.js";
import type { PacketRequest, Presentation, TitleSources } from "./model.js";
import { useCompactFrame } from "../../packet/frame-profile.js";

export interface TitleFrameContext {
  readonly presentation: Presentation;
  readonly request: PacketRequest;
  readonly sources?: TitleSources;
}
const contexts = new WeakMap<PaperPage, TitleFrameContext>();
/** A normalized page owns the selected frame and authored metadata. */
export function configureTitleFrame(
  page: PaperPage,
  context: TitleFrameContext,
) {
  useCompactFrame(page);
  contexts.set(page, context);
}
export function titleFrameContext(page: PaperPage) {
  return contexts.get(page);
}

interface AuthoredTitleContext extends TitleFrameContext {
  readonly viewIndex?: number;
  readonly firstSheet?: number;
}
const presentations = new WeakMap<object, AuthoredTitleContext>();
export function registerTitlePresentation(
  presentation: object,
  context: AuthoredTitleContext,
) {
  presentations.set(presentation, context);
}
export function titlePresentationContext(presentation: object | undefined) {
  return presentation && presentations.get(presentation);
}
export function authoredTitlePresentation(
  presentation:
    import("@thermite/compiler").CompiledProjectPresentation | undefined,
  page: PaperPage,
  viewIndex: number,
  firstSheet: number,
) {
  const context = titleFrameContext(page);
  if (!context || !presentation) return presentation;
  const authored = { ...presentation };
  registerTitlePresentation(authored, {
    ...context,
    viewIndex: viewIndex + 1,
    firstSheet,
  });
  return authored;
}

export function packetFrameMetadata(page: PaperPage) {
  return titleFrameContext(page)
    ? { presentationFormat: "project-presentation/0.3" as const }
    : {};
}
