const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("live activity cache keeps only ordered public steps and closes deterministically", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import {
      clearLiveSteps, liveStepsFor, liveWorkByAgent, noteLiveSteps,
    } from "./apps/desktop/src/livesteps.ts";

    clearLiveSteps();
    const base = { channelId: "c", messageId: "m", agentId: "a", at: 10 };

    noteLiveSteps({ ...base, steps: [
      { seq: 2, kind: "read", label: "Read b", detail: "private provider detail" },
    ] });
    const first = liveStepsFor("m");
    assert.equal(first[0].steps[0].detail, undefined,
      "private detail must never enter the public cache");

    // A detail-only replay is the same public frame: refresh staleness, but do
    // not replace the snapshot or announce a redundant activity update.
    noteLiveSteps({ ...base, steps: [
      { seq: 2, kind: "read", label: "Read b", detail: "different private detail" },
    ] });
    assert.strictEqual(liveStepsFor("m"), first);

    // Batches may arrive out of order; the visible stream remains seq ordered.
    noteLiveSteps({ ...base, steps: [{ seq: 1, kind: "search", label: "Search a" }] });
    assert.deepEqual(liveStepsFor("m")[0].steps.map(step => step.seq), [1, 2]);
    noteLiveSteps({ ...base, steps: [{ seq: 2, kind: "read", label: "Read b", ok: true }] });
    assert.equal(liveStepsFor("m")[0].steps[1].ok, true);
    assert.deepEqual(liveWorkByAgent(), { a: { doing: "Read b", messageId: "m" } });

    // The wire has one ending vocabulary (done); repeated endings are no-ops.
    noteLiveSteps({ ...base, done: true });
    assert.deepEqual(liveStepsFor("m"), []);
    assert.deepEqual(liveWorkByAgent(), {});
    noteLiveSteps({ ...base, done: true });
    assert.deepEqual(liveStepsFor("m"), []);

    // Invalid public steps are rejected without leaving a stale row behind.
    assert.doesNotThrow(() => noteLiveSteps({ ...base, steps: { length: 1 } }));
    noteLiveSteps({ ...base, steps: [{ seq: 3, kind: "not-a-wire-kind", label: "no" }] });
    assert.deepEqual(liveStepsFor("m"), []);
    clearLiveSteps();
  `;
  execFileSync(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e", script,
  ], { cwd: require("node:path").join(__dirname, "..", "..", ".."), stdio: "pipe" });
});

test("a socket epoch clears public activity on reconnect, disconnect, and welcome", () => {
  const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
  assert.match(store, /import \{ clearLiveSteps, noteLiveSteps \} from "\.\/livesteps\.js"/);
  assert.match(store, /private openSocketTo\(url: string\): void \{\s*\/\/ Public activity[\s\S]*?clearLiveSteps\(\);/);
  assert.match(store, /ws\.onclose = \(\) => \{[\s\S]*?clearLiveSteps\(\);/);
  assert.match(store, /case "welcome": \{[\s\S]*?clearLiveSteps\(\);/);
});
