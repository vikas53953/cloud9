// mint / verify / expire / revoke / single-use, and the binding rule that
// decides which addresses a join listener may answer on.
import test from "node:test";
import assert from "node:assert/strict";
import {
  JoinHubStore, JoinTokenRow, checkJoinToken, mintJoinToken, redeemJoinToken,
  resolveJoinBind, revokeJoinToken,
} from "./joinhub.js";

/**
 * The fake store every test below runs against — a `Map`, not SQLite. It
 * implements `JoinHubStore` exactly, so a swap to the conductor's real
 * SQLite-backed store later changes nothing about the tests above this line.
 */
function fakeStore(): JoinHubStore {
  const rows = new Map<string, JoinTokenRow>();
  return {
    insertJoinToken(row) {
      if (rows.has(row.code)) throw new Error("duplicate join token code");
      rows.set(row.code, { ...row, revoked: false });
    },
    joinToken(code) {
      const row = rows.get(code);
      return row ? { ...row } : undefined;
    },
    spendJoinToken(code, usedBy, usedAt) {
      const row = rows.get(code);
      if (!row) throw new Error("no such join token");
      rows.set(code, { ...row, usedBy, usedAt });
    },
    revokeJoinToken(code) {
      const row = rows.get(code);
      if (row) rows.set(code, { ...row, revoked: true });
    },
  };
}

// ---------------------------------------------------------------------------
// mint

test("mintJoinToken makes a join_-prefixed code, distinct from an inv_ invite", () => {
  const store = fakeStore();
  const code = mintJoinToken(store, "u_owner", 1000);
  assert.match(code, /^join_[A-Za-z0-9_-]{16,}$/);
  assert.doesNotMatch(code, /^inv_/, "a join token must not look like a channel invite code");
});

test("two mints never collide — each is its own row", () => {
  const store = fakeStore();
  const a = mintJoinToken(store, "u_owner", 1000);
  const b = mintJoinToken(store, "u_owner", 1000);
  assert.notEqual(a, b);
  assert.ok(checkJoinToken(store, a, 1001).ok);
  assert.ok(checkJoinToken(store, b, 1001).ok);
});

// ---------------------------------------------------------------------------
// verify (check without spending)

test("checkJoinToken says ok for a freshly minted, unexpired token", () => {
  const store = fakeStore();
  const code = mintJoinToken(store, "u_owner", 1000);
  const result = checkJoinToken(store, code, 1500);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.token.code, code);
    assert.equal(result.token.createdBy, "u_owner");
    assert.equal(result.token.usedBy, undefined);
  }
});

test("checkJoinToken refuses a code that was never minted, in plain words", () => {
  const store = fakeStore();
  const result = checkJoinToken(store, "join_nope", 1000);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /isn't valid/);
});

test("checking a token never spends it", () => {
  const store = fakeStore();
  const code = mintJoinToken(store, "u_owner", 1000);
  checkJoinToken(store, code, 1500);
  checkJoinToken(store, code, 1600);
  const stillGood = checkJoinToken(store, code, 1700);
  assert.equal(stillGood.ok, true, "checking a token repeatedly must not use it up");
});

// ---------------------------------------------------------------------------
// expire

test("checkJoinToken refuses a token past its TTL, in plain words", () => {
  const store = fakeStore();
  const ttlMs = 1000;
  const code = mintJoinToken(store, "u_owner", 0, ttlMs);
  const stillAlive = checkJoinToken(store, code, 999);
  assert.equal(stillAlive.ok, true, "one millisecond before the deadline is still good");

  const dead = checkJoinToken(store, code, 1000);
  assert.equal(dead.ok, false);
  if (!dead.ok) assert.match(dead.reason, /expired/);
});

test("PROVE FAIL: an expired token cannot be redeemed even though it was never revoked or used", () => {
  const store = fakeStore();
  const code = mintJoinToken(store, "u_owner", 0, 1000);
  // Nobody revoked it. Nobody used it. Time alone must be enough to kill it —
  // this is the failure this module exists to prove, once, in the open: a
  // join link is not the kind of secret that is safe to leave lying around
  // forever just because nobody happened to click it or take it back.
  const result = redeemJoinToken(store, code, "u_friend", 10_000);
  assert.equal(result.ok, false, "an expired join token must fail to redeem");
  if (!result.ok) assert.match(result.reason, /expired/);
});

// ---------------------------------------------------------------------------
// revoke

test("revokeJoinToken kills a token nobody has used yet", () => {
  const store = fakeStore();
  const code = mintJoinToken(store, "u_owner", 1000);
  revokeJoinToken(store, code);
  const result = checkJoinToken(store, code, 1001);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /cancelled/);
});

