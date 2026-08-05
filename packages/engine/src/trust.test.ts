// HOW MUCH ONE AGENT MAY DO WITHOUT STOPPING TO ASK — the whole rule, pinned.
//
// WHY THIS FILE EXISTS. Vikas, repeatedly and finally in anger: "make an agent
// so that the agent can run all these commands rather than asking me whether i
// can do this or not or whether it is denying — because in buzz those agents are
// fully capable of running anything."
//
// The day before, new agents were given every capability the app can grant. But
// `commands` and `wholeComputer` are on `ALWAYS_ASK_ABILITIES`, so
// `mustAskBeforeActing` said "ask" for every one of them — and the fully capable
// agent he had just made stopped at an approval card before it was allowed to
// begin. He got MORE interruptions out of the change, not fewer.
//
// THE TENSION THIS FILE GUARDS. The approval card is what makes "may do
// everything" safe rather than reckless. So the freedom he asked for is a
// SETTING HE CHOOSES, per agent, and these tests pin the three things that make
// it a setting rather than a hole:
//
//   1. each setting produces exactly the asking behaviour its words promise;
//   2. an agent he already owns is NEVER widened by this code arriving;
//   3. nothing stored, forged or misspelt can turn the asking down — only one of
//      three exact words, written by his own editor, through the hub's validator.
//
// AND THE AUDIT SURVIVES ALL THREE. Not being asked is not the same as not being
// told: the run record still carries every command, and it now also carries WHICH
// RULE the turn ran under.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentDef, ALWAYS_ASK_ABILITIES, AgentTrust, NEW_AGENT_TRUST, OFF_MACHINE_ABILITIES,
  REMOTE_ACTIONS, RemoteAction, TRUST_LEVELS, decideAsking, mustAskBeforeActing,
  trustOf, trustWords, validateAgentDefinition, validateRunRecord, validateTrust,
} from "@cloud9/shared";
import { ApprovalDesk } from "./approvaldesk.js";
import { describeApprovalNeeds, describeRemoteAsks, NEW_AGENT_ABILITIES } from "./abilities.js";
import { buildRunRecord } from "./runrecord.js";

/** A fully capable agent — what every agent he makes now is. */
function agent(over: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭",
    persona: "you build things",
    abilities: { ...NEW_AGENT_ABILITIES },
    createdAt: 1,
    ...over,
  } as AgentDef;
}

const EVERY_REMOTE_ACTION = Object.keys(REMOTE_ACTIONS) as RemoteAction[];

/* =====================================================================
 * 1. EACH SETTING DOES WHAT ITS WORDS SAY
 * ===================================================================== */

test("ask me every time: a fully capable agent stops before it starts, and before anything goes out", () => {
  const a = agent({ trust: "askEveryTime" });
  // the job gate — this is the card he was hitting on every single job
  assert.equal(mustAskBeforeActing(a), true);
  // and every single thing that leaves the machine
  for (const action of EVERY_REMOTE_ACTION) {
    assert.equal(mustAskBeforeActing(a, { remoteAction: action }), true, action);
  }
});

test("just get on with it: local work runs unasked, and EVERY remote action still asks", () => {
  const a = agent({ trust: "localFree" });
  // THE WHOLE POINT: the job starts without a card
  assert.equal(mustAskBeforeActing(a), false);
  assert.equal(decideAsking(a), "goAhead");
  // ...and not one thing that leaves this computer got quieter
  for (const action of EVERY_REMOTE_ACTION) {
    assert.equal(mustAskBeforeActing(a, { remoteAction: action }), true,
      `"${action}" leaves this computer and must still ask`);
  }
});

test("just get on with it: running programs and reaching his files are LOCAL, so they do not ask", () => {
  // the two abilities he is actually complaining about, one at a time
  for (const ability of ["commands", "wholeComputer"] as const) {
    const a = agent({
      abilities: { webSearch: false, files: true, schedules: false, background: true, [ability]: true },
      trust: "localFree",
    } as Partial<AgentDef>);
    assert.equal(mustAskBeforeActing(a), false, `${ability} stays on this computer`);
  }
});

