// Retain the established ten-degree uncertainty without a fixed bucket boundary.
// Choose a deterministic minimum cover of the circle by arcs at most 10 degrees.
export function mergeRayAngles(values) {
  const angles = [...new Set(values.map((v) => ((v % 360) + 360) % 360))].sort(
    (a, b) => a - b,
  );
  if (!angles.length) return [];
  let best;
  for (let cut = 0; cut < angles.length; cut++) {
    const shifted = [
        ...angles.slice(cut),
        ...angles.slice(0, cut).map((v) => v + 360),
      ],
      groups = [];
    for (const angle of shifted) {
      const last = groups.at(-1);
      if (last && angle - last[0] <= 10 + 1e-9) last.push(angle);
      else groups.push([angle]);
    }
    const result = groups
      .map((g) => (Math.round(g[0] / 10) * 10) % 360)
      .sort((a, b) => a - b);
    if (
      !best ||
      result.length < best.length ||
      (result.length === best.length &&
        JSON.stringify(result) < JSON.stringify(best))
    )
      best = result;
  }
  return best;
}
