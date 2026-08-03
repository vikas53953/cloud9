// THE CONNECTIONS FILE — proving the switch is no longer a promise with nothing
// behind it, and that it never claims more than it has.
//
// The `connections` switch has been wired at the command line since 2026-07-30
// (`claudeArgs` passes `--mcp-config`, `grantedSupply` gates it) and NOTHING on
// any screen ever chose a file, so it was permanently inert: allowed, approved,
// and handing the agent nothing at all. `connections.ts` is the one owner that
// closes that — a stored path becomes a real supply, or an honest reason why not.
//
// These tests pin the three answers the owner has to be able to trust:
//   an agent WITH a file    → the engine really gets it, and so does the argv;
//   an agent WITHOUT one    → the engine gets nothing and the screen says so;
//   a file that has GONE    → reported in plain words, and never used anyway.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentAbilities, AgentDef, validateConnectionsFile } from "@cloud9/shared";
import { connectionsFileFor, connectionsWords, mcpConfigPathFor } from "./connections.js";
import { grantedSupply, renderCapabilities } from "./abilities.js";
import { claudeArgs } from "./claude-cli.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};

const agent = (abilities: Partial<AgentAbilities> = {}, over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { ...ALL_OFF, ...abilities }, createdAt: 0, ...over,
});

const CHOSEN = "C:\\Users\\Vikas\\AppData\\Roaming\\cloud9\\calendar-mcp.json";
/** a disk where exactly one file exists */
const diskWith = (...there: string[]) => {
  const asked: string[] = [];
  const onDisk = (p: string): boolean => { asked.push(p); return there.includes(p); };
  return { onDisk, asked };
};

// ------------------------------------------------- an agent WITH a file gets it

test("an agent with a connections file: the engine is handed that exact path", () => {
  const scout = agent({ connections: true }, { connectionsFile: CHOSEN });
  const disk = diskWith(CHOSEN);

  const state = connectionsFileFor(scout, disk.onDisk);
  assert.equal(state.state, "ready");
  assert.equal(state.path, CHOSEN);
  assert.equal(state.supply, CHOSEN);

  // what the engine host actually reads
  assert.equal(mcpConfigPathFor(scout, disk.onDisk), CHOSEN,
    "the one owner of path resolution must hand the launcher the owner's file");
  assert.ok(disk.asked.includes(CHOSEN), "and it must ask the disk, not assume");

  // and it survives every gate between here and the command line
  const supplied = grantedSupply(scout, { mcpConfigPath: mcpConfigPathFor(scout, disk.onDisk) });
  assert.equal(supplied.mcpConfigPath, CHOSEN);
  const args = claudeArgs(scout, [], { mcpConfigPath: mcpConfigPathFor(scout, disk.onDisk) });
  assert.equal(args[args.indexOf("--mcp-config") + 1], CHOSEN,
    "the whole point: the file the owner chose reaches the real argv");
  assert.ok(args.includes("--strict-mcp-config"),
    "his OWN servers still never load — that guard is not traded away for this one");
});

test("with a file really there, the agent is told it CAN use its connected services", () => {
  const scout = agent({ connections: true }, { connectionsFile: CHOSEN });
  const disk = diskWith(CHOSEN);
  const prompt = renderCapabilities(
    scout, grantedSupply(scout, { mcpConfigPath: mcpConfigPathFor(scout, disk.onDisk) }));
  assert.match(prompt, /You CAN use the connected services your owner set up for you/);
});

// --------------------------------------------- an agent WITHOUT one gets nothing

test("no file chosen: the engine gets nothing and the screen says there are none", () => {
  const scout = agent({ connections: true });
  const disk = diskWith(CHOSEN);

  const state = connectionsFileFor(scout, disk.onDisk);
  assert.equal(state.state, "none");
  assert.equal(state.path, undefined);
  assert.equal(state.supply, undefined);
  assert.equal(mcpConfigPathFor(scout, disk.onDisk), undefined);
  assert.equal(disk.asked.length, 0, "there is nothing to check, so nothing is checked");

  // the words the owner reads
  const words = connectionsWords(state, "Scout");
  assert.match(words.headline, /No connections file chosen yet/);
  assert.match(words.detail, /it has none/);
  assert.doesNotMatch(words.headline + words.detail, /\bin use\b/i,
    "a switch with nothing behind it must never read as working");

  // nothing on the command line, and the agent is told the truth about it
  assert.ok(!claudeArgs(scout).includes("--mcp-config"));
  assert.match(
    renderCapabilities(scout, grantedSupply(scout, {})),
    /You CANNOT use any connected service right now/);
});