test("just get on with it: a CONNECTED SERVICE is somebody else's, so it still asks", () => {
  // the honest edge of the middle setting. There is no per-call gate for a
  // connected service — the surface arrives as a config file — so the gate that
  // exists is the one before the job starts, and it stays up.
  const a = agent({
    abilities: {
      webSearch: false, files: true, schedules: false, background: true,
      commands: true, wholeComputer: true, connections: true,
    },
    trust: "localFree",
  } as Partial<AgentDef>);
  assert.equal(mustAskBeforeActing(a), true);
  // and the words on the editor say so rather than promising silence
  assert.deepEqual(describeApprovalNeeds(a), ["Use connected services your owner picked for you"]);
});

test("don't ask me: nothing asks, including everything that leaves the computer", () => {
  const a = agent({ trust: "neverAsk" });
  assert.equal(mustAskBeforeActing(a), false);
  for (const action of EVERY_REMOTE_ACTION) {
    assert.equal(mustAskBeforeActing(a, { remoteAction: action }), false, action);
  }
  // even the connected-service ability, which the middle setting holds back
  const withConnections = agent({
    abilities: { ...NEW_AGENT_ABILITIES, connections: true }, trust: "neverAsk",
  });
  assert.equal(mustAskBeforeActing(withConnections), false);
});

test("the most permissive setting carries the one sentence he is accepting", () => {
  const never = TRUST_LEVELS.find(t => t.level === "neverAsk")!;
  assert.ok(never.warning, "“don't ask me” must say what he is accepting");
  // and it is the ONLY one that does — a warning on every row is a warning on none
  assert.deepEqual(TRUST_LEVELS.filter(t => t.warning).map(t => t.level), ["neverAsk"]);
  // it names both halves of what is being given up: the machine AND publishing
  assert.match(never.warning!, /computer/i);
  assert.match(never.warning!, /GitHub|connected/i);
});

/* =====================================================================
 * 2. NOBODY IS WIDENED WITHOUT SAYING SO
 * ===================================================================== */

test("an agent he already owns keeps asking — absence is never permission", () => {
  // his six existing agents carry no `trust` field at all
  const existing = agent({});
  assert.equal("trust" in existing, false);
  assert.equal(trustOf(existing), "askEveryTime");
  assert.equal(mustAskBeforeActing(existing), true);
  assert.equal(trustWords(existing), "Asks you before every job");
});

test("“don't ask me” is never what an agent becomes by omission", () => {
  // not the fallback for a missing field...
  assert.notEqual(trustOf({}), "neverAsk");
  // ...not the default for a new agent...
  assert.notEqual(NEW_AGENT_TRUST, "neverAsk");
  // ...and not the fallback for anything a client could put in the field
  for (const forged of [undefined, null, "", "neverask", "NEVERASK", "never", 0, 1, true,
    {}, [], "askEveryTime ", "bypass-permissions", "neverAskEver"]) {
    assert.notEqual(trustOf({ trust: forged }), "neverAsk", String(forged));
  }
});

test("a new agent starts on the middle setting, and the middle setting is a real one", () => {
  assert.equal(NEW_AGENT_TRUST, "localFree");
  assert.ok(TRUST_LEVELS.some(t => t.level === NEW_AGENT_TRUST));
  // it is the one that lets his machine be used and still guards what leaves it
  const fresh = agent({ trust: NEW_AGENT_TRUST });
  assert.equal(mustAskBeforeActing(fresh), false);
  assert.equal(mustAskBeforeActing(fresh, { remoteAction: "push" }), true);
});

/* =====================================================================
 * 3. A FORGED OR STORED SETTING CANNOT BEAT WHAT HE LAST CHOSE
 * ===================================================================== */

test("anything that is not one of the three words reads as ask-me-every-time", () => {
  const forgeries: unknown[] = [
    "neverask", "NeverAsk", "never", "none", "bypass", "off", "", " ",
    0, 1, true, false, null, {}, [], ["neverAsk"], { level: "neverAsk" },
  ];
  for (const forged of forgeries) {
    const a = agent({ trust: forged } as Partial<AgentDef>);
    assert.equal(trustOf(a), "askEveryTime", `forged: ${JSON.stringify(forged)}`);
    assert.equal(mustAskBeforeActing(a), true, `forged: ${JSON.stringify(forged)}`);
    assert.equal(mustAskBeforeActing(a, { remoteAction: "push" }), true);
  }
});