test("revoking an unknown code is a quiet no-op, not a crash", () => {
  const store = fakeStore();
  assert.doesNotThrow(() => revokeJoinToken(store, "join_never-existed"));
});

test("revoking an already-spent token changes nothing about the fact it was spent", () => {
  const store = fakeStore();
  const code = mintJoinToken(store, "u_owner", 1000);
  redeemJoinToken(store, code, "u_friend", 1500);
  revokeJoinToken(store, code);
  const row = store.joinToken(code);
  assert.equal(row?.usedBy, "u_friend");
  assert.equal(row?.revoked, true);
});

// ---------------------------------------------------------------------------
// single-use

test("redeemJoinToken succeeds once and records who was admitted", () => {
  const store = fakeStore();
  const code = mintJoinToken(store, "u_owner", 1000);
  const result = redeemJoinToken(store, code, "u_friend", 1500);
  assert.equal(result.ok, true);
  const row = store.joinToken(code);
  assert.equal(row?.usedBy, "u_friend");
  assert.equal(row?.usedAt, 1500);
});

test("a second redemption of the same code fails, in plain words", () => {
  const store = fakeStore();
  const code = mintJoinToken(store, "u_owner", 1000);
  const first = redeemJoinToken(store, code, "u_friend", 1500);
  assert.equal(first.ok, true);

  const second = redeemJoinToken(store, code, "u_someone_else", 1600);
  assert.equal(second.ok, false, "a spent join token must never admit a second person");
  if (!second.ok) assert.match(second.reason, /already been used/);

  // and the first admission is untouched by the failed second attempt
  const row = store.joinToken(code);
  assert.equal(row?.usedBy, "u_friend");
});

test("PROVE FAIL: redeeming the same code twice in a row does not admit two different people", () => {
  const store = fakeStore();
  const code = mintJoinToken(store, "u_owner", 1000);
  const admitted: string[] = [];
  for (const candidate of ["u_alice", "u_mallory"]) {
    const result = redeemJoinToken(store, code, candidate, 1500);
    if (result.ok) admitted.push(candidate);
  }
  assert.deepEqual(admitted, ["u_alice"], "exactly one person may ever come through one join token");
});

// ---------------------------------------------------------------------------
// binding

test("resolveJoinBind defaults to loopback-only when nothing is requested", () => {
  const result = resolveJoinBind();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.host, "127.0.0.1");
    assert.equal(result.reach, "thisPc");
  }
});

test("resolveJoinBind treats a blank string the same as unset", () => {
  const result = resolveJoinBind("   ");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.reach, "thisPc");
});

test("resolveJoinBind allows a Tailscale (CGNAT) address as privateNetwork", () => {
  const result = resolveJoinBind("100.84.12.9");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.host, "100.84.12.9");
    assert.equal(result.reach, "privateNetwork");
  }
});

test("resolveJoinBind allows a Tailscale MagicDNS name as privateNetwork", () => {
  const result = resolveJoinBind("vikas-pc.tail9b2c.ts.net");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.reach, "privateNetwork");
});

test("resolveJoinBind allows a home/office LAN address as localNetwork", () => {
  for (const lan of ["192.168.1.20", "10.0.0.5", "172.20.3.4"]) {
    const result = resolveJoinBind(lan);
    assert.equal(result.ok, true, `${lan} should be allowed`);
    if (result.ok) assert.equal(result.reach, "localNetwork", `${lan} should be localNetwork`);
  }
});

test("resolveJoinBind refuses a public address, in plain words", () => {
  const result = resolveJoinBind("203.0.113.9");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /open internet/);
    assert.doesNotMatch(result.reason, /^(Error|TypeError)/, "a refusal is never a raw exception string");
  }
});

test("resolveJoinBind refuses a public hostname, in plain words", () => {
  const result = resolveJoinBind("example.com");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /open internet/);
});

test("PROVE FAIL: resolveJoinBind refuses 0.0.0.0 — every-interface is not a private network", () => {
  const result = resolveJoinBind("0.0.0.0");
  assert.equal(result.ok, false, "0.0.0.0 must never be handed back as a bindable address");
  if (!result.ok) assert.match(result.reason, /every network/);
});

test("resolveJoinBind refuses the other every-interface spellings too", () => {
  for (const wildcard of ["::", "*", "0", "::0", "[::]"]) {
    const result = resolveJoinBind(wildcard);
    assert.equal(result.ok, false, `"${wildcard}" must be refused`);
  }
});

test("resolveJoinBind refuses a host classifyHost does not recognise", () => {
  const result = resolveJoinBind("not a hostname at all!!");
  assert.equal(result.ok, false);
});
