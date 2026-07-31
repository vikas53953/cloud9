import test from "node:test";
import assert from "node:assert/strict";
import {
  activeHub,
  addHub,
  describeHub,
  reconcile,
  removeHub,
  renameHub,
  selfOnlyBook,
  switchTo,
  type HubBook,
  type HubBookResult,
} from "./hubbook.js";
import {
  parseHubAddress,
  reachInWords,
  type HubAddress,
} from "./hubaddress.js";

function checked(input: string): HubAddress {
  const result = parseHubAddress(input);
  if (!result.ok) throw new Error(result.reason);
  assert.equal(result.ok, true, input);
  return result.address;
}

const SELF = checked("localhost:8787");
const HUGE = "x".repeat(100_000);
const HOSTILE_IDS = [
  "",
  " ",
  "\u200b",
  "\u202eself",
  "__proto__",
  "constructor",
  "prototype",
  HUGE,
] as const;

function assertPlain(value: object): void {
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined);
}

function assertSafeBook(book: HubBook): void {
  assertPlain(book);
  assert.ok(Array.isArray(book.hubs));
  assert.ok(book.hubs.length >= 1 && book.hubs.length <= 20);
  assert.equal(book.hubs.filter(hub => hub.isSelf).length, 1);
  assert.equal(book.hubs[0].id, "self");
  assert.ok(book.hubs.some(hub => hub.id === book.activeId));

  const ids = new Set<string>();
  const addresses = new Set<string>();
  for (const hub of book.hubs) {
    assertPlain(hub);
    assertPlain(hub.address);
    assert.ok(!ids.has(hub.id));
    ids.add(hub.id);
    const key = `${hub.address.host.toLowerCase()}:${hub.address.port}`;
    assert.ok(!addresses.has(key));
    addresses.add(key);
    assert.ok(hub.label.length >= 1 && hub.label.length <= 40);
    assert.ok(Number.isInteger(hub.address.port));
    assert.ok(hub.address.port >= 1 && hub.address.port <= 65_535);
    assert.notEqual(hub.address.reach, "public");
  }
}

function assertSafeResult(result: HubBookResult): void {
  assertPlain(result);
  if (result.ok) {
    assertSafeBook(result.book);
  } else {
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  }
}

test("reconcile absorbs malformed persisted shapes and prototype keys", () => {
  const protoRow = Object.create(null) as Record<string, unknown>;
  protoRow["__proto__"] = { polluted: true };
  protoRow["constructor"] = { prototype: { polluted: true } };
  protoRow.id = "__proto__";
  protoRow.label = "Prototype payload";
  protoRow.address = checked("100.64.0.1:8787");

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const malformed: unknown[] = [
    undefined,
    null,
    false,
    true,
    0,
    -1,
    Number.MAX_SAFE_INTEGER,
    NaN,
    Infinity,
    0n,
    Symbol("book"),
    "",
    HUGE,
    [],
    {},
    cyclic,
    { hubs: null, activeId: "__proto__" },
    { hubs: HUGE, activeId: "constructor" },
    { hubs: [null, false, 0, "", [], {}, protoRow], activeId: "__proto__" },
    {
      hubs: [
        { id: "self", label: "counterfeit", address: SELF, isSelf: false },
        { id: "constructor", label: "\u202eFriend", address: checked("100.64.0.2"), isSelf: true },
        { id: "duplicate", label: HUGE, address: checked("100.64.0.2") },
        { id: "bad-port", label: "Bad port", address: { ...SELF, port: Infinity } },
        { id: "public", label: "Public", address: { ...SELF, host: "8.8.8.8" } },
      ],
      activeId: "prototype",
      ["__proto__"]: { polluted: true },
      constructor: { prototype: { polluted: true } },
    },
  ];

  for (const raw of malformed) {
    let book: HubBook | undefined;
    assert.doesNotThrow(() => {
      book = reconcile(raw, SELF);
    }, `reconcile threw for ${typeof raw}`);
    assertSafeBook(book as HubBook);
  }
});

test("all book edits safely refuse hostile ids, labels, and addresses", () => {
  const base = selfOnlyBook(SELF);
  assertSafeBook(base);

  const shared = [
    "",
    "\u200b",
    "\u202e100.64.0.1",
    "__proto__",
    "constructor",
    "100.64.0.1:0",
    "100.64.0.1:-1",
    "100.64.0.1:9007199254740992",
    "100.64.0.1:NaN",
    "100.64.0.1:Infinity",
    HUGE,
  ];

  for (const id of HOSTILE_IDS) {
    for (const label of ["", " ", "\u200b", "__proto__", "constructor", HUGE]) {
      const result = addHub(base, id, label, shared[(id.length + label.length) % shared.length]);
      assertSafeResult(result);
      assertSafeBook(base);
    }
    assertSafeResult(removeHub(base, id));
    assertSafeResult(renameHub(base, id, HUGE));
    assertSafeResult(switchTo(base, id));
  }
});

test("prototype-named hubs stay inert through add, switch, rename, and remove", () => {
  let book = selfOnlyBook(SELF);
  for (const [index, id] of ["__proto__", "constructor", "prototype"].entries()) {
    const added = addHub(book, id, `Friend ${index}`, `100.64.1.${index + 1}`);
    assert.equal(added.ok, true);
    if (added.ok) book = added.book;
  }
  assertSafeBook(book);

  for (const id of ["__proto__", "constructor", "prototype"]) {
    const switched = switchTo(book, id);
    assert.equal(switched.ok, true);
    if (!switched.ok) continue;
    assert.equal(activeHub(switched.book).id, id);
    const renamed = renameHub(switched.book, id, `Renamed ${id}`);
    assert.equal(renamed.ok, true);
    if (!renamed.ok) continue;
    const removed = removeHub(renamed.book, id);
    assert.equal(removed.ok, true);
    if (removed.ok) {
      book = removed.book;
      assertSafeBook(book);
    }
  }
});

test("describeHub returns plain text for every reconciled row", () => {
  const book = reconcile({
    hubs: [
      { id: "friend", label: "\u200bFriend", address: checked("100.64.9.9") },
      { id: "constructor", label: "Constructor", address: checked("10.0.0.1") },
    ],
    activeId: "friend",
  }, SELF);

  for (const hub of book.hubs) {
    const line = describeHub(hub, reachInWords);
    assert.equal(typeof line, "string");
    assert.ok(line.length > 0);
    assert.ok(!line.includes("[object Object]"));
  }
  assertSafeBook(book);
});