test("blank and whitespace mean the same as absent — there is no second way to say none", () => {
  const disk = diskWith(CHOSEN);
  for (const stored of ["", "   ", "\t"]) {
    const state = connectionsFileFor(agent({ connections: true }, { connectionsFile: stored }), disk.onDisk);
    assert.equal(state.state, "none", `stored ${JSON.stringify(stored)} must read as none`);
    assert.equal(state.supply, undefined);
  }
});

// ------------------------------------------------ a file that has GONE is said

test("the file was moved or deleted: reported plainly, and NOT used", () => {
  const scout = agent({ connections: true }, { connectionsFile: CHOSEN });
  const disk = diskWith(/* nothing on this disk */);

  const state = connectionsFileFor(scout, disk.onDisk);
  assert.equal(state.state, "gone");
  assert.equal(state.path, CHOSEN, "he is still shown WHICH file, so he can find it again");
  assert.equal(state.supply, undefined, "a missing file must never reach a command line");
  assert.equal(mcpConfigPathFor(scout, disk.onDisk), undefined);
  assert.ok(!claudeArgs(scout, [], { mcpConfigPath: mcpConfigPathFor(scout, disk.onDisk) })
    .includes("--mcp-config"));

  const words = connectionsWords(state, "Scout");
  assert.match(words.headline, /That file is gone/);
  assert.match(words.detail, /not being used/);

  // and the agent is told it has none, rather than being told it can
  assert.match(
    renderCapabilities(scout, grantedSupply(scout, { mcpConfigPath: mcpConfigPathFor(scout, disk.onDisk) })),
    /You CANNOT use any connected service right now/);
});

test("a check that throws is a 'no', never an exception into a turn", () => {
  const scout = agent({ connections: true }, { connectionsFile: CHOSEN });
  const state = connectionsFileFor(scout, () => { throw new Error("drive not ready"); });
  assert.equal(state.state, "gone");
  assert.equal(state.supply, undefined);
});

// ------------------------------------------------------- the switch still rules

test("the switch has the last word: a stored file grants nothing while it is off", () => {
  const off = agent({}, { connectionsFile: CHOSEN });
  const disk = diskWith(CHOSEN);
  const state = connectionsFileFor(off, disk.onDisk);
  assert.equal(state.state, "off");
  assert.equal(state.path, CHOSEN, "the choice is remembered, so switching back on is not retyping");
  assert.equal(state.supply, undefined);
  assert.equal(mcpConfigPathFor(off, disk.onDisk), undefined);
  assert.equal(disk.asked.length, 0, "an off switch is answered without touching the disk at all");
  assert.match(connectionsWords(state, "Scout").headline, /switched off/);
});

test("a path that is not a whole path on this computer is refused, not tried", () => {
  const disk = diskWith("mcp.json", "..\\mcp.json");
  for (const bad of ["mcp.json", "..\\up\\mcp.json", "C:\\a\\b\nrm.json"]) {
    const state = connectionsFileFor(
      agent({ connections: true }, { connectionsFile: bad }), disk.onDisk);
    assert.equal(state.state, "gone", `${JSON.stringify(bad)} must never be used`);
    assert.equal(state.supply, undefined);
    assert.ok(validateConnectionsFile(bad), "and the shared rule refuses it at the hub too");
  }
  assert.equal(disk.asked.length, 0, "a path we already refuse is never even looked for");
});

test("an agent this computer has never heard of supplies nothing", () => {
  // exactly what `engine.agentById()` returns for an unknown id, straight into
  // the one owner — it must be an honest nothing, not a crash mid-turn.
  assert.equal(mcpConfigPathFor(undefined, () => true), undefined);
});

test("every state says something different, and only one of them says it works", () => {
  const disk = diskWith(CHOSEN);
  const said = [
    connectionsFileFor(agent({}, { connectionsFile: CHOSEN }), disk.onDisk),
    connectionsFileFor(agent({ connections: true }), disk.onDisk),
    connectionsFileFor(agent({ connections: true }, { connectionsFile: "C:\\gone.json" }), disk.onDisk),
    connectionsFileFor(agent({ connections: true }, { connectionsFile: CHOSEN }), disk.onDisk),
  ].map(s => connectionsWords(s, "Scout"));
  const headlines = new Set(said.map(w => w.headline));
  assert.equal(headlines.size, 4, "four states, four answers — no state borrows another's words");
  assert.equal(said.filter(w => /in use/i.test(w.headline)).length, 1,
    "exactly one state may read as working, and it is the one with a file really there");
});
