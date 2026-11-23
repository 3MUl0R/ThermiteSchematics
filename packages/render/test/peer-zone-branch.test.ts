import { expect, it } from "vitest";
import type { ElectricalIr } from "@thermite/compiler";
import { normalizePaperPage } from "../src/packet/page.js";
import { wireScheduleLocations } from "../src/packet/wire-schedule-locations.js";
import { terminalPeerReferences } from "../src/packet/terminal-peer-references.js";
import {
  emitPeerReferences,
  type PeerReference,
} from "../src/packet/peer-reference-ink.js";
import type { Draft, RenderedSheet } from "../src/packet/types.js";
import { escapeXmlAttribute as attr } from "../src/svg/escape.js";
import { boxDistance } from "../src/packet/navigation-symbols.js";
import { printableTextMetrics } from "../src/text-metrics.js";
import { offViewFixture, parseSvg, required } from "./off-view-fixtures.js";

const DRAWING_BOUNDS = { x: 0, y: 0, w: 120, h: 80 };

function makeDraft(
  kind: "wiring" | "circuit",
  drawingBounds = DRAWING_BOUNDS,
): Draft {
  return {
    view: { format: "documentation-view/0.1", kind, title: "Fixture" },
    title: { title: "Fixture" },
    references: [],
    continuations: [],
    content: "",
    drawingBounds,
  };
}

