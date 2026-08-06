import { tempDir } from "./tmp-for-tests.js";
// THE PRIVATE TURN MANIFEST AT THE ENGINE/WIRE SEAM.
//
// `artifacts.test.ts` proves the folder sweep. These checks prove the remaining
// promise: every real turn reaches that sweep, and the exact note/link facts ride
// on the publish frame with the run that produced those bytes.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  AgentDef, AgentSchedule, ClientFrame, Message, Task, WorldState,
} from "@cloud9/shared";
import { ArtifactSweep, sweepProduced } from "./artifacts.js";
import { Engine, TurnInput } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";

const tmp = (): string => tempDir("cloud9-artifact-manifest-");

const normalizeSource = (source: string): string => source.replace(/\r\n?/g, "\n");
const readSource = (file: string): string => normalizeSource(fs.readFileSync(file, "utf8"));

const agent = (): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Maker", emoji: "M", persona: "You make files",
  abilities: { webSearch: false, files: true, schedules: false, background: true },
  createdAt: 0,
});

function put(dir: string, rel: string, body: string | Buffer, at?: number): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  const current = at ?? Date.now() + 2000;
  fs.utimesSync(full, new Date(current), new Date(current));
}

class WritingProvider implements ClaudeProvider {
  calls: RespondInput[] = [];
  constructor(private readonly write: (input: RespondInput) => void) {}
  async respond(input: RespondInput): Promise<string> {
    this.calls.push(input);
    this.write(input);
    return "done";
  }
}

function makeEngine(write: (dir: string, input: RespondInput) => void) {
  const dataDir = tmp();
  let engine!: Engine;
  const provider = new WritingProvider(input => {
    const dir = input.workdir ?? engine.agentDataDir(agent().id);
    write(dir, input);
  });
  engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir, provider,
    github: {
      runner: async () => ({
        code: 1, stdout: "", stderr: "not connected", timedOut: false, notFound: true,
      }),
    },
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { ws: unknown }).ws = {
    readyState: 1,
    send: (raw: string) => frames.push(JSON.parse(raw) as ClientFrame),
  };
  return { engine, frames, provider };
}

type PublishFrame = Extract<ClientFrame, { type: "publishArtifact" }>;

const publishes = (frames: ClientFrame[]): PublishFrame[] =>
  frames.filter((frame): frame is PublishFrame => frame.type === "publishArtifact");

const runId = (frames: ClientFrame[]): string => {
  const frame = frames.find(row => row.type === "runRecorded");
  assert.ok(frame, "the turn's run is sent before its files");
  return (frame.record as { id: string }).id;
};

const trigger: Message = {
  id: "m1", channelId: "c1", authorId: "u1", authorName: "Vikas",
  authorKind: "human", text: "make the file", ts: Date.now(),
};

function entryWorld(): WorldState {
  const a = agent();
  return {
    me: { id: "u1", name: "Vikas" },
    users: [{ id: "u1", name: "Vikas" }],
    agents: [a],
    channels: [{
      id: "c1", name: "work", kind: "channel", memberIds: ["u1", a.id], createdAt: 0,
    }],
    messages: [], agentStatus: {}, tasks: [], approvals: [],
  } as unknown as WorldState;
}

function installState(engine: Engine): void {
  engine.state = entryWorld();
}

