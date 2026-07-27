import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await (await b.newContext()).newPage();
await p.goto("http://127.0.0.1:4173/?relay=ws://127.0.0.1:8787");
await p.click("text=Enter Cloud9");
await p.waitForSelector("text=# general");
await p.click('button[title="Invite a friend"]');
await p.waitForSelector(".code");
console.log("overlays:", await p.locator(".overlay").count());
console.log("done buttons:", await p.locator("text=Done").count());
for (const el of await p.locator("text=Done").all()) {
  console.log("  candidate:", await el.evaluate(n => n.tagName + "." + n.className + " :: " + n.textContent.slice(0,60)));
}
await b.close();