test("the hub refuses to STORE a setting it does not recognise", () => {
  // two independent guards: this one keeps the database clean, `trustOf` above
  // keeps the turn safe. Either alone would do; both is why a bad value cannot
  // survive long enough to be interpreted generously by a later reader.
  assert.equal(validateTrust(undefined), null);
  for (const level of TRUST_LEVELS) assert.equal(validateTrust(level.level), null);
  for (const bad of ["neverask", "bypass-permissions", 3, {}, []]) {
    assert.ok(validateTrust(bad), `"${String(bad)}" must be refused`);
  }
  // and it is refused on the whole record, which is the gate every write goes through
  const whole = { ...agent(), trust: "neverask" };
  assert.ok(validateAgentDefinition(whole), "a bad setting must fail the whole save");
  assert.equal(validateAgentDefinition({ ...agent(), trust: "neverAsk" }), null);
  assert.equal(validateAgentDefinition(agent()), null, "silence is still a whole agent");
});

test("the off-machine list is a SUBSET of the always-ask list, so the middle setting cannot widen anything", () => {
  // If an ability were on OFF_MACHINE_ABILITIES without being on
  // ALWAYS_ASK_ABILITIES, "localFree" would ask about something "askEveryTime"
  // does not — the settings would cross over and the ladder would stop being a
  // ladder. This is the line that makes that impossible to write.
  for (const ability of OFF_MACHINE_ABILITIES) {
    assert.ok((ALWAYS_ASK_ABILITIES as readonly string[]).includes(ability), ability);
  }
  // said as behaviour, not only as set membership: every agent that goes quiet
  // under askEveryTime is quiet under localFree too
  for (const ability of ALWAYS_ASK_ABILITIES) {
    const a = agent({
      abilities: { webSearch: false, files: false, schedules: false, background: false,
        [ability]: true },
    } as Partial<AgentDef>);
    const strict = mustAskBeforeActing({ ...a, trust: "askEveryTime" });
    const middle = mustAskBeforeActing({ ...a, trust: "localFree" });
    assert.ok(strict || !middle, `"${ability}" asks less strictly under the STRICTER setting`);
  }
});

/* =====================================================================
 * 4. THE DESK: NOT ASKED IS STILL TOLD
 * ===================================================================== */

function desk(over: Partial<ConstructorParameters<typeof ApprovalDesk>[0]> = {}) {
  const sent: unknown[] = [];
  const told: { action: string }[] = [];
  const d = new ApprovalDesk({
    send: f => sent.push(f),
    log: () => { /* quiet */ },
    onUnasked: u => told.push({ action: u.facts.action }),
    ...over,
  });
  return { d, sent, told };
}

test("ask me every time: the desk puts a card on the wire and waits", async () => {
  const { d, sent, told } = desk();
  const waiting = d.ask({
    agent: agent({ trust: "askEveryTime" }), channelId: "c1",
    facts: { action: "push", repo: "vikas/cloud9", branch: "cloud9/x", commits: 3 },
  });
  assert.equal(d.pending, 1, "it is standing at the gate");
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { type: string }).type, "askApproval");
  assert.equal(told.length, 0, "nothing went ahead unasked");
  d.giveUpAll("test over");
  assert.equal((await waiting).approved, false);
});

test("just get on with it: a push STILL puts a card on the wire", async () => {
  const { d, sent } = desk();
  const waiting = d.ask({
    agent: agent({ trust: "localFree" }), channelId: "c1",
    facts: { action: "push", repo: "vikas/cloud9", branch: "cloud9/x", commits: 3 },
  });
  assert.equal(sent.length, 1, "the middle setting must not silence a push");
  d.giveUpAll("test over");
  assert.equal((await waiting).approved, false);
});