async function waitForPublish(frames: ClientFrame[]): Promise<void> {
  const deadline = Date.now() + 3000;
  while (publishes(frames).length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(publishes(frames).length, 1, "the entry path reached exactly one publish funnel");
}

function oneRunLinkedPublish(frames: ClientFrame[]): PublishFrame {
  const sent = publishes(frames);
  assert.equal(sent.length, 1, "the entry path published exactly one produced file");
  assert.equal(frames.filter(frame => frame.type === "runRecorded").length, 1,
    "the entry path made exactly one run record");
  assert.equal(sent[0].runId, runId(frames), "the publish points at this exact run");
  return sent[0];
}

function initialiseRepository(): string {
  const dir = tmp();
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Cloud9 Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "cloud9-test@example.invalid"],
    { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "seed"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("publishArtifact carries the matching note and exact-version typed links, not the manifest", async () => {
  const { engine, frames } = makeEngine(dir => {
    put(dir, "summary.pdf", "summary bytes");
    put(dir, "figures.csv", "figure bytes");
    put(dir, ".cloud9/artifact-links.json", JSON.stringify({
      files: [{
        name: "summary.pdf",
        note: "final figures",
        links: [
          { kind: "made-from", target: { artifactId: "af-123", version: 2 } },
          { kind: "goes-with", target: { artifactId: "af-456", version: 7 } },
        ],
      }, {
        name: "not-made.txt",
        note: "a manifest row cannot create a file",
      }],
    }));
  });

  await engine.respondAs(agent(), {
    context: "", trigger: "make the pack", triggerAuthor: "Vikas",
    kind: "chat", channelId: "c1",
  });

  const sent = publishes(frames);
  assert.deepEqual(sent.map(frame => frame.name).sort(), ["figures.csv", "summary.pdf"],
    "the private manifest and names it merely mentions are never published");
  const summary = sent.find(frame => frame.name === "summary.pdf")!;
  const figures = sent.find(frame => frame.name === "figures.csv")!;
  assert.deepEqual(summary, {
    type: "publishArtifact", channelId: "c1", agentId: "a1", name: "summary.pdf",
    dataBase64: Buffer.from("summary bytes").toString("base64"),
    runId: runId(frames),
    note: "final figures",
    links: [
      { kind: "made-from", target: { artifactId: "af-123", version: 2 } },
      { kind: "goes-with", target: { artifactId: "af-456", version: 7 } },
    ],
  });
  assert.equal(figures.note, undefined);
  assert.equal(figures.links, undefined);
});

test("captured frames survive rewrite, replacement, deletion and manifest mutation", () => {
  const dir = tmp();
  const since = Date.now();
  const rewritePath = path.join(dir, "rewrite.txt");
  const replacePath = path.join(dir, "replace.txt");
  const deletePath = path.join(dir, "delete.txt");
  put(dir, "rewrite.txt", "old-one", since + 1000);
  put(dir, "replace.txt", "old-two", since + 1100);
  put(dir, "delete.txt", "old-three", since + 1200);
  put(dir, ".cloud9/artifact-links.json", JSON.stringify({
    files: [{
      name: "rewrite.txt", note: "captured note",
      links: [{ kind: "made-from", target: { artifactId: "af-source", version: 4 } }],
    }],
  }), since + 1300);
  const captured = sweepProduced(dir, { since });

  fs.writeFileSync(rewritePath, "new-one"); // same size
  fs.utimesSync(rewritePath, new Date(since + 1000), new Date(since + 1000));
  fs.rmSync(replacePath);
  fs.writeFileSync(replacePath, "new-two");
  fs.rmSync(deletePath);
  fs.writeFileSync(path.join(dir, ".cloud9/artifact-links.json"), JSON.stringify({
    files: [{ name: "rewrite.txt", note: "mutated note", links: [] }],
  }));

  const { engine, frames } = makeEngine(() => { /* this test publishes a pre-captured sweep */ });
  const input: TurnInput = {
    context: "", trigger: "snapshot", triggerAuthor: "Vikas",
    kind: "task", channelId: "c1", taskId: "t-snapshot",
  };
  (engine as unknown as {
    publishCaptured: (a: AgentDef, i: TurnInput, runId: string, sweep: ArtifactSweep) => void;
  }).publishCaptured(agent(), input, "r-snapshot", captured);

  const sent = publishes(frames);
  assert.equal(sent.length, 3);
  const byName = new Map(sent.map(frame => [frame.name, frame]));
  assert.equal(Buffer.from(byName.get("rewrite.txt")!.dataBase64, "base64").toString(), "old-one");
  assert.equal(Buffer.from(byName.get("replace.txt")!.dataBase64, "base64").toString(), "old-two");
  assert.equal(Buffer.from(byName.get("delete.txt")!.dataBase64, "base64").toString(), "old-three");
  assert.equal(byName.get("rewrite.txt")!.note, "captured note");
  assert.deepEqual(byName.get("rewrite.txt")!.links,
    [{ kind: "made-from", target: { artifactId: "af-source", version: 4 } }]);
  for (const frame of sent) {
    assert.equal(frame.runId, "r-snapshot");
    assert.equal(frame.taskId, "t-snapshot");
  }
});

test("source normalization gives LF, CRLF and CR identical static parsing", () => {
  const lf = [
    "  private publishCaptured(",
    "    file.bytes.toString(\"base64\");",
    "  /**",
    "   * Send one run",
    "export interface ProducedFile {",
    "  bytes: Buffer;",
    "}",
    "export interface NextType {",
  ].join("\n") + "\n";
  const parse = (raw: string) => {
    const source = normalizeSource(raw);
    const publishStart = source.indexOf("  private publishCaptured(");
    const publishEnd = source.indexOf("\n  /**\n   * Send one run", publishStart);
    const producedStart = source.indexOf("export interface ProducedFile {");
    const producedEnd = source.indexOf("\n}\n", producedStart);
    assert.ok(publishStart >= 0 && publishEnd > publishStart);
    assert.ok(producedStart >= 0 && producedEnd > producedStart);
    return {
      publishBody: source.slice(publishStart, publishEnd),
      producedType: source.slice(producedStart, producedEnd),
    };
  };
  const expected = parse(lf);

  assert.deepEqual(parse(lf.replace(/\n/g, "\r\n")), expected);
  assert.deepEqual(parse(lf.replace(/\n/g, "\r")), expected);
});

test("the source has one provider doorway and one produced-file funnel", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readSource(path.resolve(here, "../src/engine.ts"));
  const artifactSource = readSource(path.resolve(here, "../src/artifacts.ts"));
  const start = source.indexOf("  async respondAs(");
  const end = source.indexOf("\n  private recordRun(", start);
  assert.ok(start >= 0 && end > start, "the respondAs body is still findable by its method declarations");
  const respondAsBody = source.slice(start, end);

  assert.equal([...source.matchAll(/\bprovider\.respond\(/g)].length, 1,
    "a new provider entry point must not bypass respondAs");
  assert.equal([...source.matchAll(/this\.shareProduced\(/g)].length, 1,
    "a new publish path must not bypass the one post-turn funnel");
  assert.match(respondAsBody, /provider\.respond\(/,
    "respondAs owns the only call into a provider");
  assert.match(respondAsBody, /this\.shareProduced\(/,
    "the same respondAs body owns produced-file sharing for chat, task, schedule and repository turns");
  const publishStart = source.indexOf("  private publishCaptured(");
  const publishEnd = source.indexOf("\n  /**\n   * Send one run", publishStart);
  assert.ok(publishStart >= 0 && publishEnd > publishStart,
    "the captured-value publisher is findable by its source boundaries");
  const publishBody = source.slice(publishStart, publishEnd);
  assert.match(publishBody, /file\.bytes\.toString\("base64"\)/,
    "publish encodes the held Buffer directly");
  assert.doesNotMatch(publishBody, /\b(fs\.|path\.|open|stat|readFile|readProduced|sha|hash)/,
    "nothing after capture may reopen, restat, reread or rehash a source path");
  const producedStart = artifactSource.indexOf("export interface ProducedFile {");
  const producedEnd = artifactSource.indexOf("\n}\n", producedStart);
  const producedType = artifactSource.slice(producedStart, producedEnd);
  assert.match(producedType, /bytes: Buffer/);
  assert.doesNotMatch(producedType, /\b(path|state):/,
    "a publishable value has no source recipe left to consult");
  assert.doesNotMatch(artifactSource, /readFileSync\(manifestPath/,
    "a private manifest must not be loaded whole before its byte limit is known");
  assert.match(artifactSource, /ARTIFACT_LIMITS\.manifestBytes \+ 1/,
    "the manifest reader is bounded by the shared limit plus one refusal byte");
});

test("real chat, task, schedule and repository entries each reach one run-linked publish", async t => {
  await t.test("chat entry", async () => {
    const { engine, frames, provider } = makeEngine(dir => put(dir, "chat.txt", "chat"));
    installState(engine);

    await engine.takeTurn(agent(), "c1", trigger);

    const publish = oneRunLinkedPublish(frames);
    assert.equal(publish.name, "chat.txt");
    assert.equal(publish.taskId, undefined);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].kind, "chat");
    assert.equal(provider.calls[0].workdir, undefined,
      "ordinary chat stays in the agent's own folder");
  });

  await t.test("delegated task through the public relay connection", async () => {
    const task: Task = {
      id: "t1", title: "make the task file", requesterId: "u1", requesterName: "Vikas",
      agentId: "a1", channelId: "c1", status: "not_started", createdAt: 1, updatedAt: 1,
    };
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const dataDir = tmp();
    let engine!: Engine;
    const provider = new WritingProvider(input => {
      put(input.workdir ?? engine.agentDataDir("a1"), "task.txt", "task");
    });
    engine = new Engine({
      relayUrl: `ws://127.0.0.1:${port}`, token: "t", dataDir, provider,
    });
    const frames: ClientFrame[] = [];
    server.on("connection", socket => {
      let admitted = false;
      socket.on("message", raw => {
        const frame = JSON.parse(String(raw)) as ClientFrame;
        frames.push(frame);
        if (!admitted && frame.type === "hello") {
          admitted = true;
          socket.send(JSON.stringify({ type: "welcome", state: entryWorld() }));
          socket.send(JSON.stringify({ type: "task", task }));
        }
      });
    });

    try {
      engine.connect();
      await waitForPublish(frames);

      const publish = oneRunLinkedPublish(frames);
      assert.equal(publish.name, "task.txt");
      assert.equal(publish.taskId, task.id, "the delegated job id reaches the published version");
      assert.equal(provider.calls.length, 1);
      assert.equal(provider.calls[0].kind, "task");
      const recorded = frames.find(frame => frame.type === "runRecorded");
      assert.ok(recorded && recorded.type === "runRecorded");
      assert.equal(recorded.record.taskId, task.id,
        "the relay task frame carries its id into the run and published version");
    } finally {
      engine.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  await t.test("scheduled tick", async () => {
    const { engine, frames, provider } = makeEngine(dir => put(dir, "schedule.txt", "schedule"));
    installState(engine);
    const schedule: AgentSchedule = {
      id: "s1", agentId: "a1", channelId: "c1",
      when: "every 1m", prompt: "make the scheduled file", enabled: true,
    };
    engine.schedules = [schedule];

    engine.scheduler.tick(new Date(Date.now() + 120_000));
    await waitForPublish(frames);

    const publish = oneRunLinkedPublish(frames);
    assert.equal(publish.name, "schedule.txt");
    assert.equal(publish.taskId, undefined);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].kind, "schedule");
    assert.equal(provider.calls[0].workdir, undefined);
  });

  await t.test("repository worktree entry", async () => {
    const repoDir = initialiseRepository();
    const { engine, frames, provider } = makeEngine((dir, input) => {
      assert.equal(dir, input.workdir, "the provider writes in the worktree it was handed");
      put(dir, "repo-result.txt", "repository result");
    });
    installState(engine);

    const result = await engine.workInRepository(agent(), {
      channelId: "c1", ask: "make the repository file", triggerAuthor: "Vikas", repoDir,
    });

    assert.ok(result, "the public repository entry completed");
    const publish = oneRunLinkedPublish(frames);
    assert.equal(publish.name, "repo-result.txt",
      "sharing swept the worktree, not the agent's ordinary folder");
    assert.equal(publish.taskId, undefined);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].workdir, result!.path,
      "the repository entry propagated its exact worktree into the turn");
    assert.equal(fs.existsSync(path.join(result!.path, "repo-result.txt")), true);
  });
});

test("markdown that mentions file relationships never becomes typed link data", async () => {
  const { engine, frames } = makeEngine(dir => {
    put(dir, "report.md", [
      "Made from cloud9://artifact/af-123@2.",
      "{\"kind\":\"goes-with\",\"target\":{\"artifactId\":\"af-456\",\"version\":7}}",
    ].join("\n"));
  });

  await engine.respondAs(agent(), {
    context: "", trigger: "make it", triggerAuthor: "Vikas", kind: "chat", channelId: "c1",
  });

  const sent = publishes(frames);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].note, undefined);
  assert.equal(sent[0].links, undefined,
    "only the private typed manifest may create stored relationships");
});

test("a malformed current manifest produces a plain refusal but the file still publishes unannotated", async () => {
  const { engine, frames } = makeEngine(dir => {
    put(dir, "summary.pdf", "summary bytes");
    put(dir, ".cloud9/artifact-links.json", JSON.stringify({
      files: [{
        name: "private-roadmap.txt", note: "must not survive",
        links: "not a list",
      }],
    }));
  });

  await engine.respondAs(agent(), {
    context: "", trigger: "make it", triggerAuthor: "Vikas", kind: "chat", channelId: "c1",
  });

  const sent = publishes(frames);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].note, undefined);
  assert.equal(sent[0].links, undefined);
  const refusal = frames.find(frame => frame.type === "agentSend");
  assert.ok(refusal);
  assert.match(String(refusal.text), /did not add any file notes or links/i);
  assert.match(String(refusal.text), /artifact-links\.json/i);
  assert.ok(!String(refusal.text).includes("must not survive"));
  assert.ok(!String(refusal.text).includes("private-roadmap.txt"),
    "a room-visible refusal cannot repeat a private manifest file name");
});
