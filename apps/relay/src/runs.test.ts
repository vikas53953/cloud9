// What an agent actually did, on the hub (FR-TL-003, FR-AU-003).
//
// Every test here failed before this round: there was no `runRecorded` frame,
// no `runs` table and no way for a screen to learn anything about a turn beyond
// the sentence the agent said at the end of it.
//
// The theme running through the file is that a run record is a REPORT, not a
// permission. Nothing in it decides who may read it: whose agent it is comes
// from `myAgent`, which room it was in comes from `channelFor`, and both read
// stored state.
import test from "node:test";
import assert from "node:assert/strict";
import {
  RunRecord, RUN_RETENTION, ServerFrame, setMachineNames,
} from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
};

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const hello = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  // the engine host is a SECOND connection for the same person — exactly how it
  // runs in the real app, and the only client allowed to report a run
  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  return { relay, url, owner, engine, me: hello.state.me };
}

async function invite(owner: TestClient, notCode?: string): Promise<string> {
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(
    f => f.type === "invite" && f.code !== notCode);
  return inv.code;
}

async function makeAgent(client: TestClient, name: string) {
  client.send({ type: "createAgent", agent: { ...BASE_AGENT, name } });
  const frame = await client.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === name);
  return frame.agent;
}

/** A record shaped exactly as the engine builds one. */
function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `r-${Date.now().toString(36).padStart(9, "0")}-0001`,
    kind: "chat", agentId: "a?", agentName: "Scout", provider: "claude",
    requestedBy: "Vikas", requestedByKind: "human",
    ask: "find three villas in Goa",
    startedAt: 1_000, finishedAt: 42_000, durationMs: 41_000,
    outcome: "ok", steps: [], replyChars: 12, events: 3,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The happy path: the record reaches the hub, the room and the trail
// ---------------------------------------------------------------------------

test("a finished turn reaches the hub, the room and the activity trail", async () => {
  const { relay, url, owner, engine } = await stand("runs-happy.db");
  const agent = await makeAgent(owner, "Scout");
  const channel = relay.store.channels()[0];

  engine.send({
    type: "runRecorded",
    record: record({
      agentId: agent.id, channelId: channel.id,
      steps: [
        { seq: 1, kind: "web", label: "Read a web page", detail: "https://villas.example/goa" },
        { seq: 2, kind: "read", label: "Read notes.md", ok: true },
      ],
      usage: { inputTokens: 900, outputTokens: 120, costUsd: 0.76 },
    }),
  });

  // 1. the owner's ordinary client is told, without asking
  const pushed = await owner.wait<Extract<ServerFrame, { type: "run" }>>(f => f.type === "run");
  assert.equal(pushed.record.agentId, agent.id);
  assert.equal(pushed.record.steps.length, 2);
  assert.equal(pushed.record.usage?.costUsd, 0.76);

  // 2. it is stored, and can be asked for again by id
  owner.send({ type: "runDetail", runId: pushed.record.id });
  const detail = await owner.wait<Extract<ServerFrame, { type: "run" }>>(
    f => f.type === "run" && f.record.id === pushed.record.id);
  assert.equal(detail.record.ask, "find three villas in Goa");

  // 3. and it appears in the agent's history, with the plain-words line
  owner.send({ type: "runList", agentId: agent.id });
  const list = await owner.wait<Extract<ServerFrame, { type: "runs" }>>(f => f.type === "runs");
  assert.equal(list.runs.length, 1);
  assert.match(list.runs[0].summary, /Checked 1 site/);
  assert.match(list.runs[0].summary, /cost 76 cents/);

  // 4. THE ROW THE ACTIVITY PANEL WAS ALWAYS MISSING
  const trail = relay.store.activity(Date.now() + 1, 100);
  const row = trail.find(r => r.kind === "run_recorded");
  assert.ok(row, "a recorded run is an action and belongs in the trail");
  assert.equal(row.actorId, agent.id);
  assert.equal(row.refId, pushed.record.id);
  assert.equal(relay.store.verifyActivity(), null, "the ledger still hangs together");

  owner.close(); engine.close(); relay.close();
});

