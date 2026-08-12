// Focused Node coverage for the TypeScript draft utility. The desktop test
// command intentionally does not emit `src`, so this test transpiles that one
// module in memory with the same TypeScript compiler used by the workspace.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const SOURCE = path.join(__dirname, "..", "src", "chatdrafts.ts");

function loadDraftModule() {
  const source = fs.readFileSync(SOURCE, "utf8");
  const output = ts.transpileModule(source, {
    fileName: SOURCE,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const module = { exports: {} };
  const context = { module, exports: module.exports };
  vm.runInNewContext(output, context, { filename: SOURCE });
  return module.exports;
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

const drafts = loadDraftModule();
const scope = { channelId: "general", userId: "vikas" };

test("keys isolate user, channel, and optional thread scope", () => {
  const room = drafts.chatDraftKey(scope);
  assert.ok(room.startsWith(`${drafts.CHAT_DRAFT_KEY_PREFIX}:`));
  assert.notEqual(room, drafts.chatDraftKey({ ...scope, userId: "other" }));
  assert.notEqual(room, drafts.chatDraftKey({ ...scope, channelId: "random" }));
  assert.notEqual(room, drafts.chatDraftKey({ ...scope, threadId: "reply-1" }));
  assert.notEqual(room, drafts.chatDraftKey({ ...scope, threadId: "room" }),
    "a real message id must not collide with the room-level sentinel");
  assert.equal(drafts.chatDraftKey({ ...scope, threadId: "" }), room);
});

test("save, load, and clear preserve plain text exactly", () => {
  const storage = memoryStorage();
  const text = "  keep this\nexactly *as typed*  ";
  const saved = drafts.saveChatDraft(scope, text, { storage });
  assert.equal(saved.ok, true);
  assert.equal(saved.key, drafts.chatDraftKey(scope));
  assert.equal(saved.text, text);
  assert.equal(drafts.loadChatDraft(scope, { storage }).text, text);
  assert.equal(drafts.clearChatDraft(scope, { storage }).ok, true);
  assert.equal(drafts.loadChatDraft(scope, { storage }).text, null);
});

test("oversized text is rejected without overwriting the last draft", () => {
  const storage = memoryStorage();
  drafts.saveChatDraft(scope, "last safe draft", { storage });
  const result = drafts.saveChatDraft(
    scope,
    "x".repeat(drafts.CHAT_DRAFT_MAX_LENGTH + 1),
    { storage },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too-long");
  assert.equal(drafts.loadChatDraft(scope, { storage }).text, "last safe draft");
});

test("invalid input and unavailable or throwing storage fail explicitly", () => {
  assert.equal(drafts.chatDraftKey({ channelId: "", userId: "vikas" }), null);
  assert.equal(drafts.saveChatDraft(scope, 42, { storage: memoryStorage() }).reason, "invalid-text");
  // The VM has no browser global at all; the default path must be safe in
  // SSR/tests and in a privacy-restricted WebView.
  assert.equal(drafts.loadChatDraft(scope).reason, "storage-unavailable");
  assert.equal(drafts.loadChatDraft(scope, { storage: null }).reason, "storage-unavailable");

  const throwingStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("quota"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(drafts.saveChatDraft(scope, "draft", { storage: throwingStorage }).reason, "storage-error");
  assert.equal(drafts.loadChatDraft(scope, { storage: throwingStorage }).reason, "storage-error");
  assert.equal(drafts.clearChatDraft(scope, { storage: throwingStorage }).reason, "storage-error");
});

test("an offline submit reports failure so the composer retains its local draft", () => {
  const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
  assert.match(store, /if \(this\.send\(frame\) === undefined\) \{/);
  assert.match(store, /Cloud9 is offline\. Your message is still in the box\./);
});

test("durable upload restore dedupes failed and already-outgoing ids", () => {
  const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
  assert.match(store, /const held = current\.filter\(u => scope\(u\) && \(!u\.attachmentId/);
  assert.match(store, /u\.draftSynced === false && !projectedIds\.has\(u\.attachmentId\)/);
  assert.match(store, /all\.find\(candidate => candidate\.state !== "removed" && candidate\.id === a\.id\)/);
  assert.match(store, /return ids\.filter\(\(id, index\) => ids\.indexOf\(id\) === index\)/);
});

test("an accepted send fences its late draft projection without hiding a newer edit", () => {
  const sent = "twelve-line note from far back";
  assert.equal(drafts.shouldRestoreDurableChatDraft({
    localText: "", durableText: sent, acceptedSentText: sent,
  }), false, "message held, draftRemoved delivered, then stale draftChanged must stay gone");
  assert.equal(drafts.shouldRestoreDurableChatDraft({
    localText: "", durableText: "typed in another window", acceptedSentText: sent,
  }), true, "a different cross-window projection remains restorable");
  assert.equal(drafts.shouldRestoreDurableChatDraft({
    localText: "next message", durableText: sent, acceptedSentText: sent,
  }), false, "new local input always wins over durable state");
});

test("the accepted-send fence survives reconnect hydration but resets on scope change", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  assert.match(app, /const acceptedSentScope = useRef<string \| null>\(null\)/);
  assert.match(app, /if \(acceptedSentScope\.current !== draftKey\) \{/,
    "only a real draft-scope change may clear the accepted-send fence");
  assert.match(app, /acceptedSentScope\.current === draftKey \? acceptedSentText\.current : null/,
    "reconnect hydration must still apply the fence for the same scope");
  assert.match(app, /acceptedSentScope\.current = draftKey;\s*acceptedSentText\.current = t/,
    "the accepted callback associates the fence with the sending scope");
});

test("an authoritative empty scoped draft response clears the local scope", () => {
  const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
  assert.match(store, /const request = frame\.requestId \? this\.draftRequests\.get\(frame\.requestId\) : undefined/);
  assert.match(store, /if \(request\?\.type === "draftList" \|\| request\?\.type === "draftReconcile"\)/);
  assert.match(store, /if \(channelMatches && threadMatches\) delete next\[key\]/);
});

test("send retries keep one client intent id until acceptance or payload change", () => {
  const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
  assert.match(store, /private pendingSendIntents = new Map<string, \{ signature: string; clientMessageId: ID \}>\(\)/);
  assert.match(store, /const prior = this\.pendingSendIntents\.get\(scopeKey\)/);
  assert.match(store, /prior\?\.signature === signature/);
  assert.match(store, /this\.pendingSendIntents\.delete\(scopeKey\)/);
});
