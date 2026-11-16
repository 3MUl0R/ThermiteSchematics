import { AsyncLocalStorage } from "node:async_hooks";
import type { NavigationGeometry } from "./navigation-walk.js";

export const navigationCache = new AsyncLocalStorage<{
  entries: Map<string, NavigationGeometry[]>;
  nodes: number;
  snapshots: WeakMap<object, string>;
}>();

/** Share only within an immutable render operation, including its exact previews. */
export function withNavigationGeometryCache<T>(
  render: () => Promise<T>,
): Promise<T> {
  return navigationCache.getStore()
    ? render()
    : navigationCache.run(
        {
          entries: new Map(),
          nodes: 0,
          snapshots: new WeakMap(),
        },
        render,
      );
}