test("a run receipt keeps public execution facts and omits provider-absent cost", async () => {
  const { relay, owner, engine } = await stand("runs-receipt.db");
  try {
    const agent = await makeAgent(owner, "Scout");
    const channel = relay.store.channels()[0];
    engine.send({
      type: "runRecorded",
      record: record({
        id: "r-000000011-0001", agentId: agent.id, channelId: channel.id,
        model: "gpt-5.6-sol", effort: "high", branch: "cloud9/scout-1",
        commit: "abc123", files: ["src/app.ts"],
        tests: [{ command: "npm test", ok: true }],
        pullRequest: "https://github.com/example/cloud9/pull/1",
        artifacts: [{ id: "artifact-1", name: "report.md", available: true }],
        usage: undefined,
        invocation: {
          agentId: agent.id, permissionScope: "readOnly", trust: "askEveryTime",
          abilities: { webSearch: false, files: false, schedules: false, background: false },
        },
      }),
    });
    const pushed = await owner.wait<Extract<ServerFrame, { type: "run" }>>(
      f => f.type === "run" && f.record.id === "r-000000011-0001");
    assert.equal(pushed.record.branch, "cloud9/scout-1");
    assert.equal(pushed.record.commit, "abc123");
    assert.deepEqual(pushed.record.files, ["src/app.ts"]);
    assert.deepEqual(pushed.record.tests, [{ command: "npm test", ok: true }]);
    assert.equal(pushed.record.usage?.costUsd, undefined, "Codex did not report money");
    assert.equal(pushed.record.invocation?.permissionScope, "readOnly");
  } finally {
    owner.close(); engine.close(); relay.close();
  }
});

test("a delegated job learns which run actually did it", async () => {
  const { relay, url, owner, engine, me } = await stand("runs-task.db");
  const agent = await makeAgent(owner, "Scout");
  const channel = relay.store.channels()[0];

  engine.send({
    type: "createTask", agentId: agent.id, channelId: channel.id,
    title: "find three villas in Goa", requesterId: me.id,
  });
  const created = await owner.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task");
  assert.equal(created.task.runId, undefined, "nothing has happened yet, so nothing is claimed");

  engine.send({
    type: "runRecorded",
    record: record({
      kind: "task", agentId: agent.id, channelId: channel.id, taskId: created.task.id,
      steps: [{ seq: 1, kind: "write", label: "Wrote villas.md" }],
    }),
  });

  const updated = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.id === created.task.id && f.task.runId !== undefined);
  assert.ok(updated.task.runId, "'the job finished' becomes 'here is what it did'");
  assert.equal(relay.store.task(created.task.id)?.runId, updated.task.runId);

  // and asking by job gives the runs behind it
  owner.send({ type: "runList", taskId: created.task.id });
  const byTask = await owner.wait<Extract<ServerFrame, { type: "runs" }>>(
    f => f.type === "runs" && f.taskId === created.task.id);
  assert.equal(byTask.runs.length, 1);
  assert.equal(byTask.runs[0].id, updated.task.runId);

  owner.close(); engine.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Who may write one
// ---------------------------------------------------------------------------

test("only an engine may say what an agent did", async () => {
  const { relay, owner, engine } = await stand("runs-onlyengine.db");
  const agent = await makeAgent(owner, "Scout");

  // the owner's own desktop client is still not an engine — a report about a
  // turn may only come from the machine that took it
  owner.send({ type: "runRecorded", record: record({ agentId: agent.id }) });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /only the engine/);
  assert.equal(relay.store.runsForAgent(agent.id).length, 0);

  owner.close(); engine.close(); relay.close();
});

