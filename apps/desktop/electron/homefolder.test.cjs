// THE FOLDER A NEW AGENT STARTS IN — it must be his REAL home folder, resolved
// on this machine, or nothing at all.
//
// A new agent is allowed out of its own folder from the second it exists, so it
// is given a folder in the same breath (see `useHomeFolder` in App.tsx). The
// whole honesty of that rests on one thing: the path is what the computer says,
// not what the window guessed. These tests call the REAL handler `main.cjs`
// registers and hold it to that.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadMain } = require("./testkit.cjs");

function handlers() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-home-"));
  const { state } = loadMain({ userData, packaged: false });
  return state.ipcHandlers;
}

test("the home folder handed to the window is this computer's own, and really there", async () => {
  const answer = await handlers()["cloud9:homeFolder"]({});
  assert.equal(answer.ok, true, "the app could not say where his home folder is");
  assert.equal(answer.path, os.homedir(), "the path was not the one the computer reports");
  assert.ok(fs.statSync(answer.path).isDirectory(), "the folder handed over is not a folder");
});

test("it goes through the same path check every other folder does", async () => {
  const answer = await handlers()["cloud9:homeFolder"]({});
  assert.ok(!answer.path.includes(".."), "a path with .. in it would have been handed over");
  // a whole path — a drive letter on Windows, a leading slash elsewhere
  assert.ok(/^[A-Za-z]:[\\/]/.test(answer.path) || answer.path.startsWith("/"),
    "a half path would have been stored on an agent");
});

test("nothing but the path crosses — no listing, no contents", async () => {
  const answer = await handlers()["cloud9:homeFolder"]({});
  assert.deepEqual(Object.keys(answer).sort(), ["ok", "path"],
    "the home-folder answer grew a field that could carry what is inside it");
});
