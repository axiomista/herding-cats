import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evidenceInText, normalizeText, verifyItems } from "../../src/engine/verify.js";
import type { ExtractedItem } from "../../src/types.js";

const doc = (name: string) => readFileSync(`seed/docs/${name}`, "utf8");

const cases: { name: string; file: string; evidence: string; ok: boolean }[] = [
  { name: "kickoff action item, exact", file: "2026-09-21 Kickoff - Project PURRFECT.md",
    evidence: "Tuxedo will book the Q4 All-Paws Meeting in the Great Hall by November 13.", ok: true },
  { name: "sync01 restatement spanning two sentences", file: "2026-09-28 Weekly Sync 01.md",
    evidence: "Tuxedo is still working on booking the Great Hall for the all-paws. Target date is still November 13.", ok: true },
  { name: "memo sentence after a bold label", file: "2026-10-05 Memo - FY27 Treat Budget.md",
    evidence: "Sir Reginald Biscuits will submit a revised R&D treat budget, reflecting the 85% allocation and the salmon-to-granola substitution, by November 2.", ok: true },
  { name: "bold label copied without its asterisks", file: "2026-10-05 Memo - FY27 Treat Budget.md",
    evidence: "Required next step: Sir Reginald Biscuits will submit a revised R&D treat budget", ok: true },
  { name: "sync02 plain text", file: "2026-10-12 Weekly Sync 02.txt",
    evidence: "The Human Acclimation Lab box order is cancelled.", ok: true },
  { name: "brainstorm idea with straight quotes", file: "Brainstorm - Human Augmentation Ideas.md",
    evidence: "Possibly a \"Nap Pod\" pilot.", ok: true },
  { name: "brainstorm idea with curly quotes", file: "Brainstorm - Human Augmentation Ideas.md",
    evidence: "Possibly a “Nap Pod” pilot.", ok: true },
  { name: "handbook policy with extra spaces", file: "Employee Handbook - Section 4 - Rest and Napping Policy.md",
    evidence: "Associates   shall not wake a\nsleeping executive.", ok: true },
  { name: "email with a curly apostrophe", file: "Laser Dynamics - Email Thread Export.txt",
    evidence: "I’ll send you the signed PO by November 10.", ok: true },
  { name: "paraphrase is rejected", file: "2026-09-28 Weekly Sync 01.md",
    evidence: "The tuna dispenser is only dispensing at 60 percent, probably because of the filter.", ok: false },
  { name: "invented commitment is rejected", file: "2026-10-12 Weekly Sync 02.txt",
    evidence: "Pixel will run the Sunbeam of the Month program.", ok: false },
  { name: "changed word is rejected", file: "2026-09-21 Kickoff - Project PURRFECT.md",
    evidence: "Tuxedo will book the Q4 All-Paws Meeting in the Great Hall by November 14.", ok: false },
  { name: "empty evidence is rejected", file: "2026-09-21 Kickoff - Project PURRFECT.md", evidence: "  ", ok: false },
];

for (const c of cases) {
  test(`verify: ${c.name}`, () => assert.equal(evidenceInText(c.evidence, doc(c.file)), c.ok));
}

test("normalizeText folds quotes, emphasis and whitespace", () => {
  assert.equal(normalizeText("  **Bold:**  “x”\n‘y’ "), "Bold: \"x\" 'y'");
});

test("verifyItems splits verified from unverified", () => {
  const items: ExtractedItem[] = [
    { kind: "commitment", action: "a", evidence: "Dale will complete Augmentation Module 1 by October 31." },
    { kind: "commitment", action: "b", evidence: "Dale will finish Module 1 soon." },
  ];
  const { verified, unverified } = verifyItems(items, doc("2026-09-28 Weekly Sync 01.md"));
  assert.deepEqual(verified.map((i) => i.action), ["a"]);
  assert.deepEqual(unverified.map((i) => i.action), ["b"]);
});