test("an engine cannot plant a run against somebody else's agent", async () => {
  const { relay, url, owner, engine } = await stand("runs-notyours.db");
  const code = await invite(owner);
  const priya = new TestClient(url, `invite:${code}:Priya`);
  await priya.wait(f => f.type === "welcome");
  const hers = await makeAgent(priya, "Wanda");

  // The owner's engine host reports a run naming PRIYA's agent. If the record
  // were believed, the owner would be writing history about somebody else's
  // agent — and choosing the room it is readable in.
  engine.send({ type: "runRecorded", record: record({ agentId: hers.id }) });
  const err = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /not your agent/);
  assert.equal(relay.store.runsForAgent(hers.id).length, 0);

  priya.close(); owner.close(); engine.close(); relay.close();
});

test("a record that arrived malformed never reaches the database", async () => {
  const { relay, owner, engine } = await stand("runs-bad.db");
  const agent = await makeAgent(owner, "Scout");

  // an id that would become a file name outside the agent's own folder
  engine.send({
    type: "runRecorded",
    record: record({ agentId: agent.id, id: "../../../etc/passwd" }),
  });
  const err = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /run id/);
  assert.equal(relay.store.runsForAgent(agent.id).length, 0);

  owner.close(); engine.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Who may read one
// ---------------------------------------------------------------------------

test("a run is readable by the room it happened in — and by nobody else", async () => {
  const { relay, url, owner, engine } = await stand("runs-room.db");
  const agent = await makeAgent(owner, "Scout");
  const general = relay.store.channels()[0];

  // Priya joins; new people land in #general, so she shares the room
  const code = await invite(owner);
  const priya = new TestClient(url, `invite:${code}:Priya`);
  await priya.wait(f => f.type === "welcome");

  // a private room the owner alone is in
  owner.send({ type: "createChannel", name: "private-notes", memberIds: [agent.id], kind: "channel" });
  const priv = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "private-notes");

  engine.send({
    type: "runRecorded",
    record: record({ id: "r-000000001-aaaa", agentId: agent.id, channelId: general.id }),
  });
  engine.send({
    type: "runRecorded",
    record: record({ id: "r-000000002-bbbb", agentId: agent.id, channelId: priv.channel.id }),
  });
  await owner.wait(f => f.type === "run" && f.record.id === "r-000000002-bbbb");

  // the shared room's run is hers to read...
  priya.send({ type: "runDetail", runId: "r-000000001-aaaa" });
  const ok = await priya.wait<Extract<ServerFrame, { type: "run" }>>(f => f.type === "run");
  assert.equal(ok.record.id, "r-000000001-aaaa");

  // ...the private room's is not, and it refuses with the SAME words an
  // invented id gets, so an id cannot be probed
  priya.send({ type: "runDetail", runId: "r-000000002-bbbb" });
  const denied = await priya.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /no such run/);
  priya.send({ type: "runDetail", runId: "r-000000009-zzzz" });
  const missing = await priya.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.error === denied.error);
  assert.ok(missing, "'you may not' and 'there isn't one' must read identically");

  priya.close(); owner.close(); engine.close(); relay.close();
});

test("a guest cannot list somebody else's agent's history", async () => {
  const { relay, url, owner, engine } = await stand("runs-history.db");
  const agent = await makeAgent(owner, "Scout");
  const general = relay.store.channels()[0];
  const code = await invite(owner);
  const priya = new TestClient(url, `invite:${code}:Priya`);
  await priya.wait(f => f.type === "welcome");

  engine.send({
    type: "runRecorded",
    record: record({ agentId: agent.id, channelId: general.id }),
  });
  await owner.wait(f => f.type === "run");

  // Sharing a room with someone's agent shows you the turns it takes THERE. It
  // is not a licence to read everything that agent has ever done, everywhere.
  priya.send({ type: "runList", agentId: agent.id });
  const err = await priya.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /not your agent/);

  priya.close(); owner.close(); engine.close(); relay.close();
});

test("a run with no room at all belongs to its owner alone", async () => {
  const { relay, url, owner, engine } = await stand("runs-noroom.db");
  const agent = await makeAgent(owner, "Scout");
  const code = await invite(owner);
  const priya = new TestClient(url, `invite:${code}:Priya`);
  await priya.wait(f => f.type === "welcome");

  // a scheduled check-in that posted nowhere
  engine.send({
    type: "runRecorded",
    record: record({ id: "r-000000003-cccc", kind: "schedule", agentId: agent.id }),
  });
  await owner.wait(f => f.type === "run" && f.record.id === "r-000000003-cccc");

  priya.send({ type: "runDetail", runId: "r-000000003-cccc" });
  const err = await priya.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /no such run/);

  priya.close(); owner.close(); engine.close(); relay.close();
});

