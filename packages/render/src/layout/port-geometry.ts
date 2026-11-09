import type { SymbolSide } from "../symbols/types.js";

export function portBorderOffset(
  side: SymbolSide,
  position: Readonly<{ x: number; y: number }>,
  width: number,
  height: number,
): number {
  // ELK 0.12 places a side-constrained zero-size port on the node border. A
  // negative border offset keeps the FIXED_POS anchor at the D6 primitive.
  switch (side) {
    case "west":
      return -position.x;
    case "east":
      return -(width - position.x);
    case "north":
      return -position.y;
    case "south":
      return -(height - position.y);
  }
}