function makeSheet(
  number: number,
  kind: "wiring" | "circuit",
  body: string,
): RenderedSheet {
  return {
    number,
    view: { format: "documentation-view/0.1", kind, title: "Fixture" },
    references: [],
    continuations: [],
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="80mm" viewBox="0 0 120 80">${body}</svg>`,
  };
}

function findFixtures(ir: Readonly<ElectricalIr>) {
  const ps1 = required(ir.devices.find((d) => d.designation === "PS1")).uid;
  const k1 = required(ir.devices.find((d) => d.designation === "K1")).uid;
  const w1 = required(ir.wires.find((w) => w.designation === "W1")).uid;
  return { ps1, k1, w1 };
}

function offViewCardSvg(
  ps1Uid: string,
  w1Uid: string,
  x: number,
  y: number,
): string {
  const terminalId = attr(
    JSON.stringify({ deviceUid: ps1Uid, terminalKey: "+" }),
  );
  const conductors = attr(JSON.stringify([{ kind: "wire", uid: w1Uid }]));
  return (
    `<g class="off-view-annotation" data-off-view-terminal-id="${terminalId}" data-off-view-conductors="${conductors}">` +
    `<rect x="${x}" y="${y}" width="40" height="14" fill="white" stroke="#101828" stroke-width="0.3"/>` +
    `<text class="off-view-heading" x="${x + 2}" y="${y + 4}" font-size="2.5" fill="#101828">Off-view at PS1.+</text>` +
    `<text class="off-view-row" x="${x + 2}" y="${y + 9}" font-size="2.5" fill="#101828">W1 → K1.A1</text>` +
    `</g>`
  );
}

it.each([
  [
    "schematic junction-dot",
    (uid: string) =>
      `<circle class="junction-dot" data-device-uid="${uid}" data-terminal-key="+" cx="50" cy="30" r="1" fill="#101828" stroke="none"/>`,
  ],
  [
    "circuit junction",
    (uid: string) =>
      `<circle data-circuit-junction="true" data-device-uid="${uid}" data-terminal-key="+" cx="50" cy="30" r=".55" fill="#17212b"/>`,
  ],
  [
    "wiring junction",
    (uid: string) =>
      `<circle data-wiring-junction="true" data-device-uid="${uid}" data-terminal-key="+" cx="50" cy="30" r=".65" fill="#344054"/>`,
  ],
  [
    "hidden circuit landing anchor",
    (uid: string) =>
      `<circle data-circuit-landing-for="p0" data-device-uid="${uid}" data-terminal-key="+" cx="50" cy="30" r=".001" fill="none" stroke="none"/>`,
  ],
  [
    "hidden wiring landing anchor",
    (uid: string) =>
      `<circle data-wiring-landing-for="p0" data-device-uid="${uid}" data-terminal-key="+" cx="50" cy="30" r=".001" fill="none" stroke="none"/>`,
  ],
])(
  "wireScheduleLocations ignores %s emitted before physical terminal-marker",
  async (_label, branchCircle) => {
    const fixture = await offViewFixture();
    try {
      const page = normalizePaperPage();
      if (!page.ok) throw Error("paper");
      const { ps1, k1, w1 } = findFixtures(fixture.ir);
      const physicalPs1 = `<circle class="terminal-marker" data-device-uid="${ps1}" data-terminal-key="+" cx="30" cy="30" r="1" fill="white" stroke="#101828"/>`;
      const physicalK1 = `<circle class="terminal-marker" data-device-uid="${k1}" data-terminal-key="A1" cx="90" cy="30" r="1" fill="white" stroke="#101828"/>`;
      // Branch circle is in zone B3 (x=50, y=30); physical PS1.+ is in zone B2 (x=30, y=30).
      const withPhysical = wireScheduleLocations(
        fixture.ir,
        [makeDraft("wiring")],
        [makeSheet(4, "wiring", branchCircle(ps1) + physicalPs1 + physicalK1)],
        page.value,
      );
      expect(withPhysical.get(w1)).toEqual(["04.B2", "04.B5"]);

      // A branch circle alone without a physical terminal must not invent a drawn zone.
      const branchOnly = wireScheduleLocations(
        fixture.ir,
        [makeDraft("wiring")],
        [makeSheet(4, "wiring", branchCircle(ps1) + physicalK1)],
        page.value,
      );
      expect(branchOnly.get(w1)).toEqual([undefined, "04.B5"]);
    } finally {
      await fixture.dispose();
    }
  },
);

it("terminalPeerReferences chooses physical terminal zone over preceding branch junction-dot and preserves alternates", async () => {
  const fixture = await offViewFixture();
  try {
    const page = normalizePaperPage();
    if (!page.ok) throw Error("paper");
    const { ps1, k1, w1 } = findFixtures(fixture.ir);
    // Sheet 1: junction-dot at B3 (50, 30) BEFORE physical terminal-marker at B2 (30, 30).
    const s1Body =
      `<circle class="junction-dot" data-device-uid="${ps1}" data-terminal-key="+" cx="50" cy="30" r="1" fill="#101828" stroke="none"/>` +
      `<circle class="terminal-marker" data-device-uid="${ps1}" data-terminal-key="+" cx="30" cy="30" r="1" fill="white" stroke="#101828"/>` +
      offViewCardSvg(ps1, w1, 2, 2);
    // Sheet 2: second physical appearance of PS1.+ at B2 (30, 30) with off-view card.
    const s2Body =
      `<circle class="terminal-marker" data-device-uid="${ps1}" data-terminal-key="+" cx="30" cy="30" r="1" fill="white" stroke="#101828"/>` +
      offViewCardSvg(ps1, w1, 2, 2);
    // Sheet 3: K1.A1 receives peer note pointing to PS1.+; must address 01.B2 (also shown 02.B2), never 01.B3.
    const s3Body = `<circle class="terminal-marker" data-device-uid="${k1}" data-terminal-key="A1" cx="70" cy="40" r="1" fill="white" stroke="#101828"/>`;

    const updated = terminalPeerReferences(
      fixture.ir,
      [makeDraft("wiring"), makeDraft("wiring"), makeDraft("circuit")],
      [
        makeSheet(1, "wiring", s1Body),
        makeSheet(2, "wiring", s2Body),
        makeSheet(3, "circuit", s3Body),
      ],
      page.value,
    );
    const notes = [
      ...parseSvg(updated[2]!.svg).querySelectorAll(
        '[data-peer-reference="conductor-peer"]',
      ),
    ].map((el) => el.textContent?.replace(/\s+/gu, " ").trim());
    expect(notes).toContain("W1 · K1.A1 → PS1.+ 01.B2 (also shown 02.B2)");
    expect(notes.join(" ")).not.toContain("01.B3");
  } finally {
    await fixture.dispose();
  }
});

it("terminalPeerReferences still suppresses redundant peer notes when a wire fans out from a terminal's junction-dot", async () => {
  const fixture = await offViewFixture();
  try {
    const page = normalizePaperPage();
    if (!page.ok) throw Error("paper");
    const { ps1, k1, w1 } = findFixtures(fixture.ir);
    // Sheet 1 draws both PS1.+ (B2), its branch junction-dot (B3), K1.A1 (B5), and W1 from the junction-dot to K1.A1.
    const s1Body =
      `<circle class="junction-dot" data-device-uid="${ps1}" data-terminal-key="+" cx="50" cy="30" r="1" fill="#101828" stroke="none"/>` +
      `<circle class="terminal-marker" data-device-uid="${ps1}" data-terminal-key="+" cx="30" cy="30" r="1" fill="white" stroke="#101828"/>` +
      `<circle class="terminal-marker" data-device-uid="${k1}" data-terminal-key="A1" cx="90" cy="30" r="1" fill="white" stroke="#101828"/>` +
      `<path class="wire-path" data-wire-uid="${w1}" d="M 50 30 H 90" fill="none" stroke="#101828" stroke-width="0.4"/>`;
    // Sheet 2 draws PS1.+ with an off-view card listing W1 → K1.A1.
    const s2Body =
      `<circle class="terminal-marker" data-device-uid="${ps1}" data-terminal-key="+" cx="30" cy="30" r="1" fill="white" stroke="#101828"/>` +
      offViewCardSvg(ps1, w1, 2, 2);

    const updated = terminalPeerReferences(
      fixture.ir,
      [makeDraft("wiring"), makeDraft("wiring")],
      [makeSheet(1, "wiring", s1Body), makeSheet(2, "wiring", s2Body)],
      page.value,
    );
    expect(
      parseSvg(updated[0]!.svg).querySelectorAll("[data-peer-reference]")
        .length,
    ).toBe(0);
  } finally {
    await fixture.dispose();
  }
});

it("emitPeerReferences never places a peer note nearer a foreign terminal than its owner or conductor support", () => {
  const sheet = makeSheet(
    7,
    "circuit",
    `<rect x="10" y="38" width="90" height="4" fill="#17212b"/>`,
  );
  const owner = { x: 20, y: 40, w: 1.3, h: 1.3 };
  const foreign = { x: 60, y: 39.35, w: 1.3, h: 1.3 };
  const along = [{ x: 35, y: 39.99, w: 18, h: 0.02 }];
  // Block slots near owner directly so placement must choose along-conductor or wrapped slot
  // while remaining nearer own support than the foreign terminal at x=60.
  const entry: PeerReference = {
    kind: "conductor-peer",
    identity: [
      { deviceUid: "ps1", terminalKey: "+" },
      { kind: "wire", uid: "w12" },
      { deviceUid: "s2", terminalKey: "11" },
    ],
    owner,
    foreignOwners: [foreign],
    along,
    ownerLabel: "PS1.+",
    value: "W-CTL-012 · PS1.+ → S2.11 07.B2",
    compact: "→ S2.11 07.B2",
    destination: "07.B2",
  };
  const field = { x: 26, y: 20, w: 80, h: 40 };
  const result = emitPeerReferences(sheet, field, [entry]);
  const doc = parseSvg(result.svg);
  const group = doc.querySelector('[data-peer-reference="conductor-peer"]');
  expect(group).not.toBeNull();
  const texts =
    group!.tagName.toLowerCase() === "text"
      ? [group!]
      : [...group!.querySelectorAll("text")];
  const boxes = texts.map((t) => {
    const x = Number(t.getAttribute("x"));
    const y = Number(t.getAttribute("y"));
    const m = printableTextMetrics(t.textContent ?? "", 2.5);
    return {
      x: x + m.left,
      y: y - m.top,
      w: m.right - m.left,
      h: m.top - m.bottom,
    };
  });
  const region = {
    x: Math.min(...boxes.map((b) => b.x)),
    y: Math.min(...boxes.map((b) => b.y)),
    w:
      Math.max(...boxes.map((b) => b.x + b.w)) -
      Math.min(...boxes.map((b) => b.x)),
    h:
      Math.max(...boxes.map((b) => b.y + b.h)) -
      Math.min(...boxes.map((b) => b.y)),
  };
  const ownerGap = Math.min(
    boxDistance(region, owner),
    ...along.map((a) => boxDistance(region, a)),
  );
  const foreignGap = boxDistance(region, foreign);
  expect(ownerGap).toBeLessThanOrEqual(foreignGap);
});