test("a room the record NAMES but nobody can see is dropped, not obeyed", async () => {
  const { relay, url, owner, engine } = await stand("runs-claimroom.db");
  const agent = await makeAgent(owner, "Scout");

  // Priya makes a room of her own; the owner is not in it.
  const code = await invite(owner);
  const priya = new TestClient(url, `invite:${code}:Priya`);
  const hers = await priya.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  priya.send({ type: "createChannel", name: "priya-only", memberIds: [hers.state.me.id], kind: "channel" });
  const herRoom = await priya.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "priya-only");

  // The engine claims its run happened in her room. Believing that would make
  // the owner's agent's work readable in a conversation it was never in.
  engine.send({
    type: "runRecorded",
    record: record({ id: "r-000000004-dddd", agentId: agent.id, channelId: herRoom.channel.id }),
  });
  await owner.wait(f => f.type === "run" && f.record.id === "r-000000004-dddd");

  const stored = relay.store.run("r-000000004-dddd");
  assert.ok(stored);
  assert.equal(stored.channelId, undefined, "an unverifiable room is dropped");
  assert.equal(stored.record.channelId, undefined, "and it does not survive inside the record either");

  priya.send({ type: "runDetail", runId: "r-000000004-dddd" });
  const err = await priya.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /no such run/);

  priya.close(); owner.close(); engine.close(); relay.close();
});

test("a run cannot attach itself to another agent's job", async () => {
  const { relay, owner, engine, me } = await stand("runs-claimtask.db");
  const scout = await makeAgent(owner, "Scout");
  const wanda = await makeAgent(owner, "Wanda");
  const channel = relay.store.channels()[0];

  engine.send({
    type: "createTask", agentId: wanda.id, channelId: channel.id,
    title: "wanda's job", requesterId: me.id,
  });
  const task = await owner.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task");

  // Scout's run claims Wanda's job.
  engine.send({
    type: "runRecorded",
    record: record({
      id: "r-000000005-eeee", agentId: scout.id, channelId: channel.id, taskId: task.task.id,
    }),
  });
  await owner.wait(f => f.type === "run" && f.record.id === "r-000000005-eeee");

  assert.equal(relay.store.run("r-000000005-eeee")?.taskId, undefined);
  assert.equal(relay.store.task(task.task.id)?.runId, undefined, "Wanda's job is untouched");

  owner.close(); engine.close(); relay.close();
});

// ---------------------------------------------------------------------------
// What leaves the machine
// ---------------------------------------------------------------------------

