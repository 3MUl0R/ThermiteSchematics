import type { PreparedSchematicDrawing } from "../renderer.js";
import type { RenderFailure } from "../types.js";
import type { DrawingBounds } from "./types.js";
import { bankBounds, type ContinuationBank } from "./continuation-bank.js";
import { rootedGrids } from "./rooted-plans.js";

/** Retain failures from tested cuts, never from uncut source conductors. A grid
 * that passes the cut guards must still report its own later fit constraint. */
export function rootedBankGrids(
  p: PreparedSchematicDrawing,
  b: DrawingBounds,
  scale: number,
  banks: readonly ContinuationBank[],
  explore: boolean,
) {
  let identityFailure: RenderFailure | undefined;
  const rejected = (error: RenderFailure) => {
    if (error.code === "R006" && error.details?.continuationIdentity)
      identityFailure ??= error;
  };
  const grids = banks.flatMap((bank) =>
    rootedGrids(p, bankBounds(b, bank), scale, true, explore, rejected).map(
      (grid) => ({ bank, grid }),
    ),
  );
  if (!grids.length && !identityFailure)
    for (const bank of banks)
      grids.push(
        ...rootedGrids(
          p,
          bankBounds(b, bank),
          scale,
          true,
          true,
          rejected,
          true,
        ).map((grid) => ({ bank, grid })),
      );
  return { grids, identityFailure: grids.length ? undefined : identityFailure };
}
