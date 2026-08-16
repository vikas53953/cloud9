const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");
const readRelay = name => fs.readFileSync(path.join(__dirname, "..", "..", "relay", "src", name), "utf8");
const readShared = name => fs.readFileSync(path.join(__dirname, "..", "..", "..", "packages", "shared", "src", name), "utf8");

test("attachment previews use a narrow safe local allowlist", () => {
  const store = read("store.ts");
  const app = read("App.tsx");
  assert.match(store, /export function uploadPreviewKind\(name: string, mime\?: string\)/);
  assert.match(store, /LOCAL_IMAGE_EXTENSIONS/);
  assert.match(store, /LOCAL_AUDIO_EXTENSIONS/);
  assert.match(store, /downloadContentType\(name\)\.startsWith\("image\/"\)/,
    "an empty browser MIME may only infer a safe raster image from its validated extension");
  assert.doesNotMatch(store, /svg\"/i, "SVG must not become an in-app object-URL preview");
  assert.match(store, /const previewKind = uploadPreviewKind\(file\.name, file\.type\)/);
  assert.match(app, /uploadPreviewKind\(u\.name, u\.mime\) === "image"/);
  assert.match(app, /uploadPreviewKind\(u\.name, u\.mime\) === "audio"/);
});

test("the tray reports real read progress and explicit upload states", () => {
  const store = read("store.ts");
  const app = read("App.tsx");
  assert.match(store, /reader\.onprogress = event =>/);
  assert.match(store, /Math\.round\(event\.loaded \/ event\.total \* 100\)/);
  assert.match(store, /phase: "reading"/);
  assert.match(store, /phase: "uploading"/);
  assert.match(store, /phase: "ready"/);
  assert.match(app, /Reading file/);
  assert.match(app, /Uploading/);
  assert.match(app, /Ready to send/);
  assert.match(app, /<progress className="up-progress"/);
});

test("restored unavailable files can be replaced, removed, and deduped", () => {
  const store = read("store.ts");
  const app = read("App.tsx");
  assert.match(store, /const duplicate = list\.some\(u => u\.state !== "failed"/);
  assert.match(store, /replaceUpload\(channelId: ID, localId: string, file: File\)/);
  assert.match(store, /state !== "failed"[\s\S]*u\.name === file\.name/,
    "duplicate detection must remain scoped to the same message/thread");
  assert.match(app, /replacementForRef\.current = u\.localId/);
  assert.match(app, /client\.replaceUpload\(channel\.id, replacementFor, files\[0\]\)/);
  assert.match(app, /aria-label=\{`Take \$\{u\.name\} back off this message`\}/);
});

test("reconnect restore and narrow windows stay explicit and usable", () => {
  const app = read("App.tsx");
  const css = read("styles.css");
  assert.match(app, /client\.restoreDraftUploads\(durableDraft\)/);
  assert.match(app, /\[durableDraft\?\.id, durableDraft\?\.updatedAt, channel\.id, replyTo, world\.connected\]/,
    "a fresh reconnect projection must re-run parked attachment reconciliation");
  assert.match(app, /role="list" aria-label="Files going with this message"/);
  assert.match(app, /role="listitem"/);
  assert.match(css, /\.uptile\{align-items:flex-start;flex-wrap:wrap/);
  assert.match(css, /@media \(max-width:360px\)/);
  assert.match(css, /audio\.upload-preview\{flex:1 1 160px;width:min\(100%,180px\);max-width:100%/);
});

test("upload answers are correlated end-to-end so a late A cannot settle queued B", () => {
  const store = read("store.ts");
  const relay = readRelay("server.ts");
  const shared = readShared("index.ts");
  assert.match(store, /const requestId = this\.nextRequestId\("uploadAttachment"\)/);
  assert.match(store, /this\.ask\(\{ \.\.\.next\.frame, requestId \}/);
  assert.match(store, /f\.type === "attachment"[\s\S]*\(f as \{ requestId\?: ID \}\)\.requestId === requestId/);
  assert.match(relay, /type: "attachment", attachment,[\s\S]*requestId: frame\.requestId/);
  assert.match(shared, /type: "attachment"; attachment: Attachment; requestId\?: ID/);
});

test("channel loss and reconnect cancel pending readers, ledger rows, and previews", () => {
  const store = read("store.ts");
  assert.match(store, /private uploadReaders = new Map/);
  assert.match(store, /pending\.reader\.abort\(\)/);
  assert.match(store, /this\.removeAsked\(current\.requestId\)/);
  assert.match(store, /private clearAllUploads\(\): void/);
  assert.match(store, /this\.clearAllUploads\(\);[\s\S]*const orphaned = this\.asked/);
  assert.match(store, /this\.clearUploadsFor\(frame\.channelId\)/);
  assert.match(store, /URL\.revokeObjectURL\(upload\.previewUrl\)/);
});

test("authoritative draft restore drops reclaimed ids but preserves transient picks", () => {
  const store = read("store.ts");
  assert.match(store, /const authoritative = draft\.attachments/);
  assert.match(store, /const held = current\.filter\(u => scope\(u\) && \(!u\.attachmentId/);
  assert.match(store, /if \(upload\.previewUrl\) URL\.revokeObjectURL\(upload\.previewUrl\);/);
  assert.match(store, /const next = \[\.\.\.other, \.\.\.held, \.\.\.restored\]/);
});

test("an older draft projection cannot erase a newly ready local upload", () => {
  const store = read("store.ts");
  assert.match(store, /draftSynced\?: boolean/);
  assert.match(store, /draftSynced: false/);
  assert.match(store, /const projectedIds = new Set\(draft\.attachments\.map\(a => a\.id\)\)/);
  assert.match(store, /u\.draftSynced === false && !projectedIds\.has\(u\.attachmentId\)/);
  assert.match(store, /upload\.draftSynced === false && !projectedIds\.has\(upload\.attachmentId\)/);
  assert.match(store, /draftSynced: true/);
  assert.match(store, /u\.draftSynced === n\.draftSynced/);
  assert.doesNotMatch(store, /uploadedAt\s*>=\s*draft\.updatedAt/);
});

test("an accepted send clears only its own files, never a newly picked next file", () => {
  const store = read("store.ts");
  const app = read("App.tsx");
  assert.match(store, /clearUploads\(channelId: ID, attachmentIds: readonly ID\[\], threadId\?: ID\)/);
  assert.match(store, /const sentIds = new Set\(attachmentIds\)/);
  assert.match(store, /const wasSent = !!u\.attachmentId && sentIds\.has\(u\.attachmentId\)/);
  assert.match(store, /if \(inScope && wasSent\)/);
  assert.match(app, /client\.clearUploads\(channel\.id, ready\.ids, replyTo\)/);
});

test("removing one channel advances the global upload queue", () => {
  const store = read("store.ts");
  assert.match(store, /Upload[s]? are globally serialized, not scoped to one room/);
  assert.match(store, /this\.pumpUploads\(\);[\s\S]*private clearAllUploads/);
  assert.match(store, /this\.clearUploadsFor\(frame\.channelId\)/);
});
