import { nativeNeeds, nativeRequestForSheet } from "./m3-native.mjs";
export function packetNativeNeeds(packet, geometries, ir, catalog, request) {
  return packet.sheets.flatMap((s, i) =>
    nativeNeeds(
      s,
      geometries[i],
      ir,
      catalog,
      nativeRequestForSheet(packet, geometries, request, s),
      { packet, geometries, request },
    ).map((n) => ({ ...n, sheet: s.number })),
  );
}
