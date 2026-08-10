const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

test("composer labels only explicit, eligible in-room agent invocations as Run", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { composerIntent } from "./apps/desktop/src/composerintent.ts";

    const owner = { id: "a-scout", name: "Scout", ownerId: "u1", persona: "", createdAt: 0 };
    const spaced = { id: "a-data", name: "Data Scout", ownerId: "u1", persona: "", createdAt: 0 };
    const emoji = { id: "agent_🧭", name: "🧭 Reviewer", ownerId: "u1", persona: "", createdAt: 0 };
    const roomAgents = [owner, spaced, emoji];
    const run = value => composerIntent({ text: value, roomAgents, requesterId: "u1" });

    assert.equal(run("@Scout check the release"), "run");
    assert.equal(run("@Data Scout !bg inspect telemetry"), "run");
    assert.equal(run("@🧭 Reviewer /review release notes"), "run");
    assert.equal(run("@Scout /unknown thing"), "run", "unknown slash prose still uses explicit mention routing");
    assert.equal(run("/plan @Scout"), "run", "a mention in a command argument still routes the engine turn");
    assert.equal(run("/assign @Data Scout fix the failing test"), "run");
    assert.equal(run("@agent_🧭 /review release notes"), "run");
    assert.equal(composerIntent({ text: "please check this", roomAgents: [owner], requesterId: "u1", direct: true }), "run");
    assert.equal(composerIntent({
      text: "/assign @Data Scout inspect",
      roomAgents: [spaced, { ...spaced, id: "a-data-2" }], requesterId: "u1",
    }), "send", "ambiguous names cannot be called Run");
    assert.equal(composerIntent({
      text: "/assign @Data Scout inspect",
      roomAgents: [{ ...spaced, lifecycle: "paused" }, { ...spaced, id: "a-data-2" }], requesterId: "u1",
    }), "send", "a paused duplicate still makes the route ambiguous");

    const twinLive = { ...spaced, id: "a-twin-live", name: "Twin" };
    const twinPaused = { ...spaced, id: "a-twin-paused", name: "Twin", lifecycle: "paused" };
    const mixedTwins = [twinLive, twinPaused];
    assert.equal(composerIntent({
      text: "@Twin !bg inspect telemetry", roomAgents: mixedTwins, requesterId: "u1",
    }), "send", "a bang command cannot choose between duplicate display names");
    assert.equal(composerIntent({
      text: "@Twin /review release notes", roomAgents: mixedTwins, requesterId: "u1",
    }), "send", "a leading slash route cannot choose between duplicate display names");
    assert.equal(composerIntent({
      text: "/review @Twin release notes", roomAgents: mixedTwins, requesterId: "u1",
    }), "send", "a display-name mention in slash arguments stays ambiguous");
    assert.equal(composerIntent({
      text: "@a-twin-live /review release notes", roomAgents: mixedTwins, requesterId: "u1",
    }), "run", "an exact stable id disambiguates the live target");
    assert.equal(composerIntent({
      text: "/assign @a-twin-live inspect telemetry", roomAgents: mixedTwins, requesterId: "u1",
    }), "run", "an exact stable id routes an assignment");
    assert.equal(composerIntent({
      text: "@a-twin-paused /review release notes", roomAgents: mixedTwins, requesterId: "u1",
    }), "send", "an exact stable id still cannot run a paused target");
    assert.equal(composerIntent({
      text: "@Twin !bg inspect telemetry", roomAgents: mixedTwins, requesterId: "u1", direct: true,
    }), "send", "a direct form cannot hide an ambiguous display target");

    assert.equal(run("ordinary room note"), "send");
    assert.equal(run("!bg do this later"), "send");
    assert.equal(run("@NotInThisRoom do the thing"), "send");
    assert.equal(run(""), "send", "attachments-only drafts keep Send wording");
    assert.equal(composerIntent({ text: "@Scout do it", roomAgents, requesterId: "u2" }), "send");
    assert.equal(composerIntent({ text: "@Scout do it", roomAgents: [{ ...owner, lifecycle: "paused" }], requesterId: "u1" }), "send");
    assert.equal(composerIntent({ text: "@Scout do it", roomAgents, requesterId: "u1", available: false }), "send");
  `;
  execFileSync(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e", script,
  ], { cwd: path.join(__dirname, "..", "..", ".."), stdio: "pipe" });
});

test("composer keeps one send path while exposing contextual accessible wording", () => {
  const fs = require("node:fs");
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  assert.match(app, /composerIntent\(\{/);
  assert.match(app, /data-intent=\{intent\}/);
  assert.match(app, /runningIntent \? "Run agent request" : "Send message"/);
  assert.match(app, /onClick=\{sendNow\}/);
  assert.match(app, /data-waiting=\{busy \? "file"/);
  assert.match(app, /disabled=\{busy \|\| \(!text\.trim\(\) && ready === 0\)\}/);
});
