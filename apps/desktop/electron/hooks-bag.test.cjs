// Pure unit of the desktop hooks-bag merge rule.
// The live store uses keepHooksBag so settle(list) cannot wipe audit/pending/test.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/** Mirror of keepHooksBag in apps/desktop/src/store.ts — class rule under test. */
function keepHooksBag(prior, patch) {
  return { ...prior, ...patch };
}

test("list answer keeps audit history and pending mutation state", () => {
  const prior = {
    asked: false,
    requestId: "hooks-1",
    list: [],
    auditAsked: true,
    auditLoading: true,
    auditRequestId: "audit-1",
    audit: [{ action: "created", said: "hook created", at: 1 }],
    pending: { "mut-1": true },
    mutationRequestId: "mut-1",
    test: { hookId: "h1", ok: true, said: "ready" },
  };
  const next = keepHooksBag(prior, {
    asked: true,
    list: [{ id: "h1", name: "Done" }],
    problem: undefined,
  });
  assert.equal(next.asked, true);
  assert.equal(next.list[0].id, "h1");
  assert.equal(next.auditRequestId, "audit-1");
  assert.equal(next.auditAsked, true);
  assert.equal(next.auditLoading, true);
  assert.equal(next.audit.length, 1);
  assert.equal(next.pending["mut-1"], true);
  assert.equal(next.mutationRequestId, "mut-1");
  assert.equal(next.test.hookId, "h1");
  assert.equal(next.requestId, "hooks-1");
});

test("bare two-field replace would have wiped audit — the class bug", () => {
  const prior = {
    asked: false,
    requestId: "hooks-1",
    list: [],
    audit: [{ action: "created", said: "kept", at: 1 }],
    auditAsked: true,
    pending: { "mut-1": true },
  };
  const wiped = { asked: true, list: [{ id: "h1" }] };
  assert.equal(wiped.audit, undefined);
  assert.equal(wiped.pending, undefined);
  const kept = keepHooksBag(prior, wiped);
  assert.equal(kept.audit.length, 1);
  assert.equal(kept.pending["mut-1"], true);
});

test("store.ts askHooks always spreads the prior hooks bag", () => {
  const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
  const askStart = store.indexOf("askHooks(): void");
  const askEnd = store.indexOf("askHooksAudit(): void");
  assert.ok(askStart >= 0 && askEnd > askStart);
  const body = store.slice(askStart, askEnd);
  assert.match(body, /keepHooksBag/);
  assert.match(body, /\.\.\.this\.world\.hooks/);
  // The pre-fix class bug: assign a brand-new two-field object on list answer.
  assert.doesNotMatch(body, /this\.world\.hooks = \{ asked: true, list: f\.hooks \}/);
  assert.doesNotMatch(body, /this\.world\.hooks = \{ asked: false, requestId, list: \[\] \}/);
});
