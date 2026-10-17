import assert from "node:assert/strict";
import { test } from "node:test";
import { metadataPatch } from "../../src/box.js";

test("the first metadata write adds keys and skips empty values", () => {
  assert.deepEqual(metadataPatch({}, { hcDocType: "memo", hcDocDate: "", hcScannedVersion: "1@v1" }), [
    { op: "add", path: "/hcDocType", value: "memo" },
    { op: "add", path: "/hcScannedVersion", value: "1@v1" },
  ]);
});

test("a later metadata write replaces existing keys", () => {
  const existing = { hcDocType: "memo", hcDocDate: "2026-09-08", hcScannedVersion: "1@v1" };
  assert.deepEqual(metadataPatch(existing, { hcDocType: "memo", hcDocDate: "", hcScannedVersion: "2@v1" }), [
    { op: "replace", path: "/hcDocType", value: "memo" },
    { op: "remove", path: "/hcDocDate" },
    { op: "replace", path: "/hcScannedVersion", value: "2@v1" },
  ]);
});
