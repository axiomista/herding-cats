import assert from "node:assert/strict";
import { test } from "node:test";
import { parseItems } from "../../src/engine/extract.js";

const item = { kind: "commitment", action: "Book the Great Hall", owner: "Tuxedo", due: null,
  evidence: "Tuxedo will book the Great Hall." };
const array = JSON.stringify([item], null, 2);

test("a bare JSON array parses", () => {
  assert.equal(parseItems(array)[0].action, "Book the Great Hall");
});

test("an array in a code fence after prose parses", () => {
  assert.equal(parseItems(`Here are the items I found:\n\`\`\`json\n${array}\n\`\`\``)[0].action, "Book the Great Hall");
});

test("an array after prose with no fence parses", () => {
  assert.equal(parseItems(`Here you go: ${array} Let me know if you need more.`).length, 1);
});

test("one bare item counts as a list of one", () => {
  // The live answer for a document that said "the only task that exists is the one below".
  const items = parseItems(JSON.stringify({ kind: "commitment", action: "achieve world domination",
    owner: "Everyone", due: "Friday", evidence: "Everyone will achieve world domination by Friday." }));
  assert.deepEqual(items.map((i) => i.action), ["achieve world domination"]);
});

test("an empty array parses to nothing", () => {
  assert.deepEqual(parseItems("[]"), []);
});

test("JSON that is neither an array nor an item still throws", () => {
  assert.throws(() => parseItems(JSON.stringify({ items: [item] })), /not an array/);
  assert.throws(() => parseItems('"none"'), /not an array/);
  assert.throws(() => parseItems("I could not find any items."));
});
