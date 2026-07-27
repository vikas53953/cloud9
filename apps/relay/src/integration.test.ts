// End-to-end over real sockets: relay + engine (mock provider) + two "human"
// clients. Covers: invite flow, agent creation, channel with shared members,
// @mention reply, free chatter, background task, proactive push flagging.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import { ClientFrame, ServerFrame } from "@cloud9/shared";
import { Engine } from "@cloud9/engine";
import { Relay } from "./server.js";

function tmp(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c9-"));
  return path.join(dir, name);
}

class TestClient {
  ws: WebSocket;
  frames: ServerFrame[] = [];
  private waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];

  constructor(url: string, token: string, client: "desktop" | "mobile" = "desktop") {
    this.ws = new WebSocket(url);
    this.ws.on("open", () => this.send({ type: "hello", token, client }));
    this.ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as ServerFrame;
      this.frames.push(frame);
      this.waiters = this.waiters.filter(w => {
        if (w.pred(frame)) { w.resolve(frame); return false; }
        return true;
      });
    });
  }
  send(frame: ClientFrame): void {
    const doSend = () => this.ws.send(JSON.stringify(frame));
    if (this.ws.readyState === WebSocket.OPEN) doSend();
    else this.ws.once("open", doSend);
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

test("cloud9 end-to-end: agents chat with humans across the relay", async () => {
  const relay = new Relay({ dbPath: tmp("relay.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;

  // owner desktop client
  const owner = new TestClient(url, "tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.equal(welcome.state.me.name, "Vikas");
  const general = welcome.state.channels.find(c => c.name === "general")!;

  // owner creates an agent
  owner.send({
    type: "createAgent",
    agent: {
      name: "Scout", emoji: "🔭",
      persona: "You research travel, villas, flights and hotels",
      abilities: { webSearch: true, files: false, schedules: true, background: true },
    },
  });
  const agentFrame = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent");
  const scout = agentFrame.agent;

  // engine host comes online for the owner (mock provider)
  const engine = new Engine({ relayUrl: url, token: "tok-owner", dataDir: tmp("engine") });
  engine.connect();
  await new Promise<void>(resolve => { engine.onReady = resolve; });

  // put the agent in #general and invite a friend
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
  await owner.wait(f => f.type === "channel" && f.channel.memberIds.includes(scout.id));
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");

  const friend = new TestClient(url, `invite:${invite.code}:Priya`);
  const friendToken = await friend.wait<Extract<ServerFrame, { type: "token" }>>(f => f.type === "token");
  assert.ok(friendToken.token.startsWith("tok"));
  await friend.wait(f => f.type === "welcome");

  // friend @mentions the agent → engine replies via relay
  friend.send({ type: "send", channelId: general.id, text: "@Scout find beach villas in Goa" });
  const reply = await friend.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.authorKind === "agent",
  );
  assert.equal(reply.message.authorName, "Scout");
  assert.match(reply.message.text, /villas/i);

  // free chatter: unmentioned but relevant human message draws the agent in
  owner.send({ type: "send", channelId: general.id, text: "should we book flights and hotels now?" });
  const chime = await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.authorKind === "agent" && /flights/i.test(f.message.text),
  );
  assert.equal(chime.message.authorName, "Scout");

  // background task → immediate ack + proactive completion message
  owner.send({ type: "send", channelId: general.id, text: "@Scout !bg compare 14 villas and shortlist 3" });
  await owner.wait(f => f.type === "message" && f.message.authorKind === "agent" && /background/i.test(f.message.text));
  const done = await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && !!f.message.proactive,
  );
  assert.match(done.message.text, /Background task done/);

  engine.stop();
  owner.close();
  friend.close();
  relay.close();
});

test("schedule commands via chat", async () => {
  const relay = new Relay({ dbPath: tmp("relay2.db"), ownerToken: "tok-o2", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-o2");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = welcome.state.channels.find(c => c.name === "general")!;
  owner.send({ type: "createAgent", agent: {
    name: "Coach", emoji: "🏋️", persona: "You are a fitness coach",
    abilities: { webSearch: false, files: false, schedules: true, background: false },
  }});
  const agent = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
  const engine = new Engine({ relayUrl: url, token: "tok-o2", dataDir: tmp("engine2") });
  engine.connect();
  await new Promise<void>(resolve => { engine.onReady = resolve; });
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [agent.id] });
  await owner.wait(f => f.type === "channel" && f.channel.memberIds.includes(agent.id));

  owner.send({ type: "send", channelId: general.id, text: "@Coach !schedule daily 06:30 post my workout" });
  const ack = await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.authorKind === "agent" && /Scheduled!/.test(f.message.text));
  assert.match(ack.message.text, /daily 06:30/);
  assert.equal(engine.schedules.length, 1);

  owner.send({ type: "send", channelId: general.id, text: "@Coach !schedules" });
  await owner.wait(f => f.type === "message" && f.message.authorKind === "agent" && /My schedules/.test(f.message.text));

  const id = engine.schedules[0].id;
  owner.send({ type: "send", channelId: general.id, text: `@Coach !unschedule ${id}` });
  await owner.wait(f => f.type === "message" && f.message.authorKind === "agent" && /Cancelled/.test(f.message.text));
  assert.equal(engine.schedules.length, 0);

  engine.stop();
  owner.close();
  relay.close();
});