test("don't ask me: it goes ahead with no card — and he is TOLD, from counted facts", async () => {
  const { d, sent, told } = desk();
  const outcome = await d.ask({
    agent: agent({ trust: "neverAsk" }), channelId: "c1",
    facts: { action: "pullRequest", repo: "vikas/cloud9", branch: "cloud9/x", base: "main" },
  });
  assert.equal(outcome.approved, true);
  assert.equal(outcome.unasked, true, "an approval nobody gave must say so");
  assert.equal(outcome.approvalId, undefined, "there was no card, so there is no card id");
  assert.match(outcome.reason, /Don't ask me/i);
  assert.equal(sent.length, 0, "no card was drawn");
  assert.equal(d.pending, 0, "nothing is waiting");
  // NOT ASKED IS NOT UNRECORDED — the room is told, from the same facts
  assert.deepEqual(told, [{ action: "pullRequest" }]);
});

test("an action Cloud9 has no words for never happens, whatever the setting", async () => {
  // "we cannot describe it" must not be answerable by trust: an action with no
  // row on REMOTE_ACTIONS has no sentence and no counted facts, so letting it
  // through would be trusting a blank.
  for (const trust of ["askEveryTime", "localFree", "neverAsk"] as AgentTrust[]) {
    const { d, sent, told } = desk();
    const outcome = await d.ask({
      agent: agent({ trust }), channelId: "c1",
      facts: { action: "deleteEverything" as RemoteAction },
    });
    assert.equal(outcome.approved, false, trust);
    assert.equal(outcome.unasked, undefined, trust);
    assert.equal(sent.length, 0, trust);
    assert.equal(told.length, 0, trust);
  }
});

/* =====================================================================
 * 5. THE AUDIT SURVIVES EVERY SETTING
 * ===================================================================== */

test("the run record shows every command whatever the setting, and says which rule it ran under", () => {
  for (const trust of ["askEveryTime", "localFree", "neverAsk"] as AgentTrust[]) {
    const record = buildRunRecord(
      {
        kind: "chat", agentId: "a1", agentName: "Scout", provider: "claude",
        requestedBy: "Vikas", requestedByKind: "human", ask: "go build this",
        startedAt: 1, trust,
      },
      {
        finishedAt: 2, outcome: "ok", reply: "done",
        trace: {
          provider: "claude", text: "done", events: 3,
          steps: [
            { seq: 1, kind: "command", label: "npm test", ok: true },
            { seq: 2, kind: "command", label: "git commit", ok: true },
            { seq: 3, kind: "command", label: "git push", ok: true },
          ],
        },
      },
      "r-1-aaaa");
    assert.equal(record.steps.length, 3, `${trust}: every command is written down`);
    assert.deepEqual(record.steps.map(s => s.label), ["npm test", "git commit", "git push"]);
    assert.equal(record.trust, trust, "the record says which rule it ran under");
    assert.equal(validateRunRecord(record), null);
  }
});

test("a run from before this existed reads as ask-me-every-time, not as permission", () => {
  const old = buildRunRecord(
    { kind: "chat", agentId: "a1", agentName: "Scout", provider: "claude",
      requestedBy: "Vikas", requestedByKind: "human", ask: "hello", startedAt: 1 },
    { finishedAt: 2, outcome: "ok" }, "r-1-bbbb");
  assert.equal(old.trust, undefined);
  assert.equal(trustOf(old), "askEveryTime");
  assert.equal(validateRunRecord(old), null, "old records must still be readable");
  // and a record cannot claim a rule that does not exist
  assert.ok(validateRunRecord({ ...old, trust: "bypass" }));
});

/* =====================================================================
 * 6. THE SCREEN SAYS THE SAME THING THE RULE DOES
 * ===================================================================== */

test("the editor's “you'll be asked before it” list obeys the setting, and never overstates it", () => {
  const capable = agent({ trust: "askEveryTime" });
  assert.ok(describeApprovalNeeds(capable).length > 0, "strict: it does stop for these");
  assert.deepEqual(describeApprovalNeeds(agent({ trust: "localFree" })), [],
    "a new agent holds no connected service, so nothing local is left to ask about");
  assert.deepEqual(describeApprovalNeeds(agent({ trust: "neverAsk" })), []);
});

test("what still asks under the middle setting is LISTED, not promised", () => {
  const listed = describeRemoteAsks({ trust: "localFree" });
  // every row of the shared table, in his words — no hand-written subset
  assert.equal(listed.length, EVERY_REMOTE_ACTION.length);
  assert.deepEqual([...listed].sort(), Object.values(REMOTE_ACTIONS).sort());
  assert.ok(listed.some(w => /push/i.test(w)));
  assert.ok(listed.some(w => /pull request/i.test(w)));
  // strictest lists the same; most permissive correctly lists nothing
  assert.deepEqual(describeRemoteAsks({ trust: "askEveryTime" }), listed);
  assert.deepEqual(describeRemoteAsks({ trust: "neverAsk" }), []);
});

test("every setting has words for a card and words for a button, and they are not jargon", () => {
  for (const level of TRUST_LEVELS) {
    for (const words of [level.label, level.plainWords, level.cardWords]) {
      assert.ok(words.trim().length > 0, level.level);
      assert.doesNotMatch(words, /permission-mode|bypass|sandbox|MCP|approvalsFor|boolean/i,
        `${level.level}: "${words}" is jargon`);
    }
  }
});
