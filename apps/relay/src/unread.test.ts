// Account-level unread must report the true count — never a silent ceiling of
// 1000 that the screen then prints as "999".
import test from "node:test";
import assert from "node:assert/strict";
import { Message } from "@cloud9/shared";
import { Store } from "./store.js";
import { tmp } from "./testclient.js";

test("unread past a thousand is still the real number, not a capped 1000", () => {
  const store = new Store(tmp("unread-cap.db"), { ownerToken: "tok-owner" });
  const owner = store.ensureOwner("Vikas", "tok-owner");
  const rajId = "u_raj";
  store.db.prepare("INSERT INTO users(id,name) VALUES(?,?)").run(rajId, "Raj");
  store.createChannel({
    id: "ch1", name: "general", kind: "channel",
    memberIds: [owner.id, rajId], createdAt: 1,
  });
  store.markRead(owner.id, "ch1", 0);

  const total = 1005;
  for (let i = 1; i <= total; i++) {
    const m: Message = {
      id: `m${i}`, channelId: "ch1", authorId: rajId, authorName: "Raj",
      authorKind: "human", text: `note ${i}`, ts: i,
    };
    store.saveMessage(m);
  }

  const entry = store.unreadFor(owner.id, "ch1", new Set([owner.id]));
  assert.equal(entry.unread, total,
    `hub must report the true unread count (${total}), not stop at 1000`);
});
