import type { ElectricalIr } from "@thermite/compiler";
import {
  prepareSignalLoopDrawing,
  selectSignalLoop,
  type SignalLoopViewRequest,
} from "../signal-loop.js";

/** Keep the exact Round 2 acceptance boundary after the inline/6 mm attempt. */
export async function preparePrintableSignalLoop(
  ir: Readonly<ElectricalIr>,
  request: SignalLoopViewRequest,
  fits: (
    drawing: Awaited<ReturnType<typeof prepareSignalLoopDrawing>>,
  ) => boolean,
) {
  if (request.flow !== "top-to-bottom")
    return prepareSignalLoopDrawing(ir, request);
  const selected = selectSignalLoop(ir, request);
  if (!selected.output || selected.series)
    return prepareSignalLoopDrawing(ir, request);
  let drawing;
  try {
    drawing = await prepareSignalLoopDrawing(ir, request);
  } catch {
    return prepareSignalLoopDrawing(ir, request, "round2");
  }
  return fits(drawing)
    ? drawing
    : prepareSignalLoopDrawing(ir, request, "round2");
}
