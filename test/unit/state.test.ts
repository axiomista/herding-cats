import assert from "node:assert/strict";
import { test } from "node:test";
import { State } from "../../src/state.js";

test("rescheduled and reassigned status changes are set aside, not dropped", () => {
  const state = new State("dry-run");
  state.files.set("f", {
    id: "f", name: "notes.md", version: "1", docType: "meeting notes", model: "m",
    commitments: [], setAside: [], unverified: [],
    statusChanges: [
      { kind: "status_change", action: "Move the survey", newStatus: "rescheduled", evidence: "The survey is rescheduled.", fileId: "f" },
      { kind: "status_change", action: "Give the survey to Pixel", newStatus: "reassigned", evidence: "Pixel will take the survey.", fileId: "f" },
      { kind: "status_change", action: "Cancel the box order", newStatus: "cancelled", evidence: "The box order is cancelled.", fileId: "f" },
    ],
  });
  const aside = state.toAppState().setAside.map((i) => i.newStatus);
  assert.deepEqual(aside, ["rescheduled", "reassigned"]);
});
