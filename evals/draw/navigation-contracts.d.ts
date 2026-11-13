/** Independent measured repeat audit. DQ-07 mirrors/returns are E2b. */
export interface RepeatAudit {
  findings: { sheet: number; kind: string; [key: string]: unknown }[];
  measurements: { sheet: number; [key: string]: unknown }[];
  appearanceCount: number;
  repeatCount: number;
}
/** Inactive seam: no mirror/return pass credit before native/ink reconciliation. */
export interface MirrorReturnAudit {
  status: "not-implemented" | "measured";
  coilAppearances: readonly {
    deviceUid: string;
    functionKey: string;
    sheet: number;
    view: number;
  }[];
  contactAppearances: readonly {
    deviceUid: string;
    functionKey: string;
    sheet: number;
    view: number;
  }[];
  findings: readonly { kind: string; sheet: number; [key: string]: unknown }[];
}
