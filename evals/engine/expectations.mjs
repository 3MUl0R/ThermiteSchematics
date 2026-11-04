// The sole open-gap registry. Each line is independently removable; retiring a
// marker changes checker bytes, never corpus bytes. Preconditions are not gaps.
import { isDeepStrictEqual } from "node:util";
const absentRatingAssessment = (owner, reason) => ({
  owner,
  reason,
  signature: (e) =>
    e.ok === true &&
    e.exit === 0 &&
    isDeepStrictEqual(e.diagnostics, []) &&
    isDeepStrictEqual(e.ratingConflict, {
      net: ["N1.a", "N1.b"],
      ratings: {
        "N1.a": { nominal_voltage: 24, voltage_type: "DC" },
        "N1.b": { nominal_voltage: 48, voltage_type: "AC" },
      },
      potentialUids: [],
    }),
});
// prettier-ignore
export const expectations = {
  "mutation/ratings-without-potential": absentRatingAssessment("V1", "Report conflicting explicit ratings or report the obligation unassessed; no future code or pointer is prescribed"),
};
