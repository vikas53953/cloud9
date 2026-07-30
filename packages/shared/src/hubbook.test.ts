import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selfOnlyBook, activeHub, addHub, removeHub, renameHub, switchTo, reconcile, describeHub,
} from "./hubbook.js";
import { parseHubAddress, reachInWords, HubAddress } from "./hubaddress.js";

function addr(s: string): HubAddress {
  const r = parseHubAddress(s);
  if (!r.ok) throw new Error(`test address bad: ${s}`);
  return r.address;
}
const SELF = addr("localhost:8787");
const add = (b: ReturnType<typeof selfOnlyBook>, id: string, label: string, shared: string) => {
  const r = addHub(b, id, label, shared);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  return r.ok ? r.book : (undefined as never);
};

test("a fresh book is self only, and self is active", () => {
  const b = selfOnlyBook(SELF);
  assert.equal(b.hubs.length, 1);
  assert.equal(b.hubs[0].isSelf, true);
  assert.equal(activeHub(b).id, "self");
});

test("adding a friend's hub keeps the input untouched (immutable)", () => {
  const b0 = selfOnlyBook(SELF);
  const b1 = add(b0, "h1", "Priya's", "100.100.1.1:8787#inv_AbCdEf0123456789xyz");
  assert.equal(b0.hubs.length, 1, "original book must not change");
  assert.equal(b1.hubs.length, 2);
  assert.equal(b1.hubs[1].address.invite, "inv_AbCdEf0123456789xyz");
});

test("a bad address is refused with the address module's own words", () => {
  const r = addHub(selfOnlyBook(SELF), "h1", "Nope", "8.8.8.8");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /private network/i);
});

test("blank and over-long labels are refused", () => {
  assert.equal(addHub(selfOnlyBook(SELF), "h1", "   ", "100.100.1.1").ok, false);
  assert.equal(addHub(selfOnlyBook(SELF), "h1", "x".repeat(41), "100.100.1.1").ok, false);
});

test("the reserved id and duplicate ids are refused", () => {
  assert.match(addHub(selfOnlyBook(SELF), "self", "clash", "100.100.1.1").ok ? "" :
    (addHub(selfOnlyBook(SELF), "self", "clash", "100.100.1.1") as { reason: string }).reason, /reserved/i);
  const b1 = add(selfOnlyBook(SELF), "h1", "One", "100.100.1.1");
  assert.equal(addHub(b1, "h1", "Two", "100.100.2.2").ok, false);
});

test("the same address twice is caught however it was typed", () => {
  const b1 = add(selfOnlyBook(SELF), "h1", "Priya's", "100.100.1.1:8787");
  const r = addHub(b1, "h2", "Priya again", "cloud9://100.100.1.1:8787");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /already have that address.*Priya's/i);
});

test("the hub ceiling holds", () => {
  let b = selfOnlyBook(SELF);
  for (let i = 0; i < 19; i++) b = add(b, `h${i}`, `Hub ${i}`, `100.100.0.${i + 1}`);
  assert.equal(b.hubs.length, 20);
  assert.equal(addHub(b, "over", "Over", "100.100.9.9").ok, false);
});

test("removing the active hub falls back to self", () => {
  let b = add(selfOnlyBook(SELF), "h1", "Priya's", "100.100.1.1");
  b = (switchTo(b, "h1") as { book: typeof b }).book;
  assert.equal(activeHub(b).id, "h1");
  const r = removeHub(b, "h1");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.book.activeId, "self");
});

test("this computer can never be removed or renamed", () => {
  const b = selfOnlyBook(SELF);
  assert.match((removeHub(b, "self") as { reason: string }).reason, /can't be removed/i);
  assert.match((renameHub(b, "self", "Hey") as { reason: string }).reason, /keeps its name/i);
});

test("rename refuses a duplicate label", () => {
  let b = add(selfOnlyBook(SELF), "h1", "Priya's", "100.100.1.1");
  b = add(b, "h2", "Sam's", "100.100.2.2");
  assert.equal(renameHub(b, "h2", "priya's").ok, false); // case-insensitive clash
  assert.equal(renameHub(b, "h2", "Sam the second").ok, true);
});

test("switchTo refuses an unknown id", () => {
  assert.equal(switchTo(selfOnlyBook(SELF), "ghost").ok, false);
});

test("reconcile repairs a junk file down to a safe book", () => {
  const b = reconcile({ hubs: "not an array", activeId: "ghost" }, SELF);
  assert.equal(b.hubs.length, 1);
  assert.equal(b.activeId, "self");
});

test("reconcile drops malformed rows, dedupes, and fixes a dangling active id", () => {
  const raw = {
    activeId: "gone",
    hubs: [
      { id: "self", label: "sneaky self", address: SELF }, // reserved id → dropped
      { id: "h1", label: "Priya's", address: addr("100.100.1.1:8787") }, // kept
      { id: "h2", label: "dupe", address: addr("100.100.1.1:8787") }, // same address → dropped
      { id: "h3", label: "", address: addr("100.100.3.3") }, // blank label → dropped
      { id: "h4", label: "No address" }, // no address → dropped
    ],
  };
  const b = reconcile(raw, SELF);
  assert.deepEqual(b.hubs.map(h => h.id), ["self", "h1"]);
  assert.equal(b.activeId, "self"); // "gone" wasn't kept → falls back
});

test("describeHub reads plainly", () => {
  const b = add(selfOnlyBook(SELF), "h1", "Priya's", "100.100.1.1");
  assert.equal(describeHub(b.hubs[0], reachInWords), "This computer");
  assert.match(describeHub(b.hubs[1], reachInWords), /Priya's · .*private network/i);
});