test("a guest cannot learn the owner's folder layout from a run record", async () => {
  const { relay, url, owner, engine } = await stand("runs-redact.db");
  const agent = await makeAgent(owner, "Scout");
  const general = relay.store.channels()[0];
  const code = await invite(owner);
  const priya = new TestClient(url, `invite:${code}:Priya`);
  await priya.wait(f => f.type === "welcome");

  // The hub knows what THIS computer is called, and blanks it — the same rule
  // the engine applies, reached through the same function.
  setMachineNames(["C:\\Users\\vikasmit", "vikasmit", "VIKAS-PC"]);
  try {
    // A RAW record, as if an older or broken engine had skipped `shareableRun`.
    // The hub is the last door and must not pass it through.
    engine.send({
      type: "runRecorded",
      record: record({
        id: "r-000000006-ffff", agentId: agent.id, channelId: general.id,
        ask: "tidy C:\\Users\\vikasmit\\Documents\\taxes",
        outcome: "failed",
        error: "ENOENT: C:\\Users\\vikasmit\\AppData\\Roaming\\cloud9\\secrets.json",
        steps: [
          {
            seq: 1, kind: "command", label: "Ran a command",
            detail: "C:\\WINDOWS\\system32\\cmd.exe /c type C:\\Users\\vikasmit\\.ssh\\id_rsa",
          },
          {
            seq: 2, kind: "web", label: "Read a web page",
            detail: "https://example.com/help",
          },
        ],
      }),
    });

    const seen = await priya.wait<Extract<ServerFrame, { type: "run" }>>(
      f => f.type === "run" && f.record.id === "r-000000006-ffff");
    const asText = JSON.stringify(seen.record);
    assert.doesNotMatch(asText, /vikasmit/i, "the account name must never travel");
    assert.doesNotMatch(asText, /AppData|Documents|system32|\.ssh/,
      "nor the folder layout of somebody else's computer");
    // ...while the point of the feature survives
    assert.match(asText, /id_rsa/, "what it acted on is still visible");
    assert.match(asText, /https:\/\/example\.com\/help/, "a web address is not private");

    // and the STORED copy is the redacted one, so it cannot leak later either
    const stored = JSON.stringify(relay.store.run("r-000000006-ffff")?.record);
    assert.doesNotMatch(stored, /vikasmit/i);
  } finally {
    setMachineNames([]);
  }

  priya.close(); owner.close(); engine.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Bounded, like the copy on disk
// ---------------------------------------------------------------------------

test("the hub keeps a bounded number of runs per agent, oldest first", async () => {
  const { relay, owner, engine } = await stand("runs-prune.db");
  const agent = await makeAgent(owner, "Scout");
  const general = relay.store.channels()[0];

  const extra = 5;
  const total = RUN_RETENTION.perAgent + extra;
  for (let i = 0; i < total; i++) {
    engine.send({
      type: "runRecorded",
      record: record({
        id: `r-${String(i).padStart(9, "0")}-0001`,
        agentId: agent.id, channelId: general.id, startedAt: 1000 + i,
      }),
    });
  }
  await owner.wait(f =>
    f.type === "run" && f.record.id === `r-${String(total - 1).padStart(9, "0")}-0001`);

  const kept = relay.store.runsForAgent(agent.id, RUN_RETENTION.listPage);
  assert.equal(kept.length, RUN_RETENTION.perAgent);
  // the oldest went, the newest stayed
  assert.equal(relay.store.run("r-000000000-0001"), undefined);
  assert.ok(relay.store.run(`r-${String(total - 1).padStart(9, "0")}-0001`));

  owner.close(); engine.close(); relay.close();
});

test("no client can ask for a bigger page of runs than the protocol allows", async () => {
  const { relay, owner, engine } = await stand("runs-page.db");
  const agent = await makeAgent(owner, "Scout");
  const general = relay.store.channels()[0];
  for (let i = 0; i < 10; i++) {
    engine.send({
      type: "runRecorded",
      record: record({
        id: `r-${String(i).padStart(9, "0")}-0002`,
        agentId: agent.id, channelId: general.id, startedAt: 1000 + i,
      }),
    });
  }
  await owner.wait(f => f.type === "run" && f.record.id === "r-000000009-0002");

  owner.send({ type: "runList", agentId: agent.id, limit: 1_000_000 });
  const list = await owner.wait<Extract<ServerFrame, { type: "runs" }>>(f => f.type === "runs");
  assert.ok(list.runs.length <= RUN_RETENTION.listPage);

  owner.close(); engine.close(); relay.close();
});

test("deleting an agent takes its runs with it", async () => {
  const { relay, owner, engine } = await stand("runs-forget.db");
  const agent = await makeAgent(owner, "Scout");
  const general = relay.store.channels()[0];
  engine.send({
    type: "runRecorded",
    record: record({ id: "r-000000007-gggg", agentId: agent.id, channelId: general.id }),
  });
  await owner.wait(f => f.type === "run" && f.record.id === "r-000000007-gggg");

  owner.send({ type: "deleteAgent", agentId: agent.id });
  await owner.wait(f => f.type === "agentDeleted");
  assert.equal(relay.store.run("r-000000007-gggg"), undefined);

  owner.close(); engine.close(); relay.close();
});
