// The HUB half of "join a friend's Cloud9": minting a join link, redeeming it
// from a fresh socket, and every way that must be refused. `joinhub.ts` owns
// the token arithmetic (proved in joinhub.test.ts); this proves it is wired
// into `server.ts` correctly — owner-gated mint, single use, network-aware
// bind, and that admitting a join grants nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import { ClientFrame, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";

function tmp(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c9-join-"));
  return path.join(dir, name);
}

/** A socket that speaks the protocol but sends nothing until told — so a join
 *  can arrive as its FIRST frame, instead of a `hello`. */
class RawClient {
  ws: WebSocket;
  frames: ServerFrame[] = [];
  private waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as ServerFrame;
      this.frames.push(frame);
      this.waiters = this.waiters.filter(w => {
        if (w.pred(frame)) { w.resolve(frame); return false; }
        return true;
      });
    });
  }
  private open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise(res => this.ws.once("open", () => res()));
  }
  async send(frame: ClientFrame): Promise<void> {
    await this.open();
    this.ws.send(JSON.stringify(frame));
  }
  wait<T extends ServerFrame>(pred: (f: ServerFrame) => boolean, ms = 5000): Promise<T> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), ms);
      this.waiters.push({ pred, resolve: f => { clearTimeout(timer); resolve(f as T); } });
    });
  }
  close(): void { this.ws.close(); }
}

function ownerHello(url: string, token: string): RawClient {
  const c = new RawClient(url);
  void c.send({ type: "hello", token, client: "desktop" });
  return c;
}

test("join tokens: owner mints, a fresh socket redeems ONCE into a new user", async () => {
  const relay = new Relay({ dbPath: tmp("join.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;

  const owner = ownerHello(url, "tok-owner");
  await owner.wait(f => f.type === "welcome");
  await owner.send({ type: "createJoinToken" });
  const minted = await owner.wait<Extract<ServerFrame, { type: "joinToken" }>>(f => f.type === "joinToken");
  assert.ok(minted.code.startsWith("join_"), "a join token is prefixed join_");
  assert.ok(minted.expiresInMs > 0);

  // a friend on a fresh socket redeems it — gets a durable token AND a welcome
  const friend = new RawClient(url);
  await friend.send({ type: "joinWithToken", token: minted.code, displayName: "Priya" });
  const tok = await friend.wait<Extract<ServerFrame, { type: "token" }>>(f => f.type === "token");
  assert.ok(tok.token.length > 10);
  const welcome = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.equal(welcome.state.me.name, "Priya");
  // the display name is a LABEL — the account is fresh, not the owner's (P0 #1)
  assert.notEqual(welcome.state.me.id, relay.ownerId);
  assert.ok(welcome.state.channels.some(c => c.name === "general"), "the joiner lands in #general");

  // a SECOND redemption of the same code is refused
  const late = new RawClient(url);
  await late.send({ type: "joinWithToken", token: minted.code, displayName: "Impostor" });
  const err = await late.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /already been used/i);

  owner.close(); friend.close(); late.close(); relay.close();
});

test("join tokens: the owner can cancel an unredeemed link, and it then refuses", async () => {
  const relay = new Relay({ dbPath: tmp("join2.db"), ownerToken: "tok-o2" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;

  const owner = ownerHello(url, "tok-o2");
  await owner.wait(f => f.type === "welcome");
  await owner.send({ type: "createJoinToken" });
  const minted = await owner.wait<Extract<ServerFrame, { type: "joinToken" }>>(f => f.type === "joinToken");

  await owner.send({ type: "revokeJoinToken", code: minted.code });
  // give the write a beat, then try to redeem
  const friend = new RawClient(url);
  await friend.send({ type: "joinWithToken", token: minted.code, displayName: "Late" });
  const err = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /cancelled|isn't valid/i);

  owner.close(); friend.close(); relay.close();
});

test("join tokens: a NON-owner cannot mint or cancel one", async () => {
  const relay = new Relay({ dbPath: tmp("join3.db"), ownerToken: "tok-o3" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;

  const owner = ownerHello(url, "tok-o3");
  await owner.wait(f => f.type === "welcome");
  await owner.send({ type: "createJoinToken" });
  const minted = await owner.wait<Extract<ServerFrame, { type: "joinToken" }>>(f => f.type === "joinToken");

  // a friend joins with a legitimate token — then tries to mint one of their own
  const friend = new RawClient(url);
  await friend.send({ type: "joinWithToken", token: minted.code, displayName: "Priya" });
  await friend.wait(f => f.type === "welcome");
  await friend.send({ type: "createJoinToken" });
  const err = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /only the owner/i);
  // admitting a join granted NO extra power: minting is still owner-only.

  owner.close(); friend.close(); relay.close();
});

test("join tokens: a bind the join rule refuses is caught BEFORE the store is touched", async () => {
  const relay = new Relay({ dbPath: tmp("join4.db"), ownerToken: "tok-o4" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;

  const owner = ownerHello(url, "tok-o4");
  await owner.wait(f => f.type === "welcome");
  await owner.send({ type: "createJoinToken" });
  const minted = await owner.wait<Extract<ServerFrame, { type: "joinToken" }>>(f => f.type === "joinToken");

  // Simulate a hub that ended up bound to a public address: the join rule must
  // refuse in words, and the token must remain UNSPENT (the refusal fires
  // first, so a later legitimate redemption on a fixed bind still works).
  relay.bind = "8.8.8.8";
  const friend = new RawClient(url);
  await friend.send({ type: "joinWithToken", token: minted.code, displayName: "Priya" });
  const err = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /open internet|private/i);
  assert.equal(relay.store.joinToken(minted.code)?.usedBy, undefined, "the token was never spent");

  owner.close(); friend.close(); relay.close();
});

test("join tokens: an unknown or malformed code is refused, in words", async () => {
  const relay = new Relay({ dbPath: tmp("join5.db"), ownerToken: "tok-o5" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const friend = new RawClient(url);
  await friend.send({ type: "joinWithToken", token: "join_not-a-real-code", displayName: "X" });
  const err = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /isn't valid|ask for a new one/i);
  friend.close(); relay.close();
});
