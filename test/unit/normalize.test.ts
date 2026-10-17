import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dedupe, emailSender, loadPeople, resolveDate, resolveOwner } from "../../src/engine/normalize.js";
import type { Commitment } from "../../src/types.js";

const people = loadPeople();
const VANESSA = people.users.vanessa;
const ZAQ = people.users.zaq;
const email = readFileSync("seed/docs/Laser Dynamics - Email Thread Export.txt", "utf8");
const ctx = { docType: "meeting notes", text: "", evidence: "" };

const owners: { written: string | undefined; owner?: string; userId?: string; flag?: string }[] = [
  { written: "Tuxedo", owner: "Tuxedo Meowtani", userId: ZAQ },
  { written: "Tuxedo Meowtani (COO)", owner: "Tuxedo Meowtani", userId: ZAQ },
  { written: "Sir Reginald Biscuits", owner: "Sir Reginald Biscuits", userId: VANESSA },
  { written: "Biscuits", owner: "Sir Reginald Biscuits", userId: VANESSA },
  { written: "dale", owner: "Dale Henderson", userId: VANESSA },
  { written: "Pixel", owner: "Pixel", userId: ZAQ },
  { written: "The Chairmeow", owner: "Chairmeow Baroness Nyanland", flag: "owner has no Box user" },
  { written: "Gary Okafor", owner: "Gary Okafor", flag: "owner external" },
  { written: "Mittens", owner: "Mittens", flag: "owner unresolved" },
  { written: undefined, flag: "owner missing" },
  { written: "I", owner: "I", flag: "owner unresolved" }, // "I" outside an email
];

for (const o of owners) {
  test(`owner: ${o.written ?? "(none)"}`, () => {
    const r = resolveOwner(o.written, people, ctx);
    assert.equal(r.owner, o.owner);
    assert.equal(r.userId, o.userId);
    assert.deepEqual(r.flags, o.flag ? [o.flag] : []);
  });
}

test("owner: 'I' in an email is the sender of that message", () => {
  const r = resolveOwner("I", people, { docType: "email thread", text: email,
    evidence: "I'll send you the signed PO by October 20." });
  assert.deepEqual(r, { owner: "Pixel", userId: ZAQ, flags: [] });
});

test("emailSender finds the right message in a thread", () => {
  assert.equal(emailSender(email, "I'll need a signed purchase order."), "Gary Okafor");
  assert.equal(emailSender(email, "It is not catchable."), "Gary Okafor");
  assert.equal(emailSender(email, "Tuxedo has approved the spend."), "Pixel");
});

const dates: { written: string | undefined; docDate?: string; due?: string; absolute: boolean; flag?: string }[] = [
  { written: "October 23", docDate: "2026-09-08", due: "2026-10-23", absolute: true },
  { written: "by October 1", docDate: "2026-09-15", due: "2026-10-01", absolute: true },
  { written: "Oct 20", docDate: "2026-10-02", due: "2026-10-20", absolute: true },
  { written: "October 9th", docDate: "2026-09-08", due: "2026-10-09", absolute: true },
  { written: "January 5", docDate: "2026-12-10", due: "2027-01-05", absolute: true },
  { written: "October 23, 2027", docDate: "2026-09-08", due: "2027-10-23", absolute: true },
  { written: "2026-11-01", due: "2026-11-01", absolute: true },
  { written: undefined, absolute: true },
  { written: "next Friday", docDate: "2026-09-08", absolute: false, flag: "date relative" },
  { written: "end of the month", docDate: "2026-09-08", absolute: false, flag: "date relative" },
  { written: "October 23", absolute: false, flag: "date unresolved" },
];

for (const d of dates) {
  test(`date: ${d.written ?? "(none)"} against ${d.docDate ?? "no doc date"}`, () => {
    const r = resolveDate(d.written, d.docDate);
    assert.equal(r.due, d.due);
    assert.equal(r.absolute, d.absolute);
    assert.deepEqual(r.flags, d.flag ? [d.flag] : []);
  });
}

const c = (id: string, fileId: string, text: string, ownerUserId: string): Commitment =>
  ({ id, fileId, fileVersion: "1", text, evidence: `${text}.`, ownerUserId, status: "open" });

test("dedupe merges a restatement by the same owner", () => {
  const out = dedupe([
    c("a", "kickoff", "Book the Q4 All-Paws Meeting in the Great Hall", ZAQ),
    c("b", "sync01", "Book the Great Hall for the all-paws meeting", ZAQ),
  ], 80);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].mentions, [{ fileId: "sync01", evidence: "Book the Great Hall for the all-paws meeting." }]);
});

test("dedupe keeps similar actions by different owners", () => {
  assert.equal(dedupe([
    c("a", "f", "Complete Augmentation Module 1", VANESSA),
    c("b", "f", "Complete Augmentation Module 1", ZAQ),
  ], 80).length, 2);
});

test("dedupe keeps different actions by the same owner", () => {
  assert.equal(dedupe([
    c("a", "f", "Complete Augmentation Module 1", VANESSA),
    c("b", "f", "Replace the break room tuna dispenser filter", VANESSA),
  ], 80).length, 2);
});
