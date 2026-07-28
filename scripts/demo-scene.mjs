// Stage a lively demo scene, then screenshot the real app for Vikas.
import WebSocket from "ws";
import { chromium } from "playwright";

const URL = "ws://127.0.0.1:8787";
const frames = [];
const ws = new WebSocket(URL);
const send = f => ws.send(JSON.stringify(f));
const wait = (pred, ms = 6000) => new Promise((res, rej) => {
  const hit = frames.find(pred); if (hit) return res(hit);
  const t = setTimeout(() => rej(new Error("timeout")), ms);
  waiters.push({ pred, res: f => { clearTimeout(t); res(f); } });
});
const waiters = [];
ws.on("message", raw => {
  const f = JSON.parse(String(raw));
  frames.push(f);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].pred(f)) { waiters.splice(i, 1)[0].res(f); }
  }
});
await new Promise(r => ws.on("open", r));
send({ type: "hello", token: "dev-owner-token", client: "desktop" });
const welcome = await wait(f => f.type === "welcome");

// two agents
send({ type: "createAgent", agent: { name: "Scout", emoji: "🔭",
  persona: "You research travel, villas, flights and hotels for trips, always with prices and links",
  abilities: { webSearch: true, files: false, schedules: true, background: true } } });
const scout = (await wait(f => f.type === "agent" && f.agent.name === "Scout")).agent;
send({ type: "createAgent", agent: { name: "Chef", emoji: "🍳",
  persona: "You plan meals, recipes, restaurants and food crawls",
  abilities: { webSearch: true, files: true, schedules: true, background: false } } });
const chef = (await wait(f => f.type === "agent" && f.agent.name === "Chef")).agent;

// channel with both agents
send({ type: "createChannel", name: "trip-goa", memberIds: [scout.id, chef.id], kind: "channel" });
const chan = (await wait(f => f.type === "channel" && f.channel.name === "trip-goa")).channel;

// conversation: mention → reply; then a food question that draws Chef in
send({ type: "send", channelId: chan.id, text: "@Scout find beach villas in Goa under ₹8k/night for Dec 12–15" });
await wait(f => f.type === "message" && f.message.authorName === "Scout", 8000);
send({ type: "send", channelId: chan.id, text: "also what food and restaurants should we plan around Anjuna?" });
await wait(f => f.type === "message" && f.message.authorName === "Chef", 8000);
send({ type: "send", channelId: chan.id, text: "@Scout !bg compare 14 villas and shortlist the best 3" });
await wait(f => f.type === "message" && f.message.proactive, 10000);
ws.close();

// screenshots
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await p.goto("http://127.0.0.1:4173/?relay=ws://127.0.0.1:8787");
await p.click("text=Enter Cloud9");
await p.waitForSelector(".sidebar >> text=# trip-goa");
await p.click(".sidebar >> text=# trip-goa");
await p.waitForSelector(".msg");
await p.waitForTimeout(400);
await p.screenshot({ path: "docs/qa/design-main.png" });
await p.keyboard.press("Control+k");
await p.waitForSelector(".qc-input");
await p.screenshot({ path: "docs/qa/design-quickchat.png" });
await p.keyboard.press("Escape");
await p.click('button[title="New agent"]');
await p.waitForSelector(".panel");
await p.screenshot({ path: "docs/qa/design-new-agent.png" });
await b.close();
console.log("done");
