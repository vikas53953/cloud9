// DOES THE NAMING RULE LOCK HIM OUT OF HIS OWN DATA?
//
// The one way a uniqueness rule goes badly wrong is by being asked of rows that
// already exist. His live database is FULL of the case: measured on 2026-07-30,
// the checkpointed file alone holds 23 agents ALL called Scout and 22 rooms all
// called trip-goa (with the write-ahead log counted, 35 and 45) — QA junk from
// before the throwaway-stack fix, but junk that is really there. A rule that
// refused to open that, or refused to save any of it, would be a worse bug than
// the one it was written for.
//
// This opens a COPY — never the original, and it refuses to run if the path it
// is given is the repository's own database — lets the hub migrate it, and then
// proves three things on the real rows:
//   1. it opens at all, and nothing was lost
//   2. an agent that shares its name with every other one can still be SAVED
//   3. a NEW name that clashes is still refused, so the rule is on, not off
//
//   node scripts/qa-his-db.mjs <path to a copy>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Relay } from "../apps/relay/dist/server.js";
import { TestClient } from "../apps/relay/dist/testclient.js";
import { reportAndExit } from "./qa-target.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.resolve(process.argv[2] ?? "");
const EXPECTED_CHECKS = 5;
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? " :: " + detail : ""}`);
};

if (!dbPath || !fs.existsSync(dbPath)) {
  console.error("give me the path to a COPY of the database");
  process.exit(2);
}
// HIS ORIGINAL IS NEVER TOUCHED. Not a convention — a refusal.
if (path.resolve(dbPath).startsWith(path.join(repo, "cloud9-relay.db"))) {
  console.error("that is the real database, not a copy. Copy it first.");
  process.exit(2);
}

const before = (() => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const count = t => db.prepare(`select count(*) c from ${t}`).get().c;
  const rows = {
    channels: count("channels"), agents: count("agents"),
    users: count("users"), messages: count("messages"),
  };
  const agents = db.prepare("select json from agents").all().map(r => JSON.parse(r.json));
  /* SIGN IN AS THE PERSON WHOSE AGENTS THESE ARE, not as a fresh owner. A new
     token would make a new user, and the question this file exists to answer —
     "can he still save the crew he already has" — would go untested because
     none of it would be his. So the token is read out of the copy. */
  const busiest = agents.reduce((m, a) => (m[a.ownerId] = (m[a.ownerId] ?? 0) + 1, m), {});
  const ownerId = Object.entries(busiest).sort((x, y) => y[1] - x[1])[0]?.[0];
  const token = ownerId
    ? db.prepare("select token from tokens where userId=?").get(ownerId)?.token
    : undefined;
  db.close();
  return { rows, agents, ownerId, token };
})();

const relay = new Relay({
  dbPath, ownerToken: before.token ?? "tok-owner", ownerName: "Vikas",
});
const port = await relay.listen(0);
const owner = new TestClient(`ws://127.0.0.1:${port}`, before.token ?? "tok-owner", "desktop");
const welcome = await owner.wait(f => f.type === "welcome");

ok("his own database still opens, and the hub migrates it without complaint", true,
  `${before.rows.channels} rooms, ${before.rows.agents} agents, ${before.rows.messages} messages`);

const after = (() => {
  const count = t => relay.store.db.prepare(`select count(*) c from ${t}`).get().c;
  return {
    channels: count("channels"), agents: count("agents"),
    users: count("users"), messages: count("messages"),
  };
})();
/* NOTHING WAS LOST. Not "nothing changed": opening a hub can legitimately add
   a row (a first-boot #general, this run's own sign-in). What must never happen
   is a row going missing, so every count is checked for having gone DOWN. */
ok("nothing was lost on the way in — no row count went down",
  Object.keys(before.rows).every(k => after[k] >= before.rows[k]),
  `${JSON.stringify(before.rows)} → ${JSON.stringify(after)}`);

const key = s => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
const tally = {};
for (const a of before.agents) tally[key(a.name)] = (tally[key(a.name)] ?? 0) + 1;
const worst = Object.entries(tally).sort((x, y) => y[1] - x[1])[0] ?? ["(none)", 0];
ok("this database really does hold the case the rule could have broken — duplicate names",
  worst[1] > 1, `${worst[1]} agents share the name "${worst[0]}"`);

// 2. one of those duplicates must still be editable
const mine = before.agents.filter(a => a.ownerId === welcome.state.me.id);
const victim = mine.find(a => tally[key(a.name)] > 1) ?? mine[0];
let saved = false;
if (victim) {
  owner.frames.length = 0;
  owner.send({ type: "updateAgent", agent: { ...victim, persona: `${victim.persona ?? ""} .` } });
  const back = await Promise.race([
    owner.wait(f => f.type === "agent" && f.agent.id === victim.id, 8000).then(f => f),
    owner.wait(f => f.type === "error", 8000).then(f => f).catch(() => null),
  ]).catch(err => ({ type: "error", error: String(err) }));
  saved = back?.type === "agent";
  ok("an agent that shares its name with every other one can STILL be saved",
    saved, saved ? `${victim.name} saved` : `refused: ${back?.error ?? "no answer"}`);
} else {
  ok("an agent that shares its name with every other one can STILL be saved",
    false, "this copy holds none of the owner's agents to try");
}

// 3. and the rule is genuinely ON — a NEW clash is refused
owner.frames.length = 0;
owner.send({
  type: "createAgent",
  agent: {
    name: victim?.name ?? "Scout", emoji: "✨", persona: "a brand-new clash",
    provider: "claude", model: "claude-sonnet-5",
    abilities: { webSearch: false, files: false, schedules: false, background: false },
    approvals: {},
  },
});
const refused = await owner.wait(f => f.type === "error", 8000).catch(() => null);
ok("and the rule is on, not off — a NEW agent with a name he already has is refused",
  !!refused && /you already have an agent called/.test(refused.error),
  refused?.error ?? "nothing was refused");

owner.close();
relay.close();
reportAndExit("qa-his-db.mjs", results, EXPECTED_CHECKS);
