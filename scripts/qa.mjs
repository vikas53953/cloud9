import { chromium } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  assertHarnessIsHonest, qaOwnerToken, qaTarget, reportAndExit, signInAsOwner, waitFor,
  waitForAgentAnswer,
} from "./qa-target.mjs";
// The screen shows `summarizeRun`'s sentence VERBATIM, so the check that it did
// has to be able to say the sentence itself. Imported from the same package the
// app imports, never re-spelled here.
// The size ceilings are the HUB's numbers. The screen reads them from this
// package and so does this suite, so a check can never agree with a number the
// renderer made up on its own.
// The Projects and mid-run-approval checks below hold the SCREEN to the
// contract's own sentences — `describeRemoteAction` writes the words the hub
// puts on the card, `validateRepo` writes the refusal the form prints, and
// REMOTE_ACTIONS is the one table naming what Cloud9 asks about. Imported
// rather than re-typed, so a check can never agree with a sentence this file
// made up.
import {
  ATTACHMENT_LIMITS, describeRemoteAction, detailRemoteAction, FILE_NAME_SENTENCE, humanMoney,
  isGitHubWriteKind,
  MESSAGE_LIMITS, NAME_LIMITS, REMOTE_ACTIONS, summarizeRun, validateLocalFolder, validateName,
  validateRepo,
  // THE SKILL LIBRARY, from the package the screen reads. Every count and every
  // sentence below is DERIVED from these two lists, never typed here — so a
  // sixteenth skill or a sixth shelf moves this suite with it instead of
  // leaving a number that used to be right, and a check can never agree with
  // wording this file made up.
  SKILL_CATEGORIES, SKILL_LIBRARY, SKILL_LIMITS,
  // THE FILE AN AGENT MADE — the reference a message carries and the one line a
  // card draws under its name, taken from the package the screen reads them
  // from. A check that spelled either of them here could agree with a card that
  // was wrong in exactly the same way.
  artifactRef, describeArtifactVersion,
} from "@cloud9/shared";
// THE LADDER AND THE TABLE, from the engine that owns them. Every count below
// is derived, never typed: a ninth capability or a fifth rung moves this suite
// with it instead of leaving a number here that used to be right.
import {
  abilitiesForReach, CAPABILITIES, REACH_LEVELS,
  // what a brand-new agent starts with, so this suite asks the table rather
  // than carrying a list of switch names that used to be right
  NEW_AGENT_ABILITIES, capabilitiesForNewAgent,
} from "@cloud9/engine/dist/abilities.js";
import { isolationFor } from "@cloud9/engine/dist/isolation.js";

/**
 * EVERYTHING ONE AGENT EDITOR PUTS IN FRONT OF HIM.
 *
 * The point of reading it as one object is the comparison it makes possible:
 * a role hired from the catalogue must offer EXACTLY this, field for field,
 * against an agent he typed out himself. He reported that it did not — no tool
 * permissions, no files folder, no skills — and the only check that can hold
 * that shut for good is one that compares the two screens rather than looking
 * for three things by name.
 */
const editorOffers = page => page.evaluate(() => ({
  sections: [...document.querySelectorAll(".editor .form-col > section h3")]
    .map(h => h.innerText.trim()),
  rungs: [...document.querySelectorAll(".editor .reachrung")].map(b => b.dataset.reach),
  abilities: [...document.querySelectorAll(".editor .abilitypick .toggle-row")]
    .map(r => r.dataset.ability),
  approvals: [...document.querySelectorAll(".editor .asksec .panelbox .toggle-row .tx b")]
    .map(b => b.innerText.trim()),
  whoCanUse: [...document.querySelectorAll(".editor .respondpick")].map(b => b.dataset.respond),
  skillsEditor: document.querySelectorAll(".editor .skills").length,
  skillButtons: [...document.querySelectorAll(".editor .skillhead button")]
    .map(b => b.innerText.trim()),
  honestReport: document.querySelectorAll(".editor .harnesshonest").length,
  namePlate: document.querySelectorAll(".editor .preview-card .plate .portrait svg").length,
}));

/**
 * The drawing of one portrait, so two screens can be held to the same face.
 *
 * The gradient's id is unique per render (React's `useId`), and it is the one
 * thing in there that is allowed to differ — so it is normalised out. Without
 * that, this would compare two identical drawings and call them different.
 */
const portraitOf = async (page, sel) =>
  (await page.$eval(sel, el => el.innerHTML)).replace(/plate-[A-Za-z0-9_:-]+/g, "PLATE");

const SHOTS = new URL("../docs/qa", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
fs.mkdirSync(SHOTS, { recursive: true });
// A QA run points at the throwaway stack by default, never at the real hub
// (finding #18). `qa-target.mjs` owns that decision for every QA script.
const { ui: UI, relayPort: RELAY_PORT } = qaTarget();

/**
 * PUT A FILE INTO A CONVERSATION THE WAY THE ENGINE DOES — the only way there is.
 *
 * `publishArtifact` is ENGINE ONLY at the hub: a desktop client that sends it is
 * refused with *"only your own agent engine can share a file an agent made"*,
 * and that refusal is the entire value of the store — attribution nobody can
 * fake. So this suite cannot type a file into the app, and must not pretend to:
 * it opens a second connection, says `hello` as an engine exactly as
 * `scripts/engine-host.mjs` does, and sends the real frame. Everything after
 * that — the storing, the versioning, the attribution, the push to everyone in
 * the room, the ticket, the bytes — is the hub's own code doing its own job.
 *
 * Closing this socket is safe: the real engine host stays connected, so the hub
 * still has an engine for this owner and nobody's agents go offline.
 */
function publishAsEngine({ channelId, agentId, name, data, note, runId, links }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}`);
    let over = false;
    const finish = (err, artifact) => {
      if (over) return;
      over = true;
      try { ws.close(); } catch { /* already gone */ }
      err ? reject(err) : resolve(artifact);
    };
    const timer = setTimeout(
      () => finish(new Error(`the hub never answered the publish of ${name}`)), 20000);
    ws.onopen = () => ws.send(JSON.stringify({
      type: "hello", token: qaOwnerToken(), client: "engine",
    }));
    ws.onmessage = ev => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.type === "welcome") {
        ws.send(JSON.stringify({
          type: "publishArtifact", channelId, agentId, name,
          dataBase64: Buffer.from(data).toString("base64"),
          ...(note ? { note } : {}), ...(runId ? { runId } : {}),
          ...(links ? { links } : {}),
        }));
      } else if (frame.type === "artifact" && frame.artifact.name === name) {
        clearTimeout(timer);
        finish(null, frame.artifact);
      } else if (frame.type === "error") {
        clearTimeout(timer);
        finish(new Error(frame.error));
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish(new Error("the QA engine socket failed")); };
  });
}

/**
 * A SECOND, real Cloud9 hub on another loopback port — a friend's, for the join
 * proof. It is the very same `Relay` the app runs, on a brand-new database, so
 * nothing here is stubbed: the browser dials it over a real socket, redeems a
 * real join token, and becomes a real member of it.
 */
async function startSecondHub() {
  const { Relay } = await import("@cloud9/relay");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-hubB-"));
  const token = "hubB-owner-" + crypto.randomBytes(8).toString("hex");
  const relay = new Relay({
    dbPath: path.join(dir, "hubB.db"), ownerToken: token, ownerName: "Priya", devMode: false,
  });
  const port = await relay.listen(0);
  return { relay, port, token, dir };
}

/** Mint a single-use join link ON a hub, as its owner — what the friend shares. */
function mintJoinTokenOn(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already gone */ }
      reject(new Error("the second hub never minted a join token"));
    }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token, client: "desktop" }));
    ws.onmessage = ev => {
      let f;
      try { f = JSON.parse(ev.data); } catch { return; }
      if (f.type === "welcome") ws.send(JSON.stringify({ type: "createJoinToken" }));
      else if (f.type === "joinToken") { clearTimeout(timer); try { ws.close(); } catch { /* gone */ } resolve(f.code); }
      else if (f.type === "error") { clearTimeout(timer); reject(new Error(f.error)); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("the second hub socket failed")); };
  });
}

/**
 * How many checks a complete run of this file performs.
 *
 * This number is the difference between "12 of 13 passed" (which reads like a
 * near-miss) and the truth, which was that 36 checks never ran at all. If the
 * run stops early it now FAILS and says so. Add or remove an `ok(...)` and this
 * number must move with it — a mismatch is the suite telling you it drifted.
 */
// 354 → 363: nine checks added for the phase 5 Majors — A3 (the composer keeps
// what he typed), B6/B6b (one Scout, and the refusal says so), D2/D3/D4 (a room
// name obeys the same rule an agent name does), F3 (everyday file names land,
// and the sentence is the rule's own), C12 (connecting asks GitHub there and
// then). One EXISTING check changed rather than being added: the one that used
// to assert a freshly connected repository says "Not looked at GitHub yet".
// 363 → 381: eighteen checks added. One is the model list's provenance on the
// harness card (skills-library-handoff §1 — a list proved by running each model
// and a list we are falling back on are not the same thing, and the screen now
// prints the engine's own sentence saying which). The other seventeen are the
// SKILL LIBRARY screen. One holds the
// no-role case (a hand-written agent is never told a role it does not have);
// the rest walk the library on a just-hired agent — it is reachable from the
// skills section, everything it ships with is on the shelves the library itself
// names, each card carries its own plain words and its own source, the whole
// procedure is readable before it is taken, the room left is said before he
// picks, nothing shows a rating or a count nobody measured, a shelf filters —
// and then the promise: what he takes is drawn as the SAME row as one he typed,
// with the same pencil and the same bin, editable word for word, deletable, and
// still ordinary after a round trip through the hub.
// 381 → 397: sixteen checks added for Phase 6's UI findings, and TWO EXISTING
// checks rewritten rather than added — the pair that used to assert the old,
// wrong behaviour of the ladder (that a hand-picked mix reads as the highest rung
// it covers). Of the sixteen: three hold the ladder to the switches (the exact
// two-abilities case he was shown, the words it says instead, and every rung
// reading back as exactly itself); ten hold "Escape closes what it opened" to
// its one owner (the casting-room brief, the quick-chat palette, the skill
// library, search with the focus deliberately taken away, and two overlays at
// once closing newest-first) — half of those read the STACK itself, so the
// mechanism is checked and not only the behaviour; and three hold the pluralising
// owner (the "1 CATEGORIES" tile in the singular, the same header in the plural,
// and a sweep of the whole screen for the shape of that bug).
// 397 → 410: thirteen checks added for the one thing Vikas named — the view not
// following to what he just typed — and for the whole CLASS of it, which is one
// missing rule with three faces rather than three bugs. Two hold the two halves
// that must not be confused (a message ARRIVING never drags him off what he is
// reading; SENDING follows wherever he had read back to) and one asks the rule
// itself which of the two it thought it was doing. Two hold the motion setting in
// both directions — smooth on a machine that has not asked for stillness, and no
// animation at all on one that has. Four hold "the bottom moving is the trigger":
// the file tray opening and a picture finishing loading each REPRODUCED as a real
// movement of the bottom with nothing arriving, and each followed. One holds the
// composer growing with what is typed into it (it was a one-line slot with a
// hidden scrollbar). One holds the cursor staying in the box when Send is CLICKED
// rather than pressed. One holds a thread's own list, through the same owner. And
// the last is the first: a check that he really was a long way from the newest
// message before any of it, so none of the rest can pass on a technicality.
// 410 → 440: thirty checks added by the artifact-store screen round.
// THIRTEEN are the file an agent made, finally on his screen: it arrives as a
// card with its name (never a path), the card says which agent made it and how
// big it is, version 1 is not labelled "version 1", the reference in the words
// is not printed beside the card that replaces it, the bytes really come back
// through the attachment's own one-use ticket, a second agent publishing the
// same name updates the SAME card and says whose version this now is, the
// earlier version is still listed with its author and still downloadable AS the
// old bytes, text can be read where it sits, a picture is a download and is
// never drawn into the room, a reference to something that is not there says so
// in plain words, the room's details list every file agents made in it, and a
// room where nobody has shared anything says that rather than showing a blank.
// EIGHT are the unsaved-work owner, on TWO different surfaces: an untouched
// editor is not "holding work", a typed one tells the one owner it is, a rail
// click then ASKS instead of throwing the words away, "keep editing" leaves
// every word where it was, saving does not ask (the bug the guard itself would
// introduce), "throw them away" really does, and the room-details panel — a
// completely different screen — reaches the same owner and asks on a change of
// conversation.
// NINE are error legibility: the owner strips the transport's "Error:",
// refuses to show computer-speak as the sentence while keeping the raw words
// reachable, passes a plain-English hub refusal through untouched, does the same
// for a database code, and then on the screen — a raw refusal from the hub's
// catch-all reaches him with no "Error:" anywhere on the page, and the audit's
// own photograph (one refusal, said twice, once politely and once not) is
// reproduced and comes back said exactly ONCE.
// 448 → 456: eight checks for "join a friend's Cloud9" (docs/plans/join-hub-handoff.md).
// A SECOND hub is stood up on another loopback port, a join link minted on it,
// and the browser walked through the real feature: the address book lists this
// computer's own Cloud9 as the live one; a public-internet address is refused
// in the preview, in words; a valid loopback link previews with its honest reach
// ("this PC") and names the host; adding it actually DIALS the second hub and the
// connection sentence says so; a message sent there round-trips; KILLING the
// second hub falls the client back to this computer's own; the owner can mint a
// cloud9://…#join_ link; and the invite panel says plainly that reaching a friend
// over the internet needs Tailscale and is not wired tonight.
// 466 → 467: one check for the switches a Codex agent cannot give up. Every
// Codex agent saved before the fail-closed rule refused to run for ever, so the
// app stopped offering an off that would never happen: those switches read on,
// locked, and say why, on the row, above the ladder and on the honesty card.
// 467 → 475: eight checks for the ONE WAY IN to every typed command. Everything
// an agent can be TOLD to do — !issue, !comment, !review, !code, !bg,
// !remember, !handoff, !schedule/!schedules/!unschedule — already worked and
// none of it was on the screen, so the owner's report was "GitHub integration is
// not there". The checks walk the door itself: the control is beside the box; it
// opens and lists all ten in plain words; picking a row writes the line into the
// composer and sends NOTHING; a row that cannot work here (no repository
// connected) says why on the row and refuses to be picked; and the menu is on
// the app's one Escape owner rather than answering the key its own way.
// 475 → 479 on 2026-08-01: the GitHub card in Settings. His bug was "I am not
// able to connect my account" against a Cloud9 that was already riding the `gh`
// sign-in on this computer and saying so nowhere. Four checks: the card is
// there beside the two AI apps; it shows ONE of the three honest states and
// says when it really asked; that state offers the way in (or names the
// account); and no token or scope string reaches the DOM.
// 479 → 494 on 2026-08-02, in two pieces, both on the Projects screen:
//  • SEVEN for "where the code lives on this computer" (approval-handoff §8 —
//    the gap that made every `!code` answer "nobody has told Cloud9 where this
//    project's code lives"). The row exists; with nothing linked it SAYS so
//    rather than showing a blank; a window with no OS folder picker says which
//    and takes the typed folder instead; a half-path is refused in the shared
//    rule's own sentence; a chosen folder is drawn back and REACHES THE ENGINE
//    on the project's own frame; and forgetting it restores the honest state.
//  • EIGHT for the repository picker (his ask: show me MY things, let me
//    click). Opening the panel asks the computer that holds the GitHub sign-in;
//    the rows it reported are drawn; a private repository is drawn as private;
//    the list says WHEN it was asked for; the typed field survives as the
//    fallback; clicking a row connects it down the same path as typing; and a
//    listing that failed shows the reason instead of an empty list that would
//    read "you have no repositories".
// 494 → 501 on 2026-08-02: seven permanent checks for the Files workspace.
// They open the rail door, hold latest-maker + exact-turn attribution, open the
// retained history, prove room-default access and manager-only editing from two
// signed-in screens, save a real restriction with managers still required, follow
// a typed exact-version relationship, and prove markdown words alone create no
// stored relationship.
// 501 → 508 on 2026-08-03: seven permanent checks for "search everywhere".
// The panel opens on EVERYTHING and asks the hub nothing until there are words
// to ask about; a real message, a real reply written in a real thread, and a
// real file's shared name are each found and each labelled in plain words; the
// words only an EARLIER version of that file ever had are found and open its
// kept history at that version; a message result lands in the room it was
// really said in; and the security one — a plain member searching everywhere is
// not shown the file that was restricted from them, not its name, not its
// words, and not the fact that it exists.
// 508 → 512 on 2026-08-03: four permanent checks for "a job that is stuck or
// fell over looks nothing like one that is working" (feature 4, slice B). A job
// that failed prints the state in plain words AND the reason the engine really
// recorded, on the card, with no path and no argv in it; a stuck job reads
// "Stuck — waiting on something" and is listed apart from the ones genuinely
// running, never in among them; a job that recorded no reason SAYS it recorded
// none rather than borrowing a sentence; and the agent's own presence line
// carries the same one fact, so a row can no longer read "Ready" while its job
// is stuck. The jobs are real hub jobs; the final states are written with the
// hub's own `updateTask` because the engine cannot yet report "blocked".
// 512 → 520 on 2026-08-03: eight permanent checks for "a refused sign-in must
// never cost you the one you already had". The join screen used to blank the
// stored credential BEFORE asking the hub about the code, so a spent, mistyped
// or expired invite destroyed a working sign-in — permanently for an invited
// friend, who has no owner key to dig back out with. These hold the class rule
// shut: a successful join stores the hub's durable token and never the code; a
// spent code typed over a working credential leaves it byte-for-byte intact,
// puts the person back inside on it, and says so in plain words; a bad code
// with nothing behind it refuses honestly and invents no credential; a join
// that WORKS still replaces a stale one, and a reload comes back in on it; and
// the one startup path that wipes credentials still spares the session one.
// 520 → 529 on 2026-08-03: nine permanent checks for feature 5, in two groups.
//  • FOUR for A ROOM HE HAS TURNED DOWN, plus one for the door it comes
//    through. They exist because notifications were all-or-nothing, so one busy
//    room was the reason to switch every notification off. The control has to
//    SAY what muting really does (everything except somebody naming him), the
//    room's own row has to show it so a quiet room is never a mystery, real
//    news in a muted room must be silenced (proved on the app's own delivery
//    record, not on a toast that may have timed out), a real mention must still
//    get through it, and unmuting must give the news back. The fifth holds
//    DELIVERY HONESTY: this browser has no operating-system door at all, so
//    every notification must still arrive in the app, be recorded, and — where
//    the OS was the right home — be recorded as a fallback with its reason.
//    Nothing dropped in silence is the one outcome that is not allowed.
//  • THREE for THE CONNECTIONS FILE, because "Use connected services" was a
//    switch that was on, allowed, approved and handed the agent nothing. On
//    with no file chosen must say the agent HAS none; the way in must be
//    offered and a window with no file picker must say which window can rather
//    than pretend; and off with nothing remembered must say nothing at all.
//    The other two states — a file that is really there ("In use") and one that
//    has really vanished ("That file is gone") — cannot be reached from a
//    browser at all: the path is chosen through the operating system's own file
//    picker and only the computer running the agent may look at the disk. They
//    are held in drive-app.mjs against the installed app instead.
//    ONE EXISTING check changed rather than being added: the inert-switch check
//    no longer expects a `connections` row, because that switch now has
//    somewhere to point and is no longer inert.
// 529 → 542 on 2026-08-04: thirteen permanent checks for THREADS, in six groups.
// His complaint, in his words: "an agent does not have a conversation inside the
// threads. they do discuss within channels only." Everything the app already
// checked was about what HE can do in a thread; nothing held where the AGENT's
// answer lands, which was the whole bug.
//  • TWO for THE HEADLINE BEHAVIOUR, both real turns of a real engine, nothing
//    seeded: a question typed into the real thread box is answered INSIDE that
//    thread (proved by message id, so an unrelated agent chiming in about
//    something else in the room can never be mistaken for the answer leaking
//    out), and the same question asked in the room is still answered in the
//    room. The second is not a formality — a rule that swept every answer into
//    a thread would pass the first and break the app.
//  • ONE for ONE LEVEL, NEVER NESTED. The hub re-parents a reply to a reply onto
//    the root (`resolveReplyTo`), and `packages/engine/src/threads.ts` RELIES on
//    that — it passes a stored `replyTo` straight back, trusting it is already a
//    root. Driven through the app's own send frame aimed deliberately at a
//    reply, which the composer itself cannot do.
//  • TWO for ↳N, the hunt he reported: "1 new" used to send him into a room
//    whose scroll showed nothing new. The row must say ↳1 and say in words that
//    the new thing is inside a thread, and the mark must GO when the room is
//    read. A real reply from a real second person, in a room he never opened.
//  • TWO for WHICH THREAD: the message it hangs off says New on its replies
//    line, and stands down the moment that thread is opened.
//  • FIVE for WHO IS TOLD. Three ask the rule itself through
//    `window.cloud9Notify.threadRule` — the SAME function the screen calls —
//    because staging four people in a room to prove four lines is how a suite
//    ends up agreeing with a copy of the rule instead of the rule. The other two
//    are real all the way down: a real reply raises a real toast, and the same
//    journey in a room he really muted raises nothing. Both halves are needed —
//    the silence alone could mean thread replies never notify at all.
//  • ONE for THE SAME BOX, NARROWER: the thread's tool row must be the SAME row
//    as the conversation's, not a named list of four, so a tool added to the
//    room tomorrow and quietly withheld from the thread fails here.
// 542 → 561 on 2026-08-04: nineteen permanent checks for the chat experience,
// in four groups. Every one of them exists because a thing he reported was true
// and nothing in this suite would have caught it coming back.
//  • SIX for READING BACK MUST NOT COST HIM THE NEXT MESSAGE (his: "the chat
//    window doesn't auto-scroll to the newest message on Enter"). The checks
//    that already held "a send takes the view down" passed all through the bug,
//    because they never read back FAR ENOUGH to ask the hub for an older page —
//    and asking is what set the scroll anchor that was only ever released by a
//    page that really added messages. A page that adds nothing (there is nothing
//    older) released nothing, the anchor was held for the rest of that room's
//    life, and his own message coming back after Enter was pulled straight back
//    to the row he had been reading. So the walk is the bug's own shape: a new
//    conversation of sixty messages, read all the way to the start, and only
//    then a message typed. The other five are the pill that the same rule now
//    raises instead of yanking him: a message from somebody else does not move
//    him and is counted; his own is never counted; clicking it takes him to the
//    newest and clears it; and walking down there himself clears it too. The
//    empty slot the pill lives in is held to always being there, because a slot
//    that came and went would move the bottom the follow rule watches.
//  • SEVEN for THE BOX BEING CALM UNTIL HE IS WRITING (his §3.2: affordances
//    appear on intent). The line that is easy to cross by accident is held by
//    two questions asked of the same row — is it IN the box (always) and is it
//    SHOWING (only while he is writing) — because a tool removed from the DOM
//    when idle is the invisibility bug again in a tidier coat. The ＋ door and
//    Send are held to being on screen in BOTH states for the same reason. The
//    `@ agent` button really did go, so its check is not "is it gone" on its own
//    — which breaking both roads would satisfy — but "it is gone AND typing @
//    still opens the very list it opened". The `/` road is held to being the
//    SAME list as the ＋ (by comparing the row counts, so a second drifting
//    command table fails here), to narrowing as he types, to writing the line in
//    without sending it, and to refusing a row that cannot work here in the same
//    sentence the list itself uses. The last one is the two ways a file usually
//    arrives — dropped on the box, or pasted into it.
//  • FOUR for SEMANTIC RECEIPTS (his §2). A live 👀 → 💭 → one committed tick,
//    held to being ONE moving signal rather than a growing pile; held to being
//    unmistakable from a person's reaction (a greyed span with no count and a
//    tooltip that says it is a live signal that is not saved, beside a real
//    person's button with a count on the same message at the same moment); and
//    held to being genuinely EPHEMERAL by a reload, with the person's reaction
//    going through the same reload so "everything vanished" cannot pass as
//    "receipts vanished". The three signals are REAL `agentReceipt` frames over
//    the owner's own socket — the hub's every gate runs, it really broadcasts,
//    the real handler routes and the real component draws. Only the ENGINE's
//    decision about when to send each one is stood in for; catching a live turn
//    mid-👀 would be a race, not a check.
//  • TWO for SMOOTHNESS AS A NUMBER, read off the app's own render counter. One
//    incoming message used to redraw 151 bubbles and now redraws one; an
//    unrelated presence tick used to redraw 151 and now redraws none. These are
//    the checks that stop the optimisation quietly rotting.
//  • THREE for ENTER FROM A LONG WAY BACK (`# farback`), which exist for one
//    bug and name it: pressing Enter started a smooth scroll, and the rule that
//    started it knew its own animation by a 700ms clock (`FOLLOW_SETTLES_MS`)
//    started once and treated as how long a follow LASTS. A smooth scroll's
//    length grows with the distance — about 745ms for 2,000px, about 1,520ms
//    for 13,000px — so from far back the clock ran out mid-animation, the app
//    read the rest of its own scroll as the reader moving, and both the arrival
//    rule and the resize watcher switched off. The view landed on a target
//    worked out before his row existed, short by exactly that row's height.
//    Every OTHER room in this suite is about 2,000px tall, which is a follow
//    inside the clock — which is why they were all green while he was looking
//    at the bug. So these three build a room that is genuinely tall (260 long
//    messages, four pages read back, parked 10,000px+ off the bottom), hold his
//    echo open so it lands mid-scroll, and read the rule's own trail: with the
//    bug the reasons since Enter are exactly ["sent","resized"], and the word
//    that says the fix is alive is "arrived".
//  • 2026-08-04, THE THREADING ROUND (+8, 564 → 572). An agent's answer now goes
//    into a thread hanging off the message it answers, in the channel as well as
//    inside a thread (`threadOf` in packages/engine/src/threads.ts). Every wait
//    on an agent's answer moved to the one helper, `waitForAgentAnswer` in
//    qa-target.mjs — that part changed where checks LOOK without changing how
//    many there are. These eight are genuinely new ground:
//      +1 HIS ASK, pinned: a question in the CHANNEL leaves no agent row in the
//         conversation, and the answer is in a thread under his own message.
//         The check that stood here asserted the OPPOSITE in its own name, so it
//         was rewritten rather than kept — it would have gone green on the bug.
//      +4 THE LAST INERT SWITCH, closed. "Reach files outside its own folder"
//         used to be on, allowed, approved and grant nothing, and the old check
//         DEMANDED that inert row. It now asserts no inert row is left anywhere,
//         plus the three things the folder block put in its place: the honest
//         "none" state, the choose/forget controls, and the refusal a window
//         with no desktop shell must give. The fourth is its silence twin at the
//         bottom rung — switch off, nothing remembered, nothing claimed.
//      +3 LIVE STEPS, the new preview: they stream onto the message that asked,
//         a step reported twice merges into one, the block says out loud it is
//         not the record, and `done` really ends it.
//      +1 FULLY CAPABLE BY DEFAULT (2026-08-05): a hired role is now held to the
//         SAME switch set a hand-written agent gets, read from the capability
//         table — and the one row nobody but he can supply (connected services)
//         is asked about separately, which is the check this adds.
const EXPECTED_CHECKS = 573;
const results = [];
let failShot = null; // set once a page exists, so an uncaught error leaves evidence
const consoleErrors = [];

function ok(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? " :: " + detail : ""}`);
}

/**
 * A real PNG of one colour, built here rather than checked into the repo.
 *
 * The attachment checks below compare what came back off the hub with what went
 * up, byte for byte. That comparison is only worth anything against a genuine
 * file with a genuine header, so this writes one: signature, IHDR, a deflated
 * IDAT and IEND, with the CRC every chunk is required to carry.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

function pngOfSolidColour(width, height, [r, g, b]) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // no per-row filter
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 8 bits per channel
  ihdr[9] = 2;  // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const browser = await chromium.launch(
  process.env.CLOUD9_CHROMIUM ? { executablePath: process.env.CLOUD9_CHROMIUM } : {}
);
try {
  // ---------- owner context ----------
  const owner = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  /* ---- A HOLD ON ONE KIND OF ANSWER FROM THE HUB ----------------------------
   *
   * Two of the findings below can only be PROVED by catching the app in a state
   * that lasts a fraction of a second: one file on the wire and unanswered, with
   * a second already read and queued behind it. The suite used to try to catch
   * it by racing — pick a big file, then spin waiting for the moment to come
   * round. On a hub that answered quickly the moment had already gone, and the
   * check failed on a run where nothing whatsoever was wrong. Worse, the failure
   * cascaded: with no refusal ever provoked there was no toast to read, and the
   * whole run died on a 30-second timeout with 70 checks never executed.
   *
   * So the moment is HELD OPEN instead of chased. `__c9hold.hold(["attachment"])`
   * makes the browser keep the hub's answers to uploads in a queue until
   * `release()` hands them over, in the order they arrived. Nothing in the app is
   * stubbed or stood in for: every frame the hub sends is still delivered, to the
   * app's own handler, unchanged and in order — the only thing this decides is
   * WHEN. That turns "if the hub happens to be slow" into a state the app is
   * simply in, which is what the checks then wait on.
   *
   * It also matches the real ordering the bug needs: a refusal about something
   * else is a small, fast answer, so on a busy hub it genuinely does arrive
   * before the upload it got mistakenly pinned on. */
  await owner.addInitScript(() => {
    const Real = window.WebSocket;
    const gate = { types: [], held: [] };
    window.__c9hold = {
      hold: types => { gate.types = types; gate.held = []; },
      holding: () => gate.held.length,
      release: () => {
        gate.types = [];
        const queued = gate.held.splice(0);
        for (const deliver of queued) deliver();
        return queued.length;
      },
    };
    class Gated extends Real {
      constructor(...args) {
        super(...args);
        let mine = null;
        // the app assigns `ws.onmessage`; this instance property shadows the
        // native one, so every frame comes through here first
        Object.defineProperty(this, "onmessage", {
          configurable: true,
          get: () => mine,
          set: fn => { mine = fn; },
        });
        Real.prototype.addEventListener.call(this, "message", ev => {
          const deliver = () => { if (mine) mine.call(this, ev); };
          let type = "";
          try { type = JSON.parse(ev.data).type; } catch { /* not a frame we know */ }
          if (gate.types.includes(type)) gate.held.push(deliver);
          else deliver();
        });
      }
    }
    window.WebSocket = Gated;
  });

  const page = await owner.newPage();
  failShot = page;
  /* A failed WebSocket connection is logged by the BROWSER itself (net::
   * ERR_CONNECTION_REFUSED), not by the app — and the join proof below
   * deliberately KILLS a hub to prove the client falls back to its own, which
   * means the client retrying that downed hub necessarily produces exactly this
   * message. It is the honest symptom of the feature working, not an app error,
   * so this one network noise is not counted. Every other console error still is. */
  const isExpectedDeadHubNoise = t =>
    /WebSocket connection to/i.test(t) && /ERR_CONNECTION_REFUSED/i.test(t);
  page.on("console", m => {
    if (m.type() === "error" && !isExpectedDeadHubNoise(m.text())) consoleErrors.push("owner: " + m.text());
  });
  page.on("pageerror", e => consoleErrors.push("owner pageerror: " + e.message));

  await page.goto(UI);
  await page.waitForSelector("text=Welcome to Cloud9");
  await page.screenshot({ path: `${SHOTS}/01-join.png` });
  ok("join screen renders", true);

  // one owner for how a QA run signs in — it types THIS stack's key, not the
  // shipped default the join screen pre-fills
  await signInAsOwner(page);
  ok("owner connects, #general visible", true);

  // §4.0 harness pre-flight: prove this suite can still tell true from false
  // before a single result from it is believed.
  await assertHarnessIsHonest(page);

  // create agent
  await page.click('button[title="New agent"]');
  await page.fill('input[placeholder="Scout"]', "Scout");
  // selector updated (round 2): the create screen holds more than one textarea
  // (the skills form), so the personality box is addressed by its own class.
  await page.fill("textarea.persona-input", "You research travel, villas, flights and hotels for trips, always with prices");
  // provider picker (FR-AG-005): Claude default, Codex offered.
  // Selector updated (Studio reskin): the app an agent runs on is picked with
  // the two cards the approved design uses, not a dropdown. Same assertion —
  // exactly claude and codex are offered, and Claude is the one already chosen.
  const pickerOptions = await page.$$eval(".app-pick", bs => bs.map(b => b.dataset.app));
  const pickerValue = await page.$eval('.app-pick[aria-pressed="true"]', b => b.dataset.app);
  ok("agent create offers a provider picker (Claude default)",
    pickerOptions.join(",") === "claude,codex" && pickerValue === "claude",
    `${pickerOptions.join("/")} value=${pickerValue}`);

  // ---- feedback round 1, his 5+6: a model picker in CREATE ----
  await page.waitForSelector("select.modelpick");
  const createModels = await page.$$eval("select.modelpick option", os => os.map(o => o.value));
  const createModel = await page.inputValue("select.modelpick");
  ok("agent create offers a model picker with a model already chosen",
    createModels.length > 0 && !!createModel && createModels.includes(createModel),
    `${createModels.join("/")} value=${createModel}`);
  const createModelNames = await page.$$eval("select.modelpick option", os => os.map(o => o.textContent.trim()));
  ok("models are shown by friendly name, not raw ids",
    createModelNames.every(n => n && !/^claude-/.test(n)), createModelNames.join("/"));

  // ---- his 9: the skills section lives on the create screen too ----
  ok("agent create has a Skills section with a way to write and to upload one",
    (await page.locator(".skills .skill-add").count()) === 1 &&
    (await page.locator(".skills .skill-upload").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/02-create-agent.png` });
  await page.click(".editor >> text=Create agent");
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".sidebar >> text=Scout");
  ok("agent created and listed", true);

  /* ---- B6 / B6b: he must be able to tell his agents apart ----
     Phase 5 made FOUR agents called `Scout`; typing `@Sco` then offered four
     rows reading exactly `✨ Scout AGENT`, with different personalities,
     different apps and different reach behind them. Nothing stopped it and
     nothing said anything. The second one is now refused in words, in the form,
     with everything he typed still in it. */
  await page.click('button[title="New agent"]');
  await page.fill('input[placeholder="Scout"]', "scout");
  await page.fill("textarea.persona-input", "a second scout, typed out in full and not to be thrown away");
  await page.click(".editor >> text=Create agent");
  await page.waitForSelector('.editor [data-namerefusal="agent"]', { timeout: 10000 });
  const dupeSays = (await page.locator('.editor [data-namerefusal="agent"]').innerText()).trim();
  const dupeKeptName = await page.inputValue('input[placeholder="Scout"]');
  const dupeKeptPersona = await page.inputValue("textarea.persona-input");
  ok("B6: a second agent with a name already taken is refused in plain words, and nothing he typed is lost",
    dupeSays === validateName("agent", "scout", ["Scout"])
    && dupeKeptName === "scout" && dupeKeptPersona.startsWith("a second scout"),
    `${dupeSays} :: name "${dupeKeptName}", ${dupeKeptPersona.length} characters of personality kept`);
  await page.screenshot({ path: `${SHOTS}/name-duplicate-agent.png` });
  await page.click(".editor .topbar >> text=Cancel");
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector('.sidebar .agentrow[data-agent="Scout"]', { timeout: 15000 });
  const scoutRows = await page.$$eval(".sidebar .agentrow", rows =>
    rows.filter(r => (r.dataset.agent ?? "").toLowerCase() === "scout").length);
  ok("B6b: there is exactly ONE Scout to point at, so an @ mention can only mean one agent",
    scoutRows === 1, `${scoutRows} agents named Scout`);

  // ---- his 15: clicking an agent opens the direct conversation, never a dead click ----
  await page.click('.sidebar .agentrow[data-agent="Scout"] .agentmain');
  await page.waitForSelector('.chathead .ch-title .n:text-is("Scout")', { timeout: 15000 });
  ok("clicking an agent opens the direct conversation with it", true);

  // The conversation's own header must say which app AND which model the agent
  // runs on. (Selector updated in the Studio reskin: the approved design's
  // sidebar row is a portrait and a name, and the app+model line lives in the
  // header of the conversation you land in.)
  const scoutSub = (await page.textContent(".chathead .runchip")).trim();
  ok("the agent's conversation shows the app and the model it runs on",
    /Claude/.test(scoutSub) && scoutSub.split("·").length >= 2, scoutSub);
  // clicking it a second time must land in the SAME conversation, not a new one
  const scoutRowsBefore = await page.locator('.sidebar .agent-row .agent-name:text-is("Scout")').count();
  await page.click(".sidebar >> text=# general");
  await page.click('.sidebar .agentrow[data-agent="Scout"] .agentmain');
  await page.waitForSelector('.chathead .ch-title .n:text-is("Scout")', { timeout: 15000 });
  await page.waitForTimeout(400);
  const scoutRowsAfter = await page.locator('.sidebar .agent-row .agent-name:text-is("Scout")').count();
  ok("that conversation is found, not created a second time",
    scoutRowsAfter === scoutRowsBefore, `${scoutRowsBefore} then ${scoutRowsAfter} rows named Scout`);

  // create channel with agent
  await page.click('button[title="New channel"]');
  await page.fill('.panel input[placeholder="trip-goa"]', "trip-goa");
  await page.click('label:has-text("Scout") input');
  await page.click(".panel .foot >> text=Create");
  await page.waitForSelector(".sidebar >> text=# trip-goa");
  await page.click("text=# trip-goa");
  ok("channel created with agent member", true);

  /* ---- @mention: the answer hangs off the question, in a thread ----
   * WHAT CHANGED (2026-08-04): an agent's answer goes into a thread on the
   * message it answers, in the channel as well as inside a thread — see
   * `threadOf()` in packages/engine/src/threads.ts and the long note on
   * `waitForAgentAnswer`. So "the agent replied" is no longer "there is a row in
   * the scroll": his question carries "1 reply" and the words are in the panel.
   * Every wait on an agent's answer in this file goes through the one helper. */
  const box = page.locator(".composer textarea");
  await box.fill("@Scout find beach villas in Goa under 8k");
  await box.press("Enter");
  // This is the FIRST time the engine is asked to speak, so it pays the whole
  // cold-start cost: connect, detect both harnesses, start a CLI. That is
  // 15-25s on this machine and the old 8s wait simply could not survive it —
  // the suite died here and blamed the feature. The wait is now on the thing we
  // actually need (an agent message carrying the answer), with a bound that
  // fits a cold engine. Later replies are fast because this one warmed it up.
  const villaAnswer = await waitForAgentAnswer(page, {
    under: { text: "find beach villas in Goa under 8k" }, text: "villas",
  });
  ok("@mention in the conversation is answered in a thread under the question, and the question says it has a reply",
    villaAnswer.answerIds.length >= 1 && villaAnswer.replies >= 1,
    `${villaAnswer.answerIds.length} agent answer(s) in the thread, the question says ${villaAnswer.replies} reply/replies`);
  await page.screenshot({ path: `${SHOTS}/03-chat-reply.png` });

  // free chatter (no mention, relevant) — and it lands in the same place
  await box.fill("should we also look at flights and hotels?");
  await box.press("Enter");
  const chatterAnswer = await waitForAgentAnswer(page, {
    under: { text: "should we also look at flights and hotels?" }, text: "flights",
    what: "an unmentioned agent to chime in about flights, in the thread under it",
  });
  ok("free chatter: a relevant agent chimes in unmentioned, in a thread under what it is answering",
    chatterAnswer.answerIds.length >= 1, `${chatterAnswer.replies} reply/replies on the question`);

  // background task
  await box.fill("@Scout !bg compare 14 villas and shortlist 3");
  await box.press("Enter");
  /* ONE PRESS NOW STANDS BETWEEN A JOB AND THE WORK — 2026-08-05.
   *
   * Every agent Cloud9 creates is fully capable from its first second (see
   * `NEW_AGENT_ABILITIES` in the engine's capability table), and every switch
   * that changes his machine carries `alwaysAsk`. So a handed-out job now stops
   * at the approval card in the room it was asked in, and waits — which is the
   * whole point of raising the ceiling safely, and is exactly what a person
   * would see. QA presses the same button he would.
   *
   * It does NOT insist on the card. An agent that holds nothing needing a yes
   * simply gets on with the job, and this must not fail for that; the ack below
   * is still the thing being checked either way. */
  const bgApprovalCard = page.locator(`.msg[data-approval][data-state="pending"]`).last();
  await bgApprovalCard.waitFor({ timeout: 60000 }).then(
    () => bgApprovalCard.locator('button:has-text("Approve")').click(),
    () => { /* nothing to approve — the job is already on its way */ });
  const bgAck = await waitForAgentAnswer(page, {
    under: { text: "compare 14 villas and shortlist 3" }, text: "background",
    what: "the agent's acknowledgement of the background job, in the thread under the ask",
  });
  /* AND THE ROOM IS NOT LEFT BLIND. A long job's detail belongs where it was
     asked for, and `reportFinished` posts ONE short proactive line back into the
     conversation saying it ended and where to look ("🧵 Finished in the
     thread: …"). That line is a room message on purpose — nobody asked it for
     anything — so it is still checked in `.msgs`, and the "started on its own"
     marker is what proves nobody asked. */
  await waitFor(page, () => [...document.querySelectorAll(".msgs .msg.proactive")]
    .some(m => m.querySelector(".selfstart") && /in the thread/i.test(m.innerText ?? "")),
  undefined, { what: "the finished background job to post its one-line report back to the room" });
  const bgRoomLine = await page.evaluate(() =>
    [...document.querySelectorAll(".msgs .msg.proactive")]
      .filter(m => m.querySelector(".selfstart"))
      .map(m => (m.innerText ?? "").replace(/\s+/g, " ").trim()).pop() ?? "");
  ok("a background job acknowledges in the thread, does its work there, and posts ONE short line back to the room saying where to look",
    bgAck.answerIds.length >= 1 && /in the thread/i.test(bgRoomLine),
    `${bgAck.answerIds.length} line(s) in the thread :: room says "${bgRoomLine.slice(0, 90)}"`);
  await page.screenshot({ path: `${SHOTS}/04-background-task.png` });

  // quick chat
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".qc-input");
  await page.screenshot({ path: `${SHOTS}/05-quick-chat.png` });
  await page.fill(".qc-input", "quick ping from the hotkey popup");
  await page.press(".qc-input", "Enter");
  await page.waitForSelector("text=Sent to", { timeout: 15000 });
  ok("quick chat (Ctrl/Cmd+K) sends", true);

  // settings: two harness cards with live status from the engine host.
  // No sleep here: Playwright will not click a button something is covering, so
  // the click itself is the wait for the quick panel to get out of the way.
  await page.click('.rail-btn[data-go="settings"]', { timeout: 20000 });
  await page.waitForSelector("text=connect your AI apps");
  await page.waitForSelector('.harnesscard[data-harness="claude"]');
  await page.waitForSelector('.harnesscard[data-harness="codex"]');
  // status arrives over the relay from the engine host — wait for a real verdict
  await page.waitForFunction(() =>
    ![...document.querySelectorAll(".harnessstate")].some(e => e.textContent.includes("checking")),
  { timeout: 15000 });
  const claudeState = (await page.textContent('.harnesscard[data-harness="claude"] .harnessstate')).trim();
  const codexState = (await page.textContent('.harnesscard[data-harness="codex"] .harnessstate')).trim();
  ok("settings shows live Claude + Codex status", !!claudeState && !!codexState,
    `claude: ${claudeState} | codex: ${codexState}`);

  // ---- his 1 + 11: the sign-in card says what is TRUE for its state ----
  // Replaces the old "both sign-in buttons are present" check: when a harness is
  // already signed in the contract forbids a sign-in button at all, so the check
  // is now per-card and state-aware (stricter, never weaker).
  for (const [h, title] of [["claude", "Claude"], ["codex", "Codex"]]) {
    const card = page.locator(`.harnesscard[data-harness="${h}"]`);
    const text = (await card.innerText()).replace(/\s+/g, " ").trim();
    const signedIn = (await card.locator(".signedinline").count()) === 1;
    const waiting = (await card.locator(".waitingline").count()) === 1;
    const failed = (await card.locator(".problemline").count()) === 1;
    const signInBtn = await card.locator(`.primary:has-text("Sign in with ${title}")`).count();
    const states = [signedIn, waiting, failed].filter(Boolean).length;

    if (signedIn) {
      const tick = await card.locator(".signedinline .tick").count();
      const switcher = await card.locator(".signedinline .switchacct").count();
      ok(`${title} card, signed in: green tick, an account line and a quiet Switch account`,
        tick === 1 && switcher === 1 && signInBtn === 0 && !/again/i.test(text), text.slice(0, 120));
    } else if (waiting) {
      const spinner = await card.locator(".waitingline .spinner").count();
      const cancel = await card.locator('.waitingline button:has-text("Cancel")').count();
      ok(`${title} card, working: spinner, "Waiting for you in the browser" and a Cancel`,
        spinner === 1 && cancel === 1 && /waiting for you in the browser/i.test(text), text.slice(0, 120));
    } else if (failed) {
      const retry = await card.locator('.problemline button:has-text("Try again")').count();
      ok(`${title} card, failed: the problem in plain words and a Try again`,
        retry === 1 && (await card.locator(".problemtext").innerText()).trim().length > 0, text.slice(0, 120));
    } else {
      ok(`${title} card, not signed in: one "Sign in with ${title}" button and no "again"`,
        signInBtn === 1 && !/again/i.test(text), text.slice(0, 120));
    }
    ok(`${title} card shows exactly one state`, states <= 1, `signedIn=${signedIn} waiting=${waiting} failed=${failed}`);
  }
  /* WHERE THE MODEL LIST CAME FROM (skills-library-handoff §1).
     "13 models" cannot tell him whether each one was proved by running it or
     whether Cloud9 is falling back on the list it ships with. The engine writes
     that sentence; the screen prints it verbatim and marks which of the two it
     is. Absent means absent — a harness with nothing to say draws nothing. */
  const modelSource = await page.$$eval(".harnesscard", cards => cards.map(c => ({
    harness: c.dataset.harness,
    chip: [...c.querySelectorAll(".harnessfacts span")]
      .map(s => s.textContent.trim()).find(t => /models available$/.test(t)) ?? "",
    line: c.querySelector(".modelsource .ms-tx")?.textContent.trim() ?? "",
    checked: c.querySelector(".modelsource")?.dataset.checked ?? "",
  })));
  /* Only Claude's list has a provenance sentence to print — the engine proves
     Claude by running each model and writes that down; Codex answers a listing
     command and no sentence is written for it. So this check holds the CLASS
     rule rather than demanding two lines: whatever is drawn must be a real
     sentence with a real yes/no beside it, and a harness with nothing to say
     draws nothing at all rather than a reassuring blank. */
  const claudeSource = modelSource.find(m => m.harness === "claude");
  ok("where the model list came from is printed in the engine's own words, marked proved or not",
    modelSource.length === 2 &&
    claudeSource.line.length > 20 && ["yes", "no"].includes(claudeSource.checked) &&
    modelSource.every(m => (m.line === "") === (m.checked === "")),
    modelSource.map(m => `${m.harness}: ${m.chip || "no models"} → ` +
      (m.line ? `[${m.checked}] ${m.line}` : "(nothing claimed)")).join(" | "));

  await page.locator('.harnesscard[data-harness="claude"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/models-provenance.png`, animations: "disabled" });

  const fallbacks = await page.$$eval(".harnesscard .linkbtn", bs => bs.map(b => b.textContent.trim()));
  ok("settings still offers the API-key fallback on both cards",
    fallbacks.filter(b => /API key instead/.test(b)).length === 2, fallbacks.join(" · "));

  /* ================= THE GITHUB CARD =================
     HIS BUG, IN HIS WORDS: "Cloud9 doesn't give me a connected GitHub account,
     I am not able to connect my account." Cloud9 rides the `gh` sign-in already
     on the computer and never holds a token — which is right, and which NO
     SCREEN SAID. The only mention was one sentence inside the
     connect-a-repository box. Invisible is the same as not there, so these
     checks hold the card itself, not the plumbing behind it. */
  /* Read the WHOLE card in one pass in the page, and never through a locator
     that assumes it is there. A card that has gone missing must fail its own
     check and let the other 478 run — an exception here would abort the script
     and report "stopped early", which hides which thing actually broke. */
  const ghPresent = await page.locator(".githubcard[data-service='github']").count() === 1;
  if (ghPresent) {
    await page.locator(".githubcard").scrollIntoViewIfNeeded();
    // the answer comes off the engine host over the relay — wait for a real one
    await page.waitForFunction(() =>
      document.querySelector(".githubcard")?.dataset.state !== "checking", { timeout: 15000 });
  }
  const gh = await page.evaluate(() => {
    const c = document.querySelector(".githubcard[data-service='github']");
    if (!c) return null;
    const tx = s => c.querySelector(s)?.textContent.trim() ?? "";
    return {
      inAppsSection: !!document.querySelector("#set-apps .githubcard"),
      state: c.dataset.state ?? "",
      text: c.innerText.replace(/\s+/g, " ").trim(),
      checked: c.querySelector(".checkedline")?.dataset.checked ?? "",
      checkedLine: tx(".checkedline .ms-tx"),
      named: tx(".signedinline .signedintext"),
      command: tx(".ghcommand"),
      signInButtons: c.querySelectorAll("button.ghsignin").length,
      copyButtons: c.querySelectorAll("button.ghcopy").length,
      recheckButtons: c.querySelectorAll(".ghrecheck").length,
    };
  });
  ok("Settings has a GitHub card, beside the Claude and Codex cards",
    !!gh && gh.inAppsSection, gh ? gh.state : "NO GITHUB CARD ON THE SETTINGS SCREEN");

  /* ONE of three honest states, and it must say WHEN it looked. A card that
     reads "signed in" with no time on it is telling you about the past in the
     present tense — the same class of lie as a stale harness dot. */
  ok("the GitHub card shows one honest state and says when Cloud9 really asked",
    !!gh && ["not-installed", "not-signed-in", "signed-in"].includes(gh.state) &&
    gh.checked === "yes" && /asked this computer at/i.test(gh.checkedLine),
    gh ? `${gh.state} :: ${gh.checkedLine}` : "no card, so nothing was said about anything");

  /* THE WAY IN. Whichever state this machine is in, the card must answer "how
     do I connect my account?" — a name when it is connected, and a real door
     when it is not. There is no state in which the answer is nothing. */
  if (gh?.state === "signed-in") {
    ok("signed in: the GitHub card names the account and says who keeps the token",
      /signed in as \S+/i.test(gh.named) &&
      /never holds your password or token/i.test(gh.text) &&
      gh.recheckButtons === 1, gh.named);
  } else if (gh?.state === "not-signed-in") {
    ok("not signed in: the GitHub card offers a real way in, plus the exact command to copy",
      gh.signInButtons === 1 &&
      gh.command === "gh auth login --web --git-protocol https" &&
      gh.copyButtons === 1 && gh.recheckButtons === 1, gh.text.slice(0, 140));
  } else {
    ok("not installed: the GitHub card says where to get it and offers Check again",
      !!gh && /cli\.github\.com/.test(gh.text) &&
      gh.recheckButtons === 1 && gh.signInButtons === 0,
      gh ? gh.text.slice(0, 140) : "there is no card to say anything at all");
  }

  /* NO SECRET, ANYWHERE ON THE PAGE. `gh auth status` prints a masked token and
     a scope list right beside the login this card shows, and the frame has no
     field for either. This walks the WHOLE rendered document, not just the
     card, so a future line that pastes one in fails here. */
  const ghLeak = await page.evaluate(() => {
    const body = document.body.innerText;
    const html = document.documentElement.innerHTML;
    const hits = [];
    for (const re of [/gh[pousr]_[A-Za-z0-9]{6,}/, /token scopes/i, /\bread:org\b/, /\bgist\b/]) {
      if (re.test(body) || re.test(html)) hits.push(String(re));
    }
    return hits;
  });
  ok("no GitHub token and no scope list appears anywhere on the screen",
    ghLeak.length === 0, ghLeak.join(" | "));

  await page.screenshot({ path: `${SHOTS}/github-card.png`, animations: "disabled" });

  // ---- his 13: settings has real, changeable things ----
  // selectors updated (Studio reskin): the look is chosen with the approved
  // design's three painted cards, each addressed by the theme it sets.
  const settingsPanel = page.locator(".settingspanel");
  const themeButtons = await settingsPanel.locator("#set-look .theme-pick").count();
  await settingsPanel.locator('#set-look .theme-pick[data-theme-set="dark"]').click();
  const wentDark = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await settingsPanel.locator('#set-look .theme-pick[data-theme-set="light"]').click();
  const wentLight = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  ok("settings can actually change the look (light / dark / match this computer)",
    themeButtons === 3 && wentDark === "dark" && wentLight === "light", `${wentDark} then ${wentLight}`);
  await settingsPanel.locator('#set-look .theme-pick[data-theme-set="system"]').click();

  const defaultModels = await settingsPanel.locator("#set-agents select.defaultmodelpick option").count();
  ok("settings sets which app + model new agents start on",
    (await settingsPanel.locator("#set-agents select.defaultproviderpick").count()) === 1 && defaultModels > 0,
    `${defaultModels} models`);

  // selectors updated (Studio reskin): quiet hours is its own section now, and
  // a switch row is the approved design's `.toggle-row`.
  await settingsPanel.locator('#set-quiet .toggle-row:has-text("Quiet hours") input').check();
  const quietEnabled = await settingsPanel.locator('#set-quiet input[type="time"]').first().isEnabled();
  ok("settings has notifications on/off and quiet hours that switch on",
    (await settingsPanel.locator('#set-notify .toggle-row:has-text("new messages") input').count()) === 1 && quietEnabled);
  await settingsPanel.locator('#set-quiet .toggle-row:has-text("Quiet hours") input').uncheck();

  ok("settings tells you where agent files live and offers a Danger zone",
    (await settingsPanel.locator("#set-files .pathbox").count()) === 1 &&
    (await settingsPanel.locator('#set-danger button:has-text("Remove Claude key")').count()) === 1 &&
    (await settingsPanel.locator("#set-danger select.removepersonpick").count()) === 1);

  // the policy disclosure (FR-PC-004) stays visible
  await page.waitForSelector("text=Heads up");
  // credentials must never be kept in the browser (secrets class fix)
  const leaked = await page.evaluate(() =>
    Object.keys(localStorage).filter(k => /cred|token|key/i.test(k) && k !== "cloud9.token"));
  ok("no credential is stored in the browser", leaked.length === 0, leaked.join(","));

  // an upgraded install must have its old plain-text credential wiped on start
  await page.evaluate(() => {
    localStorage.setItem("cloud9.claudeCred", "sk-ant-leftover-from-v1");
    localStorage.setItem("cloud9.claudeCredKind", "apiKey");
  });
  await page.reload();
  await page.waitForSelector("text=# general", { timeout: 10000 });
  const purged = await page.evaluate(() => [
    localStorage.getItem("cloud9.claudeCred"),
    localStorage.getItem("cloud9.claudeCredKind"),
  ]);
  ok("an old browser-stored credential is wiped on startup",
    purged[0] === null && purged[1] === null, JSON.stringify(purged));
  await page.click('.rail-btn[data-go="settings"]');
  await page.waitForSelector("text=connect your AI apps");
  await page.screenshot({ path: `${SHOTS}/06-settings.png` });
  await page.click('.rail-btn[data-go="chat"]');

  // agent edit also lets you change which app an agent runs on
  await page.hover(".sidebar .agentrow");
  await page.click('.sidebar .agentrow button[title="Edit agent"]');
  await page.waitForSelector(".editor .app-pick");
  const editPicker = await page.$$eval(".app-pick", bs => bs.map(b => b.dataset.app));
  ok("agent edit offers a provider picker", editPicker.join(",") === "claude,codex", editPicker.join("/"));

  // ---- his 5+6: the model picker is in EDIT too, already holding a model ----
  await page.waitForSelector("select.modelpick");
  const editModels = await page.$$eval("select.modelpick option", os => os.map(o => o.value));
  const editModel = await page.inputValue("select.modelpick");
  ok("agent edit offers a model picker with this agent's model selected",
    editModels.length > 0 && !!editModel && editModels.includes(editModel),
    `${editModels.join("/")} value=${editModel}`);

  // ---- his 9: write a skill, edit it, upload one from a file, delete it ----
  // Names carry a per-run stamp so the check is exact even when the relay's
  // database still holds agents from an earlier run.
  const stamp = Date.now().toString(36).slice(-5);
  const skillA = `Villa shortlist ${stamp}`;
  const skillB = `Villa shortlist ${stamp} v2`;
  const skillC = `Flight watch ${stamp}`;

  await page.click(".skills .skill-add");
  await page.fill(".skill-name-input", skillA);
  await page.fill(".skill-desc-input", "Picks three villas and says why");
  await page.fill(".skill-instructions-input", "Read the villa notes, keep the three best under budget, and give a one-line reason for each.");
  await page.click(".skills .skill-save");
  await page.waitForSelector(`.skillrow[data-skill="${skillA}"]`);
  ok("a skill can be written in plain words and saved", true);

  await page.click(`.skillrow[data-skill="${skillA}"] .skill-edit`);
  await page.fill(".skill-name-input", skillB);
  await page.click(".skills .skill-save");
  await page.waitForSelector(`.skillrow[data-skill="${skillB}"]`);
  ok("a saved skill can be edited",
    (await page.locator(`.skillrow[data-skill="${skillA}"]`).count()) === 0);

  const skillFile = path.join(os.tmpdir(), `${skillC}.md`);
  fs.writeFileSync(skillFile, "Check the fare every morning and tell me when it drops below 8k.");
  await page.setInputFiles(".skills .skill-upload", skillFile);
  await page.waitForSelector(`.skillrow[data-skill="${skillC}"]`);
  await page.click(`.skillrow[data-skill="${skillC}"] .skill-edit`);
  await page.waitForSelector(".skill-instructions-input");
  const uploadedInstructions = await page.inputValue(".skill-instructions-input");
  const uploadedName = await page.inputValue(".skill-name-input");
  ok("a skill can be uploaded from a .md file (name from the filename, body as the instructions)",
    /fare every morning/.test(uploadedInstructions) && uploadedName === skillC,
    `${uploadedName} :: ${uploadedInstructions.slice(0, 50)}`);
  await page.click(".skills .skillformbtns button:has-text('Cancel')");

  await page.click(`.skillrow[data-skill="${skillC}"] .skill-delete`);
  ok("a skill can be deleted",
    (await page.locator(`.skillrow[data-skill="${skillC}"]`).count()) === 0 &&
    (await page.locator(`.skillrow[data-skill="${skillB}"]`).count()) === 1);
  await page.screenshot({ path: `${SHOTS}/14-agent-edit.png` });

  // the surviving skill must actually reach the agent
  await page.click('.editor .topbar >> text=Save');
  // wait for the editor to actually be gone (the save round-tripped), not 800ms
  await waitFor(page, () => !document.querySelector(".editor .skills"),
    undefined, { timeout: 20000, what: "the agent editor to close after Save" });
  await page.click('.rail-btn[data-go="chat"]');
  await page.hover(".sidebar .agentrow");
  await page.click('.sidebar .agentrow button[title="Edit agent"]');
  await page.waitForSelector(".editor .skills");
  ok("skills are saved onto the agent and are still there when you reopen it",
    (await page.locator(`.skillrow[data-skill="${skillB}"]`).count()) === 1);
  // put the agent back the way it was found
  await page.click(`.skillrow[data-skill="${skillB}"] .skill-delete`);
  await page.click('.editor .topbar >> text=Save');
  await page.waitForTimeout(400);
  await page.click('.rail-btn[data-go="chat"]');

  // ============ agent memory + agent-to-agent handoff ============
  //
  // Memory: an agent keeps durable notes between conversations, tells the owner
  // it kept one, and shows them back on its own file. Handoff: one agent hands
  // work to another with a plain "passed to @…" line, and the receiver actually
  // takes the turn. Everything here is real — the notes are read off the
  // engine's own store on this computer, and the handoff is delivered through
  // the hub — so a broken feature shows as a failed check, never a fake pass.
  // Bounded waits record a FAIL rather than crashing the whole suite.
  const seen = (locator, timeout = 20000) =>
    locator.first().waitFor({ timeout }).then(() => true).catch(() => false);

  // -- a note saved with "!remember" --
  await page.click("text=# trip-goa");
  const memBox = page.locator(".composer textarea");
  await memBox.fill("@Scout !remember beach villas in Goa are cheapest in the monsoon");
  await memBox.press("Enter");
  /* The confirmation answers the ask, so it hangs off the ask — the same rule as
     any other answer (`threadOf`). It used to be a row in the room; the check
     now says where it really is rather than looking where it used to be. */
  const memSaid = await waitForAgentAnswer(page, {
    under: { text: "!remember beach villas in Goa are cheapest in the monsoon" },
    text: "Saved to memory", timeout: 30000,
    what: "the agent's 'Saved to memory' line, in the thread under the ask",
  }).catch(err => ({ answerIds: [], failed: String(err.message ?? err) }));
  ok("!remember: the agent saves a note and confirms it in a thread under the ask",
    memSaid.answerIds.length >= 1, memSaid.failed ?? "");

  // -- and that note shows on the agent's own file, newest first --
  await page.hover('.sidebar .agentrow[data-agent="Scout"]');
  await page.click('.sidebar .agentrow[data-agent="Scout"] button[title="Edit agent"]');
  await page.waitForSelector(".editor .rememberssec", { timeout: 15000 });
  const noteShown = await seen(page.locator('.rememberssec .memrow[data-note] .mem-tx b'), 15000);
  const noteText = noteShown
    ? (await page.locator(".rememberssec .memrow .mem-tx b").first().innerText()).trim() : "";
  ok("the 'What this agent remembers' panel shows the saved note",
    noteShown && /monsoon/.test(noteText), noteText);
  await page.screenshot({ path: `${SHOTS}/22-agent-remembers.png` });
  await page.click(".editor .topbar >> text=Cancel");
  await page.click('.rail-btn[data-go="chat"]');

  // -- a second agent, and its HONEST empty memory (nothing saved, and it says so) --
  await page.click('button[title="New agent"]');
  await page.fill('input[placeholder="Scout"]', "Terra");
  await page.fill("textarea.persona-input",
    "You handle deployment notes and villa shortlists, always concrete and brief");
  await page.click(".editor >> text=Create agent");
  // Create returns to the crew screen; the chat sidebar (with its agent rows) is
  // where an agent is edited from, so go there before reaching for Terra's row.
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector('.sidebar .agentrow[data-agent="Terra"]', { timeout: 15000 });
  await page.hover('.sidebar .agentrow[data-agent="Terra"]');
  await page.click('.sidebar .agentrow[data-agent="Terra"] button[title="Edit agent"]');
  await page.waitForSelector(".editor .rememberssec", { timeout: 15000 });
  const emptyShown = await seen(page.locator('.rememberssec [data-memory-empty="yes"]'), 15000);
  const emptyText = emptyShown
    ? (await page.locator('.rememberssec [data-memory-empty="yes"]').innerText()).trim() : "";
  ok("an agent with nothing saved shows the honest empty state, not a faked note",
    emptyShown && /hasn't saved anything to remember/.test(emptyText), emptyText);
  await page.click(".editor .topbar >> text=Cancel");
  await page.click('.rail-btn[data-go="chat"]');

  // -- handing work from one agent to another --
  await page.click("text=# trip-goa");
  const hoBox = page.locator(".composer textarea");
  await hoBox.fill("@Scout !handoff @Terra shortlist the three cheapest villas");
  await hoBox.press("Enter");
  /* TWO DIFFERENT PLACES, AND THAT IS THE POINT.
   *  · The "passed to @Terra" line ANSWERS the command, so it hangs off it in a
   *    thread, like every other answer.
   *  · Terra's own turn arrives from a HANDOFF, which carries a channel pointer
   *    and nothing finer (`receiveHandoff`) — there is no message for it to
   *    answer, so it is a room line and must stay one. Guessing a thread there
   *    would file it under a message Terra never saw. */
  const passedLine = await waitForAgentAnswer(page, {
    under: { text: "!handoff @Terra shortlist the three cheapest villas" },
    text: "Passed to @Terra", timeout: 30000,
    what: "the 'Passed to @Terra' line, in the thread under the command",
  }).catch(err => ({ answerIds: [], failed: String(err.message ?? err) }));
  ok("handing off shows a plain 'passed to @Terra' line in a thread under the command",
    passedLine.answerIds.length >= 1, passedLine.failed ?? "");
  const terraTook = await waitForAgentAnswer(page, {
    inRoom: true, author: "Terra", timeout: 30000,
  }).catch(err => ({ answerIds: [], failed: String(err.message ?? err) }));
  ok("the receiving agent @Terra takes the handed-off turn in the conversation — a handoff names a room and nothing finer, so it has no thread to answer in",
    terraTook.answerIds.length >= 1, terraTook.failed ?? "");
  await page.screenshot({ path: `${SHOTS}/23-agent-handoff.png` });

  // ============ the actions menu — one way in to every typed command ============
  //
  // THE BUG THIS GUARDS. Every one of the commands above — !remember, !handoff,
  // and the GitHub ones — worked before there was any way to find out they
  // existed. The owner's report was "GitHub integration is not there", and he
  // was right: a feature is done when he can SEE it and USE it.
  //
  // These checks are on the DOOR, not on the commands (those are checked
  // above). They walk it the way he would: find the control, open it, read the
  // list, pick a row, watch the line land in the box he already types in, see a
  // row that cannot work say so, and press Escape.
  //
  // This room is `# trip-goa` and it has Scout AND Terra in it, so "an agent is
  // here" and "two agents are here" are both true; no repository is connected on
  // a fresh QA hub, so the GitHub rows are the honest blocked case.
  await page.click("text=# trip-goa");
  const acBox = page.locator(".composer textarea").first();
  await acBox.fill("");
  ok("a control beside the message box offers the things an agent can be told to do",
    (await page.locator(".composer .actionsbtn").count()) >= 1);

  await page.click(".composer .actionsbtn");
  await page.waitForSelector(".composer .actionspop .ap-row", { timeout: 10000 });
  const rowCount = await page.locator(".composer .actionspop .ap-row").count();
  const named = await page.evaluate(() =>
    [...document.querySelectorAll(".composer .actionspop .ap-row")]
      .map(r => r.dataset.command));
  ok("opening it lists every typed command the engine understands, each in plain words",
    rowCount >= 10
      && ["!issue", "!comment", "!review", "!code", "!bg", "!remember", "!handoff",
        "!schedule", "!schedules", "!unschedule"].every(c => named.includes(c)),
    `${rowCount} rows: ${named.join(" ")}`);

  // a row that CAN work here writes its line into the box he already uses
  await page.click('.composer .actionspop .ap-row[data-command="!remember"]');
  const filled = await acBox.inputValue();
  ok("picking a row pre-fills the message box with the command, ready to edit and send",
    /^@\w+ !remember <.+>$/.test(filled)
      && (await page.locator(".composer .actionspop").count()) === 0,
    filled);
  ok("picking a row does NOT send anything — the line is still sitting in the box, unsent",
    (await page.locator('.msg p:has-text("!remember <")').count()) === 0);
  await acBox.fill("");

  // a row that CANNOT work here says so, on the row, and refuses to be picked
  await page.click(".composer .actionsbtn");
  await page.waitForSelector('.composer .actionspop .ap-row[data-command="!issue"][data-blocked="yes"]',
    { timeout: 15000 });
  const blockedSays = (await page.locator('.composer .actionspop .ap-row[data-command="!issue"] .ap-say')
    .innerText()).trim();
  ok("a command that cannot work in this room explains itself in plain words instead of failing later",
    /repositor/i.test(blockedSays) && /connect/i.test(blockedSays), blockedSays);
  ok("and that row cannot be picked, so it can never write a line that would come straight back refused",
    await page.locator('.composer .actionspop .ap-row[data-command="!issue"]').isDisabled()
      && (await acBox.inputValue()) === "");
  await page.screenshot({ path: `${SHOTS}/24-actions-menu.png` });

  // Escape closes it — through the ONE owner of Escape, not a handler of its own
  ok("the actions menu registers with the app's one Escape owner rather than answering the key itself",
    (await page.evaluate(() => window.cloud9Escape.stacked())) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  ok("Escape closes the actions menu and leaves the box exactly as it was",
    (await page.locator(".composer .actionspop").count()) === 0
      && (await page.evaluate(() => window.cloud9Escape.stacked())) === 0
      && (await acBox.inputValue()) === "");

  // invite flow
  await page.click('button[title="Invite a friend"]');
  await page.waitForSelector(".code");
  await page.waitForFunction(() => document.querySelector(".code")?.textContent?.startsWith("inv_"));
  const code = (await page.textContent(".code")).trim();
  await page.screenshot({ path: `${SHOTS}/07-invite.png` });
  await page.click('.overlay .foot button:has-text("Done")');
  ok("invite code generated", true, code);

  // ---------- friend context ----------
  const friendCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const fpage = await friendCtx.newPage();
  fpage.on("console", m => { if (m.type() === "error") consoleErrors.push("friend: " + m.text()); });
  await fpage.goto(UI);
  await fpage.click("text=I have an invite");
  await fpage.fill('.panel input[placeholder="inv_…"]', code);
  await fpage.fill('.panel input[placeholder="Priya"]', "Priya");
  await fpage.click("text=Enter Cloud9");
  await fpage.waitForSelector("text=# general", { timeout: 30000 });
  ok("friend joins via invite", true);

  await fpage.click("text=# general");
  const fbox = fpage.locator(".composer textarea");
  await fbox.fill("hi everyone, Priya here!");
  await fbox.press("Enter");
  await fpage.screenshot({ path: `${SHOTS}/08-friend-view.png` });

  // owner sees the friend's message
  await page.click("text=# general");
  await page.waitForSelector(".msg p:has-text('Priya here')", { timeout: 30000 });
  ok("human-to-human message syncs across clients", true);
  await page.screenshot({ path: `${SHOTS}/09-owner-sees-friend.png` });

  /* ===== A REFUSED SIGN-IN MUST NEVER COST YOU THE ONE YOU ALREADY HAD =====
   *
   * The bug this locks shut: the join screen wrote `cloud9.token` BEFORE the
   * hub was asked anything — pasting an invite blanked it outright. So a spent,
   * mistyped or expired code destroyed the sign-in the person already had.
   * Vikas could dig himself out with the owner key; an invited friend, who has
   * nothing else, was locked out of their own Cloud9 permanently.
   *
   * The class rule, and what these checks hold shut: a credential is written
   * only once the hub has answered `welcome` (store.ts `adoptCredential`, the
   * one owner). Everything that can fail happens before that and therefore
   * cannot touch storage at all.
   *
   * Each case runs in its OWN browser context, so a check can never pass because
   * of something a previous one left behind.
   */
  const storedToken = ctx => ctx.evaluate(() => localStorage.getItem("cloud9.token"));

  // 1 · A SUCCESSFUL join adopted a real, durable credential — not the code.
  const priyaToken = await storedToken(fpage);
  ok("a successful join stores the durable credential the hub issued, never the invite code",
    !!priyaToken && priyaToken.length > 0 && priyaToken !== code
      && !priyaToken.startsWith("invite:"),
    `${priyaToken ? priyaToken.length : 0} chars`);

  // 2 · THE REPORTED BUG. A working credential, a sign-in box on screen, and a
  // code that has already been spent typed into it. The credential must survive
  // untouched, the person must land back inside on it, and the screen must say
  // so in plain words.
  const spentCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const spent = await spentCtx.newPage();
  await spent.goto(UI);
  await spent.waitForSelector("text=Welcome to Cloud9");
  // the credential that already works, exactly as a member's machine holds it
  await spent.evaluate(t => localStorage.setItem("cloud9.token", t), priyaToken);
  await spent.click("text=I have an invite");
  await spent.fill('.panel input[placeholder="inv_…"]', code); // already redeemed above
  await spent.fill('.panel input[placeholder="Priya"]', "Priya");
  await spent.click("text=Enter Cloud9");
  // The app is back inside on the credential that still works — the whole point.
  // (Nothing is asserted on the sign-in screen here: the fall-back is faster than
  // that screen can be read, which is exactly the behaviour we want.)
  // Caught, not awaited bare: when this breaks, the run must still SAY which of
  // these three promises broke rather than dying on a timeout with no verdict.
  let backInside = true;
  try {
    await spent.waitForSelector(".sidebar >> text=# general", { timeout: 30000 });
  } catch { backInside = false; }
  ok("a spent invite leaves the credential that was already working exactly as it was",
    (await storedToken(spent)) === priyaToken,
    `stored ${JSON.stringify(await storedToken(spent))}`);
  ok("a refused code drops the person back into their own Cloud9 rather than a dead sign-in box",
    backInside && (await spent.locator(".join").count()) === 0
      && (await spent.locator(".sidebar .person-row").count()) > 0);
  let keptSays = "";
  try {
    keptSays = (await spent.locator('.toast-text[data-kept-signed-in="yes"]')
      .innerText({ timeout: 15000 })).trim();
  } catch { keptSays = "(nothing said)"; }
  ok("and it says what happened in plain words, including that nothing was lost",
    /already been used/i.test(keptSays) && /still signed in as before/i.test(keptSays)
      && !/^Error:/.test(keptSays), keptSays);
  await spent.screenshot({ path: `${SHOTS}/07b-spent-invite-keeps-you-signed-in.png` });
  await spentCtx.close();

  // 3 · Nothing to fall back to: the refusal is honest and NOTHING is invented.
  const noneCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const none = await noneCtx.newPage();
  await none.goto(UI);
  await none.waitForSelector("text=Welcome to Cloud9");
  await none.click("text=I have an invite");
  await none.fill('.panel input[placeholder="inv_…"]', "inv_not_a_real_code");
  await none.fill('.panel input[placeholder="Priya"]', "Nobody");
  await none.click("text=Enter Cloud9");
  await none.waitForSelector(".join .joinerror .problemtext", { timeout: 20000 });
  ok("a bad code with nothing to fall back to says so and does not pretend you are signed in",
    (await storedToken(none)) === null
      && (await none.locator(".join .keptsignedin").count()) === 0
      && (await none.locator(".sidebar").count()) === 0,
    (await none.locator(".join .joinerror .problemtext").innerText()).trim());
  await noneCtx.close();

  // 4 · A join that WORKS does replace what was there — the rule is "prove it
  // first", not "never change it". A stale credential is typed over by a good one.
  await page.click('button[title="Invite a friend"]');
  // wait for a code that is NOT the one already spent, so this case cannot
  // quietly retest case 2 against a stale panel
  await page.waitForFunction(
    spentCode => {
      const t = document.querySelector(".code")?.textContent?.trim();
      return !!t && t.startsWith("inv_") && t !== spentCode;
    },
    code,
    { timeout: 20000 },
  );
  const code2 = (await page.textContent(".code")).trim();
  await page.click('.overlay .foot button:has-text("Done")');
  const swapCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const swap = await swapCtx.newPage();
  await swap.goto(UI);
  await swap.waitForSelector("text=Welcome to Cloud9");
  await swap.evaluate(() => localStorage.setItem("cloud9.token", "stale-key-that-no-longer-works"));
  await swap.click("text=I have an invite");
  await swap.fill('.panel input[placeholder="inv_…"]', code2);
  await swap.fill('.panel input[placeholder="Priya"]', "Ravi");
  await swap.click("text=Enter Cloud9");
  await swap.waitForSelector(".sidebar >> text=# general", { timeout: 30000 });
  const swapped = await storedToken(swap);
  ok("a join that works replaces the old credential with the one the hub just issued",
    !!swapped && swapped !== "stale-key-that-no-longer-works" && swapped !== code2
      && !swapped.startsWith("invite:"), `${swapped ? swapped.length : 0} chars`);
  // and a reload comes straight back in on it — the credential is genuinely good
  await swap.reload();
  await swap.waitForSelector(".sidebar >> text=# general", { timeout: 30000 });
  ok("and a reload comes straight back in on it, with no sign-in box",
    (await storedToken(swap)) === swapped
      && (await swap.locator(".join").count()) === 0);
  await swapCtx.close();

  // 5 · A DELIBERATE destroy is still allowed to destroy. The app ships no
  // sign-out button, so the only credential-wiping path there is runs at startup
  // — and it is named-key by design, so the session credential survives it while
  // the old v1 secrets do not. (The wipe itself is checked further up.)
  ok("the one startup path that wipes credentials still leaves the session credential alone",
    (await storedToken(fpage)) === priyaToken);

  // empty-input edge: Enter on empty composer sends nothing
  const before = await page.locator(".msg").count();
  await box.press("Enter");
  await page.waitForTimeout(400);
  ok("empty message is not sent", (await page.locator(".msg").count()) === before);

  // ---- his 15: every person is listed once ----
  const personNames = await page.$$eval(".sidebar .person-row", rows => rows.map(r => r.dataset.person));
  const duplicates = personNames.filter((n, i) => personNames.indexOf(n) !== i);
  ok("the people list shows each person once",
    duplicates.length === 0 && personNames.filter(n => n === "Priya").length === 1,
    personNames.join(", "));

  // ---- his 15: clicking a person opens the direct conversation with them ----
  await page.click('.sidebar .person-row[data-person="Priya"]');
  await page.waitForSelector('.chathead .ch-title .n:text-is("Priya")', { timeout: 15000 });
  ok("clicking a person opens the direct conversation with them", true);
  const dmRows = await page.locator('.sidebar .agent-row .agent-name:text-is("Priya")').count();
  await page.click('.sidebar .person-row[data-person="Priya"]');
  await page.waitForSelector('.chathead .ch-title .n:text-is("Priya")', { timeout: 15000 });
  ok("clicking that person again reuses the same conversation",
    (await page.locator('.sidebar .agent-row .agent-name:text-is("Priya")').count()) === dmRows,
    `${dmRows} DM row(s)`);
  // your own row is not a dead click — it is plainly not a button
  ok("your own row is marked as you, not offered as a chat",
    (await page.locator(".sidebar .person-row.is-me .youtag").count()) === 1);

  // ---- his 12+14: the design pass — screenshots and no sideways scroll ----
  await page.click(".sidebar >> text=# general");
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(220);
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      ok(`no sideways scrolling at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
    }
  }
  // the design shots are pinned to the light look so they are comparable run
  // to run; the dark look gets its own shot below
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/design-main.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/design-main-dark.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.waitForTimeout(250);

  await page.click('.rail-btn[data-go="settings"]');
  await page.waitForSelector(".settingspanel");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/design-settings.png`, fullPage: true });
  await page.click('.rail-btn[data-go="chat"]');

  await page.click('button[title="New agent"]');
  await page.waitForSelector("select.modelpick");
  await page.click(".skills .skill-add");
  await page.fill(".skill-name-input", "Weekly report");
  await page.fill(".skill-desc-input", "Writes the Monday summary of last week");
  await page.fill(".skill-instructions-input", "Read the last seven days of notes. Write five bullet points: what moved, what stalled, what needs me.");
  await page.click(".skills .skill-save");
  await page.waitForSelector('.skillrow[data-skill="Weekly report"]');
  // frame the shot so the app picker and the skills list are both in view
  await page.evaluate(() => document.querySelector(".editor .pick-apps")
    ?.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/design-new-agent.png`, fullPage: true });
  ok("the create screen shows the model picker and the skills editor together",
    (await page.locator("select.modelpick").count()) === 1 &&
    (await page.locator('.skillrow[data-skill="Weekly report"]').count()) === 1 &&
    (await page.locator(".skills .skill-add").count()) === 1);
  await page.click('.editor .topbar >> text=Cancel');
  await page.click('.rail-btn[data-go="chat"]');

  await page.keyboard.press("Control+k");
  await page.waitForSelector(".qc-input");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/design-quickchat.png`, fullPage: true });
  await page.keyboard.press("Escape");

  // ---------- a message is set the way it was written ----------
  // The formatting buttons used to make a message look WORSE: they inserted
  // **stars** and the list printed them raw. These checks assert the shapes,
  // and — the one that matters — that a message can never become markup.
  const md = [
    "**bold words** and *italic* and `inline code`",
    "- first thing",
    "- second thing",
    "```js",
    "const x = 1;",
    "```",
    "> a quoted line",
    "<script>alert('xss')</script>",
    "https://example.com/page",
  ].join("\n");
  await box.fill(md);
  await box.press("Enter");
  const last = page.locator(".msg").last();
  await last.locator(".md strong").first().waitFor({ timeout: 8000 });

  ok("a message renders bold, italic and inline code",
    (await last.locator(".md strong").count()) > 0 &&
    (await last.locator(".md em").count()) > 0 &&
    (await last.locator("code.mdcode").count()) > 0);
  ok("a message renders lists, code blocks and quotes",
    (await last.locator("ul.mdlist li").count()) >= 2 &&
    (await last.locator("pre.mdpre code").count()) > 0 &&
    (await last.locator("blockquote.mdquote").count()) > 0);
  ok("a bare link becomes a safe link",
    (await last.locator('a.mdlink[href="https://example.com/page"]').count()) === 1 &&
    (await last.locator("a.mdlink").first().getAttribute("rel")).includes("noopener"));
  // The whole safety argument in one assertion: markdown renders to React
  // elements, never to HTML, so a script tag is the WORDS "<script>".
  const scriptTags = await page.locator(".msg script").count();
  const scriptShownAsText = (await last.textContent()).includes("<script>");
  ok("a script tag in a message stays text, and never becomes markup",
    scriptTags === 0 && scriptShownAsText, `script els=${scriptTags}`);
  await page.screenshot({ path: `${SHOTS}/chat-markdown.png`, fullPage: true });

  /* ================= CHAT BASICS — the renderer half =================
   * docs/plans/chat-basics-handoff.md. Every check below drives the real UI
   * against the real relay: scrollback, search, reactions, edit and delete,
   * threads, account-level unread, and who may set an agent working. */

  // ---------- a conversation longer than one page ----------
  await page.click('button[title="New channel"]');
  await page.fill('.panel input[placeholder="trip-goa"]', "backlog");
  await page.click(".panel .foot >> text=Create");
  await page.waitForSelector(".sidebar >> text=# backlog");
  await page.click("text=# backlog");
  const backlogBox = page.locator(".composer textarea");
  const LINES = 55; // more than one 50-message page, so paging is real
  for (let i = 1; i <= LINES; i++) {
    await backlogBox.fill(`backlog line ${i}`);
    await backlogBox.press("Enter");
  }
  await page.waitForSelector(`.msg:has-text("backlog line ${LINES}")`, { timeout: 30000 });

  // a reload is the honest starting point: the app knows only what the hub says
  await page.reload();
  await page.waitForSelector(".sidebar >> text=# backlog", { timeout: 20000 });
  await page.click("text=# backlog");
  await page.waitForSelector('.msg:has-text("backlog line 55")', { timeout: 20000 });
  await page.waitForTimeout(600);
  const firstPage = await page.locator(".msgs .msg").count();
  ok("a long conversation opens on its newest page, not the whole thing",
    firstPage <= 50 && firstPage >= 20 &&
    (await page.locator(".startofhistory").count()) === 0,
    `${firstPage} messages on screen`);

  // scrolling to the top asks for the page before — and must not move the
  // words under the reader's eyes
  const anchorBefore = await page.evaluate(() => {
    const el = document.querySelector(".msgs");
    const first = el.querySelector(".msg");
    el.scrollTop = 0;
    return { id: first?.dataset.msg, top: first?.getBoundingClientRect().top ?? 0 };
  });
  await waitFor(page, n => document.querySelectorAll(".msgs .msg").length > n, firstPage,
    { timeout: 20000, what: "older messages to be loaded when the top is reached" });
  await page.waitForTimeout(350);
  const anchorAfter = await page.evaluate(id => {
    const el = document.querySelector(`.msgs .msg[data-msg="${id}"]`);
    return el ? el.getBoundingClientRect().top : null;
  }, anchorBefore.id);
  ok("older messages load on scroll-up and the reader keeps their place",
    anchorAfter !== null && Math.abs(anchorAfter - anchorBefore.top) <= 2,
    `the message the reader was on moved ${anchorAfter === null ? "off screen" : Math.round(anchorAfter - anchorBefore.top)}px`);

  // keep going until the relay says there is nothing older — `hasMore`, never
  // "the page was short"
  for (let i = 0; i < 6 && (await page.locator(".startofhistory").count()) === 0; i++) {
    await page.evaluate(() => { document.querySelector(".msgs").scrollTop = 0; });
    await page.waitForTimeout(700);
  }
  const allLoaded = await page.locator(".msgs .msg").count();
  ok("the beginning of a conversation is said, once, and only when the hub says so",
    (await page.locator(".startofhistory").count()) === 1 && allLoaded >= LINES,
    `${allLoaded} of ${LINES} messages loaded`);
  await page.evaluate(() => { document.querySelector(".msgs").scrollTop = 0; });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/chat-scrollback.png` });
  await page.evaluate(() => {
    const el = document.querySelector(".msgs");
    el.scrollTop = el.scrollHeight;
  });

  // ---------- reactions ----------
  const lastBacklog = page.locator(".msgs .msg").last();
  await lastBacklog.hover();
  await lastBacklog.locator(".ma.react").click();
  await page.click('.reactpop button:has-text("👍")');
  await page.waitForSelector('.reactpill[data-emoji="👍"]', { timeout: 15000 });
  const pill = page.locator('.reactpill[data-emoji="👍"]').last();
  ok("a reaction can be added on hover, and says who reacted",
    (await pill.locator(".n").innerText()).trim() === "1" &&
    /You/.test(await pill.getAttribute("title")),
    (await pill.getAttribute("title")) ?? "");
  await page.screenshot({ path: `${SHOTS}/chat-reactions.png` });
  await pill.click();
  await waitFor(page, () => document.querySelectorAll('.reactpill[data-emoji="👍"]').length === 0,
    undefined, { timeout: 15000, what: "the reaction pill to go when the last person takes it back" });
  ok("clicking your own reaction takes it back and the pill goes", true);

  // ---------- edit and delete your own message ----------
  await backlogBox.fill("this line will be corrected");
  await backlogBox.press("Enter");
  const toEdit = page.locator('.msg:has-text("this line will be corrected")').last();
  await toEdit.waitFor({ timeout: 15000 });
  await toEdit.hover();
  await toEdit.locator(".ma.edit").click();
  await page.fill(".editmsg-input", "this line was corrected");
  await page.click(".editmsg-save");
  await page.waitForSelector('.msg:has-text("this line was corrected")', { timeout: 15000 });
  const edited = page.locator('.msg:has-text("this line was corrected")').last();
  ok("your own message can be changed, and says it was changed",
    (await edited.locator(".editedmark").count()) === 1 &&
    (await page.locator('.msg:has-text("this line will be corrected")').count()) === 0);
  await page.screenshot({ path: `${SHOTS}/chat-edited.png` });

  const beforeDelete = await page.locator(".msgs .msg").count();
  await edited.hover();
  await edited.locator(".ma.del").click();
  await edited.locator(".ma.yes").click();
  await page.waitForSelector(".msgs .msg.deleted .tombstone", { timeout: 15000 });
  const afterDelete = await page.locator(".msgs .msg").count();
  ok("a deleted message becomes a tombstone in place, never a hole",
    afterDelete === beforeDelete &&
    (await page.locator(".msgs .msg.deleted .msgactions").count()) === 0,
    `${beforeDelete} rows before, ${afterDelete} after`);
  await page.screenshot({ path: `${SHOTS}/chat-edit-delete.png` });

  // someone else's words are not yours to change
  await page.click(".sidebar >> text=# general");
  await page.waitForSelector(".msg p:has-text('Priya here')");
  const theirs = page.locator(".msg:has-text('Priya here')").last();
  await theirs.hover();
  ok("there is no edit or delete on a message you did not write",
    (await theirs.locator(".ma.edit").count()) === 0 &&
    (await theirs.locator(".ma.del").count()) === 0);

  // ---------- threads ----------
  await page.click(".sidebar >> text=# backlog");
  await backlogBox.fill("what should we do about the backlog?");
  await backlogBox.press("Enter");
  const root = page.locator('.msg:has-text("what should we do about the backlog?")').last();
  await root.waitFor({ timeout: 15000 });
  await root.hover();
  await root.locator(".ma.reply").click();
  await page.waitForSelector(".threadpanel", { timeout: 15000 });
  ok("a message can be replied to in a thread, and the thread opens beside it",
    (await page.locator(".threadpanel .msg").count()) >= 1);

  await page.fill(".threadcomposer textarea", "cut it in half");
  await page.press(".threadcomposer textarea", "Enter");
  await page.waitForSelector('.threadpanel .msg:has-text("cut it in half")', { timeout: 20000 });
  await page.waitForSelector(".threadline", { timeout: 20000 });
  const replyLine = (await page.locator(".threadline").last().innerText()).replace(/\s+/g, " ");
  ok("a reply lands in the thread and the message it answers says how many replies it has",
    /1 reply/.test(replyLine), replyLine);
  await page.screenshot({ path: `${SHOTS}/chat-thread.png` });

  await page.click(".threadpanel .threadclose");
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 10000 });
  await page.locator(".threadline").last().click();
  await page.waitForSelector(".threadpanel", { timeout: 15000 });
  ok("the reply count opens the thread, with the message it started and every reply",
    (await page.locator(".threadpanel .msg").count()) === 2,
    `${await page.locator(".threadpanel .msg").count()} messages in the panel`);
  await page.click(".threadpanel .threadclose");
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 10000 });

  /* ================= WHAT HE COULD NOT FIND ================================
   *
   * Threads were all there — a panel, reply counts, a `replyTo` on the wire —
   * and he still said they were missing, because every reply was ALSO posted
   * into the room. A thread that changes nothing about the room is a thread
   * nobody can see. So: with threads on, a reply is NOT a row in the
   * conversation. That is the check.
   */
  const rowsInRoom = async () => page.evaluate(() => [...document.querySelectorAll(".msgs .msg")]
    .map(m => (m.querySelector(".body")?.innerText ?? "").replace(/\s+/g, " ")));
  const roomRows = await rowsInRoom();
  ok("with threads on, a reply is kept in its thread and is NOT a row in the conversation",
    roomRows.some(t => /what should we do about the backlog/.test(t)) &&
    !roomRows.some(t => /cut it in half/.test(t)),
    `${roomRows.length} row(s) in the room`);

  /* The door to a thread used to be an unlabelled ↳ among five other glyphs,
     revealed only on hover. It carries the word now. */
  await root.hover();
  ok("the way into a thread is a control that says Reply, not a bare glyph",
    /reply/i.test((await root.locator(".ma.reply").innerText()).trim()),
    (await root.locator(".ma.reply").innerText()).replace(/\s+/g, " "));
  await page.screenshot({ path: `${SHOTS}/thread-channel.png` });

  /* ---- and the setting he asked for, which must CHANGE the behaviour ---- */
  await page.evaluate(() => window.cloud9Menu.run("settings"));
  await page.waitForSelector("#set-replies", { timeout: 15000 });
  const replyChoices = await page.$$eval(".repliespick", bs => bs.map(b => ({
    value: b.dataset.replies,
    words: b.innerText.replace(/\s+/g, " ").trim(),
  })));
  ok("Settings offers the two ways a reply can behave, and says plainly what each one does",
    replyChoices.length === 2 &&
    replyChoices[0].value === "thread" && replyChoices[1].value === "inline" &&
    /reply count/i.test(replyChoices[0].words) &&
    /does not appear in the conversation/i.test(replyChoices[0].words) &&
    /straight into the conversation/i.test(replyChoices[1].words) &&
    /no thread opens/i.test(replyChoices[1].words),
    replyChoices.map(c => `${c.value}: ${c.words.slice(0, 60)}`).join(" | "));
  ok("threads is what it starts on — the behaviour he is comparing it against",
    (await page.$eval('.repliespick[aria-pressed="true"]', b => b.dataset.replies)) === "thread");
  await page.screenshot({ path: `${SHOTS}/thread-setting.png` });

  // KEEP IT IN THE CONVERSATION — the reply comes back into the room…
  await page.click('.repliespick[data-replies="inline"]');
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# backlog");
  await page.waitForSelector('.msgs .msg:has-text("cut it in half")', { timeout: 15000 });
  const inlineRows = await rowsInRoom();
  ok("choosing “keep it in the conversation” really does put the reply back in the room",
    inlineRows.some(t => /cut it in half/.test(t)), `${inlineRows.length} row(s) in the room`);
  ok("and it says which message it is answering, instead of just appearing",
    (await page.locator('.msg:has-text("cut it in half") .answeringmark').count()) === 1,
    (await page.locator('.msg:has-text("cut it in half") .answeringmark').innerText()).replace(/\s+/g, " "));
  ok("no thread pill is offered when threads are off — there is nothing to open",
    (await page.locator(".threadline").count()) === 0);

  // …and Reply now aims the room's own box instead of opening a panel
  const inlineRoot = page.locator('.msgs .msg:has-text("what should we do about the backlog?")').last();
  await inlineRoot.hover();
  await inlineRoot.locator(".ma.reply").click();
  await page.waitForSelector(".answeringbar", { timeout: 10000 });
  ok("with threads off, Reply aims the conversation's own box and opens no thread at all",
    (await page.locator(".threadpanel").count()) === 0 &&
    (await page.locator(".answeringbar").count()) === 1,
    (await page.locator(".answeringbar").innerText()).replace(/\s+/g, " "));
  await page.fill(".thread .composer textarea", "and ship the rest next week");
  await page.press(".thread .composer textarea", "Enter");
  await page.waitForSelector('.msgs .msg:has-text("ship the rest next week")', { timeout: 20000 });
  ok("a reply written that way lands in the conversation, under the message it answers",
    (await page.locator('.msgs .msg:has-text("ship the rest next week") .answeringmark').count()) === 1 &&
    (await page.locator(".answeringbar").count()) === 0);
  await page.screenshot({ path: `${SHOTS}/thread-inline.png` });

  // put it back, and prove the room goes quiet again
  await page.evaluate(() => window.cloud9Menu.run("settings"));
  await page.waitForSelector("#set-replies", { timeout: 15000 });
  await page.click('.repliespick[data-replies="thread"]');
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# backlog");
  await waitFor(page, () => ![...document.querySelectorAll(".msgs .msg")]
    .some(m => /cut it in half/.test(m.textContent ?? "")),
  undefined, { timeout: 20000, what: "the replies to leave the conversation again" });
  const backRows = await rowsInRoom();
  ok("switching back to threads takes the replies out of the conversation again",
    !backRows.some(t => /cut it in half/.test(t)) &&
    !backRows.some(t => /ship the rest next week/.test(t)) &&
    (await page.locator(".threadline").count()) >= 1,
    `${backRows.length} row(s), ${await page.locator(".threadline").count()} reply pill(s)`);
  await page.locator(".threadline").last().click();
  await page.waitForSelector(".threadpanel", { timeout: 15000 });
  ok("and every reply written either way is in the thread, none of them lost",
    (await page.locator(".threadpanel .msg").count()) === 3,
    `${await page.locator(".threadpanel .msg").count()} messages in the panel`);
  await page.screenshot({ path: `${SHOTS}/thread-panel.png` });

  /* ================= ONE LEVEL DEEP, NEVER A THREAD INSIDE A THREAD =========
   *
   * The rule is the HUB's (`resolveReplyTo`, apps/relay/src/server.ts:789): a
   * reply whose parent is itself a reply is re-parented onto the ROOT, so a
   * thread can never grow a second level. `packages/engine/src/threads.ts` leans
   * on that guarantee — it passes a stored `replyTo` straight back and relies on
   * it already being a root — so if the hub ever stopped normalising, the engine
   * would start answering into a thread that does not exist.
   *
   * Nothing here is faked: the message goes through the app's OWN send frame
   * (`cloud9Wire.ask`, the same door the composer uses) deliberately aimed at a
   * REPLY, which the composer itself cannot do. The proof is where the hub filed
   * it: the open panel is fed by `world.threads[root]`, which is filled from the
   * `replyTo` the HUB sent back — so a message that shows up in the root's panel
   * is a message the hub parented onto the root, and the reply count on the root
   * agrees. It must also stay out of the conversation, like any other reply. */
  const threadIds = await page.evaluate(() =>
    [...document.querySelectorAll(".threadpanel .msg[data-msg]")].map(m => m.dataset.msg));
  const backlogId = (await page.evaluate(() => window.cloud9Wire.channels()))
    .find(c => c.name === "backlog").id;
  const NESTED = "reply-to-a-reply-still-belongs-to-the-root";
  await page.evaluate(([c, parent, text]) =>
    window.cloud9Wire.ask({ type: "send", channelId: c, text, replyTo: parent }),
  [backlogId, threadIds[1], NESTED]);
  await page.waitForSelector(`.threadpanel .msg:has-text("${NESTED}")`, { timeout: 20000 });
  const nestedRows = await rowsInRoom();
  const nestedReplies = await page.locator(`.msgs .msg[data-msg="${threadIds[0]}"] .threadline`)
    .getAttribute("data-replies");
  ok("a reply to a reply lands on the ROOT thread — one level deep, never a thread inside a thread",
    (await page.locator(".threadpanel .msg").count()) === 4 &&
    nestedReplies === "3" &&
    !nestedRows.some(t => t.includes(NESTED)),
    `${await page.locator(".threadpanel .msg").count()} in the panel, root says ${nestedReplies} replies`);

  /* ================= THE SAME BOX, NARROWER — NOT A LESSER ONE =============
   *
   * The thread rail used to drop bold, italic, code and Delegate on the grounds
   * that "a thread is a narrow column and a reply is a sentence" — which is the
   * panel deciding what he is allowed to SAY in it, and a thread is exactly
   * where the work gets discussed. Both boxes are the same component, so the
   * honest check is not "are these four buttons there" but "is the tool row the
   * SAME row" — that way a tool added to the room tomorrow and quietly withheld
   * from the thread fails here, instead of passing a list of four names. The
   * four he asked for are named as well, so the check still says out loud what
   * the complaint was about. */
  const toolsOf = sel => page.$$eval(`${sel} .tools button.mini`, bs => bs.map(b => b.title));
  const roomTools = await toolsOf(".thread .composer");
  const threadTools = await toolsOf(".threadcomposer");
  const NAMED_TOOLS = ["Bold", "Italic", "Code", "Hand this over as background work"];
  ok("the thread's box offers the same tools as the room's — bold, italic, code and Delegate among them",
    roomTools.length > 0 &&
    threadTools.length === roomTools.length &&
    roomTools.every(t => threadTools.includes(t)) &&
    NAMED_TOOLS.every(t => threadTools.includes(t)),
    `room: ${roomTools.join(" / ")} :: thread: ${threadTools.join(" / ")}`);
  await page.screenshot({ path: `${SHOTS}/thread-composer-tools.png` });
  await page.click(".threadpanel .threadclose");
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 10000 });

  /* ================= HIS COMPLAINT, END TO END, WITH A REAL AGENT ==========
   *
   * In his words: "an agent does not have a conversation inside the threads.
   * they do discuss within channels only." Everything above proves what HE can
   * do in a thread; this is the half he actually complained about — where the
   * AGENT's answer lands. Nothing is seeded: a real question is typed into the
   * real thread box, a real engine turn happens, and the answer is read where it
   * landed.
   *
   * The proof is by message ID, not by words. The agent's answer in the panel is
   * looked up in the conversation by the very same `data-msg`, so an unrelated
   * agent chiming in about something else in the room — which this room's free
   * chatter really does — can never be mistaken for the answer leaking out. */
  await page.click(".sidebar >> text=# trip-goa");
  await page.waitForSelector(".composer textarea", { timeout: 20000 });
  const goaBox = page.locator(".thread .composer textarea");
  await goaBox.fill("thread-turn-root: the villa shortlist");
  await goaBox.press("Enter");
  const turnRoot = page.locator('.msgs .msg:has-text("thread-turn-root")').last();
  await turnRoot.waitFor({ timeout: 20000 });
  const turnRootId = await turnRoot.getAttribute("data-msg");
  await turnRoot.hover();
  await turnRoot.locator(".ma.reply").click();
  await page.waitForSelector(".threadpanel", { timeout: 15000 });
  await page.fill(".threadcomposer textarea",
    "@Scout in one short line, which villa has the best kitchen?");
  await page.press(".threadcomposer textarea", "Enter");
  await waitFor(page, () => [...document.querySelectorAll(".threadpanel .msg[data-msg]")]
    .some(m => m.classList.contains("from-agent")),
  undefined, { what: "the agent to answer inside the thread it was asked in" });
  const answerIds = await page.evaluate(() =>
    [...document.querySelectorAll(".threadpanel .msg[data-msg]")]
      .filter(m => m.classList.contains("from-agent")).map(m => m.dataset.msg));
  const leakedIntoRoom = await page.evaluate(ids =>
    ids.filter(i => !!document.querySelector(`.msgs .msg[data-msg="${i}"]`)), answerIds);
  ok("an agent asked inside a thread answers INSIDE that thread, and its answer is not a row in the conversation",
    answerIds.length >= 1 && leakedIntoRoom.length === 0,
    `${answerIds.length} agent answer(s) in the thread, ${leakedIntoRoom.length} of them also in the room`);
  await page.screenshot({ path: `${SHOTS}/thread-agent-answer.png` });

  /* ============ THE OTHER HALF, AND IT IS THE ONE HE ASKED FOR =============
   *
   * HIS ASK, 2026-08-04: an agent's answer goes into a thread hanging off the
   * message it answers — IN THE CHANNEL as well as inside a thread. So the
   * ordinary case is no longer "asked in the room, answered in the room": the
   * question typed in the channel becomes its own thread root
   * (`threadOf(trigger) = trigger.replyTo ?? trigger.id`), the answer is a reply
   * under it, and with his default setting a reply is NOT a row in the scroll.
   *
   * This check used to assert the opposite, in those words, and a check whose
   * name states the reverse of the behaviour is worse than no check: it would
   * have gone green on the very bug it was renamed to catch. So it now pins the
   * headline behaviour, and pins all four halves of it at once:
   *   · the channel gains NO new agent row;
   *   · his own question gains a replies line;
   *   · the answer really is in that thread, with words in it;
   *   · and it is under HIS question, not swept into some other thread — the
   *     thread opened above must not have moved.
   *
   * Proved by message id, never by words: this room has free chatter in it, so
   * matching on text would eventually blame the feature for an unrelated line.
   */
  await page.click(".threadpanel .threadclose");
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 10000 });
  const otherThreadBefore = await page.locator(`.msgs .msg[data-msg="${turnRootId}"] .threadline`)
    .getAttribute("data-replies");
  const roomAgentRowsBefore = await page.evaluate(() =>
    [...document.querySelectorAll(".msgs .msg.from-agent[data-msg]")].map(m => m.dataset.msg));
  const CHANNEL_ASK = "channel-ask-root: in one short line, what time should we check in?";
  await goaBox.fill(`@Scout ${CHANNEL_ASK}`);
  await goaBox.press("Enter");
  const channelAsk = await waitForAgentAnswer(page, {
    under: { text: "channel-ask-root" }, text: "check in",
    close: false,
    what: "the agent's answer to a CHANNEL question — a thread under his message, not a row in the scroll",
  });
  /* Read while the panel is open, so "the answer is not in the room" is asked of
     the exact ids that are in the panel — the leak test the helper hands back. */
  const newRoomAgentRows = await page.evaluate(known =>
    [...document.querySelectorAll(".msgs .msg.from-agent[data-msg]")]
      .map(m => m.dataset.msg).filter(id => !known.includes(id)), roomAgentRowsBefore);
  await page.screenshot({ path: `${SHOTS}/channel-ask-answered-in-thread.png` });
  await page.click(".threadpanel .threadclose");
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 10000 });
  const otherThreadAfter = await page.locator(`.msgs .msg[data-msg="${turnRootId}"] .threadline`)
    .getAttribute("data-replies");
  ok("HIS ASK: a question asked in the CHANNEL leaves no agent row in the conversation — the answer is in a thread under his own message, and the message says so",
    channelAsk.answerIds.length >= 1 && channelAsk.alsoInRoom.length === 0 &&
    channelAsk.replies >= 1 && newRoomAgentRows.length === 0,
    `${channelAsk.answerIds.length} answer(s) in the thread, ${channelAsk.alsoInRoom.length} of them in the room, ` +
    `his message says ${channelAsk.replies} reply/replies, ${newRoomAgentRows.length} new agent row(s) in the scroll`);
  ok("and it went under HIS question, not into whatever thread happened to be open before it",
    otherThreadAfter === otherThreadBefore && channelAsk.rootId !== turnRootId,
    `the earlier thread still says ${otherThreadAfter} replies (was ${otherThreadBefore})`);

  /* ================= THE BOX IS CALM UNTIL HE IS WRITING ====================
   *
   * His §3.2: "affordances appear on intent, not permanently". The message box
   * carried nine controls at all times, so the two that matter — the one door
   * into everything an agent can be told to do, and Send — were two of nine
   * rather than the two.
   *
   * THE LINE THIS HOLDS, and it is the one that is easy to cross by accident:
   * what recedes must still be THERE. A tool removed from the DOM when the box
   * is idle is a tool that cannot be found, cannot be tabbed to, and cannot be
   * clicked from a script — which is the invisibility bug again wearing a
   * tidier coat. So the check asks two different questions of the same row: is
   * it in the box (always), and is it showing (only while he is writing).
   *
   * `armed` is the app's own word for "he is writing" — focused, or holding
   * text, or holding files, or with a menu open — written once beside the box
   * and published as `data-writing`. Reading the attribute rather than
   * measuring pixels means a check can never disagree with the rule that drew
   * it.
   */
  await page.click(".sidebar >> text=# trip-goa");
  await page.waitForSelector(".thread .composer textarea", { timeout: 20000 });
  const cbox = page.locator(".thread .composer textarea");
  await cbox.fill("");
  await page.evaluate(() => document.activeElement?.blur?.());
  await waitFor(page, () =>
    document.querySelector(".thread .composer .composer-box")?.dataset.writing === "no",
  undefined, { timeout: 10000, what: "the box to go calm with nothing being written" });
  /* Everything the two readings below are made of, taken the same way both
     times so "calm" and "writing" are honestly comparable. `showing` is the
     COMPUTED answer, not a class name — a stylesheet that stopped hiding the
     row would otherwise pass a check that only read markup. */
  const composerNow = () => page.evaluate(() => {
    const box = document.querySelector(".thread .composer .composer-box");
    /* Judged on whether the control really takes up space on the screen, not on
       a class name and not on the wrapper's own `display` — the row is hidden
       with `display:none` and shown with `display:contents`, and a wrapper that
       generates no box of its own is exactly what `contents` means. So the
       BUTTONS are asked, which is what he actually sees. */
    const showing = el => !!el && el.getClientRects().length > 0;
    const receding = [...box.querySelectorAll(".toolset button.mini")];
    return {
      writing: box.dataset.writing,
      recedingInBox: receding.map(b => b.title),
      recedingShowing: receding.length > 0 && receding.every(showing),
      actionsShowing: showing(box.querySelector(".actionsbtn")),
      sendShowing: showing(box.querySelector(".sendbtn")),
      /* The button whose whole job was to type one character. It went; the
         `@` road it opened did not. */
      atAgentButtons: [...box.querySelectorAll("button")]
        .filter(b => /@\s*agent/i.test((b.textContent ?? "").trim())).length,
    };
  });
  const calmBox = await composerNow();
  await cbox.click();
  await waitFor(page, () =>
    document.querySelector(".thread .composer .composer-box")?.dataset.writing === "yes",
  undefined, { timeout: 10000, what: "the box to arm when he clicks into it" });
  const armedBox = await composerNow();
  ok("the message box is calm when nothing is being written, and shows its tools the moment he is — and they never left the box",
    calmBox.writing === "no" && calmBox.recedingShowing === false &&
    calmBox.recedingInBox.length >= 5 &&
    armedBox.writing === "yes" && armedBox.recedingShowing === true &&
    armedBox.recedingInBox.length === calmBox.recedingInBox.length,
    `calm: ${calmBox.recedingInBox.length} tools in the box, showing=${calmBox.recedingShowing}; ` +
    `writing: ${armedBox.recedingInBox.length} in the box, showing=${armedBox.recedingShowing}`);
  ok("the ＋ Actions door and Send are on screen in BOTH states — invisible is the same as absent",
    calmBox.actionsShowing === true && calmBox.sendShowing === true &&
    armedBox.actionsShowing === true && armedBox.sendShowing === true,
    `calm: ＋=${calmBox.actionsShowing} Send=${calmBox.sendShowing}; ` +
    `writing: ＋=${armedBox.actionsShowing} Send=${armedBox.sendShowing}`);
  await page.screenshot({ path: `${SHOTS}/composer-calm-and-armed.png` });

  /* ---- the one control that was really taken away, and the road it left ----
     "@ agent" was a button that typed an `@`. The list it opened is opened by
     typing the character itself, and always was — so the check is not "is the
     button gone" on its own, which any regression could satisfy by breaking
     both. It is: the button is gone AND the list still opens, with the same
     people and agents in it. */
  await cbox.fill("@");
  await waitFor(page, () =>
    document.querySelector(".thread .composer .autocomplete[data-mentions-open]") !== null,
  undefined, { timeout: 10000, what: "typing @ to open the list of people and agents" });
  const mentions = await page.evaluate(() => {
    const ac = document.querySelector(".thread .composer .autocomplete");
    return {
      open: ac.dataset.mentionsOpen,
      n: Number(ac.dataset.mentions),
      names: [...ac.querySelectorAll(".opt .opt-label")].map(o => o.textContent.trim()),
    };
  });
  await cbox.fill("");
  ok("the `@ agent` button is gone, and typing @ still opens the very list it used to open",
    calmBox.atAgentButtons === 0 && armedBox.atAgentButtons === 0 &&
    mentions.open === "yes" && mentions.n >= 2 &&
    mentions.names.some(n => /Scout/.test(n)),
    `${mentions.n} offered: ${mentions.names.join(" / ")}`);

  /* ================= `/` IS THE SAME LIST, NOT A SECOND ONE ================
   *
   * Two doors, one room. The ＋ list is already held above (it opens, it lists
   * every command the engine understands, a row fills the box, a blocked row
   * says why). These hold the TYPED road to the same rows — and hold it to
   * being the same rows, by comparing the count `/` alone offers with the
   * count the ＋ offers. A second, drifting command list is exactly the failure
   * `ROOM_COMMANDS` exists to prevent.
   */
  await page.click(".thread .composer .actionsbtn");
  await page.waitForSelector('.thread .composer .actionspop[data-open-by="button"]', { timeout: 10000 });
  const byButton = Number(await page.getAttribute(".thread .composer .actionspop", "data-rows"));
  await page.keyboard.press("Escape");
  await page.waitForSelector(".thread .composer .actionspop", { state: "detached", timeout: 10000 });
  await cbox.fill("/");
  await waitFor(page, () =>
    document.querySelector('.thread .composer .actionspop[data-open-by="slash"]') !== null,
  undefined, { timeout: 10000, what: "a typed slash to open the same list" });
  const bySlash = Number(await page.getAttribute(".thread .composer .actionspop", "data-rows"));
  await cbox.fill("/rem");
  await waitFor(page, () => {
    const pop = document.querySelector('.thread .composer .actionspop[data-open-by="slash"]');
    return pop && Number(pop.dataset.rows) === 1;
  }, undefined, { timeout: 10000, what: "the list to narrow to the one command he is typing" });
  const narrowedTo = await page.$$eval(".thread .composer .actionspop .ap-row",
    rs => rs.map(r => r.dataset.command));
  const slashClass = await page.getAttribute(".thread .composer .actionspop", "class");
  await cbox.press("Enter");
  const slashFilled = await cbox.inputValue();
  ok("typing / opens the SAME list the ＋ opens, narrows it as he types, and Enter writes the command into the box",
    bySlash === byButton && bySlash >= 10 &&
    narrowedTo.length === 1 && narrowedTo[0] === "!remember" &&
    /slashpop/.test(slashClass ?? "") &&
    /^@\w+ !remember <.+>$/.test(slashFilled),
    `＋ offered ${byButton}, / offered ${bySlash}, "/rem" narrowed to ${narrowedTo.join("/")}, ` +
    `Enter wrote: ${slashFilled}`);
  ok("and it sent nothing — the line is still sitting in the box, exactly as the ＋ road promises",
    (await page.locator('.msgs .msg p:has-text("!remember <")').count()) === 0 &&
    (await page.locator(".thread .composer .actionspop").count()) === 0);

  /* A row that cannot work here refuses on the TYPED road too, in the same
     sentence. Without this, `/` would be a way round the promise the ＋ list
     makes — a line written into the box that comes straight back refused. */
  await page.evaluate(() => window.cloud9Wire.notify(""));
  await cbox.fill("/issue");
  await waitFor(page, () => {
    const row = document.querySelector('.thread .composer .actionspop .ap-row[data-command="!issue"]');
    return !!row && row.dataset.blocked === "yes";
  }, undefined, { timeout: 10000, what: "the blocked row to be drawn as blocked on the typed road" });
  const slashBlockedSays = (await page.locator(
    '.thread .composer .actionspop .ap-row[data-command="!issue"] .ap-say').innerText()).trim();
  await cbox.press("Enter");
  await page.waitForTimeout(300);
  const refusedOnTyping = await page.evaluate(() => window.cloud9Wire.lastError()?.text ?? "");
  ok("a command that cannot work here still says why on the typed road, and refuses to be written in",
    /repositor/i.test(slashBlockedSays) && /connect/i.test(slashBlockedSays) &&
    refusedOnTyping === slashBlockedSays &&
    (await cbox.inputValue()) === "/issue",
    `the row says "${slashBlockedSays}"; pressing Enter said "${refusedOnTyping}"`);
  await page.screenshot({ path: `${SHOTS}/composer-slash-list.png` });
  await cbox.fill("");
  await page.keyboard.press("Escape").catch(() => {});

  /* ---- a file arrives the way a file usually arrives ----
     The paperclip is already held elsewhere (the upload tray, the ceiling, the
     hub's refusal). These are the two roads that were added when the wide
     "Attach" label became an icon: a paste carrying files, and a drop on the
     box. Both go through `attachFiles`, the one owner — so the proof is that a
     real file really lands in the tray, and that the box says out loud it is a
     drop target while something is over it. */
  const dropped = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["dropped onto the box"], "dropped-note.txt", { type: "text/plain" }));
    return dt;
  });
  await page.dispatchEvent(".thread .composer", "dragover", { dataTransfer: dropped });
  const sayingDrop = await page.getAttribute(".thread .composer", "data-dragover");
  await page.dispatchEvent(".thread .composer", "drop", { dataTransfer: dropped });
  await page.waitForSelector('.thread .composer .uptile[data-upload="dropped-note.txt"]', { timeout: 25000 });
  const afterDrop = await page.getAttribute(".thread .composer", "data-dragover");
  /* Built and dispatched inside the page rather than handed in from here: a
     `paste` is a `ClipboardEvent`, and the only way to be sure the handler sees
     real files on it is to make the event where the DataTransfer lives. It is
     still the real event, on the real box, reaching the app's own handler. */
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["pasted onto the box"], "pasted-note.txt", { type: "text/plain" }));
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    if (!ev.clipboardData || ev.clipboardData.files.length === 0) {
      Object.defineProperty(ev, "clipboardData", { value: dt });
    }
    document.querySelector(".thread .composer textarea").dispatchEvent(ev);
  });
  await page.waitForSelector('.thread .composer .uptile[data-upload="pasted-note.txt"]', { timeout: 25000 });
  ok("a file dropped on the box, or pasted into it, is put on the message exactly as the paperclip's is",
    sayingDrop === "yes" && afterDrop === "no" &&
    (await page.locator('.thread .composer .uptile[data-upload="dropped-note.txt"]').count()) === 1 &&
    (await page.locator('.thread .composer .uptile[data-upload="pasted-note.txt"]').count()) === 1,
    `the box said dragover=${sayingDrop} while it was over, ${afterDrop} once it landed`);
  await page.screenshot({ path: `${SHOTS}/composer-drop-and-paste.png` });
  /* Taken back off again: the rest of the suite is entitled to an empty box. */
  await page.waitForSelector('.thread .composer .uptile[data-upload="dropped-note.txt"].done',
    { timeout: 40000 }).catch(() => {});
  while (await page.locator(".thread .composer .uptile .upx").count() > 0) {
    await page.locator(".thread .composer .uptile .upx").first().click();
    await page.waitForTimeout(150);
  }
  await waitFor(page, () => document.querySelectorAll(".thread .composer .uptile").length === 0,
    undefined, { timeout: 15000, what: "the dropped and pasted files to be taken back off the message" });

  /* ================= SEMANTIC RECEIPTS — A LIVE SIGNAL, NEVER A RECORD =====
   *
   * His §2: when a message is sent, the agent's state should appear on it —
   * 👀 reading, 💭 thinking, then ONE tick saying how it was understood.
   *
   * WHAT IS REAL HERE AND WHAT IS SEEDED, said out loud rather than implied.
   * The three signals are sent as REAL `agentReceipt` frames over the owner's
   * own socket, so the hub's every gate really runs (it proves this account
   * owns the agent, that the message exists and is visible to it, that the
   * frame's channel is the message's real channel, and that a verdict carries a
   * verdict and nothing else does), it really broadcasts them, the client's
   * real frame handler really routes them, and the real component draws them.
   * The one thing standing in is the ENGINE's decision about WHEN to send each
   * one and which verdict it earned — `turnVerdict` is pinned by the engine's
   * own tests, and driving a live turn to catch a 👀 that is replaced by a 💭
   * a moment later would be a race, not a check.
   *
   * The message they hang off carries no `@`, so no agent is asked anything and
   * no subscription is spent on drawing three emoji.
   */
  const scoutForReceipt = (await page.evaluate(() => window.cloud9Wire.agents()))
    .find(a => a.name === "Scout");
  const goaId = (await page.evaluate(() => window.cloud9Wire.channels()))
    .find(c => c.name === "trip-goa").id;
  await cbox.fill("receipt-carrier: the villa shortlist, for the record");
  await cbox.press("Enter");
  const carrier = page.locator('.msgs .msg:has-text("receipt-carrier")').last();
  await carrier.waitFor({ timeout: 25000 });
  const carrierId = await carrier.getAttribute("data-msg");
  const signalsOn = id => page.evaluate(msg => {
    const row = document.querySelector(`.msgs .msg[data-msg="${msg}"]`);
    return [...(row?.querySelectorAll(".receipt") ?? [])].map(r => ({
      tag: r.tagName,
      stage: r.dataset.stage,
      verdict: r.dataset.verdict ?? null,
      emoji: r.textContent.trim(),
      title: r.title,
      hasCount: !!r.querySelector(".n"),
    }));
  }, id);
  const sendSignal = (stage, verdict) => page.evaluate(([agentId, channelId, messageId, s, v]) =>
    window.cloud9Wire.ask({
      type: "agentReceipt", agentId, channelId, messageId, stage: s,
      ...(v ? { verdict: v } : {}),
    }), [scoutForReceipt.id, goaId, carrierId, stage, verdict ?? null]);

  await sendSignal("reading");
  await waitFor(page, id => document.querySelector(
    `.msgs .msg[data-msg="${id}"] .receipt[data-stage="reading"]`) !== null,
  carrierId, { timeout: 20000, what: "👀 to appear the moment the agent picks the message up" });
  const reading = await signalsOn(carrierId);
  await sendSignal("thinking");
  await waitFor(page, id => document.querySelector(
    `.msgs .msg[data-msg="${id}"] .receipt[data-stage="thinking"]`) !== null,
  carrierId, { timeout: 20000, what: "💭 to replace 👀 while the agent's program runs" });
  const thinking = await signalsOn(carrierId);
  await sendSignal("verdict", "investigating");
  await waitFor(page, id => document.querySelector(
    `.msgs .msg[data-msg="${id}"] .receipt[data-stage="verdict"]`) !== null,
  carrierId, { timeout: 20000, what: "the one committed tick when the agent has answered" });
  const verdict = await signalsOn(carrierId);
  ok("an agent picking a message up shows 👀, then 💭, then exactly ONE committed tick — one moving signal, never a growing pile",
    reading.length === 1 && reading[0].emoji === "👀" &&
    thinking.length === 1 && thinking[0].emoji === "💭" &&
    verdict.length === 1 && verdict[0].emoji === "🔍" && verdict[0].verdict === "investigating",
    `${reading.map(r => r.emoji).join("")} → ${thinking.map(r => r.emoji).join("")} → ` +
    `${verdict.map(r => r.emoji).join("")} (${verdict.length} row(s) on the message)`);
  await page.screenshot({ path: `${SHOTS}/receipt-live-signal.png` });

  /* ---- and a person who reacts is a completely different thing on screen ----
     The failure this exists to stop is somebody reading a machine's "I am
     looking at this" as a colleague's decision. A reaction is a BUTTON with a
     count that you can press; a receipt is a greyed SPAN with neither, and it
     says on itself where it came from and that it is not kept. Both are on the
     same message at the same moment, so this is a comparison and not two
     separate readings. */
  await carrier.hover();
  await carrier.locator(".ma.react").click();
  await page.click('.reactpop button:has-text("👍")');
  await page.waitForSelector(`.msgs .msg[data-msg="${carrierId}"] .reactpill[data-emoji="👍"]`,
    { timeout: 20000 });
  const sideBySide = await page.evaluate(id => {
    const row = document.querySelector(`.msgs .msg[data-msg="${id}"]`);
    const receipt = row.querySelector(".receipt");
    const react = row.querySelector('.reactpill[data-emoji="👍"]');
    return {
      receiptTag: receipt?.tagName ?? "(none)",
      receiptCount: receipt?.querySelector(".n")?.textContent ?? null,
      receiptTitle: receipt?.title ?? "",
      reactionTag: react?.tagName ?? "(none)",
      reactionCount: react?.querySelector(".n")?.textContent?.trim() ?? null,
    };
  }, carrierId);
  ok("a receipt can never be read as somebody's reaction — a greyed span with no count that says it is a live signal, beside a person's button with one",
    sideBySide.receiptTag === "SPAN" && sideBySide.receiptCount === null &&
    /not a person's reaction/i.test(sideBySide.receiptTitle) &&
    /isn't saved/i.test(sideBySide.receiptTitle) &&
    sideBySide.reactionTag === "BUTTON" && sideBySide.reactionCount === "1",
    `receipt: <${sideBySide.receiptTag}> no count, "${sideBySide.receiptTitle}" :: ` +
    `reaction: <${sideBySide.reactionTag}> count ${sideBySide.reactionCount}`);
  await page.screenshot({ path: `${SHOTS}/receipt-vs-reaction.png` });

  /* ================= WHAT IT IS DOING, WHILE IT IS DOING IT ================
   *
   * NEW 2026-08-04. Sitting in a CLI you watch each tool call land; Cloud9 used
   * to show "X is working on it" for two minutes and then the whole story at
   * once. Live steps are the other half — a preview, drawn on the message that
   * ASKED, by the very same `RunSteps` renderer the stored record uses.
   *
   * Driven the same way the receipts above are, and for the same reason: the
   * frames go through this window's OWN socket, so the hub's every gate really
   * runs (ownership, the message exists and is visible, the frame's channel is
   * the message's channel, the step shape and its limits, the redaction on the
   * way out), it really broadcasts, the real handler routes and the real
   * component draws. Only the ENGINE's decision about WHEN to send a batch is
   * stood in for — catching a live turn mid-step would be a race, not a check.
   *
   * TWO THINGS ARE WORTH PINNING and nothing else:
   *  · a batch that repeats a `seq` is the SAME step with more filled in (a
   *    command is announced when it starts and gets its outcome when it ends),
   *    so it must MERGE — appending would show him one command twice;
   *  · `done` really ends the preview, so the screen hands back to the stored
   *    record instead of a list that spins for a turn that is over.
   */
  const sendSteps = (steps, done) => page.evaluate(([agentId, channelId, messageId, s, d]) =>
    window.cloud9Wire.ask({
      type: "agentSteps", agentId, channelId, messageId,
      ...(s ? { steps: s } : {}), ...(d ? { done: true } : {}),
    }), [scoutForReceipt.id, goaId, carrierId, steps, done ?? null]);

  await sendSteps([{ seq: 1, kind: "command", label: "Ran a command" }]);
  await waitFor(page, id => !!document.querySelector(
    `.msgs .msg[data-msg="${id}"] .livework[data-msg="${id}"] .runstep[data-seq="1"]`),
  carrierId, { timeout: 20000, what: "the first live step to appear on the message that asked" });
  await sendSteps([
    { seq: 1, kind: "command", label: "Ran a command", ok: true },
    { seq: 2, kind: "read", label: "Read a file" },
  ]);
  await waitFor(page, id => !!document.querySelector(
    `.msgs .msg[data-msg="${id}"] .runstep[data-seq="2"]`),
  carrierId, { timeout: 20000, what: "the second live step to arrive" });
  const live = await page.evaluate(id => {
    const block = document.querySelector(`.msgs .msg[data-msg="${id}"] .livework[data-msg="${id}"]`);
    const turn = block?.querySelector(".liveturn");
    return {
      blocks: document.querySelectorAll(`.msgs .msg[data-msg="${id}"] .livework`).length,
      agent: turn?.dataset.agent ?? "",
      said: turn?.dataset.liveSteps ?? "",
      steps: [...(block?.querySelectorAll(".runstep") ?? [])]
        .map(s => `${s.dataset.seq}:${s.dataset.kind}:${s.dataset.ok}`),
      says: (block?.innerText ?? "").replace(/\s+/g, " ").trim(),
    };
  }, carrierId);
  ok("live steps stream onto the message that asked, and a step reported twice is ONE step with its outcome filled in — never the same command listed again",
    live.blocks === 1 && live.agent === scoutForReceipt.id && live.said === "2" &&
    live.steps.join(" ") === "1:command:true 2:read:unsaid",
    `${live.said} step(s) claimed, drawn: ${live.steps.join(" / ")}`);
  ok("and it says out loud that this is live and not the record, so nobody reads a preview as the answer",
    /working/i.test(live.says) && /full record appears when it finishes/i.test(live.says),
    live.says.slice(0, 110));
  await page.screenshot({ path: `${SHOTS}/live-steps.png` });

  await sendSteps(undefined, true);
  await waitFor(page, id => !document.querySelector(`.msgs .msg[data-msg="${id}"] .livework`),
    carrierId, { timeout: 20000, what: "the live preview to end when the turn says it is over" });
  ok("when the turn ends the preview ends with it — the screen hands back to the stored record instead of a list that spins forever",
    (await page.locator(`.msgs .msg[data-msg="${carrierId}"] .livework`).count()) === 0);

  /* ---- the honest half of "ephemeral": it really is gone ----
     Nothing about a receipt is written down — not on the hub, not in the
     world, not in history and not in search. The only way to prove that from
     the outside is to throw the screen away and build it again from what was
     really stored. The person's reaction goes through the same reload in the
     same breath, so "everything vanished" cannot pass as "receipts vanished". */
  await page.reload();
  await page.waitForSelector(".sidebar >> text=# trip-goa", { timeout: 30000 });
  await page.click(".sidebar >> text=# trip-goa");
  await page.waitForSelector(`.msgs .msg[data-msg="${carrierId}"]`, { timeout: 30000 });
  await page.waitForTimeout(600);
  const afterReload = await signalsOn(carrierId);
  ok("a reload leaves no trace of a receipt — nothing was ever stored, and the screen does not pretend otherwise",
    afterReload.length === 0 &&
    (await page.locator(`.msgs .msg[data-msg="${carrierId}"] .receipts`).count()) === 0,
    `${afterReload.length} receipt(s) survived the reload`);
  const survived = page.locator(`.msgs .msg[data-msg="${carrierId}"] .reactpill[data-emoji="👍"]`);
  ok("and the person's reaction on that very message DID survive it, because that one really is a fact somebody stated",
    (await survived.count()) === 1 &&
    (await survived.locator(".n").innerText()).trim() === "1",
    `${await survived.count()} reaction pill(s) came back from the hub`);
  /* Taken back off, so the rest of the suite meets the message it expects. */
  await survived.click();
  await waitFor(page, id => document.querySelectorAll(
    `.msgs .msg[data-msg="${id}"] .reactpill`).length === 0,
  carrierId, { timeout: 15000, what: "the reaction to be taken back off the carrier message" });

  // ---------- search across everything ----------
  await page.evaluate(() => window.cloud9Menu.run("search"));
  await page.waitForSelector(".searchpanel", { timeout: 10000 });
  /* The panel now opens on EVERYTHING (feature 3). These older checks are about
     the message-only question — the one door that understands `in:` and
     `from:` — so they walk to it the way a person would, by clicking it. */
  await page.click('.scopepill[data-scope="messages"]');
  ok("search opens from the menu and looks across everything, not one room", true);
  await page.fill(".search-input", "backlog");
  await page.waitForSelector(".searchhit", { timeout: 20000 });
  await page.waitForTimeout(400);
  const groups = await page.locator(".searchgroup").count();
  const firstHit = page.locator(".searchhit").first();
  const hitText = (await firstHit.innerText()).replace(/\s+/g, " ");
  ok("results are grouped by conversation, with who said it, when, and the words around it",
    groups >= 1 &&
    (await firstHit.locator(".hitwho b").count()) === 1 &&
    (await firstHit.locator(".hitwho .t").count()) === 1 &&
    (await page.locator(".searchhit .snippet mark").count()) >= 1,
    `${groups} group(s) :: ${hitText.slice(0, 80)}`);
  await page.screenshot({ path: `${SHOTS}/chat-search.png` });

  // a result is a way BACK to the message, in its own conversation
  const wantedId = await page.locator(".searchhit").first().getAttribute("data-hit");
  await page.locator(".searchhit").first().click();
  await page.waitForSelector(`.msgs .msg[data-msg="${wantedId}"].litup`, { timeout: 25000 });
  ok("clicking a result goes to that message, in the conversation it was said in", true);
  await page.screenshot({ path: `${SHOTS}/chat-search-jump.png` });

  // ---------- unread, from the account and not from this browser ----------
  await page.evaluate(() => localStorage.setItem("cloud9.lastRead", '{"c":1}'));
  await page.reload();
  await page.waitForSelector(".sidebar >> text=# general", { timeout: 20000 });
  ok("the old per-machine read state is deleted on start — the hub owns it now",
    (await page.evaluate(() => localStorage.getItem("cloud9.lastRead"))) === null);

  await page.click(".sidebar >> text=# backlog");
  await page.waitForTimeout(500);
  await fpage.click("text=# general");
  await fpage.fill(".composer textarea", "@Vikas can you look at this when you get a moment?");
  await fpage.press(".composer textarea", "Enter");
  await page.waitForSelector('.side-item[data-channel="general"] .cnt.hot', { timeout: 25000 });
  ok("a message you have not seen is counted, and one that asks for you is marked apart",
    (await page.locator('.side-item[data-channel="general"] .cnt.at').count()) === 1,
    (await page.locator('.side-item[data-channel="general"]').innerText()).replace(/\s+/g, " "));
  await page.screenshot({ path: `${SHOTS}/chat-unread.png` });

  await page.click(".sidebar >> text=# general");
  await waitFor(page, () =>
    document.querySelectorAll('.side-item[data-channel="general"] .cnt').length === 0,
  undefined, { timeout: 20000, what: "the unread marks to clear once the room is read" });
  ok("reading the conversation clears the marks", true);

  /* ================= WHEN THE ONLY NEW THING IS INSIDE A THREAD ============
   *
   * The hunt: with replies kept in threads, "1 new" sent him into a room whose
   * scroll showed nothing new — the reply was hanging off a message further up.
   * Two halves answer it, and both are checked here against a REAL reply typed
   * by a REAL second person into the real thread box:
   *   · the room's row says ↳1 and its words say where the new thing is;
   *   · the message it hangs off says "New" on its replies line, until opened.
   * The room is left un-opened while Priya writes, so the reply is genuinely
   * unread rather than a mark this suite arranged. */
  await page.fill(".composer textarea", "thread-unread-root: where do we stand on the villas?");
  await page.press(".composer textarea", "Enter");
  const unreadRoot = page.locator('.msgs .msg:has-text("thread-unread-root")').last();
  await unreadRoot.waitFor({ timeout: 20000 });
  const unreadRootId = await unreadRoot.getAttribute("data-msg");
  /* Out of the room, so everything Priya writes next is really unread. */
  await page.click(".sidebar >> text=# backlog");
  await page.waitForTimeout(800);

  await fpage.click("text=# general");
  await fpage.waitForSelector(`.msgs .msg[data-msg="${unreadRootId}"]`, { timeout: 20000 });
  const priyaRoot = fpage.locator(`.msgs .msg[data-msg="${unreadRootId}"]`);
  await priyaRoot.hover();
  await priyaRoot.locator(".ma.reply").click();
  await fpage.waitForSelector(".threadpanel", { timeout: 15000 });
  await fpage.fill(".threadcomposer textarea", "thread-only-unread: still waiting on the architect");
  await fpage.press(".threadcomposer textarea", "Enter");
  await fpage.waitForSelector('.threadpanel .msg:has-text("thread-only-unread")', { timeout: 20000 });
  await fpage.click(".threadpanel .threadclose");

  await page.waitForSelector('.side-item[data-channel="general"] .cnt.inthread', { timeout: 30000 });
  const threadMark = await page.evaluate(() => {
    const row = document.querySelector('.side-item[data-channel="general"]');
    const arrow = row.querySelector(".cnt.inthread");
    const count = row.querySelector(".cnt.hot");
    return {
      inThread: arrow?.dataset.inthread ?? "",
      only: arrow?.dataset.onlyThreads ?? "",
      arrowWords: (arrow?.textContent ?? "").trim(),
      arrowSays: arrow?.title ?? "",
      countSays: count?.title ?? "",
    };
  });
  ok("when the only new thing is inside a thread the row says ↳1, and its words say that is where it is",
    threadMark.inThread === "1" && threadMark.only === "yes" &&
    threadMark.arrowWords === "↳1" &&
    /inside a thread/i.test(threadMark.arrowSays) &&
    /inside a thread/i.test(threadMark.countSays),
    JSON.stringify(threadMark));
  await page.screenshot({ path: `${SHOTS}/thread-unread-mark.png` });

  /* THE OTHER HALF — WHICH thread. Read before the room's own marks are allowed
     to clear, because the "New" on the replies line is worked out from the read
     marker the conversation was OPENED on, not from the one it ends up with. */
  await page.click(".sidebar >> text=# general");
  const movedLine = page.locator(`.msgs .msg[data-msg="${unreadRootId}"] .threadline`);
  await movedLine.waitFor({ timeout: 20000 });
  const movedWords = (await movedLine.innerText()).replace(/\s+/g, " ").trim();
  ok("the message the thread hangs off says New on its replies line, so he is not left opening every thread",
    (await movedLine.getAttribute("data-thread-new")) === "yes" &&
    ((await movedLine.getAttribute("class")) ?? "").includes("has-new") &&
    /\bnew\b/i.test(movedWords),   // the tag is drawn "New" and set in capitals by the stylesheet
    movedWords);
  await page.screenshot({ path: `${SHOTS}/thread-line-new.png` });

  await waitFor(page, () =>
    document.querySelectorAll('.side-item[data-channel="general"] .cnt').length === 0,
  undefined, { timeout: 25000, what: "the ↳ mark to go once the room is read" });
  ok("reading the room takes the ↳ mark away with the rest — a mark that will not go is one he learns to ignore",
    (await page.locator('.side-item[data-channel="general"] .cnt.inthread').count()) === 0);

  await movedLine.click();
  await page.waitForSelector(".threadpanel", { timeout: 15000 });
  await waitFor(page, id => {
    const l = document.querySelector(`.msgs .msg[data-msg="${id}"] .threadline`);
    return !!l && !l.classList.contains("has-new");
  }, unreadRootId, { timeout: 20000, what: "the New to stand down once the thread is opened" });
  ok("opening that thread takes the New off its replies line — he has seen it now",
    (await movedLine.getAttribute("data-thread-new")) === null &&
    !/\bnew\b/i.test((await movedLine.innerText()).replace(/\s+/g, " ")),
    (await movedLine.innerText()).replace(/\s+/g, " ").trim());
  await page.click(".threadpanel .threadclose");
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 10000 });

  /* ================= WHO IS TOLD ABOUT A REPLY IN A THREAD =================
   *
   * `threadReplyEvent` is the rule, and `window.cloud9Notify.threadRule` IS that
   * function — the same one the screen calls, not a copy this suite could agree
   * with while the app did something else. Asking it directly is how four
   * people's worth of staging is avoided for a rule that is four lines; the
   * REAL end-to-end halves are below (a real reply from Priya raises a real
   * toast) and at the foot of this file (the same reply in a MUTED room raises
   * nothing). Between them the rule and its wiring are both held. */
  const threadRule = await page.evaluate(() => {
    const base = {
      replyId: "m_reply", channelId: "c_room", authorId: "u_priya", authorName: "Priya",
      text: "still waiting on the architect", at: Date.now(),
      rootId: "m_root", rootAuthorId: "u_me", threadAuthorIds: [], mentions: [],
    };
    const me = { id: "u_me", agentIds: ["a_scout"] };
    const rule = window.cloud9Notify.threadRule;
    return {
      started: rule(base, me),
      replied: rule({ ...base, rootAuthorId: "u_sam", threadAuthorIds: ["u_dev", "u_me"] }, me),
      myAgentIsInIt: rule({ ...base, rootAuthorId: "a_scout" }, me),
      bystander: rule({ ...base, rootAuthorId: "u_sam", threadAuthorIds: ["u_dev"] }, me),
      hisOwnReply: rule({ ...base, authorId: "u_me" }, me),
      alsoMentionsHim: rule({ ...base, mentions: ["u_me"] }, me),
    };
  });
  const isReply = e => !!e && e.kind === "thread_reply" && e.subjectId === "m_reply";
  ok("somebody in a thread is told when it moves — whether he started it, replied in it, or his agent is in it",
    isReply(threadRule.started) && isReply(threadRule.replied) && isReply(threadRule.myAgentIsInIt) &&
    /your thread/.test(threadRule.started.title) &&
    /thread you are in/.test(threadRule.replied.title),
    `${threadRule.started.title} :: ${threadRule.replied.title}`);
  ok("a bystander is never told about a side conversation they are not in, and nor is he told about his own reply",
    threadRule.bystander === null && threadRule.hisOwnReply === null,
    `bystander=${JSON.stringify(threadRule.bystander)} own=${JSON.stringify(threadRule.hisOwnReply)}`);
  ok("a reply that also mentions him by name does not fire twice — one message, one interruption",
    threadRule.alsoMentionsHim === null,
    JSON.stringify(threadRule.alsoMentionsHim));

  // ---------- NOTIFICATIONS: the four events that interrupt him ----------
  //
  // Each raises ONE on-screen toast, through the single `decideNotification`
  // gate (packages/shared/src/notify.ts) fed by the engine's `notify-feed`
  // builders. These checks drive the REAL client pipeline — a real mention, a
  // real background job, a real quiet window — with nothing stubbed. Pop-ups
  // default OFF, so they are switched on through his OWN Settings screen and
  // switched back off at the end so the rest of the run sees the app as it was.
  {
    const goSettings = async () => {
      await page.click('.rail-btn[data-go="settings"]');
      await page.waitForSelector("#set-notify", { timeout: 15000 });
    };
    const backToGeneral = async () => {
      await page.click('.rail-btn[data-go="chat"]');
      await page.click(".sidebar >> text=# general");
      await page.waitForSelector(".composer textarea", { timeout: 15000 });
    };
    const notifyBox = () => page.locator('input.sw[aria-label="Tell me about new messages"]');
    const quietBox = () => page.locator('input.sw[aria-label="Quiet hours"]');

    // switch his notifications on — the real Settings toggle, not a back door
    await goSettings();
    if (!(await notifyBox().isChecked())) await notifyBox().click();
    await backToGeneral();

    // --- 1. a MENTION shows a toast, in plain words ---
    await fpage.click("text=# general");
    await fpage.fill(".composer textarea", "@Vikas notify-mention-alpha please");
    await fpage.press(".composer textarea", "Enter");
    await page.waitForSelector('.notify-toast[data-kind="mention"]', { timeout: 25000 });
    const mTitle = (await page.locator('.notify-toast[data-kind="mention"] .notify-title').first().innerText()).trim();
    const mText = (await page.locator('.notify-toast[data-kind="mention"] .notify-text').first().innerText()).trim();
    const mSubject = await page.locator('.notify-toast[data-kind="mention"]').first().getAttribute("data-subject");
    ok("a mention raises an on-screen toast, in plain words",
      /mentioned you/i.test(mTitle) && /notify-mention-alpha/.test(mText), `${mTitle} :: ${mText}`);
    await page.screenshot({ path: `${SHOTS}/notify-mention.png` });

    // --- 2. a DUPLICATE does not stack: another world update re-considers the
    //        same mention, and it must not mint a second toast for that subject ---
    await fpage.fill(".composer textarea", "just chatting, no one in particular");
    await fpage.press(".composer textarea", "Enter");
    await page.waitForTimeout(1200);   // let the plain line land and re-render
    const dupeCount = await page.locator(`.notify-toast[data-subject="${mSubject}"]`).count();
    ok("a duplicate does not stack — the same mention subject shows exactly one toast",
      dupeCount === 1, `toasts for that subject: ${dupeCount}`);

    // --- 3. his OWN action shows nothing: a line he sends, even one that @s
    //        himself, never becomes a toast for him ---
    await page.fill(".composer textarea", "@Vikas note-to-self-should-not-toast");
    await page.press(".composer textarea", "Enter");
    await page.waitForTimeout(1500);
    const selfToasts = await page.locator(".notify-toast .notify-text",
      { hasText: "note-to-self-should-not-toast" }).count();
    ok("his own action shows nothing — a line he sends never toasts him",
      selfToasts === 0, `self toasts: ${selfToasts}`);

    // --- 4. a finished JOB shows a toast with the right words ---
    //   Proven-deterministic terminal path (mirrors qa-v2): a throwaway
    //   approval-gated agent is delegated a job, and the job is REJECTED — which
    //   drives its Task straight to the terminal `cancelled` state without any
    //   wait on a model. A cancelled job is a finished job, and the toast says
    //   so. The throwaway agent is deleted afterwards so the rest of the run —
    //   which edits the FIRST sidebar agent, Scout — is left exactly as it was.
    await page.click('button[title="New agent"]');
    await page.fill('input[placeholder="Scout"]', "Ping");
    await page.fill("textarea.persona-input", "A throwaway agent for the notification test");
    await page.click('.toggle-row:has-text("Background work") input');   // require approval for !bg
    await page.click('.editor >> text=Create agent');
    await page.click('.rail-btn[data-go="chat"]');
    await page.waitForSelector(".sidebar >> text=Ping", { timeout: 20000 });
    await page.click(".sidebar >> text=# general");
    await page.selectOption(".chathead select", { label: "✨ Ping" }).catch(async () => {
      const opt = await page.$$eval(".chathead select option",
        os => os.find(o => o.textContent.includes("Ping"))?.value);
      await page.selectOption(".chathead select", opt);
    });
    await page.fill(".composer textarea", "@Ping !bg a job to reject");
    await page.press(".composer textarea", "Enter");
    await page.waitForSelector('.rail-btn[data-go="tasks"] .rail-count', { timeout: 90000 });
    await page.click('.rail-btn[data-go="tasks"]');
    await page.click('.taskrow button:has-text("Reject")');
    await page.waitForSelector('.notify-toast[data-kind="job_finished"]', { timeout: 30000 });
    const jTitle = (await page.locator('.notify-toast[data-kind="job_finished"] .notify-title').first().innerText()).trim();
    ok("a job finishing shows a toast with the right words",
      /finished a job|couldn.t finish a job|was cancelled/i.test(jTitle), jTitle);
    await page.screenshot({ path: `${SHOTS}/notify-job-finished.png` });
    // delete the throwaway agent so `.sidebar .agentrow` is Scout again
    await page.click('.rail-btn[data-go="chat"]');
    await page.hover('.sidebar .agentrow[data-agent="Ping"]');
    await page.click('.sidebar .agentrow[data-agent="Ping"] button[title="Edit agent"]');
    await page.waitForSelector(".editor", { timeout: 15000 });
    await page.click('.editor >> text=Delete agent');
    await page.click('.editor >> text=Yes, delete');
    await page.waitForSelector('.sidebar .agentrow[data-agent="Ping"]', { state: "detached", timeout: 15000 });
    await backToGeneral();

    /* --- 5. a REPLY IN HIS THREAD reaches him — the real wiring, not the rule.
     *
     * The rule itself is held above against `cloud9Notify.threadRule`. This is
     * the other question: does a real reply, typed by a real second person into
     * the real thread box, actually travel the whole way — hub, client, the one
     * `decideNotification` gate — and interrupt him. Without this, the muted
     * check at the foot of this file could pass because thread replies never
     * notify at all, which is silence for the wrong reason. */
    await page.fill(".composer textarea", "notify-thread-root: the shortlist as it stands");
    await page.press(".composer textarea", "Enter");
    const notifyRoot = page.locator('.msgs .msg:has-text("notify-thread-root")').last();
    await notifyRoot.waitFor({ timeout: 20000 });
    const notifyRootId = await notifyRoot.getAttribute("data-msg");
    await fpage.click("text=# general");
    await fpage.waitForSelector(`.msgs .msg[data-msg="${notifyRootId}"]`, { timeout: 20000 });
    const priyaNotifyRoot = fpage.locator(`.msgs .msg[data-msg="${notifyRootId}"]`);
    await priyaNotifyRoot.hover();
    await priyaNotifyRoot.locator(".ma.reply").click();
    await fpage.waitForSelector(".threadpanel", { timeout: 15000 });
    await fpage.fill(".threadcomposer textarea", "notify-thread-reply-alpha, one more thing");
    await fpage.press(".threadcomposer textarea", "Enter");
    await fpage.waitForSelector('.threadpanel .msg:has-text("notify-thread-reply-alpha")',
      { timeout: 20000 });
    await fpage.click(".threadpanel .threadclose");
    /* THE TOAST FOR THIS REPLY, not "the first thread toast on screen". Since
       2026-08-04 an agent's answer is a thread reply too, so an agent answering
       one of his messages raises a thread toast of its own — and `.first()`
       would eventually read that one and judge this check by it. Named by the
       words this reply carries. */
    const tToast = page.locator('.notify-toast[data-kind="thread_reply"]',
      { hasText: "notify-thread-reply-alpha" }).first();
    await tToast.waitFor({ timeout: 30000 });
    const tTitle = (await tToast.locator(".notify-title").innerText()).trim();
    const tText = (await tToast.locator(".notify-text").innerText()).trim();
    ok("a real reply in a thread he started interrupts him, and says whose thread it was",
      /replied in your thread/i.test(tTitle) && /notify-thread-reply-alpha/.test(tText),
      `${tTitle} :: ${tText}`);
    await page.screenshot({ path: `${SHOTS}/notify-thread-reply.png` });

    // --- 6. QUIET HOURS silence a toast: a window that covers right now ---
    const pad = n => String(n).padStart(2, "0");
    const hhmm = total => { const m = ((total % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    await goSettings();
    if (!(await quietBox().isChecked())) await quietBox().click();
    await page.fill('#set-quiet .quietrow .field-row:nth-child(1) input[type="time"]', hhmm(nowMin - 30));
    await page.fill('#set-quiet .quietrow .field-row:nth-child(2) input[type="time"]', hhmm(nowMin + 30));
    await backToGeneral();
    await fpage.fill(".composer textarea", "@Vikas notify-quiet-should-stay-silent");
    await fpage.press(".composer textarea", "Enter");
    await page.waitForTimeout(2500);
    const quietToasts = await page.locator(".notify-toast .notify-text",
      { hasText: "notify-quiet-should-stay-silent" }).count();
    ok("quiet hours silence the toast — nothing pops inside the window",
      quietToasts === 0, `toasts during quiet: ${quietToasts}`);
    await page.screenshot({ path: `${SHOTS}/notify-quiet.png` });

    // restore: quiet off, pop-ups off — leave the rest of the run untouched
    await goSettings();
    if (await quietBox().isChecked()) await quietBox().click();
    if (await notifyBox().isChecked()) await notifyBox().click();
    await backToGeneral();
  }

  // ---------- who may set an agent working ----------
  await page.hover(".sidebar .agentrow");
  await page.click('.sidebar .agentrow button[title="Edit agent"]');
  await page.waitForSelector(".whocanuse", { timeout: 15000 });
  const respondOptions = await page.$$eval(".respondpick", bs => bs.map(b => b.dataset.respond));
  const respondChosen = await page.$eval('.respondpick[aria-pressed="true"]', b => b.dataset.respond);
  ok("the agent editor asks who may use this agent, and starts closed",
    respondOptions.join(",") === "owner,allowlist,anyone" && respondChosen === "owner",
    `${respondOptions.join("/")} chosen=${respondChosen}`);

  await page.click('.respondpick[data-respond="allowlist"]');
  await page.waitForSelector(".allowpick .allowrow", { timeout: 10000 });
  ok("choosing “me and these people” offers the people to choose",
    (await page.locator('.allowpick .allowrow[data-person="Priya"]').count()) === 1);
  await page.evaluate(() => document.querySelector(".whocanuse")?.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/chat-agent-permission.png` });
  await page.click('.allowpick .allowrow[data-person="Priya"] input');
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector(".crew-grid", { timeout: 20000 });
  await page.locator('.cast[data-crew="Scout"] .whocan').filter({ hasText: "other person" })
    .waitFor({ timeout: 20000 });
  const crewSays = (await page.locator('.cast[data-crew="Scout"] .whocan').innerText()).replace(/\s+/g, " ");
  ok("the crew card says, in plain words, who may set this agent working",
    /1 other person/.test(crewSays), crewSays);
  await page.evaluate(() =>
    document.querySelector('.cast[data-crew="Scout"] .whocan')?.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/chat-crew-permission.png` });

  // put it back to owner-only, and prove the closed default is visible to the
  // person it shuts out
  await page.click('.cast[data-crew="Scout"] button:has-text("Edit")');
  await page.waitForSelector(".whocanuse", { timeout: 15000 });
  await page.click('.respondpick[data-respond="owner"]');
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector(".crew-grid", { timeout: 20000 });
  // the save has to ROUND-TRIP through the hub before the card can be believed —
  // reading the card the instant the screen appears reads the old answer
  await page.locator('.cast[data-crew="Scout"] .whocan').filter({ hasText: "Only you" })
    .waitFor({ timeout: 20000 });
  ok("the choice is saved on the agent and is there when you open it again",
    /Only you/.test((await page.locator('.cast[data-crew="Scout"] .whocan').innerText())),
    (await page.locator('.cast[data-crew="Scout"] .whocan').innerText()).replace(/\s+/g, " "));

  /* ================= THE REACH LADDER (capability-handoff.md 4.1-4.3) =======
   *
   * WHAT WAS WRONG. The engine grew a full ladder — from "just talk" up to
   * everything Claude Code and Codex can do on his PC — and the agent editor
   * still showed the same four checkboxes it always had. He said so himself:
   * "I told you last night." The switches that let an agent run a program on
   * his computer existed, were enforced, and were unreachable from any screen.
   *
   * Every number in these checks is read from `@cloud9/engine`, so the suite
   * cannot agree with a screen that has quietly drifted from the table.
   */
  await page.click('.rail-btn[data-go="crew"]');
  await page.waitForSelector(".crew-bar", { timeout: 15000 });
  await page.click('.cast[data-crew="Scout"] button:has-text("Edit")');
  await page.waitForSelector(".editor .reachladder", { timeout: 20000 });

  const rungs = await page.$$eval(".editor .reachrung", bs => bs.map(b => ({
    level: b.dataset.reach,
    label: b.querySelector(".rr-tx b")?.innerText.trim() ?? "",
    plain: b.querySelector(".rr-tx span")?.innerText.trim() ?? "",
    count: b.querySelector(".rr-count")?.innerText.trim() ?? "",
  })));
  ok("the agent editor leads with the whole ladder the engine offers, not four checkboxes",
    rungs.length === REACH_LEVELS.length &&
    rungs.every((r, i) => r.level === REACH_LEVELS[i].level && r.label === REACH_LEVELS[i].label),
    rungs.map(r => r.level).join(" → "));
  ok("every rung says in his words what it means for his computer",
    rungs.every((r, i) => r.plain === REACH_LEVELS[i].plainWords),
    rungs.find((r, i) => r.plain !== REACH_LEVELS[i].plainWords)?.level ?? "all match");
  ok("the top rung is offered as a thing he can pick, not hidden behind a warning",
    rungs[rungs.length - 1].level === "computer" &&
    /Everything this app can do on this computer/.test(rungs[rungs.length - 1].label),
    rungs[rungs.length - 1].label);

  const abilityRows = () => page.$$eval(".editor .abilitypick .toggle-row", rs => rs.map(r => ({
    ability: r.dataset.ability,
    label: r.querySelector(".tx b")?.innerText.trim() ?? "",
    on: r.querySelector("input")?.checked === true,
  })));
  /* Open the one-by-one list once, deliberately, and leave it open: it is his
     disclosure, and nothing in the ladder re-decides it under him. */
  const openSwitches = async () => {
    if ((await page.getAttribute(".editor .abilitypick", "data-open")) !== "yes") {
      await page.click(".editor .abilityshow");
    }
    await page.waitForSelector('.editor .abilitypick[data-open="yes"]', { timeout: 10000 });
  };
  await openSwitches();
  const rows = await abilityRows();
  ok("every power the engine's table owns has a switch on this screen, in the same order",
    rows.length === CAPABILITIES.length &&
    rows.every((r, i) => r.ability === CAPABILITIES[i].ability),
    `${rows.length} rows: ${rows.map(r => r.ability).join(", ")}`);
  ok("each switch is named in his words, never with a tool name",
    rows.every((r, i) => r.label.startsWith(CAPABILITIES[i].label)) &&
    !/Bash|PowerShell|WebFetch|MCP/.test(rows.map(r => r.label).join(" ")),
    rows.map(r => r.label).join(" | "));
  ok("the powers that change his machine or spend money are marked as asking first",
    CAPABILITIES.filter(c => c.alwaysAsk).every((c, _i) =>
      rows.find(r => r.ability === c.ability)?.label.includes("asks you first")) &&
    CAPABILITIES.filter(c => !c.alwaysAsk).every(c =>
      !rows.find(r => r.ability === c.ability)?.label.includes("asks you first")),
    rows.filter(r => r.label.includes("asks you first")).map(r => r.ability).join(", "));

  // ---- a rung really is a prefix of the table, in both directions ----
  await page.locator('.editor .reachrung[data-reach="computer"]').click();
  const atTop = await abilityRows();
  ok("picking the top rung really hands over every power the engine has",
    atTop.every(r => r.on) && atTop.length === CAPABILITIES.length,
    atTop.filter(r => !r.on).map(r => r.ability).join(", ") || "all on");
  ok("and the ladder then reads as the top rung",
    (await page.getAttribute(".editor .reachladder", "data-reach")) === "computer" &&
    (await page.locator('.editor .reachrung[data-reach="computer"]').getAttribute("aria-pressed")) === "true");
  /* HONESTY IN THE OTHER DIRECTION. Two of those powers are wired in the engine
     and inert until he can choose a folder list and a service, and there is
     nowhere to choose either yet. A switch that is ON and hands the agent
     nothing must say so, or it reads as broken and every other switch is
     doubted with it. */
  /* NO INERT ROWS LEFT AT ALL — and that is the fix, not a missing check.
     "Use connected services" left this list on 2026-08-03 and "Reach files
     outside its own folder" left it on 2026-08-04: both now have somewhere on
     screen to point, so neither is a switch that grants nothing. The notice is
     kept in the app for the next capability that needs it, so what is asserted
     is that it DRAWS NOTHING today — and, right below, that each of the two
     former inert rows really does have its own block instead. A check that
     still demanded an inert row would be demanding the bug back. */
  ok("no switch is on and granting nothing any more — the 'not doing anything yet' notice draws nothing at all",
    (await page.locator(".editor .inertswitch").count()) === 0 &&
    (await page.locator("[data-inert-row]").count()) === 0,
    `${await page.locator(".editor .inertswitch").count()} notice(s), ` +
    `${await page.locator("[data-inert-row]").count()} inert row(s)`);
  await page.screenshot({ path: `${SHOTS}/reach-top.png` });

  /* ======= THE FOLDERS, UNDER THE SWITCH THAT ALLOWS THEM ==================
   *
   * The other half of the line above: "Reach files outside its own folder" was
   * allowed by a switch and DELIVERED by a list of folders, and no screen ever
   * chose one. `wholeComputerRootsFor` (packages/engine/src/wholecomputer.ts) is
   * the ONE answer to "what does this agent really reach", and this block is
   * that answer on screen — the same function the engine host reads to build a
   * command line, so the screen cannot promise reach the CLI will not carry.
   *
   * Two of its states can be driven from a browser and are held here: the switch
   * ON with no folder chosen ("none"), and the refusal a window with no desktop
   * shell must give when asked to open the computer's folder picker. "ready",
   * "partly" and "gone" all need the shell to look at the disk and are NOT
   * claimed here — drive-app.mjs walks the installed app for those.
   */
  const rootWords = (await page.locator(".editor .wholecomputer").innerText()).replace(/\s+/g, " ");
  ok("with reach outside its own folder switched on and no folder chosen, the screen says the agent HAS none",
    (await page.locator('.editor .wholecomputer[data-roots-state="none"]').count()) === 1 &&
    (await page.locator(".editor .wholecomputer").getAttribute("data-roots-count")) === "0" &&
    /no folders chosen/i.test(rootWords) && !/In use/i.test(rootWords) &&
    (await page.locator(".editor .wholecomputer [data-roots-list]").count()) === 0 &&
    (await page.locator(".editor .wholecomputer li[data-root]").count()) === 0,
    rootWords.slice(0, 130));
  ok("and it offers the way to choose one, with nothing to forget while there is nothing chosen",
    (await page.locator(".editor .wholecomputer [data-roots-choose]").count()) === 1 &&
    (await page.locator(".editor .wholecomputer [data-roots-clear]").count()) === 0,
    (await page.locator(".editor .wholecomputer [data-roots-choose]").innerText()).trim());
  await page.click(".editor .wholecomputer [data-roots-choose]");
  await page.waitForSelector(".editor .wholecomputer [data-roots-refusal]", { timeout: 10000 });
  const rootRefusal = (await page.locator(".editor .wholecomputer [data-roots-refusal]").innerText())
    .replace(/\s+/g, " ").trim();
  ok("a window with no folder picker says which one can choose folders instead of pretending, and claims nothing new about reach",
    /installed Cloud9 app/i.test(rootRefusal) && !/^Error:/i.test(rootRefusal) &&
    (await page.locator('.editor .wholecomputer[data-roots-state="none"]').count()) === 1 &&
    (await page.locator(".editor .wholecomputer li[data-root][data-root-missing]").count()) === 0,
    rootRefusal.slice(0, 120));
  await page.locator(".editor .wholecomputer").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/wholecomputer-none.png` });

  /* ======= THE CONNECTIONS FILE, UNDER THE SWITCH THAT ALLOWS IT ============
   *
   * Feature 5, part B. "Use connected services" has been wired at the command
   * line since 2026-07-30 and no screen ever chose a file, so the switch was on,
   * allowed, approved — and handing the agent nothing. `connectionsFileFor`
   * (packages/engine/src/connections.ts) is now the ONE answer to "what does
   * this agent really have", and this block is that answer on screen.
   *
   * Two of its four states can be driven from a browser and are held here: the
   * switch ON with nothing chosen ("none"), and the switch OFF with nothing
   * remembered (silence, because there is nothing honest to say). "ready" and
   * "gone" both need the desktop shell to look at the disk, so they are NOT
   * claimed here — see the remembered-file check at the end of this file for
   * what a window with no shell says instead, and drive-app.mjs for the app.
   */
  const connWords = (await page.locator(".editor .connfile").innerText()).replace(/\s+/g, " ");
  ok("with connected services switched on and no file chosen, the screen says the agent HAS none",
    (await page.locator('.editor .connfile[data-conn-state="none"]').count()) === 1 &&
    /no connections/i.test(connWords) && !/In use/i.test(connWords) &&
    /never will|not using your own connected accounts/i.test(connWords) &&
    (await page.locator(".editor .connfile [data-conn-path]").count()) === 0,
    connWords.slice(0, 130));
  /* The way in is offered — and a window that cannot open the computer's own
     file picker says WHICH window can, rather than a dead button or a pretend
     one. (The QA browser has no desktop shell, which is exactly this case.) */
  await page.click(".editor .connfile [data-conn-choose]");
  await page.waitForSelector(".editor .connfile [data-conn-refusal]", { timeout: 10000 });
  const connRefusal = (await page.locator(".editor .connfile [data-conn-refusal]").innerText())
    .replace(/\s+/g, " ").trim();
  ok("choosing is offered, and a window with no file picker says which one can instead of pretending",
    /installed Cloud9 app/i.test(connRefusal) && !/^Error:/i.test(connRefusal) &&
    (await page.locator('.editor .connfile[data-conn-state="none"]').count()) === 1,
    connRefusal.slice(0, 120));
  await page.screenshot({ path: `${SHOTS}/connections-none.png` });

  // ---- what will ask first, and that it is NOT something he can clear ----
  const asksList = () => page.$$eval(".editor .willask li", ls => ls.map(l => l.dataset.ask));
  const shownAsks = await asksList();
  ok("with the top rung on, the screen names exactly the powers that will stop and ask him",
    JSON.stringify(shownAsks) ===
      JSON.stringify(CAPABILITIES.filter(c => c.alwaysAsk).map(c => c.label)),
    shownAsks.join(" / "));
  ok("and those are stated, never offered as switches he could clear",
    (await page.locator(".editor .willask input").count()) === 0 &&
    /not switches/i.test(await page.locator(".editor .willask .wa-note").innerText()));
  ok("the two approvals that really are his choice stay editable",
    (await page.locator(".editor .asksec .panelbox .toggle-row input").count()) === 2);
  await page.locator(".editor .willask").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/reach-asks.png` });

  await page.locator('.editor .reachrung[data-reach="talk"]').click();
  const atBottom = await abilityRows();
  ok("and with nothing switched on, nothing claims to be inert either",
    (await page.locator(".editor .inertswitch").count()) === 0);
  /* The fourth honest state is SILENCE: connected services off and no file ever
     chosen means there is nothing true to say, so the block says nothing rather
     than a reassuring sentence about a switch he has not touched. */
  ok("with connected services off and no file remembered, the connections block says nothing at all",
    (await page.locator(".editor .connfile").count()) === 0);
  /* Its twin, and the same law: reach outside its own folder off with no folder
     ever chosen has nothing true to say either. Held here because the folder
     block is new — the connections block earned this check by getting it wrong
     first, and a new block that repeats the mistake would otherwise ship. */
  ok("with reach outside its own folder off and no folder remembered, the folders block says nothing at all",
    (await page.locator(".editor .wholecomputer").count()) === 0);
  ok("picking the bottom rung takes every one of them back",
    atBottom.every(r => !r.on),
    atBottom.filter(r => r.on).map(r => r.ability).join(", ") || "all off");
  ok("and nothing then claims it will ask him about anything",
    (await page.locator(".editor .willask").count()) === 0);

  /* ================= THE LADDER MAY NOT CONTRADICT THE SWITCHES =============
   *
   * Phase 6's one Major (UI-1), on the feature Vikas named himself. Switching on
   * "Look things up on the web" and "Work on jobs in the background" left the
   * ladder's dot on "Just talk — No tools at all", forty pixels above two
   * switches saying the opposite: the screen asked the engine for the highest
   * rung those two FULLY COVER (truthfully, the empty one) and then drew that
   * answer as HIS CHOICE.
   *
   * The switches are the truth — they are what the engine reads to build a
   * command line — and the ladder is now derived from them by EXACT match only.
   * So there are exactly two honest outcomes, and both are checked here: the
   * switches are a rung, or the switches are his own mixture and no rung is
   * drawn as chosen at all. The pair below is the reported case, key for key.
   */
  await page.locator('.editor .reachrung[data-reach="talk"]').click();
  await openSwitches();
  await page.locator('.editor .toggle-row[data-ability="webSearch"] input').check();
  await page.locator('.editor .toggle-row[data-ability="background"] input').check();
  const mixState = await page.evaluate(() => ({
    ladder: document.querySelector(".editor .reachladder").dataset.reach,
    pressed: [...document.querySelectorAll('.editor .reachrung[aria-pressed="true"]')]
      .map(b => b.dataset.reach),
    inked: [...document.querySelectorAll('.editor .reachrung[data-within="yes"]')]
      .map(b => b.dataset.reach),
    banner: (document.querySelector(".editor .reachmixed")?.innerText ?? "").replace(/\s+/g, " "),
    on: [...document.querySelectorAll(".editor .abilitypick input")].filter(i => i.checked).length,
  }));
  ok("TWO ABILITIES ON: no rung claims to be his choice — the dot is off “Just talk” entirely",
    mixState.on === 2 && mixState.ladder === "mixture" &&
    mixState.pressed.length === 0 && mixState.inked.length === 0,
    JSON.stringify(mixState));
  ok("and the screen says his own mixture, names what is really on, and names NO rung",
    /Your own mixture/.test(mixState.banner) &&
    /2 abilities of 8 switched on/.test(mixState.banner) &&
    /Look things up on the web/.test(mixState.banner) &&
    /Work on jobs in the background/.test(mixState.banner) &&
    !REACH_LEVELS.some(r => mixState.banner.includes(r.label)),
    mixState.banner.slice(0, 170));
  await page.locator(".editor .reachsec").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/reach-mixture-light.png` });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/reach-mixture-dark.png` });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  /* ONE FACT, TWO VIEWS. Every rung, picked, must read back as exactly itself —
     the other half of "no combination can produce a rung that contradicts the
     switches", checked in the direction a person actually uses. */
  const rungRoundTrip = [];
  for (const level of REACH_LEVELS.map(r => r.level)) {
    await page.locator(`.editor .reachrung[data-reach="${level}"]`).click();
    rungRoundTrip.push(await page.evaluate(() => ({
      ladder: document.querySelector(".editor .reachladder").dataset.reach,
      pressed: [...document.querySelectorAll('.editor .reachrung[aria-pressed="true"]')]
        .map(b => b.dataset.reach),
      mixture: document.querySelectorAll(".editor .reachmixed").length,
      on: [...document.querySelectorAll(".editor .abilitypick input")].filter(i => i.checked).length,
    })));
  }
  ok("every rung, picked, reads back as exactly itself — and nothing then calls it a mixture",
    rungRoundTrip.every((s, i) => s.ladder === REACH_LEVELS[i].level &&
      s.pressed.length === 1 && s.pressed[0] === REACH_LEVELS[i].level &&
      s.mixture === 0 && s.on === REACH_LEVELS[i].rows),
    JSON.stringify(rungRoundTrip));

  // ---- a hand-picked mix is never rounded, in either direction ----
  await page.locator('.editor .reachrung[data-reach="look"]').click();
  await openSwitches();
  await page.locator('.editor .toggle-row[data-ability="commands"] input').check();
  ok("a mix that adds a power without the rungs beneath it is not reported as a rung at all",
    (await page.getAttribute(".editor .reachladder", "data-reach")) === "mixture" &&
    (await page.locator('.editor .reachrung[aria-pressed="true"]').count()) === 0,
    `reads as ${await page.getAttribute(".editor .reachladder", "data-reach")}`);
  ok("and it is described by what is switched on, never by the rung it merely covers",
    (await page.locator(".editor .reachmixed").count()) === 1 &&
    !/Look things up and keep notes/.test(await page.locator(".editor .reachmixed").innerText()) &&
    /Run programs on this computer/.test(await page.locator(".editor .reachmixed").innerText()),
    (await page.locator(".editor .reachmixed").innerText()).replace(/\s+/g, " "));
  ok("switching one power on is enough to make the screen promise he will be asked",
    (await asksList()).includes("Run programs on this computer"),
    (await asksList()).join(" / "));
  await page.locator(".editor .reachladder").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/reach-ladder.png` });

  /* ---- the honest report: how high the switches go, and whether they hold ---- */
  const claudeIso = isolationFor("claude");
  const codexIso = isolationFor("codex");
  ok("the screen says how high these switches GO, not only what they keep out",
    (await page.locator('.editor .harnesshonest [data-field="ceiling"]').innerText()).trim()
      === claudeIso.ceiling,
    (await page.locator('.editor .harnesshonest [data-field="ceiling"]').innerText()).trim().slice(0, 70));
  ok("a Claude agent is told the switches really are the whole boundary",
    (await page.getAttribute(".editor .harnesshonest", "data-boundary")) === "yes" &&
    (await page.locator('.editor .harnesshonest [data-field="headline"]').innerText()).trim()
      === claudeIso.headline);
  await page.locator(".editor .harnesshonest").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/reach-honest-claude.png` });

  await page.click('.editor .app-pick[data-app="codex"]');
  await page.waitForSelector('.editor .harnesshonest[data-boundary="no"]', { timeout: 10000 });
  ok("and a Codex agent is NOT — the same screen refuses to tell him the same story twice",
    (await page.locator('.editor .harnesshonest [data-field="headline"]').innerText()).trim()
      === codexIso.headline,
    (await page.locator('.editor .harnesshonest [data-field="headline"]').innerText()).trim().slice(0, 70));
  ok("it says instead what those switches DO control on Codex",
    new RegExp(codexIso.togglesControl.split(":")[0]).test(
      await page.locator('.editor .harnesshonest [data-field="controls"]').innerText()));
  await page.locator(".editor .harnesshonest .hh-more summary").click();
  ok("everything Codex keeps hold of anyway is named, one line each",
    (await page.locator(".editor .honestleaks li").count()) === codexIso.stillLoaded.length,
    `${await page.locator(".editor .honestleaks li").count()} of ${codexIso.stillLoaded.length}`);
  ok("and what we looked at and could not settle is kept apart from it, under its own heading",
    (await page.locator(".editor .honestunknowns li").count()) === codexIso.unknowns.length &&
    /could not tell/i.test(await page.locator(".editor .harnesshonest .hh-more").innerText()),
    `${await page.locator(".editor .honestunknowns li").count()} unknown(s)`);
  /* textContent, not innerText: the line is set in small caps by the stylesheet
     and innerText hands back what the CSS did, not what the engine said. */
  ok("the report carries the version and date it was measured on, so a stale claim shows",
    (await page.locator(".editor .hh-measured").textContent()).includes(codexIso.measuredOn),
    (await page.locator(".editor .hh-measured").textContent()).trim());
  await page.locator(".editor .harnesshonest").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/reach-honest-codex.png` });

  /* WHAT A HAND-MADE AGENT'S EDITOR OFFERS — held for the comparison below.
     Nothing typed here is saved: the editor is left with Cancel. */
  const handMadeOffers = await editorOffers(page);
  ok("a hand-written agent's file offers the ladder, the switches, who may use it, and skills",
    handMadeOffers.rungs.length === REACH_LEVELS.length &&
    handMadeOffers.abilities.length === CAPABILITIES.length &&
    handMadeOffers.skillsEditor === 1 && handMadeOffers.honestReport === 1,
    JSON.stringify(handMadeOffers.sections));

  /* ABSENT MEANS ABSENT, IN THE LIBRARY TOO.
     Nobody knows what role a hand-written agent is, because an agent does not
     remember one — so the library must not tell it that anything was "written
     for this role", and must not offer a shelf it cannot fill. The ordering
     falls back to the library's own, which is a sensible default, not an
     error. */
  await page.click(".editor .skills .skill-library-open");
  await page.waitForSelector(".librarypanel .libskill", { timeout: 15000 });
  ok("an agent whose role nobody knows is not told a role it does not have",
    (await page.locator(".librarypanel .ls-forrole").count()) === 0 &&
    (await page.locator('.librarypanel .libseg button[data-shelf="suggested"]').count()) === 0 &&
    (await page.locator(".librarypanel .libskill").count()) === SKILL_LIBRARY.length,
    `${await page.locator(".librarypanel .libskill").count()} skills, no role claimed`);
  await page.click(".librarypanel .librarydone");
  await page.waitForSelector(".librarypanel", { state: "detached", timeout: 10000 });

  await page.click(".editor .topbar >> text=Cancel");
  await page.waitForSelector(".crew-grid", { timeout: 20000 });

  /* ================= THE CASTING ROOM (the marketplace) =====================
   *
   * A catalogue that ships INSIDE the app: no server, no download. The things
   * that make it a product rather than a list — you can get to it from where
   * you already go to add an agent, the brief is real, a role looks like a
   * person, and what you hire is an ordinary agent in every respect — are each
   * checked, and hiring is done for real, against the hub.
   */
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".sidebar", { timeout: 15000 });
  ok("the casting room is reachable from where he already goes to add an agent",
    (await page.locator(".sidebar .side-head .browsebtn.tomarket").count()) === 1,
    (await page.getAttribute(".sidebar .side-head .browsebtn.tomarket", "aria-label")) ?? "");
  ok("and nothing on screen calls it a hiring hall any more",
    !/hiring hall/i.test(await page.locator("body").innerText()),
    (await page.getAttribute(".sidebar .side-head .browsebtn.tomarket", "aria-label")) ?? "");
  await page.click('.rail-btn[data-go="crew"]');
  await page.waitForSelector(".crew-bar", { timeout: 15000 });
  ok("and from the crew screen",
    (await page.locator(".crew-bar .tomarket").count()) === 1 &&
    /casting room/i.test(await page.locator(".crew-bar .tomarket").innerText()),
    (await page.locator(".crew-bar .tomarket").innerText()).trim());
  await page.click(".crew-bar .tomarket");
  await page.waitForSelector(".market .cast.role", { timeout: 15000 });

  const roles = await page.$$eval(".market .cast.role", cards => cards.map(c => ({
    id: c.dataset.role,
    title: c.querySelector("h3")?.innerText.trim() ?? "",
    tagline: c.querySelector(".role")?.innerText.trim() ?? "",
    asks: c.querySelectorAll(".roleasks li").length,
    app: c.querySelector(".runs .chip")?.innerText.trim() ?? "",
  })));
  const wantedRoles = ["architect", "backend", "frontend", "qa", "security", "devops", "reviewer", "writer"];
  ok("the software roles he asked for are all in the catalogue",
    wantedRoles.every(r => roles.some(c => c.id === `sw-${r}`)),
    roles.map(r => r.id).join(", "));
  ok("every role says what it is for, what to ask it, and which app suits it",
    roles.length >= 8 && roles.every(r => r.title && r.tagline.length > 20 && r.asks >= 3
      && /^Suggested: (Claude|Codex)$/.test(r.app)),
    JSON.stringify(roles.find(r => !r.title || r.tagline.length <= 20 || r.asks < 3) ?? "all complete"));
  ok("the catalogue is grouped by category, so a second category is data and not a redesign",
    (await page.locator('.market .marketgroup[data-group="software"]').count()) === 1 &&
    (await page.locator('.market .seg button[data-cat]').count()) >= 1);
  /* A ROLE LOOKS LIKE A PERSON. Static emoji was a placeholder that never
     became anybody; a role now wears the same drawn-from-the-name portrait an
     agent gets, on the same square plate, so the picture he chooses by is the
     picture his crew shows him afterwards. */
  ok("every role in the catalogue wears a drawn portrait, and no emoji face is left",
    (await page.locator(".market .cast.role .plate.roleplate .portrait svg").count()) === roles.length &&
    (await page.locator(".market .roleface").count()) === 0,
    `${await page.locator(".market .cast.role .plate.roleplate .portrait svg").count()} portraits`);
  const hallFace = await portraitOf(page,
    '.market .cast.role[data-role="sw-architect"] .roleplate .portrait svg');
  await page.screenshot({ path: `${SHOTS}/hall-roles.png` });
  await page.screenshot({ path: `${SHOTS}/market-hall.png` });

  // the brief itself — the product, not filler
  await page.click('.market .cast.role[data-role="sw-architect"] .rolesee');
  await page.waitForSelector(".hirepanel", { timeout: 15000 });
  const brief = (await page.locator(".hirepanel .briefbox").innerText()).trim();
  ok("the brief he is hiring is shown in full, in the agent's own words",
    brief.length > 400 && /^You are my software architect/.test(brief),
    `${brief.length} characters`);
  ok("the panel says what the hire may touch, and that it stops and asks first",
    (await page.locator(".hirepanel .abilitywords .chip").count()) >= 1 &&
    /asks you first/i.test(await page.locator(".hirepanel .abilitywords .ab-note").first().innerText()));
  ok("a hire answers only its owner, the same default a hand-written agent gets",
    /Just you/.test(await page.locator(".hirepanel .field-row:has-text('Who can set them working')").innerText()));
  ok("he picks which app runs it, and from his app's real model list",
    (await page.locator(".hirepanel .hireapp").count()) === 1 &&
    (await page.locator(".hirepanel .hiremodel option").count()) >= 1,
    `${await page.locator(".hirepanel .hiremodel option").count()} models offered`);
  ok("the panel he hires from wears the face the agent will really be hired with",
    (await page.locator(".hirepanel .hireface .portrait svg").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/market-brief.png` });
  await page.screenshot({ path: `${SHOTS}/hall-brief.png` });

  /* ---- ESCAPE CLOSES WHAT IT OPENED (Phase 6, UI-2) ----
     This brief ignored Escape while the Ctrl-K palette obeyed it, because every
     overlay answered the key its own way — six overlays, five answers. There is
     one owner now: an overlay registers its close on a stack and one listener
     calls the top of it, so this is checked as behaviour AND as mechanism. The
     click first is deliberate: the old handler depended on where the focus was,
     and this one must not. */
  await page.click(".hirepanel .briefbox");
  ok("an overlay on screen has put its close on the one Escape owner's stack",
    (await page.evaluate(() => window.cloud9Escape.stacked())) === 1,
    `${await page.evaluate(() => window.cloud9Escape.stacked())} on the stack`);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".hirepanel", { state: "detached", timeout: 10000 });
  ok("ESCAPE CLOSES THE CASTING-ROOM BRIEF, the same as it closes the quick-chat palette",
    (await page.locator(".hirepanel").count()) === 0 &&
    (await page.evaluate(() => window.cloud9Escape.stacked())) === 0 &&
    (await page.locator(".market .cast.role").count()) >= 8,
    "brief closed, stack empty, the casting room still behind it");
  /* And the palette itself, in the same run and through the same owner — the
     control case that made UI-2 a consistency bug rather than a one-off. */
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".qc-input", { timeout: 10000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".qc-input", { state: "detached", timeout: 10000 });
  ok("and the quick-chat palette still closes on Escape now that it goes through that owner too",
    (await page.locator(".qc-input").count()) === 0 &&
    (await page.evaluate(() => window.cloud9Escape.stacked())) === 0);

  /* ---- WHERE A COUNT MEETS A WORD (Phase 6, minor) ----
     "1 CATEGORIES" was a plural label typed by hand beside a number that came
     from a list. One owner pluralises now, and a stat tile has to be given both
     forms of its word — so the singular case and the plural case are read off
     the SAME header here, and a sweep says no visible line prints "1 <word>s". */
  const tiles = await page.$$eval(".market .crew-stats .stat", ts => ts.map(t => ({
    n: Number(t.querySelector(".n").innerText.trim()),
    label: t.querySelector(".l").innerText.trim(),
  })));
  ok("a count of one takes the singular word — “1 Category”, never “1 CATEGORIES”",
    tiles.some(t => t.n === 1 && /^Category$/i.test(t.label)) &&
    !tiles.some(t => t.n === 1 && /ies$|s$/i.test(t.label)),
    JSON.stringify(tiles));
  ok("and a count of many still takes the plural, from that same one owner",
    tiles.some(t => t.n > 1 && /^Roles ready$/i.test(t.label)),
    JSON.stringify(tiles));
  const singularSlips = await page.evaluate(() => {
    const text = document.querySelector(".market").innerText.replace(/\s+/g, " ");
    // a "1" followed by a word ending in s — the shape of the bug, anywhere on screen
    return [...text.matchAll(/\b1 ([a-z]+(?:ies|s))\b/gi)].map(m => m[0]);
  });
  ok("and no line anywhere on this screen prints a plural word on a count of one",
    singularSlips.length === 0, singularSlips.join(" | ") || "none");
  await page.screenshot({ path: `${SHOTS}/count-one-category.png` });

  // back into the brief, and on with the hire
  await page.click('.market .cast.role[data-role="sw-architect"] .rolesee');
  await page.waitForSelector(".hirepanel", { timeout: 15000 });

  // hire it, for real, on Codex — and prove what landed
  await page.selectOption(".hirepanel .hireapp", "codex");
  const hireModel = await page.locator(".hirepanel .hiremodel").inputValue();
  await page.click(".hirepanel .hirebtn");
  /* HIS COMPLAINT, AND THE FIX FOR IT. He hired the Architect and reported it
     had no tool permissions, no files folder and no skills. All three were
     there — one click away, behind a note on the crew screen telling him to
     press Edit, which he had no reason to do. A role he has just taken on now
     opens ITS OWN FILE, so everything a hand-written agent has is the first
     thing he sees rather than something he has to go and find. */
  await page.waitForSelector(".editor .reachladder", { timeout: 25000 });
  ok("hiring opens the new agent's own file, instead of telling him to go and press Edit",
    (await page.locator('.editor .hirednote[data-hired="Architect"]').count()) === 1 &&
    (await page.locator(".editor .topbar h2").innerText()).trim() === "Architect",
    (await page.locator(".editor .hirednote").innerText()).replace(/\s+/g, " ").slice(0, 80));

  const hiredOffers = await editorOffers(page);
  ok("A HIRED AGENT'S FILE OFFERS EXACTLY WHAT A HAND-WRITTEN ONE'S DOES — nothing less",
    JSON.stringify(hiredOffers) === JSON.stringify(handMadeOffers),
    JSON.stringify(hiredOffers) === JSON.stringify(handMadeOffers)
      ? `${hiredOffers.sections.length} sections, ${hiredOffers.rungs.length} rungs, ` +
        `${hiredOffers.abilities.length} switches, skills editor present`
      : `hired ${JSON.stringify(hiredOffers)} vs hand-made ${JSON.stringify(handMadeOffers)}`);
  await openSwitches();
  ok("and the three he could not find are each on that screen, by name",
    (await page.locator('.editor .toggle-row[data-ability="files"]').count()) === 1 &&
    (await page.locator(".editor .abilitypick .toggle-row").count()) === CAPABILITIES.length &&
    (await page.locator(".editor .skills").count()) === 1);
  /* THIS ROLE WAS HIRED ON CODEX (see the app picker above), and Codex cannot
     give up its web, file, helper-agent and command tools. Every Codex agent
     Vikas had saved with those switches off refused to run, for good. So the
     app no longer offers an off that would not happen: those switches read ON
     and LOCKED, with the reason on the row. Nothing else is switched on for
     him — "reach files outside its own folder" is still his to give. */
  /* A HIRED ROLE IS EXACTLY AS POWERFUL AS A HAND-WRITTEN ONE — no more, and
     since 2026-08-05 no LESS either.

     This check used to name two switches and demand they be off. That was the
     old default talking: a new agent started on a subset, and every agent Vikas
     made opened by telling him what it could not do. Every agent now starts with
     the whole working set (`NEW_AGENT_ABILITIES`, derived from the capability
     table), and the guard that makes that safe is the approval card, not a
     switch left off. So the question this asks has changed shape: a hire must
     match what a hand-written agent gets, switch for switch, read from the
     table — never a list typed here that can quietly stop being true. */
  const hiredSwitches = {};
  for (const cap of CAPABILITIES) {
    hiredSwitches[cap.ability] =
      await page.locator(`.editor .toggle-row[data-ability="${cap.ability}"] input`).isChecked();
  }
  const shouldBeOn = a => NEW_AGENT_ABILITIES[a] === true
    // this role was hired on Codex, which cannot give up four of them
    || CAPABILITIES.some(c => c.ability === a && (c.codexUnavoidableTools?.length ?? 0) > 0);
  ok("a hired role starts exactly as a hand-written agent does, plus what its brief asked for",
    CAPABILITIES.every(c => hiredSwitches[c.ability] === shouldBeOn(c.ability)),
    `${JSON.stringify(hiredSwitches)} vs new-agent default ${JSON.stringify(NEW_AGENT_ABILITIES)}`);
  ok("and the one thing nobody but him can supply is still left for him to choose",
    capabilitiesForNewAgent().length === CAPABILITIES.length - 1 &&
    hiredSwitches.connections === false,
    `connections reads ${hiredSwitches.connections}`);
  ok("the switches Codex cannot give up are shown on, locked, and say why — never a false off",
    (await page.locator('.editor .toggle-row[data-ability="commands"] input').isChecked()) === true &&
    (await page.locator('.editor .toggle-row[data-ability="commands"] input').isDisabled()) === true &&
    (await page.locator('.editor .toggle-row[data-ability="helpers"] input').isChecked()) === true &&
    (await page.locator(".editor .reachforced").count()) === 1 &&
    (await page.locator('.editor .harnesshonest .hh-forced').count()) === 1,
    (await page.locator(".editor .reachforced").innerText()).replace(/\s+/g, " ").slice(0, 90));
  const hiredPersona = await page.locator(".editor .persona-input").inputValue();
  ok("the brief really was copied onto the agent, word for word",
    hiredPersona.trim() === brief, `${hiredPersona.length} characters on the agent`);
  ok("the model he picked was saved on the agent too",
    (await page.locator(".editor .modelpick").inputValue()) === hireModel,
    `${await page.locator(".editor .modelpick").inputValue()} (picked ${hireModel})`);
  const editorFace = await portraitOf(page, ".editor .preview-card .plate .portrait svg");
  ok("the face on the role card is the face the agent now wears — the same drawing",
    editorFace === hallFace);
  await page.screenshot({ path: `${SHOTS}/hall-hired-editor.png` });
  await page.locator(".editor .reachladder").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/hall-hired-reach.png` });

  /* ================= THE SKILL LIBRARY ======================================
   *
   * Fifteen researched skills shipped inside the app, on the shelves the
   * library itself names. What these checks hold shut, in order: he can find
   * it, he can see everything on it grouped the way the contract groups it, he
   * can read the whole procedure and where it came from BEFORE he takes it,
   * and — the one that matters most — a skill he takes is an ORDINARY skill.
   *
   * That last one is the mistake this must not repeat. He hired a role once
   * and found it second-class: no tool permissions, no files folder, no
   * skills. A skill off a shelf gets no badge, no read-only mark and no second
   * code path; it lands in the same list, under the same pencil and the same
   * bin, and it is proved here by editing it and deleting it like any other.
   */
  const LIB_ROLE = "sw-architect"; // the role just hired, above
  const forThisRole = SKILL_LIBRARY.filter(s => s.recommendedFor.includes(LIB_ROLE));
  const shelfWithMost = SKILL_CATEGORIES
    .map(c => ({ c, n: SKILL_LIBRARY.filter(s => s.category === c.id).length }))
    .sort((a, b) => b.n - a.n)[0];

  ok("the skill library is reachable from the skills section of an agent's own file",
    (await page.locator(".editor .skills .skill-library-open").count()) === 1,
    (await page.locator(".editor .skills .skill-library-open").innerText()).trim());

  await page.click(".editor .skills .skill-library-open");
  await page.waitForSelector(".librarypanel .libskill", { timeout: 15000 });
  const shelvesOnScreen = await page.$$eval(".librarypanel .libgroup", gs => gs.map(g => ({
    id: g.dataset.libgroup,
    heading: g.querySelector("h5")?.innerText.trim() ?? "",
    blurb: g.querySelector("p")?.innerText.trim() ?? "",
    cards: g.querySelectorAll(".libskill").length,
  })));
  ok("every skill it ships with is on screen, grouped on the shelves the library itself names",
    (await page.locator(".librarypanel .libskill").count()) === SKILL_LIBRARY.length &&
    shelvesOnScreen.length === SKILL_CATEGORIES.length &&
    shelvesOnScreen.every((g, i) => g.id === SKILL_CATEGORIES[i].id
      && g.heading === SKILL_CATEGORIES[i].label
      && g.blurb === SKILL_CATEGORIES[i].blurb
      && g.cards === SKILL_LIBRARY.filter(s => s.category === g.id).length),
    `${SKILL_LIBRARY.length} skills on ${shelvesOnScreen.length} shelves: ` +
    shelvesOnScreen.map(g => `${g.heading} (${g.cards})`).join(", "));

  const cardsOnScreen = await page.$$eval(".librarypanel .libskill", cs => cs.map(c => ({
    id: c.dataset.libskill,
    name: c.querySelector("h4")?.innerText.trim() ?? "",
    desc: c.querySelector(".ls-desc")?.innerText.trim() ?? "",
    source: c.querySelector(".ls-source")?.innerText.trim() ?? "",
  })));
  ok("each one says in plain words when it helps, and names where the procedure came from",
    cardsOnScreen.length === SKILL_LIBRARY.length &&
    cardsOnScreen.every(c => {
      const real = SKILL_LIBRARY.find(s => s.id === c.id);
      return real && c.name === real.name && c.desc === real.description
        && c.source.includes(real.source);
    }),
    cardsOnScreen.find(c => {
      const real = SKILL_LIBRARY.find(s => s.id === c.id);
      return !real || c.desc !== real.description || !c.source.includes(real.source);
    })?.id ?? "all fifteen carry their own words and their own source");

  /* THE PRODUCT IS THE PROCEDURE. He must be able to read the whole of what the
     agent will be told, before he hands it over — not a summary of it. */
  const readMe = SKILL_LIBRARY[0];
  await page.click(`.librarypanel .libskill[data-libskill="${readMe.id}"] .ls-read`);
  await page.waitForSelector(`.librarypanel [data-libinstructions="${readMe.id}"]`, { timeout: 10000 });
  const onScreenInstructions =
    await page.locator(`.librarypanel [data-libinstructions="${readMe.id}"]`).innerText();
  ok("the whole procedure can be read before it is taken, word for word",
    onScreenInstructions.replace(/\s+/g, " ").trim()
      === readMe.instructions.replace(/\s+/g, " ").trim(),
    `${onScreenInstructions.length} characters of “${readMe.name}”`);

  ok("the library says which of its skills were written for the role he just hired",
    (await page.locator(".librarypanel .ls-forrole").count()) === forThisRole.length &&
    forThisRole.length > 0 && forThisRole.length < SKILL_LIBRARY.length &&
    (await page.locator(`.librarypanel .libskill[data-libskill="${forThisRole[0].id}"] .ls-forrole`)
      .count()) === 1,
    `${await page.locator(".librarypanel .ls-forrole").count()} of ${SKILL_LIBRARY.length} written for ${LIB_ROLE}`);

  ok("it says how much room is left BEFORE he picks, not after he is refused",
    new RegExp(`0 of ${SKILL_LIMITS.perAgent} taught`).test(
      await page.locator(".librarypanel .libroom").innerText()),
    (await page.locator(".librarypanel .libroom").innerText()).trim());

  /* NOTHING NOBODY MEASURED. No stars, no downloads, no "popular", no green
     tick on a skill nobody has scored — absent means absent (law 8). */
  const libraryWords = await page.locator(".librarypanel").innerText();
  ok("nothing in the library shows a rating, a popularity or a count nobody has measured",
    /* "review" is the NAME of three of these skills, so the words hunted for
       here are only the ones that would claim a measurement nobody took. */
    !/★|⭐|\bstars?\b|\bratings?\b|\bpopular\b|\btrending\b|\bbest[- ]sell|\d[\d,.]*\s*(downloads|installs|uses|users|people)\b/i
      .test(libraryWords),
    `${libraryWords.length} characters read`);

  await page.screenshot({ path: `${SHOTS}/library-reading.png` });
  // fold it away again, so the shelves are shot in the state he first meets
  await page.click(`.librarypanel .libskill[data-libskill="${readMe.id}"] .ls-read`);
  await page.waitForSelector(`.librarypanel [data-libinstructions="${readMe.id}"]`,
    { state: "detached", timeout: 10000 });
  /* `animations: "disabled"` matters here and not by habit: the buttons carry a
     .15s background transition, so a shot taken the instant the theme flips
     catches every one of them half-way between the two looks and they read as
     disabled. This runs them to their end first. */
  await page.screenshot({ path: `${SHOTS}/library-light.png`, animations: "disabled" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.screenshot({ path: `${SHOTS}/library-dark.png`, animations: "disabled" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  await page.click(`.librarypanel .libseg button[data-shelf="${shelfWithMost.c.id}"]`);
  await waitFor(page,
    n => document.querySelectorAll(".librarypanel .libskill").length === n,
    shelfWithMost.n, { what: `the ${shelfWithMost.c.label} shelf to be the only one shown` });
  ok("a shelf on the filter bar shows that shelf and nothing else",
    (await page.locator(".librarypanel .libskill").count()) === shelfWithMost.n &&
    (await page.$$eval(".librarypanel .libskill", cs => cs.map(c => c.dataset.libskill)))
      .every(id => SKILL_LIBRARY.find(s => s.id === id)?.category === shelfWithMost.c.id),
    `${shelfWithMost.c.label}: ${shelfWithMost.n}`);
  await page.click('.librarypanel .libseg button[data-shelf="all"]');
  await waitFor(page, n => document.querySelectorAll(".librarypanel .libskill").length === n,
    SKILL_LIBRARY.length, { what: "the whole library to come back" });

  /* TAKE ONE. From here on the only thing being checked is that what landed is
     an ordinary skill. */
  const taken = SKILL_LIBRARY.find(s => s.id === "sk-verify") ?? SKILL_LIBRARY[1];
  await page.click(`.librarypanel .libskill[data-libskill="${taken.id}"] .ls-take`);
  await page.waitForSelector(`.editor .skillrow[data-skill="${taken.name}"]`, { timeout: 10000 });
  ok("giving a skill to an agent puts it straight into the same list every other skill is in",
    (await page.locator(`.editor .skillrow[data-skill="${taken.name}"]`).count()) === 1 &&
    (await page.locator(".librarypanel .libroom").innerText()).includes(`1 of ${SKILL_LIMITS.perAgent}`),
    (await page.locator(".librarypanel .libroom").innerText()).trim());

  /* TAKING IT TWICE MUST NOT MAKE TWO. */
  ok("taking one he already has offers to replace it rather than silently making a second",
    (await page.locator(`.librarypanel .libskill[data-libskill="${taken.id}"] .ls-take`).count()) === 0 &&
    (await page.locator(`.librarypanel .libskill[data-libskill="${taken.id}"] .ls-replaceask`).count()) === 1,
    (await page.locator(`.librarypanel .libskill[data-libskill="${taken.id}"] .ls-already`).innerText()).trim());
  await page.click(`.librarypanel .libskill[data-libskill="${taken.id}"] .ls-replaceask`);
  await page.click(`.librarypanel .libskill[data-libskill="${taken.id}"] .ls-replace`);
  ok("and replacing leaves one, not two",
    (await page.locator(`.editor .skillrow[data-skill="${taken.name}"]`).count()) === 1);

  /* The same one Escape owner, on the library — an overlay that never had an
     Escape of its own at all. Closed with the key here rather than the button,
     so the run proves the key and not only the button. */
  ok("the skill library is on the one Escape owner's stack while it is open",
    (await page.evaluate(() => window.cloud9Escape.stacked())) === 1);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".librarypanel", { state: "detached", timeout: 10000 });
  ok("ESCAPE CLOSES THE SKILL LIBRARY, and leaves the agent's file open behind it",
    (await page.locator(".librarypanel").count()) === 0 &&
    (await page.locator(".editor .skills").count()) === 1 &&
    (await page.evaluate(() => window.cloud9Escape.stacked())) === 0);

  /* THE PROMISE. Compare the row a library skill draws with the row a skill he
     typed out draws — they must be the same row. Anything that could only be
     true of a library skill (a badge, a lock, a source line, a missing bin) is
     a failure of the whole feature, not a cosmetic one. */
  const handWritten = `Villa notes ${Date.now().toString(36)}`;
  await page.click(".editor .skills .skill-add");
  await page.fill(".skill-name-input", handWritten);
  await page.fill(".skill-desc-input", "Reads the villa notes and picks three");
  await page.fill(".skill-instructions-input", "Read the notes and keep the three best under budget.");
  await page.click(".editor .skills .skill-save");
  await page.waitForSelector(`.editor .skillrow[data-skill="${handWritten}"]`, { timeout: 10000 });
  const rowShape = (page, name) => page.$eval(
    `.editor .skillrow[data-skill="${name}"]`,
    row => ({
      classes: row.className,
      controls: [...row.querySelectorAll("button")].map(b => b.className).sort(),
      extras: row.querySelectorAll("[data-libskill],.ls-source,.readonly,.locked,.chip").length,
    }));
  const fromLibraryRow = await rowShape(page, taken.name);
  const handWrittenRow = await rowShape(page, handWritten);
  ok("A SKILL TAKEN FROM THE LIBRARY IS DRAWN AS THE SAME ROW AS ONE HE TYPED — no badge, no lock",
    JSON.stringify(fromLibraryRow) === JSON.stringify(handWrittenRow) &&
    fromLibraryRow.extras === 0,
    JSON.stringify(fromLibraryRow) === JSON.stringify(handWrittenRow)
      ? `both: ${fromLibraryRow.controls.join(" + ")}`
      : `library ${JSON.stringify(fromLibraryRow)} vs typed ${JSON.stringify(handWrittenRow)}`);
  /* THE PICTURE OF THE PROMISE: the skill off the shelf and the skill he typed,
     side by side in one list, telling nobody which was which. */
  await page.locator(".editor .skills").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/library-same-row.png`, animations: "disabled" });

  /* AND IT IS EDITABLE, WORD FOR WORD, IN THE EDITOR HE ALREADY HAS. */
  await page.click(`.editor .skillrow[data-skill="${taken.name}"] .skill-edit`);
  await page.waitForSelector(".skill-instructions-input", { timeout: 10000 });
  const takenInstructions = await page.inputValue(".skill-instructions-input");
  ok("its words arrived in full and sit in the ordinary skill editor, not a preview",
    takenInstructions.trim() === taken.instructions.trim() &&
    (await page.inputValue(".skill-desc-input")).trim() === taken.description.trim(),
    `${takenInstructions.length} characters, editable`);
  const renamed = `${taken.name} (mine)`;
  await page.fill(".skill-name-input", renamed);
  await page.fill(".skill-instructions-input", `${taken.instructions}\n\nAnd say it in British English.`);
  await page.click(".editor .skills .skill-save");
  await page.waitForSelector(`.editor .skillrow[data-skill="${renamed}"]`, { timeout: 10000 });
  ok("every word of it can be changed, exactly like one he wrote himself",
    (await page.locator(`.editor .skillrow[data-skill="${renamed}"]`).count()) === 1 &&
    (await page.locator(`.editor .skillrow[data-skill="${taken.name}"]`).count()) === 0);

  /* …and removable. A skill nobody can delete is a second class of skill. */
  await page.click(`.editor .skillrow[data-skill="${handWritten}"] .skill-delete`);
  ok("and it can be deleted by the same bin, with nothing refusing",
    (await page.locator(`.editor .skillrow[data-skill="${handWritten}"]`).count()) === 0 &&
    (await page.locator(`.editor .skillrow[data-skill="${renamed}"]`).count()) === 1);

  // …and it is genuinely editable, not a locked template
  await page.fill(".editor .persona-input", `${hiredPersona}\n\nAlways answer in British English.`);
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector(".crew-grid", { timeout: 20000 });
  ok("hiring copies the role onto his floor as one of his own agents",
    (await page.locator('.cast[data-crew="Architect"]').count()) === 1);
  ok("and it runs on the app he chose, not the one the catalogue suggested",
    /Codex/.test(await page.locator('.cast[data-crew="Architect"] .runs').innerText()),
    (await page.locator('.cast[data-crew="Architect"] .runs').innerText()).replace(/\s+/g, " "));
  ok("the crew screen says the hire is his to change",
    (await page.locator('.hirednote[data-hired="Architect"]').count()) === 1,
    (await page.locator(".hirednote").innerText()).replace(/\s+/g, " ").slice(0, 90));
  ok("a hire is owner-only, exactly like an agent he wrote himself",
    /Only you/.test(await page.locator('.cast[data-crew="Architect"] .whocan').innerText()),
    (await page.locator('.cast[data-crew="Architect"] .whocan').innerText()).replace(/\s+/g, " "));
  ok("and the crew shows the very same picture the casting room showed",
    (await portraitOf(page, '.cast[data-crew="Architect"] .plate .portrait svg')) === hallFace);
  await page.screenshot({ path: `${SHOTS}/market-hired.png` });
  await page.screenshot({ path: `${SHOTS}/hall-crew.png` });

  await page.click('.cast[data-crew="Architect"] button:has-text("Edit")');
  await page.waitForSelector(".editor .persona-input", { timeout: 15000 });
  ok("and every word of it can be changed afterwards — the change survives the hub",
    /Always answer in British English\.$/.test(
      (await page.locator(".editor .persona-input").inputValue()).trim()),
    (await page.locator(".editor .persona-input").inputValue()).trim().slice(-40));
  /* THE SKILL WENT THROUGH THE HUB AND CAME BACK THE SAME. A library skill is
     stored as an `AgentSkill` and nothing else, so there is nowhere for a
     "where it came from" to survive — and if it had, the row would be drawing
     something the hub does not hold. */
  ok("a skill taken from the library is saved on the agent, and comes back as an ordinary skill",
    (await page.locator(`.editor .skillrow[data-skill="${renamed}"]`).count()) === 1 &&
    (await page.locator(`.editor .skillrow[data-skill="${renamed}"] .skill-edit`).count()) === 1 &&
    (await page.locator(`.editor .skillrow[data-skill="${renamed}"] .skill-delete`).count()) === 1 &&
    (await page.locator(".editor .skillrow .ls-source").count()) === 0,
    `“${renamed}” survived the hub`);
  await page.locator(".editor .skills").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/library-on-agent.png`, animations: "disabled" });
  await page.screenshot({ path: `${SHOTS}/market-editable.png` });
  await page.click(".editor >> text=← Crew");
  await page.waitForSelector(".crew-grid", { timeout: 20000 });

  /* ================= CAN THIS AGENT ACTUALLY BE USED RIGHT NOW? ============
   *
   * HIS BUG, IN HIS WORDS: "every agent shows offline." The hub was taught to
   * work the answer out from what it genuinely observes and to send a plain
   * sentence saying why — and none of it reached the screen. An agent row was
   * a name and a pencil.
   *
   * The rule these checks hold shut: the word, the dot and the reason are ONE
   * fact from ONE place, and an agent nobody has reported on is never drawn as
   * if all were well.
   */
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".sidebar .agentrow", { timeout: 20000 });
  const rowState = pg => pg.$$eval(".sidebar .agentrow", rs => rs.map(r => ({
    agent: r.dataset.agent,
    presence: r.dataset.presence,
    word: r.querySelector(".an-state b")?.innerText.trim() ?? "",
    why: (r.querySelector(".an-state")?.innerText ?? "").replace(/\s+/g, " ").trim(),
    dot: [...(r.querySelector(".pdot")?.classList ?? [])].find(c => c.startsWith("p-")) ?? "",
  })));
  const mine = await rowState(page);
  const WORDS = { ready: "Ready", working: "Working", paused: "Paused", offline: "Offline" };
  ok("every agent row on screen carries a presence, and it is one the hub can actually say",
    mine.length >= 2 && mine.every(r => ["ready", "working", "paused", "offline"].includes(r.presence)),
    mine.map(r => `${r.agent}=${r.presence}`).join(", "));
  ok("the row says the state in words, not only as a colour",
    mine.every(r => r.word === WORDS[r.presence]),
    mine.map(r => `${r.agent}:${r.word}`).join(", "));
  ok("and it says WHY, in a plain sentence",
    mine.every(r => r.why.length > r.word.length + 3),
    mine.map(r => r.why).join(" | "));
  ok("the dot and the word can never disagree — they are drawn from the same one field",
    mine.every(r => r.dot === `p-${r.presence}`),
    mine.map(r => `${r.agent}:${r.dot}`).join(", "));
  await page.screenshot({ path: `${SHOTS}/presence-sidebar.png` });

  // ---- the conversation says the same thing the rail says ----
  await page.click('.sidebar .agentrow[data-agent="Scout"] .agentmain');
  await page.waitForSelector(".dm-head .presencehere", { timeout: 20000 });
  const inHead = await page.evaluate(() => {
    const el = document.querySelector(".dm-head .presencehere");
    return {
      presence: el.dataset.presence,
      word: el.querySelector("b").innerText.trim(),
      why: el.querySelector(".ph-why").innerText.trim(),
    };
  });
  const scoutRow = (await rowState(page)).find(r => r.agent === "Scout");
  ok("the conversation header says the same state as the rail, and the reason with it",
    inHead.presence === scoutRow.presence && inHead.word === scoutRow.word &&
    scoutRow.why.endsWith(inHead.why),
    `${inHead.word} — ${inHead.why}`);
  await page.screenshot({ path: `${SHOTS}/presence-conversation.png` });

  // ---- paused is a real answer, and it is the owner's own doing ----
  await page.click('.rail-btn[data-go="crew"]');
  await page.waitForSelector(".crew-grid", { timeout: 20000 });
  await page.click('.cast[data-crew="Architect"] button:has-text("Edit")');
  await page.waitForSelector(".editor .lifecyclepick", { timeout: 20000 });
  await page.selectOption(".editor .lifecyclepick", "paused");
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector('.crew-grid .cast[data-crew="Architect"][data-presence="paused"]',
    { timeout: 25000 });
  ok("pausing an agent is shown as paused, with the owner's own doing given as the reason",
    /Paused — paused by its owner/.test(
      await page.locator('.cast[data-crew="Architect"] .nowpresence').innerText()),
    (await page.locator('.cast[data-crew="Architect"] .nowpresence').innerText()).replace(/\s+/g, " "));
  ok("and the crew card's pill says it too, rather than leaving a green dot behind",
    (await page.locator('.cast[data-crew="Architect"] .presencepill').innerText()).trim() === "Paused" &&
    (await page.locator('.cast[data-crew="Architect"] .presencepill .pdot.p-ready').count()) === 0);
  await page.screenshot({ path: `${SHOTS}/presence-paused.png` });
  ok("the Off duty filter finds it by that state, not by guessing from the record",
    await (async () => {
      await page.click('.crew-bar .seg >> text=Off duty');
      await page.waitForTimeout(300);
      return (await page.locator('.crew-grid .cast[data-crew="Architect"]').count()) === 1;
    })());
  await page.click('.crew-bar .seg >> text=Everyone');

  // put it back, and prove the screen follows
  await page.click('.cast[data-crew="Architect"] button:has-text("Edit")');
  await page.waitForSelector(".editor .lifecyclepick", { timeout: 20000 });
  await page.selectOption(".editor .lifecyclepick", "enabled");
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector('.crew-grid .cast[data-crew="Architect"][data-presence="ready"]',
    { timeout: 25000 });
  ok("un-pausing puts it back to ready on screen, without a reload",
    (await page.locator('.cast[data-crew="Architect"] .presencepill').innerText()).trim() === "Ready");

  /* ---- AN AGENT NOBODY CAN RUN SAYS SO, AND SAYS WHY ----
     "Offline" is the answer the hub gives whenever nobody could run this agent
     if they tried — no engine, no signed-in app, or switched off by its owner.
     Switching one off is the one of those three a QA run can cause on purpose
     without lying about the machine, so that is the one driven here: it goes
     down the same branch and must come back with a REASON and a hollow dot,
     never the green one. */
  await page.click('.cast[data-crew="Architect"] button:has-text("Edit")');
  await page.waitForSelector(".editor .lifecyclepick", { timeout: 20000 });
  await page.selectOption(".editor .lifecyclepick", "disabled");
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector('.crew-grid .cast[data-crew="Architect"][data-presence="offline"]',
    { timeout: 25000 });
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector('.sidebar .agentrow[data-agent="Architect"][data-presence="offline"]',
    { timeout: 20000 });
  const dead = (await rowState(page)).find(r => r.agent === "Architect");
  ok("an agent nobody can run reads Offline, with the honest reason — never a green dot",
    !!dead && dead.presence === "offline" && dead.dot === "p-offline" &&
    /switched off by its owner/.test(dead.why),
    dead ? dead.why : "(Architect not on screen)");
  await page.screenshot({ path: `${SHOTS}/presence-offline.png` });
  await page.click('.rail-btn[data-go="crew"]');
  await page.waitForSelector(".crew-grid", { timeout: 20000 });
  await page.click('.cast[data-crew="Architect"] button:has-text("Edit")');
  await page.waitForSelector(".editor .lifecyclepick", { timeout: 20000 });
  await page.selectOption(".editor .lifecyclepick", "enabled");
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector('.crew-grid .cast[data-crew="Architect"][data-presence="ready"]',
    { timeout: 25000 });
  ok("switching it back on is enough — the screen follows the hub, not a reload",
    (await page.locator('.cast[data-crew="Architect"] .presencepill').innerText()).trim() === "Ready");
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".sidebar", { timeout: 20000 });
  await page.click('.sidebar .side-item[data-channel="general"]');
  await page.waitForSelector(".composer textarea", { timeout: 20000 });

  await fpage.fill(".composer textarea", "@Scout could you find me a villa too?");
  await fpage.press(".composer textarea", "Enter");
  await fpage.waitForSelector('.mentionrefused[data-agent="Scout"]', { timeout: 25000 });
  ok("an agent that will not answer you says so, instead of silently doing nothing",
    /only answers/.test(await fpage.locator('.mentionrefused[data-agent="Scout"]').innerText()),
    (await fpage.locator('.mentionrefused[data-agent="Scout"]').innerText()).trim());
  await fpage.screenshot({ path: `${SHOTS}/chat-mention-refused.png` });

  /* ================= FILES ON A MESSAGE (handoff §9) =================
   * The whole journey, on screen and over the wire: pick a file, watch it go
   * up, send it, see it on the message, open it, and — the part that is not
   * inferrable from a link appearing — fetch the bytes back and compare them
   * to what was sent. */
  await page.click('.rail-btn[data-go="chat"]');
  await page.click('button[title="New channel"]');

  /* ---- D3 / D4 / D2: the room name is held to the SAME rule as an agent's ----
     Before this the channel box had no length cap, no uniqueness rule and no
     "is this actually a name" rule, while the agent box next door had all
     three. One rule now answers for both, and it answers HERE — in the form —
     as well as at the hub. */
  const roomSays = async name => {
    await page.fill('.panel input[placeholder="trip-goa"]', name);
    await page.click(".panel .foot >> text=Create");
    await page.waitForSelector(".panel .problemline", { timeout: 10000 });
    return {
      said: (await page.locator(".panel .problemline").innerText()).trim(),
      kept: await page.inputValue('.panel input[placeholder="trip-goa"]'),
      open: (await page.locator(".panel").count()) > 0,
    };
  };
  const dupe = await roomSays("trip-goa");
  ok("D3: a second room with a name he already has is refused in plain words, and the box keeps it",
    dupe.said === validateName("channel", "trip-goa", ["trip-goa"])
    && dupe.kept === "trip-goa" && dupe.open,
    `${dupe.said} :: kept "${dupe.kept}"`);

  const huge = await roomSays("x".repeat(3000));
  ok("D4: a 3,000-character room name is refused, in the same words the agent name uses",
    new RegExp(`too long \\(max ${NAME_LIMITS.channel} characters\\)`).test(huge.said)
    && huge.kept.length === 3000,
    `${huge.said} :: kept ${huge.kept.length} characters`);

  /* D2 — six spaces. The box turns whitespace into hyphens as he types, so what
     the rule actually sees is `-`; either way it is not a name and he is told
     so, rather than getting a room he never asked for. */
  const spaces = await roomSays("      ");
  const dashRooms = await page.locator('.sidebar .side-item:text-is("# -")').count();
  ok("D2: six spaces is not a room name — it is refused, and no room called - appears",
    /at least one letter or number|needs a name/.test(spaces.said) && dashRooms === 0,
    `${spaces.said} :: ${dashRooms} room(s) named -`);

  await page.fill('.panel input[placeholder="trip-goa"]', "paperwork");
  await page.click(".panel .foot >> text=Create");
  await page.waitForSelector(".sidebar >> text=# paperwork");
  await page.click("text=# paperwork");
  await page.waitForSelector('.chathead .ch-title .n:text-is("paperwork")', { timeout: 15000 });

  /* ---- A3: a refused message must not cost him what he typed ----
     Phase 5's worst finding for him: press Enter with a long message and the
     box emptied BEFORE the hub answered "that message is too long". Every word
     was gone and he could not shorten what he had written. */
  const TOO_LONG = "x".repeat(MESSAGE_LIMITS.text + 1000);
  await page.fill(".composer textarea", TOO_LONG);
  await page.locator(".composer textarea").press("Enter");
  await page.waitForSelector(".toast .toast-text", { timeout: 15000 });
  const tooLongSays = (await page.locator(".toast .toast-text").innerText()).trim();
  const stillTyped = await page.inputValue(".composer textarea");
  ok("A3: a message too long is refused in plain words AND every character he typed is still there",
    new RegExp(`too long \\(max ${MESSAGE_LIMITS.text} characters\\)`).test(tooLongSays)
    && stillTyped.length === TOO_LONG.length,
    `${tooLongSays} :: box holds ${stillTyped.length} of ${TOO_LONG.length}`);
  await page.fill(".composer textarea", "");
  await page.click(".toast .toast-x");

  ok("the composer offers a way to attach a file",
    (await page.locator(".composer .mini.attach").count()) === 1 &&
    (await page.locator(".composer input.filepick").count()) === 1);

  // a real PNG, not a token one: a file worth a byte-for-byte comparison
  const PICTURE = pngOfSolidColour(180, 120, [18, 83, 71]);
  const LEDGER = Buffer.from("row,amount\nvilla,7400\nflights,5200\n", "utf8");

  await page.setInputFiles(".composer input.filepick", {
    name: "site-plan.png", mimeType: "image/png", buffer: PICTURE,
  });
  await page.waitForSelector('.uploadtray .uptile[data-upload="site-plan.png"].done', { timeout: 20000 });
  ok("a picked file goes up and says it is ready to send",
    /ready to send/.test(await page.locator('.uptile[data-upload="site-plan.png"] .meta').innerText()),
    (await page.locator('.uptile[data-upload="site-plan.png"] .meta').innerText()).trim());

  await page.setInputFiles(".composer input.filepick", {
    name: "ledger.bin", mimeType: "application/octet-stream", buffer: LEDGER,
  });
  await page.waitForSelector('.uploadtray .uptile[data-upload="ledger.bin"].done', { timeout: 20000 });

  /* ---- F3: the file names a real person actually has ----
     Phase 5 attached these and watched them bounce. `report(1).pdf` is the
     exact name every browser gives a re-downloaded file, and `café-menu.txt`
     is an ordinary word. They are ordinary files, and they must land. */
  for (const everyday of ["report(1).pdf", "café-menu.txt", "photo#3.png"]) {
    await page.setInputFiles(".composer input.filepick", {
      name: everyday, mimeType: "application/octet-stream", buffer: LEDGER,
    });
  }
  await page.waitForFunction(
    () => document.querySelectorAll(".uploadtray .uptile.done").length >= 5,
    null, { timeout: 30000 });
  const everydayLanded = await page.$$eval(".uploadtray .uptile",
    tiles => tiles.map(t => `${t.dataset.upload}:${t.className}`));
  ok("F3: the everyday file names a person really has are accepted, not bounced",
    ["report(1).pdf", "café-menu.txt", "photo#3.png"].every(
      n => everydayLanded.some(t => t.startsWith(`${n}:`) && !t.includes("failed"))),
    everydayLanded.join(" | "));
  for (const everyday of ["report(1).pdf", "café-menu.txt", "photo#3.png"]) {
    await page.click(`.uploadtray .uptile[data-upload="${everyday}"] .upx`);
  }
  await waitFor(page, () => document.querySelectorAll(".uploadtray .uptile").length === 2,
    undefined, { timeout: 10000, what: "the everyday files to be taken back off" });

  // a name the hub would refuse is refused HERE, in the hub's own sentence,
  // before the bytes are ever read — and it is said, never swallowed.
  // `CON.png` is a Windows DEVICE, not a file: it is refused for a reason a
  // person can act on, unlike `report(1).pdf`, which never should have been.
  await page.setInputFiles(".composer input.filepick", {
    name: "CON.png", mimeType: "image/png", buffer: PICTURE,
  });
  await page.waitForSelector('.uploadtray .uptile.failed', { timeout: 15000 });
  const refusedSays = (await page.locator(".uploadtray .uptile.failed .meta").innerText()).trim();
  ok("a file the hub would refuse is refused in the composer, in plain words",
    /file name isn't allowed/.test(refusedSays), refusedSays);
  /* F3's second half: the sentence used to describe a STRICTER rule than the
     one enforced ("plain letters, numbers, dots and dashes" — while allowing
     spaces and underscores), so doing what it said did not help. It is now
     generated from the rule, and this compares the words on his screen with
     the words the rule itself produced. */
  ok("F3: the refusal on screen is the sentence the rule generated, word for word",
    refusedSays === FILE_NAME_SENTENCE
    && !/plain letters, numbers, dots and dashes/.test(refusedSays),
    `${refusedSays}\n  rule says: ${FILE_NAME_SENTENCE}`);
  await page.screenshot({ path: `${SHOTS}/files-composer.png` });

  // a refused file can be taken back off, and the ones that landed stay
  await page.click('.uploadtray .uptile.failed .upx');
  await waitFor(page, () => document.querySelectorAll(".uploadtray .uptile.failed").length === 0,
    undefined, { timeout: 10000, what: "the refused file to be taken off the message" });
  ok("a file can be taken back off the message before it is sent",
    (await page.locator(".uploadtray .uptile").count()) === 2);

  /* ---- what is sitting unsent, in the hub's own numbers (handoff §11.5) ----
     The ceiling on parked files is per PERSON and is enforced by the hub. The
     screen must be able to say it BEFORE somebody hits it, and must say the
     same number the hub holds — so this check compares what is on screen with
     the constant imported from `@cloud9/shared`, never with a number typed
     here. A renderer that restated "50 MB" by hand would fail the day the hub
     moved it. */
  const parkedSaid = await page.$eval(".composer .parked", el => ({
    held: Number(el.dataset.parked),
    max: Number(el.dataset.parkedMax),
    text: el.innerText.replace(/\s+/g, " ").trim(),
  }));
  const parkedMB = `${Math.round(ATTACHMENT_LIMITS.parkedBytesPerUser / 100_000) / 10} MB`;
  const parkedHours = `${Math.round(ATTACHMENT_LIMITS.parkedTtlMs / 3_600_000)} hours`;
  ok("the composer says how much is waiting to be sent, against the ceiling the hub itself holds",
    parkedSaid.max === ATTACHMENT_LIMITS.parkedBytesPerUser &&
    parkedSaid.held === PICTURE.length + LEDGER.length &&
    parkedSaid.text.includes(`of ${parkedMB}`) &&
    parkedSaid.text.includes(parkedHours),
    `${parkedSaid.text} :: held=${parkedSaid.held} max=${parkedSaid.max}`);
  await page.screenshot({ path: `${SHOTS}/room-files-waiting.png` });

  const sendSays = (await page.locator(".composer .primary.small").innerText()).trim();
  ok("the send button says how many files are going with the message",
    /2 files/.test(sendSays), sendSays);

  await page.fill(".composer textarea", "here is the site plan and the ledger");
  await page.click(".composer .primary.small");
  await page.waitForSelector('.msg .fileblock[data-file="site-plan.png"]', { timeout: 20000 });
  ok("a message carries its files, each with its name and its size",
    (await page.locator(".msg .fileblock").count()) === 2 &&
    /KB|bytes/.test(await page.locator('.fileblock[data-file="site-plan.png"] .meta').innerText()),
    (await page.locator('.fileblock[data-file="site-plan.png"] .meta').innerText()).trim());

  ok("the tray is empty once the files have gone",
    (await page.locator(".composer .uploadtray").count()) === 0);

  // what may be shown in place and what may only be saved is the HUB's answer,
  // never the sender's — a picture offers "Show", anything else offers "Save"
  ok("a picture offers to be shown in place and a file offers to be saved",
    (await page.locator('.fileblock[data-file="site-plan.png"] .fileopen').innerText()).trim() === "Show" &&
    (await page.locator('.fileblock[data-file="ledger.bin"] .fileopen').innerText()).trim() === "Save");

  const pictureId = await page.getAttribute('.fileblock[data-file="site-plan.png"]', "data-attachment");

  /* ---- the bytes, fetched back over the real HTTP path ----
   * The ticket is minted through the app's own path, then redeemed from here.
   * Two things are proved that a screenshot cannot prove: the file that comes
   * back IS the file that went up, and the ticket dies on first use. */
  const ticket = await page.evaluate(id => window.cloud9Files.ticket(id), pictureId);
  const served = await fetch(ticket.url);
  const gotBytes = Buffer.from(await served.arrayBuffer());
  ok("the file fetched back off the hub is byte-for-byte the file that was sent",
    served.status === 200 && gotBytes.length === PICTURE.length && gotBytes.equals(PICTURE),
    `${served.status} · sent ${PICTURE.length} bytes, got ${gotBytes.length}`);
  ok("the hub decides the type from the name, and tells the browser not to sniff",
    served.headers.get("content-type") === "image/png" &&
    served.headers.get("x-content-type-options") === "nosniff" &&
    /inline/.test(served.headers.get("content-disposition") ?? ""),
    `${served.headers.get("content-type")} · ${served.headers.get("content-disposition")}`);
  const replayed = await fetch(ticket.url);
  ok("a ticket is spent by the first request — a second one is refused",
    replayed.status === 404 &&
    /that link has expired/.test(await replayed.text()), `status ${replayed.status}`);

  // and a file that is NOT a picture is handed over as bytes with a download
  const ledgerId = await page.getAttribute('.fileblock[data-file="ledger.bin"]', "data-attachment");
  const ledgerTicket = await page.evaluate(id => window.cloud9Files.ticket(id), ledgerId);
  const ledgerServed = await fetch(ledgerTicket.url);
  const ledgerBytes = Buffer.from(await ledgerServed.arrayBuffer());
  ok("a file the hub will not draw comes back as bytes with a download, unchanged",
    ledgerBytes.equals(LEDGER) &&
    ledgerServed.headers.get("content-type") === "application/octet-stream" &&
    /attachment/.test(ledgerServed.headers.get("content-disposition") ?? ""),
    `${ledgerServed.headers.get("content-type")} · ${ledgerServed.headers.get("content-disposition")}`);

  // ---- and the same journey through the buttons a person actually presses ----
  await page.click('.fileblock[data-file="site-plan.png"] .fileopen');
  await page.waitForSelector('.fileblock[data-file="site-plan.png"] .fileshot img', { timeout: 20000 });
  const drawn = await page.evaluate(() => {
    const img = document.querySelector('.fileblock[data-file="site-plan.png"] .fileshot img');
    return { w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 5) };
  });
  ok("clicking a picture opens it in place, with the picture really loaded",
    drawn.w === 180 && drawn.h === 120, JSON.stringify(drawn));
  await page.screenshot({ path: `${SHOTS}/files-message.png` });

  /* ---- ONE ROUTE TO A FILE, and this is the run that proves it ----
     The screen is served on :4173 and the hub answers on :8799, so every fetch
     below really is cross-origin. There used to be a second code path for
     exactly this case, because the hub sent no CORS header and the page could
     not read its own answer; the header is there now and the branch is gone.
     A `blob:` source is the evidence: only the fetch → blob route can produce
     one, so if the old handing-the-ticket-to-the-img shortcut were still in
     use this check would fail. */
  const origins = await page.evaluate(() => ({
    screen: location.origin,
    hub: new URL((new URLSearchParams(location.search).get("relay") ?? "").replace(/^ws/, "http")).origin,
  }));
  ok("the screen and the hub really are on different addresses, so the next check means something",
    !!origins.hub && origins.screen !== origins.hub, `${origins.screen} vs ${origins.hub}`);
  ok("a picture takes the one intended route — fetched, held as a blob, freed on close",
    drawn.src === "blob:", `img src begins "${drawn.src}"`);

  // and saving still hands the file to the browser's own download path
  const saving = page.waitForEvent("download", { timeout: 20000 });
  await page.click('.fileblock[data-file="ledger.bin"] .fileopen');
  const saved = await saving;
  ok("saving a file still hands it to the browser, under its own name",
    saved.suggestedFilename() === "ledger.bin", saved.suggestedFilename());

  ok("an opened file is held for this screen, so a second look does not re-ticket",
    (await page.evaluate(() => window.cloud9Files.opened())).includes(pictureId));

  // leaving the conversation lets every opened file go — a screen that opened a
  // hundred pictures and never freed them would be holding a hundred pictures
  await page.click(".sidebar >> text=# general");
  await page.waitForTimeout(400);
  ok("opened files are let go when the message leaves the screen",
    (await page.evaluate(() => window.cloud9Files.opened())).length === 0);
  await page.click(".sidebar >> text=# paperwork");
  await page.waitForSelector('.msg .fileblock[data-file="site-plan.png"]', { timeout: 15000 });

  /* ================= ROOMS ARE REAL THINGS (handoff §10) ================= */

  // ---- the details panel: what it's for, who's in it, how it's run ----
  await page.click(".chathead .roomdetailsbtn");
  await page.waitForSelector(".roompanel", { timeout: 15000 });
  await page.waitForSelector(".roommembers .memberrow", { timeout: 15000 });
  const myRow = page.locator('.roommembers .memberrow[data-member="Vikas"]');
  ok("the room panel lists who is in the room, with their role and when they joined",
    (await myRow.count()) === 1 &&
    (await myRow.locator(".rolename").getAttribute("data-role")) === "owner" &&
    /joined /.test(await myRow.locator(".rl").innerText()),
    (await myRow.locator(".rl").innerText()).replace(/\s+/g, " "));

  await page.click(".roominfo-edit");
  await page.fill(".roomdesc-input", "Everything that has to be filed for the trip");
  await page.fill(".roomtopic-input", "back on the 14th");
  await page.click(".roominfo-save");
  await waitFor(page, () => /back on the 14th/.test(
    document.querySelector(".roompanel .roomtopic")?.textContent ?? ""),
  undefined, { timeout: 20000, what: "the room's own words to come back from the hub" });
  ok("a room's description and one-line topic can be set, and come back from the hub",
    /has to be filed/.test(await page.locator(".roompanel .roomdesc").innerText()) &&
    /back on the 14th/.test(await page.locator(".roompanel .roomtopic").innerText()));
  ok("the topic is shown beside the room's name, where it is about today",
    /back on the 14th/.test(await page.locator(".chathead .ch-topic").innerText()));
  await page.screenshot({ path: `${SHOTS}/rooms-details.png` });

  // ---- a room is private until somebody opens it, and it SAYS which ----
  ok("a room says at a glance that it is private, in the header and in the sidebar",
    (await page.locator('.chathead .roomvis[data-vis="private"]').count()) === 1 &&
    (await page.locator('.sidebar .side-item[data-channel="paperwork"][data-vis="private"]').count()) === 1);

  // ---- browse: nothing to join while every room is shut ----
  await fpage.click(".sidebar .browserooms");
  await fpage.waitForSelector(".browsepanel", { timeout: 15000 });
  await fpage.waitForSelector(".browsepanel .browseempty, .browsepanel .roomcard", { timeout: 20000 });
  const emptySays = (await fpage.locator(".browsepanel .browseempty").innerText()).replace(/\s+/g, " ").trim();
  ok("with every room shut, browsing says so — and says why, in the hub's own words",
    emptySays === "No open rooms to join. Rooms are private unless someone opens them.", emptySays);
  await fpage.screenshot({ path: `${SHOTS}/rooms-browse-empty.png` });
  await fpage.click('.browsepanel .foot button:has-text("Done")');

  // ---- the owner opens one ----
  await page.click('.roomcontrols .segbtn[data-vis="open"]');
  await waitFor(page, () => document.querySelector('.chathead .roomvis[data-vis="open"]') !== null,
    undefined, { timeout: 20000, what: "the room to come back from the hub as an open one" });
  ok("opening a room to anyone here is said in the header and on the sidebar row",
    (await page.locator('.chathead .roomvis[data-vis="open"]').count()) === 1 &&
    (await page.locator('.sidebar .side-item[data-channel="paperwork"][data-vis="open"]').count()) === 1);
  await page.screenshot({ path: `${SHOTS}/rooms-open.png` });

  // ---- and now it can be found and joined, with no members and no messages on offer ----
  await fpage.click(".sidebar .browserooms");
  await fpage.waitForSelector('.browsepanel .roomcard[data-room="paperwork"]', { timeout: 20000 });
  const card = fpage.locator('.browsepanel .roomcard[data-room="paperwork"]');
  ok("an open room can be found by somebody who is not in it, with what it's for and how many are in it",
    /has to be filed/.test(await card.locator(".rc-desc").innerText()) &&
    /1 person/.test(await card.locator(".rc-count").innerText()),
    (await card.locator(".rc-count").innerText()).trim());
  ok("browsing offers no members and no messages — finding a room is not permission to read it",
    (await fpage.locator(".browsepanel .msg").count()) === 0 &&
    (await fpage.locator(".browsepanel .mini-agent").count()) === 0);
  await fpage.screenshot({ path: `${SHOTS}/rooms-browse.png` });

  await card.locator(".roomjoin").click();
  await fpage.waitForSelector('.sidebar .side-item[data-channel="paperwork"]', { timeout: 20000 });
  await fpage.waitForSelector('.msg p:has-text("site plan and the ledger")', { timeout: 20000 });
  ok("joining an open room lets you in and hands over what was said in it", true);
  await fpage.screenshot({ path: `${SHOTS}/rooms-joined.png` });

  // a plain member is shown the room, and not the controls they may not use
  await fpage.click(".chathead .roomdetailsbtn");
  await fpage.waitForSelector(".roompanel .roomnotyours", { timeout: 20000 });
  ok("somebody who does not run the room is told so, instead of being offered a dead button",
    (await fpage.locator(".roompanel .roomarchive").count()) === 0 &&
    (await fpage.locator(".roompanel .segbtn").count()) === 0 &&
    (await fpage.locator(".roompanel .roomleave").count()) === 1);
  const joinedRow = fpage.locator('.roommembers .memberrow[data-member="Priya"]');
  /* Kept for the membership-history check further down: leaving and coming back
     writes a SECOND row, and the only way to prove the screen did not fold the
     two into one is to know what the first one said. */
  const priyaFirstJoin = Number(await joinedRow.getAttribute("data-joined"));
  ok("letting yourself into an open room is recorded as exactly that — nobody added you",
    (await joinedRow.locator(".rolename").getAttribute("data-role")) === "member" &&
    !/added by/.test(await joinedRow.locator(".rl").innerText()),
    (await joinedRow.locator(".rl").innerText()).replace(/\s+/g, " "));

  // ---- leaving takes the room, and everything cached for it, away ----
  await fpage.click(".roompanel .roomleave");
  await fpage.click(".roompanel .roomleave-yes");
  await waitFor(fpage, () =>
    document.querySelectorAll('.sidebar .side-item[data-channel="paperwork"]').length === 0,
  undefined, { timeout: 20000, what: "the room to go from the sidebar when you leave it" });
  ok("leaving a room takes it out of the sidebar, there and then", true);

  // ---- archived: readable, and nothing new ----
  await page.click(".roomarchive");
  await waitFor(page, () => document.querySelector(".composer-box.readonly") !== null,
    undefined, { timeout: 20000, what: "the composer to be replaced once the room is archived" });
  const archivedSays = (await page.locator(".composer-box.readonly .ro-say").innerText()).trim();
  ok("an archived room replaces the composer with the hub's own sentence, word for word",
    archivedSays === "that conversation is archived — nothing new can be said in it", archivedSays);
  ok("an archived room is greyed in the sidebar and marked archived in the header",
    (await page.locator('.sidebar .side-item[data-channel="paperwork"].is-archived').count()) === 1 &&
    (await page.locator('.chathead .roomvis[data-vis="archived"]').count()) === 1);
  await page.hover(".msgs .msg >> nth=0");
  await page.waitForTimeout(250);
  ok("an archived room offers nothing that would put something new in it",
    (await page.locator(".msgs .msgactions").count()) === 0 &&
    (await page.locator(".chathead select").count()) === 0);
  ok("an archived room still reads all the way down — the words and the files stay",
    (await page.locator('.msg .fileblock[data-file="site-plan.png"]').count()) === 1 &&
    (await page.locator(".msgs .msg").count()) > 0);
  await page.screenshot({ path: `${SHOTS}/rooms-archived.png` });

  // ---- and it is a state, not an epitaph ----
  await page.click(".roomarchive");
  await waitFor(page, () => document.querySelector(".composer textarea") !== null,
    undefined, { timeout: 20000, what: "the composer to come back when the room is reopened" });
  ok("reopening an archived room gives it back, exactly as it was",
    (await page.locator(".composer-box.readonly").count()) === 0 &&
    (await page.locator('.sidebar .side-item[data-channel="paperwork"].is-archived').count()) === 0);

  /* ============ WHO CAN READ THIS ROOM (handoff §11.2, §11.3, §11.6) ============

     The review reproduced this end to end: an ordinary member added SOMEBODY
     ELSE'S AGENT to a private room, and because an agent counts as its owner
     for visibility, that owner silently gained the room's entire history — with
     NOTHING ON SCREEN to say a person had been let in. The hub refuses that
     now. These checks are the other half of the fix: that the screen says who
     can read the room, and that the control which lets somebody in is offered
     by ROLE and not to whoever happens to be looking. */

  // Priya hires an agent of her own, so the room can be asked the exact
  // question the review asked.
  await fpage.click('button[title="New agent"]');
  await fpage.fill('input[placeholder="Scout"]', "Bramble");
  await fpage.fill("textarea.persona-input",
    "You keep the trip paperwork tidy and say what is still to file");
  await fpage.click(".editor >> text=Create agent");
  await fpage.click('.rail-btn[data-go="chat"]');
  await fpage.waitForSelector('.sidebar .agentrow[data-agent="Bramble"]', { timeout: 20000 });
  ok("a friend can hire an agent of their own", true);

  // ---- the control that lets somebody in is offered BY ROLE ----
  const addOptions = () => page.$$eval(".chathead .addmember option", os => os.map(o => ({
    id: o.value,
    text: (o.textContent ?? "").replace(/\s+/g, " ").trim(),
    disabled: o.disabled,
    why: o.dataset.why ?? "",
  })));
  await page.waitForSelector(".chathead .addmember", { timeout: 20000 });
  ok("the person who runs the room is offered the way to let somebody in",
    (await page.locator(".chathead .addmember").count()) === 1);

  const shutOut = await addOptions();
  const brambleShut = shutOut.find(o => /Bramble/.test(o.text));
  ok("an agent whose owner is not in this room is offered greyed, with the reason, before the click",
    !!brambleShut && brambleShut.disabled && /Priya isn't in this room/.test(brambleShut.why),
    JSON.stringify(brambleShut ?? null));
  const scoutOption = shutOut.find(o => /Scout/.test(o.text));
  ok("the picker says whose each agent is, and who admitting it would let in",
    !!scoutOption && !scoutOption.disabled && /Your agent/.test(scoutOption.text),
    scoutOption?.text ?? "(no Scout option)");

  /* The owner's own agent goes in first, so the list below holds one of each:
     an agent that tells the reader nothing new, and an agent that tells them
     somebody else is now reading the room. */
  await page.selectOption(".chathead .addmember", scoutOption.id);
  await page.waitForSelector('.roommembers .memberrow[data-member="Scout"]', { timeout: 25000 });

  // ---- Priya comes back into the room, so her agent may be admitted ----
  await fpage.click(".sidebar .browserooms");
  await fpage.waitForSelector('.browsepanel .roomcard[data-room="paperwork"]', { timeout: 20000 });
  await fpage.locator('.browsepanel .roomcard[data-room="paperwork"] .roomjoin').click();
  await fpage.waitForSelector('.sidebar .side-item[data-channel="paperwork"]', { timeout: 20000 });

  await waitFor(page, () => {
    const sel = document.querySelector(".chathead .addmember");
    return !!sel && [...sel.options].some(o => /Bramble/.test(o.textContent ?? "") && !o.disabled);
  }, undefined, { timeout: 25000, what: "the picker to notice Priya is back in the room" });
  const nowOffered = (await addOptions()).find(o => /Bramble/.test(o.text));
  ok("once its owner is in the room the agent can be added — and the picker names the person it lets in",
    !!nowOffered && !nowOffered.disabled && /Priya's agent/.test(nowOffered.text) &&
    /Priya can read it/.test(nowOffered.text),
    nowOffered?.text ?? "(no Bramble option)");

  // ---- and now the thing whose ABSENCE made the breach invisible ----
  await page.selectOption(".chathead .addmember", nowOffered.id);
  await page.waitForSelector('.roommembers .memberrow[data-member="Bramble"]', { timeout: 25000 });
  const ownerSeesBramble = page.locator('.roommembers .memberrow[data-member="Bramble"]');
  ok("an agent in a member list names its OWNER, so reading the list tells you who can see the room",
    (await ownerSeesBramble.locator(".agentowner").getAttribute("data-owner")) === "Priya" &&
    /Priya's agent/.test(await ownerSeesBramble.locator(".agentowner .whose").innerText()) &&
    /Priya can read this room/i.test(await ownerSeesBramble.locator(".agentowner .readsroom").innerText()),
    (await ownerSeesBramble.locator(".agentowner").innerText()).replace(/\s+/g, " ").trim());
  const ownScout = page.locator('.roommembers .memberrow[data-member="Scout"] .agentowner');
  ok("your own agent is named as yours in the same place, so the two are told apart at a glance",
    (await ownScout.getAttribute("data-mine")) === "yes" &&
    /Your agent/.test(await ownScout.locator(".whose").innerText()),
    (await ownScout.innerText()).replace(/\s+/g, " ").trim());
  await page.screenshot({ path: `${SHOTS}/room-members-owner.png` });

  // the right rail says it too — an agent is a room participant wherever it is drawn
  await page.click(".roompanel .roomclose");
  await page.waitForSelector('.aside .mini-agent[data-agent="Bramble"]', { timeout: 20000 });
  const railBramble = page.locator('.aside .mini-agent[data-agent="Bramble"] .agentowner');
  ok("the same is said in the rail beside the conversation, not only in the details panel",
    (await railBramble.getAttribute("data-owner")) === "Priya" &&
    /Priya can read this room/i.test(await railBramble.locator(".readsroom").innerText()),
    (await railBramble.innerText()).replace(/\s+/g, " ").trim());
  await page.screenshot({ path: `${SHOTS}/room-rail-owner.png` });
  await page.click(".chathead .roomdetailsbtn");
  await page.waitForSelector(".roompanel .memberrow", { timeout: 20000 });

  // ---- the same room, read by a plain member ----
  await fpage.click(".sidebar >> text=# paperwork");
  await fpage.click(".chathead .roomdetailsbtn");
  await fpage.waitForSelector('.roommembers .memberrow[data-member="Bramble"]', { timeout: 25000 });
  const memberSeesBramble = fpage.locator('.roommembers .memberrow[data-member="Bramble"]');
  const memberSeesScout = fpage.locator('.roommembers .memberrow[data-member="Scout"] .agentowner');
  ok("everybody in the room is told who an agent belongs to, not only the person who runs it",
    /Your agent/.test(await memberSeesBramble.locator(".agentowner .whose").innerText()) &&
    (await memberSeesBramble.locator(".agentowner").getAttribute("data-mine")) === "yes" &&
    (await memberSeesScout.getAttribute("data-owner")) === "Vikas" &&
    /Vikas can read this room/i.test(await memberSeesScout.locator(".readsroom").innerText()),
    (await memberSeesScout.innerText()).replace(/\s+/g, " ").trim());
  ok("a plain member is not offered the control that lets somebody in — it is not there to click",
    (await fpage.locator(".chathead .addmember").count()) === 0 &&
    (await fpage.locator(".chathead select").count()) === 0);
  await fpage.screenshot({ path: `${SHOTS}/room-members-member.png` });

  // ---- membership is a HISTORY now: two rows, not one (§11.6) ----
  const memberKeys = await fpage.$$eval(".roommembers .memberrow",
    rs => rs.map(r => r.dataset.memberkey ?? ""));
  ok("every member row is keyed by the membership itself, so two spells in one room cannot collapse into one",
    memberKeys.length >= 2 && memberKeys.every(k => /^[^:]+:\d+$/.test(k)) &&
    new Set(memberKeys).size === memberKeys.length,
    memberKeys.join(" "));
  const priyaBack = fpage.locator('.roommembers .memberrow[data-member="Priya"]');
  const priyaSecondJoin = Number(await priyaBack.getAttribute("data-joined"));
  ok("coming back into a room is a NEW membership, and the list shows the one she has now",
    (await priyaBack.count()) === 1 && priyaSecondJoin > priyaFirstJoin,
    `first ${priyaFirstJoin} · now ${priyaSecondJoin}`);
  ok("somebody let back in comes back as a plain member — power is not restored by the door",
    (await priyaBack.locator(".rolename").getAttribute("data-role")) === "member",
    (await priyaBack.locator(".rl").innerText()).replace(/\s+/g, " ").trim());

  // ---- nothing new pushes the page sideways, in either look ----
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await fpage.setViewportSize({ width, height });
      await fpage.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await fpage.waitForTimeout(220);
      const over = await fpage.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      ok(`a member list naming an agent's owner does not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await fpage.screenshot({ path: `${SHOTS}/room-owner-named-${theme}.png` });
      }
    }
  }
  await fpage.setViewportSize({ width: 1280, height: 800 });
  await fpage.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  /* ================= ROLES CAN BE CHANGED, NOT ONLY READ (finding #21) =======

     `removeMember` and `setMemberRole` existed on the hub with nothing on
     screen to reach them. The rule these checks hold to is the same one the
     rest of the panel follows: a control is offered only where the hub would
     say yes, and it says what the change MEANS before it is made. */

  // ---- a plain member is offered neither, because neither would be allowed ----
  ok("somebody who does not run the room is offered no way to change roles or take people out",
    (await fpage.locator(".roompanel .memberopen").count()) === 0 &&
    (await fpage.locator(".roompanel .memberout").count()) === 0 &&
    (await fpage.locator(".roompanel .roleopt").count()) === 0);
  await fpage.click(".roompanel .roomclose");

  // ---- the person who runs it is ----
  const priyaRow = page.locator('.roommembers .memberrow[data-member="Priya"]');
  await page.waitForSelector('.roommembers .memberrow[data-member="Priya"]', { timeout: 20000 });
  ok("the person who runs the room is offered a way to change what somebody can do here",
    (await priyaRow.locator(".memberopen").count()) === 1);
  /* Never a button whose one outcome is a refusal: the hub refuses to let the
     owner stand themselves down, and an agent has no screen to run a room from,
     so neither is offered a role at all. */
  ok("the owner is not offered a way to demote themselves — the hub would refuse it, so it is not there",
    (await page.locator('.memberrow[data-member="Vikas"] .memberopen').count()) === 0);
  await page.locator('.roommembers .memberrow[data-member="Bramble"] .memberopen').click();
  await page.waitForSelector('.memberask[data-manage="Bramble"]', { timeout: 15000 });
  ok("an agent can be taken out of a room but is never offered a role — a role is a job on a screen",
    (await page.locator('.memberask[data-manage="Bramble"] .roleopt').count()) === 0 &&
    (await page.locator('.memberask[data-manage="Bramble"] .memberout').count()) === 1);
  await page.locator('.roommembers .memberrow[data-member="Bramble"] .memberopen').click();

  await priyaRow.locator(".memberopen").click();
  await page.waitForSelector('.memberask[data-manage="Priya"]', { timeout: 15000 });
  const roleOpts = await page.$$eval('.memberask[data-manage="Priya"] .roleopt', bs => bs.map(b => ({
    role: b.dataset.setrole,
    name: b.querySelector("b")?.textContent?.trim() ?? "",
    means: b.querySelector("span")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    on: b.getAttribute("aria-pressed") === "true",
  })));
  ok("every role on offer says what picking it would actually do",
    roleOpts.length === 3 &&
    roleOpts.map(o => o.role).join(",") === "owner,admin,member" &&
    roleOpts.every(o => o.means.length > 30) &&
    /Hands this room over/.test(roleOpts.find(o => o.role === "owner").means) &&
    roleOpts.find(o => o.role === "member").on === true,
    roleOpts.map(o => `${o.role}:${o.means.slice(0, 34)}`).join(" | "));
  await page.screenshot({ path: `${SHOTS}/fix2-roles-offered.png` });

  // ---- and changing one really reaches the hub and comes back ----
  await page.click('.memberask[data-manage="Priya"] .roleopt[data-setrole="admin"]');
  await waitFor(page, () => document.querySelector(
    '.roommembers .memberrow[data-member="Priya"] .rolename')?.dataset.role === "admin",
  undefined, { timeout: 20000, what: "the new role to come back from the hub" });
  ok("a role changed on screen is changed at the hub, and the room says so",
    (await priyaRow.locator(".rolename").getAttribute("data-role")) === "admin" &&
    /Helps run it/.test(await priyaRow.locator(".rolename").innerText()));
  // and the person it was done to is told, on their own screen
  await waitFor(fpage, () => document.querySelectorAll(
    ".roompanel .memberopen").length > 0 || true, undefined, { timeout: 5000, what: "a moment" });
  await fpage.click(".chathead .roomdetailsbtn");
  await fpage.waitForSelector(".roompanel .memberrow", { timeout: 20000 });
  await waitFor(fpage, () => document.querySelector(
    '.roommembers .memberrow[data-member="Priya"] .rolename')?.dataset.role === "admin",
  undefined, { timeout: 20000, what: "the new role to reach the person it was given to" });
  ok("being given a job in a room reaches that person's own screen, and brings the controls with it",
    (await fpage.locator(".roompanel .memberopen").count()) >= 1 &&
    (await fpage.locator(".roompanel .roomarchive").count()) === 1);
  await fpage.screenshot({ path: `${SHOTS}/fix2-role-arrived.png` });
  /* An admin may take people out but may NOT hand out roles — that is the
     owner's alone at the hub — and may not throw out the person who runs the
     room. Neither is offered, so on the owner's row there is nothing to press
     at all. */
  ok("somebody helping run a room is offered nothing at all on the row of the person who runs it",
    (await fpage.locator('.roommembers .memberrow[data-member="Vikas"] .memberopen').count()) === 0 &&
    (await fpage.locator('.roommembers .memberrow[data-member="Vikas"] .memberout').count()) === 0);
  /* …but may take out an ordinary member, which is exactly what an admin is
     for — so the control IS there where the hub would allow it. */
  await fpage.locator('.roommembers .memberrow[data-member="Bramble"] .memberopen').click();
  await fpage.waitForSelector('.memberask[data-manage="Bramble"]', { timeout: 15000 });
  ok("and IS offered the one thing an admin may do — taking an ordinary member out — with no role picker",
    (await fpage.locator('.memberask[data-manage="Bramble"] .memberout').count()) === 1 &&
    (await fpage.locator('.memberask[data-manage="Bramble"] .roleopt').count()) === 0);
  await fpage.locator('.roommembers .memberrow[data-member="Bramble"] .memberopen').click();
  await fpage.click(".roompanel .roomclose");

  // ---- taking somebody out says what it means before it happens ----
  await page.locator('.roommembers .memberrow[data-member="Bramble"] .memberopen').click();
  await page.click('.memberask[data-manage="Bramble"] .memberout');
  await page.waitForSelector(".memberoutask", { timeout: 15000 });
  const outSays = (await page.locator(".memberoutask span").innerText()).replace(/\s+/g, " ").trim();
  ok("taking somebody out says what it costs them before it is done, and that nothing is deleted",
    /stops answering here/.test(outSays) &&
    /Priya stops seeing this room|whoever owns it stops seeing/.test(outSays) &&
    /Everything already said stays/.test(outSays), outSays);
  await page.screenshot({ path: `${SHOTS}/fix2-remove-asks.png` });
  await page.click(".memberoutask .memberout-yes");
  await waitFor(page, () => document.querySelectorAll(
    '.roommembers .memberrow[data-member="Bramble"]').length === 0,
  undefined, { timeout: 20000, what: "the agent to be taken out of the room" });
  ok("taking somebody out reaches the hub and the room list stops showing them",
    (await page.locator('.roommembers .memberrow[data-member="Bramble"]').count()) === 0);
  await page.screenshot({ path: `${SHOTS}/fix2-removed.png` });

  /* ---- nothing new pushes the panel sideways ---- */
  await page.locator('.roommembers .memberrow[data-member="Priya"] .memberopen').click();
  await page.waitForSelector('.memberask[data-manage="Priya"]', { timeout: 15000 });
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(220);
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      ok(`the role controls do not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) await page.screenshot({ path: `${SHOTS}/fix2-roles-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.locator('.roommembers .memberrow[data-member="Priya"] .memberopen').click();
  await page.click(".roompanel .roomclose");

  /* ================= A REPLY MUST BE MATCHABLE TO ITS REQUEST ===============

     Findings #9 and #18, and they are ONE finding: an answer from the hub that
     is applied to the wrong question. An `error` frame carries no echo of what
     it refuses, so an unrelated refusal was pinned on whatever happened to be
     waiting — a file that had reached the hub perfectly well could never be
     attached to anything afterwards. The same shape, the other way round: a
     `searchResults` frame was applied whether or not anybody was still asking.

     BOTH ARE REPRODUCED FIRST. Each check below proves the two things really
     overlapped before it claims the fix held; a run in which they never
     overlapped fails rather than passing on a technicality. */

  // ---- a message this person did NOT write, so a refusal can be provoked ----
  await fpage.click(".sidebar >> text=# paperwork");
  await fpage.fill(".composer textarea", "the villa deposit receipt is filed");
  await fpage.press(".composer textarea", "Enter");
  await page.waitForSelector('.msg p:has-text("villa deposit receipt")', { timeout: 25000 });
  const notMine = await page.getAttribute('.msg:has-text("villa deposit receipt")', "data-msg");

  /* TWO files, because that is what the bug needs and it is what people do.
     Uploads go up ONE AT A TIME, so the second waits its turn — and the moment
     the first is answered the second is put on the wire inside that very
     handler. A refusal that was already queued behind the first then landed on
     the second, which had done nothing wrong: it flipped to failed carrying a
     sentence about somebody else's message, and its real answer arrived to find
     nobody waiting, so the file could never be attached to anything.

     The first file is deliberately large and RANDOM — a solid-colour PNG
     deflates to almost nothing, and a hub that answers instantly cannot be
     caught in the middle of anything. */
  const HEAVY = crypto.randomBytes(ATTACHMENT_LIMITS.bytes - 200_000);
  const LIGHT = Buffer.from("deposit,7400\nbalance,2600\n", "utf8");
  /* The hub's answers to uploads are held from here until the refusal has
     landed, so the overlap the bug needs is a state the app is HELD in rather
     than a moment this script has to be lucky enough to catch. See the note on
     `__c9hold` where the browser context is made. */
  await page.evaluate(() => window.__c9hold.hold(["attachment"]));
  /* The heavy one goes first and on its own, so it is the one the hub is busy
     with. The light one is picked only once the heavy one is on the wire — it
     is read in a moment and then QUEUED, waiting for the wire rather than on
     it. */
  await page.setInputFiles(".composer input.filepick", {
    name: "survey-scan.bin", mimeType: "application/octet-stream", buffer: HEAVY,
  });
  await page.waitForFunction(
    () => window.cloud9Wire.outstanding().filter(k => k === "uploadAttachment").length === 1,
    null, { timeout: 40000 });
  await page.setInputFiles(".composer input.filepick", {
    name: "deposit-note.bin", mimeType: "application/octet-stream", buffer: LIGHT,
  });
  /* THE EXACT STATE THE BUG NEEDS: one file on the wire and unanswered, and a
     second already READ and queued behind it. A queued file is put on the wire
     from inside the handler that answers the one ahead of it — so a refusal
     that was queued behind the first arrives to find the second waiting, and
     that is the one that used to be blamed for it.

     Waiting for a second TILE is not enough, and that hole made this check pass
     against the very bug it exists to catch: a tile appears the moment a file is
     PICKED, and a file that has not finished being read cannot be pumped and so
     cannot be blamed. Both halves are the app's own state, waited for. */
  await page.waitForFunction(
    () => window.cloud9Files.queued() === 1 &&
      window.cloud9Wire.outstanding().filter(k => k === "uploadAttachment").length === 1,
    null, { timeout: 40000 });
  const overlapped = await page.evaluate(messageId => {
    const wire = window.cloud9Wire;
    // Provoke a refusal that has nothing to do with either file. editMessage is
    // fire-and-forget now, so it must reach the hub WITHOUT stealing a lifecycle
    // ledger row from the upload that is genuinely awaiting an answer.
    wire.ask({ type: "editMessage", messageId, text: "changing words that are not mine" });
    return {
      onTheWire: wire.outstanding().filter(k => k === "uploadAttachment").length,
      queuedBehind: window.cloud9Files.queued(),
      asked: wire.outstanding(),
    };
  }, notMine);
  ok("REPRODUCED: a refusal was provoked with one file on the wire and a second read and queued behind it",
    overlapped.onTheWire === 1 && overlapped.queuedBehind === 1 &&
    overlapped.asked.includes("uploadAttachment") && !overlapped.asked.includes("editMessage"),
    JSON.stringify(overlapped));

  /* The refusal must ARRIVE while the two are still overlapped — that is the
     whole point — so it is read here, before the hub's held answers are let
     through, rather than hoped to still be on screen several checks later. */
  const refusal = (await page.locator(".toast .toast-text").innerText({ timeout: 30000 })).trim();
  const letThrough = await page.evaluate(() => window.__c9hold.release());
  ok("REPRODUCED: the refusal really did land while the upload was still unanswered",
    letThrough >= 1, `${letThrough} held answer(s) released afterwards`);

  /* Waited on both files STOPPING — landed or refused — rather than on both
     landing, so a file the refusal wrongly killed is reported by the check
     below instead of being lost in a timeout. */
  await page.waitForFunction(() => document.querySelectorAll(
    ".uploadtray .uptile.done, .uploadtray .uptile.failed").length === 2,
  null, { timeout: 60000 });
  ok("the unrelated refusal touches NEITHER file — both land and both are ready to send",
    (await page.locator(".uploadtray .uptile.failed").count()) === 0 &&
    (await page.locator(".uploadtray .uptile.done").count()) === 2,
    (await page.locator(".uploadtray").innerText()).replace(/\s+/g, " ").trim().slice(0, 120));
  ok("and the refusal is still said on screen, in the hub's own words",
    /can only change your own messages/.test(refusal), refusal);
  await page.screenshot({ path: `${SHOTS}/fix2-upload-survives.png` });

  /* ---- ENTER MUST NEVER THROW AWAY A FILE THAT IS STILL GOING UP (#17) ----
     The tray is emptied when a message goes, and it used to take whatever had
     not landed yet with it: the upload finished into nothing and nobody was
     told. Pressing Enter mid-upload now refuses in a sentence and leaves the
     file exactly where it is. */
  await page.fill(".composer textarea", "the survey and the note");
  await page.click(".composer .primary.small");
  await page.waitForSelector('.msg .fileblock[data-file="survey-scan.bin"]', { timeout: 30000 });
  ok("the files that survived an unrelated refusal really go out with the message",
    (await page.locator('.msg .fileblock[data-file="survey-scan.bin"]').count()) === 1 &&
    (await page.locator('.msg .fileblock[data-file="deposit-note.bin"]').count()) === 1);

  // as big as the hub will take, so the window the press must fall inside is
  // as wide as it can honestly be made
  const SECOND = crypto.randomBytes(ATTACHMENT_LIMITS.bytes - 300_000);
  await page.setInputFiles(".composer input.filepick", {
    name: "roof-survey.bin", mimeType: "application/octet-stream", buffer: SECOND,
  });
  /* The press happens IN THE PAGE, because the window it has to fall inside is
     shorter than a round trip out to this script and back. It is dispatched at
     the composer's own textarea and goes through the app's real `onKeyDown` —
     the same handler a finger reaches; only the browser's key delivery is
     stood in for. */
  const pressedEarly = await page.evaluate(async () => {
    const tile = () => document.querySelector('.uploadtray .uptile[data-upload="roof-survey.bin"]');
    const stillGoing = () => {
      const t = tile();
      return !!t && !t.classList.contains("done") && !t.classList.contains("failed");
    };
    if (!stillGoing()) return { reproduced: false, why: "the file had already landed" };
    const box = document.querySelector(".composer textarea");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(box, "sending this before the file is up");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    const waitingWhenPressed = stillGoing();
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // give whatever the press caused a chance to be drawn
    const until = Date.now() + 6000;
    let said = "";
    while (Date.now() < until) {
      said = document.querySelector(".toast .toast-text")?.textContent?.trim() ?? "";
      if (/still going up/.test(said)) break;
      await new Promise(r => setTimeout(r, 20));
    }
    /* The send button is read HERE, at the instant of the refusal, and not out
       in the script afterwards. Read afterwards it is a race the checker
       usually loses on a busy machine: the upload finishes, the button flips
       back to "Send with 1 file", and a correct app is failed for being quick.
       The claim is unchanged — while it is refusing, the button must say what
       it is waiting for — it is only asked at the moment it is true. */
    const btn = document.querySelector(".composer .sendbtn");
    return {
      reproduced: true, waitingWhenPressed, said,
      stillThere: !!tile(),
      wordsKept: box.value,
      stillGoingWhenRead: stillGoing(),
      sendWaiting: btn?.dataset.waiting ?? "",
      sendSays: (btn?.textContent ?? "").trim(),
      wentAnyway: [...document.querySelectorAll(".msg p")]
        .filter(p => p.textContent.includes("sending this before the file is up")).length,
    };
  });
  ok("REPRODUCED: the Enter key was pressed while a file was genuinely still on its way up",
    pressedEarly.reproduced === true && pressedEarly.waitingWhenPressed === true,
    JSON.stringify(pressedEarly));
  ok("Enter mid-upload refuses in a sentence instead of throwing the file away in silence",
    /still going up/.test(pressedEarly.said) && pressedEarly.stillThere === true &&
    pressedEarly.wentAnyway === 0 &&
    pressedEarly.wordsKept === "sending this before the file is up",
    JSON.stringify(pressedEarly));
  ok("and the send button says it is waiting for the file rather than offering to send without it",
    pressedEarly.stillGoingWhenRead === true &&
    pressedEarly.sendWaiting === "file" && /Waiting for a file/.test(pressedEarly.sendSays),
    `${pressedEarly.sendSays} (data-waiting=${pressedEarly.sendWaiting}, ` +
    `still going: ${pressedEarly.stillGoingWhenRead})`);
  await page.screenshot({ path: `${SHOTS}/fix2-enter-waits.png` });

  // and once it lands, the very same message goes with the file it was holding
  await page.waitForSelector('.uploadtray .uptile[data-upload="roof-survey.bin"].done',
    { timeout: 40000 });
  await page.click(".composer .primary.small");
  await page.waitForSelector('.msg .fileblock[data-file="roof-survey.bin"]', { timeout: 30000 });
  ok("nothing was lost by waiting — the file goes out with the words that were typed",
    (await page.locator('.msg .fileblock[data-file="roof-survey.bin"]').count()) === 1 &&
    (await page.locator('.msg p:has-text("sending this before the file is up")').count()) === 1);

  /* ---- a search cleared before its answer arrives (#18) ---- */
  const searchRace = await page.evaluate(async () => {
    const wire = window.cloud9Wire;
    const before = wire.seen().searchResults ?? 0;
    wire.search("villa");        // ask
    wire.clearSearch();          // and call it off, in the same tick
    const deadline = Date.now() + 20000;
    while ((wire.seen().searchResults ?? 0) <= before && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    await new Promise(r => setTimeout(r, 400)); // let anything wrong settle in
    return {
      answersArrived: (wire.seen().searchResults ?? 0) - before,
      searchOnScreen: wire.searching(),
      hitsOnScreen: document.querySelectorAll(".searchhit").length,
    };
  });
  ok("REPRODUCED: the answer to the cleared search really did come back from the hub",
    searchRace.answersArrived >= 1, `${searchRace.answersArrived} searchResults frame(s)`);
  ok("a search called off before its answer arrives stays gone — nothing is brought back to life",
    searchRace.searchOnScreen === null && searchRace.hitsOnScreen === 0,
    JSON.stringify(searchRace));

  /* ================= ONE HELD FILE, SHOWN IN TWO PLACES (#16) ===============

     A `blob:` URL lives until it is revoked, and the same message is drawn in
     two places at once — in the room and again in an open thread. Whichever
     copy went away first used to revoke it, so closing a thread panel wiped the
     picture out of the room behind it. Ownership of a held thing cannot be
     "whoever let go of it first": every copy takes a hold and the LAST one to
     let go frees the bytes. */
  const planMsg = page.locator('.msg:has-text("here is the site plan and the ledger")').last();
  await planMsg.waitFor({ timeout: 20000 });
  await planMsg.hover();
  await planMsg.locator(".ma.reply").click();
  await page.waitForSelector(".threadpanel", { timeout: 20000 });
  await page.waitForSelector('.threadpanel .fileblock[data-file="site-plan.png"]',
    { timeout: 20000 });
  const planId = await page.getAttribute(
    '.msgs .fileblock[data-file="site-plan.png"]', "data-attachment");
  const holders = () => page.evaluate(id => window.cloud9Files.holders(id), planId);
  ok("REPRODUCED: the same picture really is drawn in two places at once, and held by both",
    (await page.locator('.fileblock[data-file="site-plan.png"]').count()) === 2 &&
    (await holders()) === 2, `${await holders()} places holding it`);

  await page.click('.msgs .fileblock[data-file="site-plan.png"] .fileopen');
  await page.waitForSelector('.msgs .fileblock[data-file="site-plan.png"] .fileshot img',
    { timeout: 20000 });
  await page.click(".threadpanel .threadclose");
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 15000 });
  await page.waitForTimeout(500);
  const stillDrawn = await page.evaluate(() => {
    const img = document.querySelector('.msgs .fileblock[data-file="site-plan.png"] .fileshot img');
    if (!img) return null;
    return { w: img.naturalWidth, h: img.naturalHeight, blob: img.src.startsWith("blob:"), done: img.complete };
  });
  ok("closing the thread does NOT take the picture out of the room behind it",
    !!stillDrawn && stillDrawn.blob && stillDrawn.done && stillDrawn.w === 180 && stillDrawn.h === 120,
    JSON.stringify(stillDrawn));
  ok("and the file is held once now, by the one place still showing it",
    (await holders()) === 1, `${await holders()} holder(s)`);
  await page.screenshot({ path: `${SHOTS}/fix2-picture-survives-thread.png` });

  /* ---- and the LAST place letting go really does free it ---- */
  await page.click(".sidebar >> text=# general");
  await page.waitForTimeout(600);
  ok("when the last place showing a file goes, the bytes are let go",
    (await holders()) === 0 &&
    !(await page.evaluate(() => window.cloud9Files.opened())).includes(planId),
    `${await holders()} holder(s) left`);
  await page.click(".sidebar >> text=# paperwork");
  await page.waitForSelector('.msg .fileblock[data-file="site-plan.png"]', { timeout: 20000 });

  /* ================= A NUMBER WITH A CEILING (#P3) ========================= */
  const capSays = await page.evaluate(() => {
    const w = window.cloud9Wire;
    const cap = w.unreadCeiling();
    return { cap, at: w.unreadSays(cap), over: w.unreadSays(cap + 40), under: w.unreadSays(12) };
  });
  ok("a count that has hit the ceiling is never printed as though it were exact",
    capSays.at === `${capSays.cap - 1}+` && capSays.over === `${capSays.cap - 1}+` &&
    capSays.under === "12", JSON.stringify(capSays));

  /* ---- and a real, uncapped count on the rail is still the plain truth ---- */
  await fpage.click(".sidebar >> text=# paperwork");
  await fpage.fill(".composer textarea", "one more for the pile");
  await fpage.press(".composer textarea", "Enter");
  await waitFor(page, () => (document.querySelector(
    '.sidebar .side-item[data-channel="paperwork"] .cnt.hot')?.textContent ?? "") !== "",
  undefined, { timeout: 25000, what: "an unread mark to appear on the rail" });
  const badge = await page.$eval('.sidebar .side-item[data-channel="paperwork"] .cnt.hot', el => ({
    says: el.textContent.trim(), capped: el.dataset.capped ?? "", label: el.getAttribute("aria-label"),
  }));
  ok("an unread count below the ceiling is said exactly, with no plus and no hedging",
    /^\d+$/.test(badge.says) && badge.capped === "" && /^\d+ new$/.test(badge.label),
    JSON.stringify(badge));

  /* ================= A HIGHLIGHT MUST BE ONE THE HUB REALLY FOUND ========== */
  await page.click(".sidebar >> text=# paperwork");
  await page.fill(".composer textarea", "the «gazebo» quote came in under budget");
  await page.press(".composer textarea", "Enter");
  await page.waitForSelector('.msg p:has-text("quote came in under budget")', { timeout: 25000 });
  await page.evaluate(() => window.cloud9Menu.run("search"));
  await page.waitForSelector(".searchpanel", { timeout: 10000 });
  /* The panel now opens on EVERYTHING (feature 3). These older checks are about
     the message-only question — the one door that understands `in:` and
     `from:` — so they walk to it the way a person would, by clicking it. */
  await page.click('.scopepill[data-scope="messages"]');
  await page.fill(".search-input", "gazebo");
  await page.waitForSelector(".searchhit", { timeout: 25000 });
  await page.waitForTimeout(400);
  const marked = await page.$eval(".searchhit .snippet", el => ({
    mode: el.dataset.marked,
    marks: el.querySelectorAll("mark").length,
    text: el.textContent,
  }));
  ok("a message that contains « » is not given a highlight it never earned, and no stray bracket is drawn",
    marked.mode === "plain" && marked.marks === 0 &&
    marked.text.includes("gazebo") && !/«»|»«/.test(marked.text),
    JSON.stringify(marked));
  await page.screenshot({ path: `${SHOTS}/fix2-snippet-honest.png` });

  // and an ordinary message is still highlighted, so the fix did not just
  // switch highlighting off
  await page.fill(".search-input", "ledger");
  await waitFor(page, () => [...document.querySelectorAll(".searchhit .snippet")]
    .some(s => s.dataset.marked === "marks"), undefined,
  { timeout: 25000, what: "a result whose marks can be trusted" });
  ok("an ordinary result is still highlighted where the hub really found the word",
    (await page.locator('.searchhit .snippet[data-marked="marks"] mark').count()) >= 1);

  /* ---- ESCAPE DOES NOT DEPEND ON WHERE THE FOCUS IS ----
     Search's Escape used to live on an `onKeyDown` on the panel, so it worked
     only while the cursor was still in the box — one of the five different
     answers the app had to one question. The focus is taken away from the box on
     purpose here before the key is pressed. */
  await page.evaluate(() => document.activeElement?.blur());
  ok("search is on the one Escape owner's stack, whatever holds the focus",
    (await page.evaluate(() => window.cloud9Escape.stacked())) === 1 &&
    (await page.evaluate(() => document.activeElement === document.body ||
      !document.activeElement?.closest(".searchpanel"))));
  await page.keyboard.press("Escape");
  await page.waitForSelector(".searchpanel", { state: "detached", timeout: 10000 });
  ok("ESCAPE CLOSES SEARCH even with nothing in the app focused",
    (await page.locator(".searchpanel").count()) === 0 &&
    (await page.evaluate(() => window.cloud9Escape.stacked())) === 0);

  /* ---- and the newest overlay closes FIRST, which is what a person means ----
     Two overlays at once is the case a per-overlay handler cannot get right: the
     palette used to be closed from under whatever was opened on top of it. */
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".qc-input", { timeout: 10000 });
  await page.evaluate(() => window.cloud9Menu.run("new-channel"));
  await page.waitForSelector('.panel input[placeholder="trip-goa"]', { timeout: 10000 });
  ok("with two overlays open, both are on the stack and neither is guessing",
    (await page.evaluate(() => window.cloud9Escape.stacked())) === 2);
  await page.keyboard.press("Escape");
  await page.waitForSelector('.panel input[placeholder="trip-goa"]',
    { state: "detached", timeout: 10000 });
  ok("Escape closes the newest one and leaves the one underneath exactly where it was",
    (await page.locator('.panel input[placeholder="trip-goa"]').count()) === 0 &&
    (await page.locator(".qc-input").count()) === 1 &&
    (await page.evaluate(() => window.cloud9Escape.stacked())) === 1);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".qc-input", { state: "detached", timeout: 10000 });
  ok("and the second press closes that one, leaving nothing on the stack",
    (await page.locator(".qc-input").count()) === 0 &&
    (await page.evaluate(() => window.cloud9Escape.stacked())) === 0);

  /* ================= THE VIEW HAS ONE OWNER (#19) ==========================

     Rule 2 (an older page must not move the words under the reader) used to be
     undone by rule 1 (a new message follows a reader who is at the bottom):
     layout effects run first, so rule 1's guard never saw rule 2's anchor and
     followed anyway. Walking back to a search result therefore snapped to the
     newest message on every page it loaded. The reader is put a little way off
     the bottom — near enough that rule 1 still considers them "at the bottom",
     far enough that rule 1 firing would be unmistakable. */
  /* A conversation LONG ENOUGH that walking back to the target takes several
     pages. One page back is not a test of this at all: the snap and the jump
     would land in the same commit, before the browser paints, and the bug would
     be invisible to anything watching the screen. The messages are sent through
     the app's own `send`, because typing a hundred and sixty of them one key at
     a time would take longer than the rest of this suite. */
  await page.click('button[title="New channel"]');
  await page.fill('.panel input[placeholder="trip-goa"]', "longhaul");
  await page.click(".panel .foot >> text=Create");
  await page.waitForSelector(".sidebar >> text=# longhaul", { timeout: 20000 });
  await page.click("text=# longhaul");
  const seeded = await page.evaluate(async () => {
    const wire = window.cloud9Wire;
    const id = wire.channels().find(c => c.name === "longhaul").id;
    // the one message with this word in it, said first and never repeated
    wire.ask({ type: "send", channelId: id, text: "the marker message nobody repeats" });
    for (let i = 1; i <= 160; i++) {
      wire.ask({ type: "send", channelId: id, text: `longhaul line ${i}` });
      if (i % 20 === 0) await new Promise(r => setTimeout(r, 60));
    }
    return id;
  });
  await page.waitForSelector('.msg:has-text("longhaul line 160")', { timeout: 60000 });
  void seeded;

  // a reload is the honest starting point: only the newest page is on screen
  await page.reload();
  await page.waitForSelector(".sidebar >> text=# longhaul", { timeout: 25000 });
  await page.click("text=# longhaul");
  await page.waitForSelector('.msg:has-text("longhaul line 160")', { timeout: 25000 });
  await page.waitForTimeout(900);
  const startedWith = await page.evaluate(async () => {
    const el = document.querySelector(".msgs");
    el.scrollTop = el.scrollHeight;                        // at the bottom first
    await new Promise(r => setTimeout(r, 120));            // let the app see it
    el.scrollTop = el.scrollHeight - el.clientHeight - 40; // 40px up: still "at the bottom"
    await new Promise(r => setTimeout(r, 120));
    /* Sampled every frame for as long as the walk could possibly take. The
       search overlay takes the message list off screen for a moment, so a
       sampler that stopped the first time it could not find one would only ever
       have watched the part before the click — which is the part that proves
       nothing. It keeps its own frame budget instead. */
    /* WATCH THE RULE ITSELF, not the paint it leaves behind.
       The follow-to-bottom rule is the only thing that calls `scrollTo` on the
       message list — keeping the reader's place sets `scrollTop` directly, and
       going to a particular message uses `scrollIntoView`. So a call here IS
       the rule firing, whether or not the browser ever painted the result. */
    window.__followed = [];
    const realScrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (...args) {
      if (this.classList && this.classList.contains("msgs")) {
        window.__followed.push(Math.round((args[0] && args[0].top) ?? args[1] ?? -1));
      }
      return realScrollTo.apply(this, args);
    };
    window.__fromBottom = [];
    const note = () => {
      const m = document.querySelector(".msgs");
      if (m) window.__fromBottom.push(Math.round(m.scrollHeight - m.scrollTop - m.clientHeight));
    };
    /* Sampled on the list's OWN scroll events as well as once a frame.
       Frames are a clock, and the clock made this check lie: on a run where the
       walk finished inside sixteen frames every sample taken was perfect and the
       check failed anyway, on "not enough samples". A scroll event is the app
       moving the view — the thing actually being watched — so no movement can
       now happen without being sampled, however fast the walk is. Listened for
       in the capture phase at the document, because scroll events do not bubble
       and React may hand this list a different element than the one on screen
       now. */
    document.addEventListener("scroll", note, true);
    let frames = 0;
    const tick = () => { note(); if (++frames < 4000) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return { onScreen: document.querySelectorAll(".msgs .msg").length };
  });
  await page.evaluate(() => window.cloud9Menu.run("search"));
  await page.waitForSelector(".searchpanel", { timeout: 10000 });
  /* The panel now opens on EVERYTHING (feature 3). These older checks are about
     the message-only question — the one door that understands `in:` and
     `from:` — so they walk to it the way a person would, by clicking it. */
  await page.click('.scopepill[data-scope="messages"]');
  await page.fill(".search-input", "marker");
  await waitFor(page, () => document.querySelectorAll(".searchhit").length >= 1,
    undefined, { timeout: 25000, what: "the one marker message to be found" });
  const oldestHit = await page.locator(".searchhit").last().getAttribute("data-hit");
  const mustWalk = await page.evaluate(id =>
    document.querySelectorAll(`.msgs .msg[data-msg="${id}"]`).length === 0, oldestHit);
  ok("REPRODUCED: the message asked for is several pages further back than what is on screen, so pages must really be walked",
    mustWalk && startedWith.onScreen <= 50,
    `${startedWith.onScreen} of 161 messages on screen, target already loaded: ${!mustWalk}`);
  await page.locator(".searchhit").last().click();
  await page.waitForSelector(`.msgs .msg[data-msg="${oldestHit}"].litup`, { timeout: 30000 });
  const walk = await page.evaluate(() => {
    const m = document.querySelector(".msgs");
    const endedAt = m ? Math.round(m.scrollHeight - m.scrollTop - m.clientHeight) : -1;
    // one last reading, taken directly, so this can never depend on a sampler
    // having been given a slice of the machine at the right instant
    if (m) (window.__fromBottom ?? []).push(endedAt);
    const seen = window.__fromBottom ?? [];
    /* The reader was put 40px off the bottom — near enough that the
       follow-to-bottom rule still counts them as "at the bottom", so if it ever
       fired the view would be pinned to 0. */
    return {
      followedToBottom: (window.__followed ?? []).length,
      samples: seen.length,
      pinned: seen.filter(d => d <= 2).length,
      min: seen.length ? Math.min(...seen) : -1,
      max: seen.length ? Math.max(...seen) : -1,
      endedAt,
    };
  });
  /* What this check is really made of, and none of it is a clock:
     - `followedToBottom` counts CALLS to the follow-to-bottom rule, caught at
       the one function it uses. It cannot be missed however fast the walk was.
     - `pinned`/`min` say the view was never at the newest message at any moment
       anybody sampled.
     - `endedAt` says the reader finished a long way from the bottom, which is
       what proves pages were really walked back rather than nudged.
     It used to also demand more than twenty samples, which was nothing but a
     guess that the walk would be slow. It was not, on a machine with a spare
     moment, and the check failed a working app for it. */
  ok("walking back to a result never snaps the view to the newest message",
    walk.followedToBottom === 0 && walk.samples >= 1 && walk.pinned === 0
      && walk.min >= 30 && walk.endedAt >= 200,
    JSON.stringify(walk));
  ok("and the reader ends up on the message they asked for",
    (await page.locator(`.msgs .msg[data-msg="${oldestHit}"].litup`).count()) === 1);
  await page.screenshot({ path: `${SHOTS}/fix2-jump-holds.png` });
  await page.keyboard.press("Escape");

  /* ================= AND THE VIEW FOLLOWS HIM =================================

     HIS OWN WORDS: he types in a conversation and the view does not move to what
     he just said. Reproduced three ways before a line was changed, and it was
     never three bugs — it was one MISSING RULE with three faces:

       1. he had read back a little way, so the app had decided he was "not at
          the bottom", and then he SENT a message and was left where he was. His
          own message landed 1461px below the foot of a 591px list;
       2. everything that moves the bottom without adding a message was ignored —
          the file tray opening pushed the newest message 154px out of sight, a
          picture finishing loading pushed it 150px out, and the box growing as he
          types a second line does the same;
       3. when it did follow, it jumped.

     `useFollowToBottom` is the one owner of all of it, and it is the SAME owner
     finding #19 needed — which is why the checks above run first and must still
     pass: a wider follow rule that put the yank back would fail them.

     This walk starts exactly where the #19 walk left the reader: several pages
     back in a 161-message conversation, a long way from the newest message.
     That is the state his complaint lives in, and it was reached by the app's own
     search-and-jump rather than arranged here. */
  const viewNow = () => page.evaluate(() => {
    const m = document.querySelector(".msgs");
    const rows = [...m.querySelectorAll(".msg")];
    const last = rows[rows.length - 1];
    const lb = m.getBoundingClientRect();
    return {
      fromBottom: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight),
      /* WHERE THE VIEW ACTUALLY IS. The distance from the bottom is not that: a
         message arriving makes the list longer, so a view nobody moved is
         FURTHER from the bottom afterwards than it was before. Holding "nothing
         moved him" to an unchanged distance asserted the wrong thing and failed a
         working app for it. */
      scrollTop: Math.round(m.scrollTop),
      /* Where `scrollTop` would have to be for this list to be at its bottom.
         This is the number that MOVES when the box below the list grows or a row
         gets taller, and it moves without a single message arriving — which is
         the whole of face 2. */
      bottom: Math.round(m.scrollHeight - m.clientHeight),
      newestInSight: !!last && last.getBoundingClientRect().top < lb.bottom,
      followed: window.cloud9View.followed(),
      motion: window.cloud9View.motion(),
    };
  });

  const readBack = await viewNow();
  ok("REPRODUCED: he is a long way from the newest message, exactly as he is after reading back",
    readBack.fromBottom >= 200 && readBack.newestInSight === false,
    JSON.stringify(readBack));

  /* ---- a message ARRIVING must still not drag him off what he is reading ----
     The one thing a wider rule could break. It goes through the hub and comes
     back on an ordinary `message` frame, which is exactly how anybody else's
     would — the rule cannot tell whose it is, and must not. */
  const arrived = await page.evaluate(async () => {
    const wire = window.cloud9Wire;
    const id = wire.channels().find(c => c.name === "longhaul").id;
    const before = wire.seen().message ?? 0;
    wire.ask({ type: "send", channelId: id, text: "something arriving while he reads" });
    const until = Date.now() + 20000;
    while ((wire.seen().message ?? 0) <= before && Date.now() < until) {
      await new Promise(r => setTimeout(r, 25));
    }
    await new Promise(r => setTimeout(r, 700)); // let anything wrong happen
    return (wire.seen().message ?? 0) - before;
  });
  const afterArrival = await viewNow();
  ok("a message arriving while he has read back does NOT drag him down to it",
    arrived >= 1 && afterArrival.scrollTop === readBack.scrollTop &&
    afterArrival.followed.n === readBack.followed.n &&
    afterArrival.newestInSight === false,
    `${arrived} message frame(s); the view stayed at ${afterArrival.scrollTop} ` +
    `(was ${readBack.scrollTop}), and the rule did not fire (${afterArrival.followed.n} follows, ` +
    `same as before)`);

  /* ---- BUT SENDING IS NOT ARRIVING (face 1, the one he named) ----
     Nobody sends a message they do not want to see. Typed into the app's own box
     and sent with the app's own Enter, from exactly where he had read back to. */
  const spyOnFollow = () => page.evaluate(() => {
    window.__followBehavior = [];
    if (!window.__followSpy) {
      const real = Element.prototype.scrollTo;
      window.__followSpy = real;
      Element.prototype.scrollTo = function (...args) {
        if (this.classList && this.classList.contains("msgs")) {
          window.__followBehavior.push((args[0] && args[0].behavior) ?? "none");
        }
        return real.apply(this, args);
      };
    }
  });
  await spyOnFollow();
  await page.fill(".composer textarea", "and this is the thing I just typed");
  await page.press(".composer textarea", "Enter");
  await page.waitForSelector('.msg p:has-text("the thing I just typed")', { timeout: 25000 });
  await waitFor(page, () => {
    const m = document.querySelector(".msgs");
    return m.scrollHeight - m.scrollTop - m.clientHeight < 3;
  }, undefined, { timeout: 20000, what: "the view to follow what he just sent" });
  const afterSend = await page.evaluate(() => {
    const m = document.querySelector(".msgs");
    const mine = [...m.querySelectorAll(".msg")]
      .find(r => r.textContent.includes("the thing I just typed"));
    const lb = m.getBoundingClientRect();
    const mb = mine?.getBoundingClientRect();
    return {
      fromBottom: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight),
      mineInSight: !!mb && mb.top < lb.bottom && mb.bottom > lb.top,
      followed: window.cloud9View.followed(),
      behaviors: window.__followBehavior,
      motion: window.cloud9View.motion(),
      cursorInBox: document.activeElement === document.querySelector(".composer textarea"),
    };
  });
  ok("SENDING takes the view to what he just said, wherever he had read back to",
    afterSend.fromBottom < 3 && afterSend.mineInSight === true,
    JSON.stringify({ fromBottom: afterSend.fromBottom, mineInSight: afterSend.mineInSight }));
  /* ONE ACT OF HIS HONESTLY MOVES THE VIEW TWICE — he sent it ("sent"), and a
     moment later that same message comes back from the hub and lands while he is
     now at the bottom ("arrived"). So the claim is that a SEND is among the
     reasons since he pressed the key, not that it was the last one; reading only
     the last said his send had been an arrival, which is a true fact about the
     wrong event. */
  const sinceHePressed = afterSend.followed.recent.slice(
    -(afterSend.followed.n - afterArrival.followed.n));
  ok("and the rule says so in its own words — a send, not just an arrival",
    afterSend.followed.n > afterArrival.followed.n && sinceHePressed.includes("sent"),
    `${afterSend.followed.n - afterArrival.followed.n} follow(s) since he pressed Enter: ` +
    JSON.stringify(sinceHePressed));
  ok("it moved smoothly, because this machine has not asked for stillness (face 3)",
    afterSend.motion === "smooth" && afterSend.behaviors.length >= 1 &&
    afterSend.behaviors.every(b => b === "smooth"),
    `motion=${afterSend.motion} behaviours=${JSON.stringify(afterSend.behaviors)}`);
  await page.screenshot({ path: `${SHOTS}/fix3-follows-his-own-message.png` });

  /* ---- and a computer that has asked for no movement gets none ----
     Smooth is a courtesy, not a law. The setting is asked at the moment of every
     move by ONE function, so this changes the app's behaviour without a reload. */
  await page.emulateMedia({ reducedMotion: "reduce" });
  await spyOnFollow();
  await page.fill(".composer textarea", "sent with motion turned off");
  await page.press(".composer textarea", "Enter");
  await page.waitForSelector('.msg p:has-text("motion turned off")', { timeout: 25000 });
  await waitFor(page, () => {
    const m = document.querySelector(".msgs");
    return m.scrollHeight - m.scrollTop - m.clientHeight < 3;
  }, undefined, { timeout: 20000, what: "the view to follow with no animation" });
  const still = await page.evaluate(() => ({
    motion: window.cloud9View.motion(),
    behaviors: window.__followBehavior,
    fromBottom: (() => {
      const m = document.querySelector(".msgs");
      return Math.round(m.scrollHeight - m.scrollTop - m.clientHeight);
    })(),
  }));
  ok("a computer asking for no movement gets none — and still ends at the newest message",
    still.motion === "auto" && still.behaviors.length >= 1 &&
    still.behaviors.every(b => b === "auto") && still.fromBottom < 3,
    JSON.stringify(still));
  await page.emulateMedia({ reducedMotion: null });

  /* ---- face 2: THE BOTTOM MOVING IS THE TRIGGER, not a message arriving ----
     Picking a file opens the tray above the words, the box below the list grows,
     and the list shrinks by that much. Nothing arrives, nothing is sent, and the
     newest message used to slide out of sight. */
  const beforeTray = await viewNow();
  await page.setInputFiles(".composer input.filepick", {
    name: "follow-note.txt", mimeType: "text/plain", buffer: Buffer.from("keeping him at the bottom"),
  });
  await page.waitForSelector('.uploadtray .uptile[data-upload="follow-note.txt"]', { timeout: 20000 });
  await page.waitForTimeout(600);
  const afterTray = await viewNow();
  ok("REPRODUCED: opening the file tray really does move the bottom, with nothing arriving at all",
    afterTray.bottom > beforeTray.bottom + 20 &&
    afterTray.followed.n > beforeTray.followed.n,
    `bottom ${beforeTray.bottom} → ${afterTray.bottom}`);
  const sinceTray = afterTray.followed.recent.slice(
    -(afterTray.followed.n - beforeTray.followed.n));
  ok("and the view follows the bottom when the bottom is what moved",
    afterTray.fromBottom < 3 && afterTray.newestInSight === true &&
    sinceTray.length >= 1 && sinceTray.every(w => w === "resized"),
    `${afterTray.fromBottom}px from the bottom, reasons since: ${JSON.stringify(sinceTray)}`);

  /* ---- the box grows with what is in it ----
     It was `rows={1}` and nothing else, so a five-line message was typed into a
     one-line slot with its own hidden scrollbar: he could see the line he was on
     and none of the ones above it. And the list shrinks as it grows, which is
     the very thing the rule above is watching for. */
  const oneLine = await page.$eval(".composer textarea", ta => Math.round(ta.getBoundingClientRect().height));
  await page.fill(".composer textarea", "one\ntwo\nthree\nfour\nfive");
  await page.waitForTimeout(500);
  const fiveLines = await page.$eval(".composer textarea",
    ta => ({ h: Math.round(ta.getBoundingClientRect().height), scrollH: ta.scrollHeight }));
  const whileTyping = await viewNow();
  ok("the box grows with what is typed into it, and the newest message stays in sight while it does",
    fiveLines.h >= oneLine * 3 && fiveLines.h >= fiveLines.scrollH - 2 &&
    whileTyping.fromBottom < 3 && whileTyping.newestInSight === true,
    `${oneLine}px empty → ${fiveLines.h}px for five lines (content ${fiveLines.scrollH}px), ` +
    `${whileTyping.fromBottom}px from the bottom`);
  await page.screenshot({ path: `${SHOTS}/fix3-box-grows.png` });

  /* ---- and the cursor stays where he is typing, whichever way he sends ----
     Enter always left it there; the Send BUTTON took the focus with it, so the
     next thing he typed went nowhere and he had to click back into the box. */
  await page.waitForSelector('.uploadtray .uptile[data-upload="follow-note.txt"].done', { timeout: 30000 });
  await page.fill(".composer textarea", "sent with the button, not the key");
  await page.click(".composer .primary.small");
  await page.waitForSelector('.msg p:has-text("sent with the button")', { timeout: 25000 });
  /* Waited on the movement HAVING FINISHED rather than measured a fixed moment
     after the click: a smooth scroll is still settling for a few hundred
     milliseconds, and a reading taken inside that window failed a working app on
     six pixels. */
  await waitFor(page, () => {
    const m = document.querySelector(".msgs");
    return m.scrollHeight - m.scrollTop - m.clientHeight < 3;
  }, undefined, { timeout: 20000, what: "the view to settle after the button was clicked" });
  const afterButton = await page.evaluate(() => ({
    cursorInBox: document.activeElement === document.querySelector(".composer textarea"),
    boxHeight: Math.round(document.querySelector(".composer textarea").getBoundingClientRect().height),
    fromBottom: (() => {
      const m = document.querySelector(".msgs");
      return Math.round(m.scrollHeight - m.scrollTop - m.clientHeight);
    })(),
  }));
  ok("clicking Send leaves the cursor in the box, and the box back to one line",
    afterButton.cursorInBox === true && afterButton.boxHeight <= oneLine + 2 &&
    afterButton.fromBottom < 3,
    JSON.stringify(afterButton));

  /* ---- face 2 again, the way he will actually meet it: A PICTURE FINISHING ----
     A row is short until its picture is drawn and then it is 120px taller. The
     rule watches every ROW as well as the list, so this is the same one owner and
     not a second answer. */
  const PLAN2 = pngOfSolidColour(180, 120, [70, 40, 18]);
  await page.setInputFiles(".composer input.filepick", {
    name: "late-picture.png", mimeType: "image/png", buffer: PLAN2,
  });
  await page.waitForSelector('.uploadtray .uptile[data-upload="late-picture.png"].done', { timeout: 40000 });
  await page.fill(".composer textarea", "a picture that draws late");
  await page.click(".composer .primary.small");
  await page.waitForSelector('.msgs .fileblock[data-file="late-picture.png"]', { timeout: 30000 });
  await waitFor(page, () => {
    const m = document.querySelector(".msgs");
    return m.scrollHeight - m.scrollTop - m.clientHeight < 3;
  }, undefined, { timeout: 20000, what: "the view to settle at the newest message" });
  const beforeDrawn = await viewNow();
  await page.click('.msgs .fileblock[data-file="late-picture.png"] .fileopen');
  await waitFor(page, () => {
    const img = document.querySelector('.msgs .fileblock[data-file="late-picture.png"] .fileshot img');
    return !!img && img.complete && img.naturalHeight > 0;
  }, undefined, { timeout: 25000, what: "the picture to finish drawing" });
  await page.waitForTimeout(600);
  const afterDrawn = await viewNow();
  ok("REPRODUCED: a picture finishing really does push the bottom down after the message landed",
    afterDrawn.bottom > beforeDrawn.bottom + 40,
    `bottom ${beforeDrawn.bottom} → ${afterDrawn.bottom}`);
  const sinceDrawn = afterDrawn.followed.recent.slice(
    -(afterDrawn.followed.n - beforeDrawn.followed.n));
  ok("and the view follows a row that grew, not only a message that arrived",
    afterDrawn.fromBottom < 3 && afterDrawn.newestInSight === true &&
    sinceDrawn.length >= 1 && sinceDrawn.every(w => w === "resized"),
    `${afterDrawn.fromBottom}px from the bottom, reasons since: ${JSON.stringify(sinceDrawn)}`);
  await page.screenshot({ path: `${SHOTS}/fix3-picture-keeps-him-down.png` });

  /* ---- a thread is a conversation too, and it has the SAME owner ----
     Not a second rule with the same shape: `useFollowToBottom` is called by both
     lists, so a reply typed in a thread follows for the same reason and animates
     by the same setting. */
  const threadOn = page.locator('.msgs .msg:has-text("a picture that draws late")').last();
  await threadOn.hover();
  await threadOn.locator(".ma.reply").click();
  await page.waitForSelector(".threadpanel .threadbody", { timeout: 20000 });
  /* A THREAD LONG ENOUGH TO SCROLL, and the reader put at the top of it. Without
     that this check passes on a thread that never overflowed its panel — "0px
     from the bottom" is free when there is no bottom to be away from, and the
     follow counter is shared with the room's list, so a thread that followed
     nothing at all would have sailed through on the room's own follows. Both
     holes were found by putting the bug back. */
  const threadRoot = await page.getAttribute(
    '.msgs .msg:has-text("a picture that draws late")', "data-msg");
  await page.evaluate(async ({ id, channel }) => {
    const wire = window.cloud9Wire;
    const cid = wire.channels().find(c => c.name === channel).id;
    for (let i = 1; i <= 14; i++) {
      wire.ask({ type: "send", channelId: cid, text: `thread filler ${i}`, replyTo: id });
      if (i % 7 === 0) await new Promise(r => setTimeout(r, 80));
    }
  }, { id: threadRoot, channel: "longhaul" });
  await page.waitForSelector('.threadpanel .msg:has-text("thread filler 14")', { timeout: 30000 });
  const threadBefore = await page.evaluate(async () => {
    const b = document.querySelector(".threadpanel .threadbody");
    b.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -600 }));
    b.scrollTop = 0;
    await new Promise(r => setTimeout(r, 400));
    return {
      overflowBy: Math.round(b.scrollHeight - b.clientHeight),
      fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight),
    };
  });
  await page.fill(".threadpanel .composer textarea", "a reply in the thread");
  await page.press(".threadpanel .composer textarea", "Enter");
  await page.waitForSelector('.threadpanel .msg:has-text("a reply in the thread")', { timeout: 25000 });
  await page.waitForTimeout(900);
  const threadView = await page.evaluate(() => {
    const b = document.querySelector(".threadpanel .threadbody");
    const mine = [...b.querySelectorAll(".msg")]
      .find(r => r.textContent.includes("a reply in the thread"));
    const bb = b.getBoundingClientRect();
    const mb = mine?.getBoundingClientRect();
    return {
      fromBottom: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight),
      mineInSight: !!mb && mb.top < bb.bottom && mb.bottom > bb.top,
    };
  });
  ok("a reply typed in a thread brings the thread's own view down to it, through the same one owner",
    threadBefore.overflowBy > 150 && threadBefore.fromBottom > 150 &&
    threadView.fromBottom < 3 && threadView.mineInSight === true,
    `the thread overflowed by ${threadBefore.overflowBy}px and he was ${threadBefore.fromBottom}px ` +
    `off its bottom; after his reply, ${threadView.fromBottom}px (in sight: ${threadView.mineInSight})`);
  await page.screenshot({ path: `${SHOTS}/fix3-thread-follows.png` });
  await page.click(".threadpanel .threadclose");
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 15000 });

  /* ============ READING BACK MUST NOT COST HIM THE NEXT MESSAGE ============
   *
   * HIS WORDS: "the chat window doesn't auto-scroll to the newest message on
   * Enter." The checks above already hold "a send takes the view down" — and
   * they passed while the app was broken, because they never read back FAR
   * ENOUGH to ask for an older page first.
   *
   * WHAT THIS WALK IS NOT, and this correction matters more than the walk.
   * It was written against a FIRST DIAGNOSIS: that reaching the top of the list
   * asks for an older page (`askForOlder`), that asking sets a scroll ANCHOR,
   * and that the anchor was only ever released by the effect that runs when
   * messages were really PREPENDED — so a page that added nothing left the
   * anchor held for the rest of that room's life and every later arrival,
   * including his own message coming back after Enter, was put back on the row
   * he had been reading.
   *
   * THAT STORY WAS TESTED AND IT IS FALSE. Putting the old anchor code back
   * leaves this walk GREEN. It never reproduced what he reported, so not one
   * line below may be read as evidence of a cause. The prose that used to sit
   * here claimed it was, and a suite that tells a false story about why it is
   * green is worse than one check short.
   *
   * THE REAL CAUSE is in `useFollowToBottom`, and it is a clock: 700ms
   * (`FOLLOW_SETTLES_MS`) was treated as how long a follow LASTS, when a smooth
   * scroll's duration grows with the distance — 2,000px is about 745ms and
   * 13,000px about 1,520ms. The timer fired in the middle of the app's own
   * animation, the rule stopped recognising its own steps, wrote down "he is not
   * at the bottom", and switched off both the arrival rule and the resize
   * watcher — so the view landed on a target worked out before his row existed,
   * short by exactly his row's height. The timer now measures STILLNESS rather
   * than duration. The check that FAILS when that comes back is the far-back one
   * further down (`# farback`), not this one — this room is only ~2,000px tall,
   * far too short to outlast a 700ms clock.
   *
   * WHAT THIS WALK DOES STILL GUARANTEE, and it is worth keeping: from a
   * conversation read all the way back to its start — the state where a page was
   * asked for and added nothing, where the anchor and the start-of-history
   * marker are both in play — pressing Enter still ends with the view on his own
   * message, and the rule still names a SEND among its reasons. In plain words:
   * the paging machinery never gets to claim the view away from a send.
   *
   * It is a room of its own rather than the one above: `# longhaul` has already
   * been paged back through by the checks above, and the state this needs is a
   * conversation that has never been walked. A second person is in it from the
   * moment it is made, because "a message arrived" and "a message arrived FROM
   * SOMEBODY ELSE" are different facts and only the second one raises the pill.
   */
  const priyaId = await fpage.evaluate(() => window.cloud9Wire.me());
  await page.evaluate(id => window.cloud9Wire.ask(
    { type: "createChannel", name: "scrollback", memberIds: [id], kind: "channel" }), priyaId);
  await page.waitForSelector(".sidebar >> text=# scrollback", { timeout: 25000 });
  await page.click(".sidebar >> text=# scrollback");
  await page.evaluate(async () => {
    const wire = window.cloud9Wire;
    const id = wire.channels().find(c => c.name === "scrollback").id;
    // more than one page (the relay hands over 50 at a time), so reading back
    // really does ask the hub for more and really does run out of older ones
    for (let i = 1; i <= 60; i++) {
      wire.ask({ type: "send", channelId: id, text: `scrollback line ${i}` });
      if (i % 20 === 0) await new Promise(r => setTimeout(r, 60));
    }
  });
  await page.waitForSelector('.msg:has-text("scrollback line 60")', { timeout: 60000 });
  /* A reload is the honest starting point, and it is also what makes this the
     FIRST walk of this room: only the newest page is on screen and nothing has
     been paged back through. */
  await page.reload();
  await page.waitForSelector(".sidebar >> text=# scrollback", { timeout: 30000 });
  await page.click(".sidebar >> text=# scrollback");
  await page.waitForSelector('.msg:has-text("scrollback line 60")', { timeout: 30000 });
  await page.waitForTimeout(900);

  /** Where this conversation is, and what the rule says it did. */
  const scrollView = () => page.evaluate(() => {
    const m = document.querySelector(".msgs");
    return {
      scrollTop: Math.round(m.scrollTop),
      fromBottom: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight),
      rows: m.querySelectorAll(".msg").length,
      followed: window.cloud9View.followed(),
      newBelow: window.cloud9View.newBelow(),
    };
  });
  /** Read back until the hub has nothing older left to give. */
  const readBackToTheStart = () => page.evaluate(async () => {
    const el = document.querySelector(".msgs");
    el.scrollTop = el.scrollHeight;
    await new Promise(r => setTimeout(r, 400));
    let rows = el.querySelectorAll(".msg").length;
    let asked = 0;
    for (let i = 0; i < 8; i++) {
      const before = rows;
      el.scrollTop = 0;                       // fires the app's own scroll handler
      asked += 1;
      await new Promise(r => setTimeout(r, 1400));
      rows = el.querySelectorAll(".msg").length;
      if (rows === before && document.querySelector(".startofhistory")) break;
    }
    return { asked, rows, startOfHistory: !!document.querySelector(".startofhistory") };
  });

  const walkedBack = await readBackToTheStart();
  const atTheTop = await scrollView();
  ok("REPRODUCED: he has read all the way back through a conversation, so the last page he asked for added nothing at all",
    walkedBack.startOfHistory === true && walkedBack.rows >= 60 && walkedBack.asked >= 2 &&
    atTheTop.fromBottom >= 200,
    `${walkedBack.rows} messages loaded after ${walkedBack.asked} walk(s) back; he is ` +
    `${atTheTop.fromBottom}px off the bottom with the start of history on screen`);

  /* Typed into the app's own box and sent with the app's own Enter, from a room
     that has been read right back to its start. What this holds is that nothing
     in the paging machinery — the anchor it sets, the page that added nothing,
     the start-of-history marker — may keep the view when he sends. */
  await page.fill(".thread .composer textarea", "and this is what I typed after reading right back");
  await page.press(".thread .composer textarea", "Enter");
  await page.waitForSelector('.msg p:has-text("after reading right back")', { timeout: 30000 });
  /* Waited on, not slept through — but NOT allowed to throw: a regression here
     must be reported as this check failing, not as a suite that fell over and
     left sixty later checks unrun. */
  await waitFor(page, () => {
    const m = document.querySelector(".msgs");
    return m.scrollHeight - m.scrollTop - m.clientHeight < 3;
  }, undefined, { timeout: 20000, what: "the view to follow what he typed after reading back" })
    .catch(() => { /* judged below */ });
  const afterReadBackSend = await page.evaluate(() => {
    const m = document.querySelector(".msgs");
    const mine = [...m.querySelectorAll(".msg")]
      .find(r => r.textContent.includes("after reading right back"));
    const lb = m.getBoundingClientRect();
    const mb = mine?.getBoundingClientRect();
    return {
      fromBottom: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight),
      mineInSight: !!mb && mb.top < lb.bottom && mb.bottom > lb.top,
      followed: window.cloud9View.followed(),
    };
  });
  const sinceReadBackSend = afterReadBackSend.followed.recent.slice(
    -(afterReadBackSend.followed.n - atTheTop.followed.n));
  ok("pressing Enter lands him on his own message even after reading right back to the start — nothing the paging machinery holds may keep the view from a send",
    afterReadBackSend.fromBottom < 3 && afterReadBackSend.mineInSight === true &&
    sinceReadBackSend.includes("sent"),
    `${afterReadBackSend.fromBottom}px from the bottom, his message in sight: ` +
    `${afterReadBackSend.mineInSight}, reasons since he pressed Enter: ` +
    JSON.stringify(sinceReadBackSend));
  await page.screenshot({ path: `${SHOTS}/scroll-enter-after-reading-back.png` });

  /* ================= "↓ N NEW MESSAGES" — TOLD, NEVER YANKED ==============
   *
   * The other half of the same rule. A message arriving while he is reading
   * back must not move him — and must not be silent either, or he is reading a
   * conversation that has quietly moved on without him. So the app says how
   * many are down there and leaves the decision to him.
   *
   * The pill's SLOT is always in the list and has no height, deliberately: a
   * slot that came and went would change where the bottom is, and the follow
   * rule watches for exactly that. Both facts are held below.
   */
  const priyaSays = text => fpage.evaluate(t => {
    const wire = window.cloud9Wire;
    const id = wire.channels().find(c => c.name === "scrollback").id;
    wire.ask({ type: "send", channelId: id, text: t });
  }, text);
  const pillNow = () => page.evaluate(() => {
    const b = document.querySelector(".newpill");
    return {
      slots: document.querySelectorAll(".newpillslot").length,
      showing: !!b,
      says: b ? b.textContent.replace(/\s+/g, " ").trim() : "",
      attr: b ? b.dataset.newMessages : null,
      rule: window.cloud9View.newBelow(),
    };
  });

  await page.evaluate(async () => {
    const el = document.querySelector(".msgs");
    el.scrollTop = 0;
    await new Promise(r => setTimeout(r, 900));
  });
  const beforeHers = await scrollView();
  const calmPill = await pillNow();
  await priyaSays("priya says something while he is reading back");
  await waitFor(page, () => window.cloud9View.newBelow() >= 1, undefined,
    { timeout: 30000, what: "the pill to count the message that arrived below him" })
    .catch(() => { /* judged below */ });
  await page.waitForTimeout(500);   // let anything wrong happen
  const afterHers = await scrollView();
  const raised = await pillNow();
  ok("a message from somebody else while he has read back does NOT move him — the app tells him how many are down there instead",
    calmPill.showing === false && calmPill.slots === 1 &&
    afterHers.scrollTop === beforeHers.scrollTop &&
    afterHers.followed.n === beforeHers.followed.n &&
    raised.showing === true && raised.attr === "1" && raised.rule === 1 &&
    /1 new message/.test(raised.says) && raised.slots === 1,
    `the view stayed at ${afterHers.scrollTop} and the rule did not fire; the pill says ` +
    `"${raised.says}" (data-new-messages=${raised.attr})`);
  await page.screenshot({ path: `${SHOTS}/scroll-new-messages-pill.png` });

  /* HIS OWN WORDS ARE NOT NEWS TO HIM. Sent through the app's own send frame
     rather than the box, because the box would take him to the bottom — this is
     the case where a message of his lands while he is still reading back (a
     second window of his, or a send that was still on the wire). A pill
     offering to take him to his own words would be counting the wrong thing. */
  await page.evaluate(() => {
    const wire = window.cloud9Wire;
    const id = wire.channels().find(c => c.name === "scrollback").id;
    wire.ask({ type: "send", channelId: id, text: "his own words landing while he reads back" });
  });
  await waitFor(page, () => [...document.querySelectorAll(".msgs .msg")]
    .some(m => m.textContent.includes("his own words landing")), undefined,
  { timeout: 30000, what: "his own message to land while he is still reading back" });
  await page.waitForTimeout(600);
  const afterHisOwn = await pillNow();
  const viewAfterHisOwn = await scrollView();
  await priyaSays("priya says a second thing while he is still reading back");
  await waitFor(page, () => window.cloud9View.newBelow() >= 2, undefined,
    { timeout: 30000, what: "the second message from somebody else to be counted" })
    .catch(() => { /* judged below */ });
  const afterSecondHers = await pillNow();
  ok("his own message never counts toward the pill, and the next one from somebody else still does",
    afterHisOwn.attr === "1" && afterHisOwn.rule === 1 &&
    viewAfterHisOwn.scrollTop === beforeHers.scrollTop &&
    afterSecondHers.attr === "2" && afterSecondHers.rule === 2 &&
    /2 new messages/.test(afterSecondHers.says),
    `after his own: "${afterHisOwn.says}"; after hers: "${afterSecondHers.says}"`);

  /* CLICKING IT IS HIS DECISION, so it owns the view outright — and it goes
     through the same one follow owner as everything else, under its own name. */
  const beforeClick = await scrollView();
  await page.click(".newpill");
  await waitFor(page, () => {
    const m = document.querySelector(".msgs");
    return m.scrollHeight - m.scrollTop - m.clientHeight < 3;
  }, undefined, { timeout: 20000, what: "the pill to take him to the newest message" })
    .catch(() => { /* judged below */ });
  await page.waitForTimeout(400);
  const afterClick = await scrollView();
  const clearedPill = await pillNow();
  const sinceClick = afterClick.followed.recent.slice(
    -(afterClick.followed.n - beforeClick.followed.n));
  ok("clicking it takes him to the newest message and clears the count — and the empty slot it lived in stays, so nothing on screen jumps",
    afterClick.fromBottom < 3 && clearedPill.showing === false &&
    clearedPill.rule === 0 && clearedPill.slots === 1 &&
    sinceClick.includes("caughtUp"),
    `${afterClick.fromBottom}px from the bottom, reasons since he clicked: ` +
    JSON.stringify(sinceClick));

  /* AND WALKING DOWN THERE HIMSELF IS THE SAME FACT. A count that survived him
     scrolling to the bottom would be a badge offering to take him where he
     already is. */
  await page.evaluate(async () => {
    const el = document.querySelector(".msgs");
    el.scrollTop = 0;
    await new Promise(r => setTimeout(r, 900));
  });
  await priyaSays("priya says one more, and this time he walks down to it himself");
  await waitFor(page, () => window.cloud9View.newBelow() >= 1, undefined,
    { timeout: 30000, what: "the pill to come up before he scrolls down himself" })
    .catch(() => { /* judged below */ });
  const beforeWalking = await pillNow();
  await page.evaluate(async () => {
    const el = document.querySelector(".msgs");
    el.scrollTop = el.scrollHeight;           // his own hand on the scrollbar
    await new Promise(r => setTimeout(r, 700));
  });
  const afterWalking = await pillNow();
  ok("and arriving at the bottom under his own steam clears it too — never a badge offering to take him where he already is",
    beforeWalking.showing === true && beforeWalking.rule === 1 &&
    afterWalking.showing === false && afterWalking.rule === 0 && afterWalking.slots === 1,
    `before he scrolled: "${beforeWalking.says}"; after: ${afterWalking.showing ? afterWalking.says : "no pill"}`);

  /* ================= SMOOTHNESS, HELD TO A NUMBER =========================
   *
   * "The chat is not smooth" is a claim about work done per event, and the only
   * honest way to keep it true is to COUNT. `window.__cloud9Renders` is the
   * app's own instrument (one integer add per render, nothing on screen reads
   * it), and these two are the guard that stops the fix quietly rotting: one
   * incoming message used to redraw 151 message bubbles and now redraws one, and
   * an unrelated presence tick used to redraw 151 and now redraws none.
   *
   * THE THRESHOLD IS DELIBERATELY NOT 1. A single arrival can honestly touch the
   * row above it (the "who said it" run of messages) as well as its own, and a
   * check pinned to exactly one would be a check that fails on a correct change.
   * Three is the point past which something is redrawing the LIST rather than
   * the message — a room with sixty rows on screen makes that unmistakable.
   * Zero is the right number for the presence tick, and there is nothing to be
   * generous about: a message bubble has no business redrawing for it at all.
   */
  const rowsOnScreen = await page.locator(".msgs .msg").count();
  await page.evaluate(() => window.__cloud9Renders.reset());
  await priyaSays("a message to measure the redraw by");
  await waitFor(page, () => [...document.querySelectorAll(".msgs .msg")]
    .some(m => m.textContent.includes("a message to measure the redraw by")), undefined,
  { timeout: 30000, what: "the message being measured to land" });
  await page.waitForTimeout(800);   // let anything else that wanted to redraw, redraw
  const onArrival = await page.evaluate(() => window.__cloud9Renders.read());
  ok("one message arriving redraws the one new bubble, not every bubble in the room",
    (onArrival.MessageRow ?? 0) >= 1 && (onArrival.MessageRow ?? 0) <= 3 &&
    rowsOnScreen >= 20,
    `${onArrival.MessageRow ?? 0} message redraw(s) with ${rowsOnScreen} messages on screen ` +
    `(the whole tally: ${JSON.stringify(onArrival)})`);

  /* A TICK ABOUT SOMETHING ELSE ENTIRELY. Fed through the app's own frame
     handler — the same door the live socket uses — so this is the real world
     update and not a poke at a React state. The agent it is about is not in this
     room and has said nothing in it, which is the whole point: nothing about
     this conversation changed, so nothing in it may redraw. The other counters
     prove the frame really arrived, so a screen that ignored it entirely cannot
     pass this by doing nothing at all. */
  const someAgent = (await page.evaluate(() => window.cloud9Wire.agents()))[0];
  await page.evaluate(() => window.__cloud9Renders.reset());
  await page.evaluate(id => window.cloud9Wire.receive({
    type: "agentStatus", agentId: id, status: "working", presence: "working",
    reason: "a presence tick that has nothing to do with this conversation",
  }), someAgent.id);
  await page.waitForTimeout(800);
  const onTick = await page.evaluate(() => window.__cloud9Renders.read());
  const screenRedrew = (onTick.Workspace ?? 0) + (onTick.ChatScreen ?? 0) + (onTick.ChatView ?? 0);
  ok("a presence tick that has nothing to do with this conversation redraws no message bubble at all",
    (onTick.MessageRow ?? 0) === 0 && screenRedrew >= 1,
    `${onTick.MessageRow ?? 0} message redraw(s), and the screen itself redrew ${screenRedrew} ` +
    `time(s) so the tick really did arrive (the whole tally: ${JSON.stringify(onTick)})`);
  await page.screenshot({ path: `${SHOTS}/smoothness-render-counts.png` });

  /* ========== ENTER FROM A LONG WAY BACK — THE FOLLOW MUST OUTLAST ITS OWN CLOCK ==========
   *
   * HIS WORDS, again: "the chat window doesn't auto-scroll to the newest message
   * on Enter." Every follow check above was green while that was still true of
   * the app, and this is the one that would have caught it.
   *
   * WHAT WENT WRONG. Pressing Enter starts a SMOOTH scroll, and the rule that
   * started it needs to know its own animation while it runs. It knew it by a
   * 700ms clock (`FOLLOW_SETTLES_MS`), started once, and treated as "how long a
   * follow lasts". But a smooth scroll's length is not a constant — it grows
   * with the distance: about 745ms for 2,000px and about 1,520ms for 13,000px.
   * So from a long way back the clock ran out MID-ANIMATION, `following` went
   * false, and every remaining step of the app's OWN scroll was then read as the
   * reader moving — writing down "he is not at the bottom". That one flag is
   * what the arrival rule and the resize watcher both ask, so both switched off,
   * and the view finished on a target worked out before his row existed: short
   * by exactly the height of the message he had just typed. The fix makes the
   * clock measure STILLNESS instead of duration — every recognised step of our
   * own animation starts it again (`keepFollowing`).
   *
   * WHY THIS NEEDS A ROOM OF ITS OWN. The bug only shows itself over a scroll
   * long enough to outlast 700ms. Every other room in this suite is around
   * 2,000px tall, which is a follow of roughly 745ms — inside the clock, so the
   * app looks perfect. So this builds a genuinely tall one: 260 long messages,
   * read back four pages, and the reader parked more than 10,000px from the
   * newest message.
   *
   * WHY THE HUB'S ANSWER IS HELD. The discriminating fact is what happens to his
   * message when it comes back from the hub WHILE the scroll is still running.
   * On a fast local hub the echo can land before the old clock had even run out,
   * which hides the bug. `__c9hold` — the suite's own gate, which delays frames
   * and never fakes them — keeps the `message` frame for 1,000ms so it always
   * lands mid-animation, which is where he lives.
   *
   * AND THE CHECK THAT ACTUALLY DISCRIMINATES is not the pixel count, it is the
   * rule's own trail. With the bug in place the reasons since Enter are exactly
   * ["sent","resized"] — his echo arrived into a rule that had already talked
   * itself out of following, so there is no "arrived" in there at all. With the
   * clock measuring stillness, "arrived" is there. That word is the mechanism.
   */
  await page.evaluate(() => window.cloud9Wire.ask(
    { type: "createChannel", name: "farback", memberIds: [], kind: "channel" }));
  await page.waitForSelector(".sidebar >> text=# farback", { timeout: 25000 });
  await page.click(".sidebar >> text=# farback");
  await page.evaluate(async () => {
    const wire = window.cloud9Wire;
    const id = wire.channels().find(c => c.name === "farback").id;
    const body = "lorem ipsum dolor sit amet ".repeat(6);
    for (let i = 1; i <= 260; i++) {
      wire.ask({ type: "send", channelId: id, text: `line ${i} — ${body}` });
      if (i % 20 === 0) await new Promise(r => setTimeout(r, 90));
    }
  });
  await page.waitForSelector('.msgs .msg p:has-text("line 260")', { timeout: 120000 });
  /* A reload is the honest starting point AND it is what makes the walk real:
     only the newest page is on screen, so reaching the top really does ask the
     hub for older ones. */
  await page.reload();
  await page.waitForSelector(".sidebar >> text=# farback", { timeout: 30000 });
  await page.click(".sidebar >> text=# farback");
  await page.waitForSelector('.msgs .msg p:has-text("line 260")', { timeout: 30000 });
  await page.waitForTimeout(900);
  /* Four older pages, each one WAITED for rather than slept through, then parked
     just below the top. The wait is on the row count really growing, which is
     the only honest sign a page landed. */
  const walkedFarBack = await page.evaluate(async () => {
    const el = document.querySelector(".msgs");
    let rows = el.querySelectorAll(".msg").length;
    let pages = 0;
    for (let i = 0; i < 4; i++) {
      const before = rows;
      el.scrollTop = 0;                        // fires the app's own scroll handler
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        await new Promise(r => setTimeout(r, 100));
        rows = el.querySelectorAll(".msg").length;
        if (rows > before) break;
      }
      if (rows > before) pages += 1;
      await new Promise(r => setTimeout(r, 500));  // let the page settle and let any claim go
    }
    el.scrollTop = 200;                        // parked, a long way from the newest message
    await new Promise(r => setTimeout(r, 700));
    return { pages, rows };
  });
  /** Where this very tall conversation is, and what the rule says it has done. */
  const farView = () => page.evaluate(() => {
    const m = document.querySelector(".msgs");
    return {
      scrollTop: Math.round(m.scrollTop),
      fromBottom: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight),
      rows: m.querySelectorAll(".msg").length,
      followed: window.cloud9View.followed(),
    };
  });
  /* TWELVE LINES, because the bug's signature is landing short by exactly the
     height of the row he just added — a one-line message hides that in the
     slack, a twelve-line one cannot. */
  const twelveLines = Array.from({ length: 12 },
    (_, i) => `twelve-line note from a long way back, line ${i + 1}`).join("\n");
  await page.fill(".thread .composer textarea", twelveLines);
  await page.waitForTimeout(400);
  const beforeFarEnter = await farView();
  ok("REPRODUCED: a conversation tall enough that following it takes longer than the old 700ms clock",
    walkedFarBack.pages >= 4 && beforeFarEnter.rows >= 250 && beforeFarEnter.fromBottom >= 10000,
    `${beforeFarEnter.rows} messages after ${walkedFarBack.pages} older page(s); he is ` +
    `${beforeFarEnter.fromBottom}px from the newest message`);

  /* HIS ECHO HELD OPEN so it lands mid-scroll, which is the state the bug needs.
     Nothing is faked: the hub's own frame is delivered, to the app's own
     handler, unchanged — only later. */
  await page.evaluate(() => window.__c9hold.hold(["message"]));
  await page.press(".thread .composer textarea", "Enter");
  const heldEcho = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 1000));   // deep inside the smooth scroll
    return window.__c9hold.release();
  });
  await page.waitForSelector('.msgs .msg p:has-text("twelve-line note from a long way back")',
    { timeout: 30000 });
  /* Waited on the movement HAVING FINISHED — but never allowed to throw, so a
     regression is reported as these checks failing rather than as a suite that
     fell over and left the rest of its checks unrun. */
  await waitFor(page, () => {
    const m = document.querySelector(".msgs");
    return m.scrollHeight - m.scrollTop - m.clientHeight < 5;
  }, undefined, { timeout: 20000, what: "the view to land on the message he typed from far back" })
    .catch(() => { /* judged below */ });
  await page.waitForTimeout(400);
  const afterFarEnter = await page.evaluate(() => {
    const m = document.querySelector(".msgs");
    const mine = [...m.querySelectorAll(".msg")]
      .find(r => r.textContent.includes("twelve-line note from a long way back"));
    const lb = m.getBoundingClientRect();
    const mb = mine?.getBoundingClientRect();
    return {
      fromBottom: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight),
      /* WHOLLY in sight, not merely poking into view: landing short by the
         height of his own row is exactly what he saw, and a check that only
         asked whether some part of it was visible would have passed on it. */
      wholeRowInSight: !!mb && mb.top >= lb.top - 1 && mb.bottom <= lb.bottom + 1,
      rowHeight: mb ? Math.round(mb.height) : 0,
      followed: window.cloud9View.followed(),
    };
  });
  const farFollows = Math.max(0, afterFarEnter.followed.n - beforeFarEnter.followed.n);
  const sinceFarEnter = farFollows === 0
    ? [] : afterFarEnter.followed.recent.slice(-Math.min(farFollows, 12));
  ok("pressing Enter from more than 10,000px back lands the whole of his own message in sight, however long the scroll takes",
    afterFarEnter.fromBottom < 5 && afterFarEnter.wholeRowInSight === true &&
    afterFarEnter.rowHeight >= 100,
    `${afterFarEnter.fromBottom}px from the bottom; his ${afterFarEnter.rowHeight}px row wholly ` +
    `in sight: ${afterFarEnter.wholeRowInSight}`);
  ok("and the rule still recognised his echo as one to follow — the clock measures stillness, not how long the animation lasts",
    sinceFarEnter.includes("sent") && sinceFarEnter.includes("arrived") && heldEcho >= 1,
    `${farFollows} follow(s) since he pressed Enter: ${JSON.stringify(sinceFarEnter)} ` +
    `(${heldEcho} held frame(s) let through 1,000ms in). With the 700ms clock this reads ` +
    `exactly ["sent","resized"] — no "arrived" at all, because the rule had already ` +
    "talked itself out of following its own animation.");
  await page.screenshot({ path: `${SHOTS}/scroll-enter-from-far-back.png` });

  /* ---- `from:` really filters now, so the placeholder is not a promise the
     hub breaks (§11.4). The author filter used to be applied in JavaScript
     AFTER SQL's limit, so on a busy room it returned nothing at all. Two people
     say the same word here, deliberately: a filter that returned one hit
     because only one hit existed would prove nothing. */
  await fpage.click(".sidebar >> text=# general");
  await fpage.fill(".composer textarea", "kayak hire is sorted for Saturday");
  await fpage.press(".composer textarea", "Enter");
  await page.click(".sidebar >> text=# general");
  await page.waitForSelector('.msg p:has-text("kayak hire is sorted")', { timeout: 25000 });
  await page.fill(".composer textarea", "kayak deposit is still to pay");
  await page.press(".composer textarea", "Enter");
  await page.waitForSelector('.msg p:has-text("kayak deposit is still")', { timeout: 25000 });

  await page.evaluate(() => window.cloud9Menu.run("search"));
  await page.waitForSelector(".searchpanel", { timeout: 10000 });
  /* The panel now opens on EVERYTHING (feature 3). These older checks are about
     the message-only question — the one door that understands `in:` and
     `from:` — so they walk to it the way a person would, by clicking it. */
  await page.click('.scopepill[data-scope="messages"]');
  const searchPlaceholder = await page.getAttribute(".search-input", "placeholder");
  ok("the search box still offers from:, and the offer is true now",
    /from:Priya/.test(searchPlaceholder ?? ""), searchPlaceholder ?? "");
  await page.fill(".search-input", "kayak");
  await waitFor(page, () => document.querySelectorAll(".searchhit").length === 2,
    undefined, { timeout: 25000, what: "both people's kayak messages to be found" });
  const bothSaid = await page.$$eval(".searchhit .hitwho b", bs => bs.map(b => b.textContent.trim()));
  ok("two different people said the same word, so narrowing by author has something to do",
    bothSaid.length === 2 && new Set(bothSaid).size === 2, bothSaid.join(" / "));
  await page.fill(".search-input", "from:Priya kayak");
  await waitFor(page, () => document.querySelectorAll(".searchhit").length === 1,
    undefined, { timeout: 25000, what: "the author filter to narrow the results" });
  const narrowed = await page.$$eval(".searchhit .hitwho b", bs => bs.map(b => b.textContent.trim()));
  ok("from: narrows to that one person's messages, from the screen",
    narrowed.length === 1 && narrowed[0] === "Priya", narrowed.join(" / "));
  await page.screenshot({ path: `${SHOTS}/room-search-from.png` });
  await page.keyboard.press("Escape");

  /* ---- the hub could not open its messages (§11.7) ----
     The sentence is written by `StoreOpenError` for a person to read, and the
     screen shows it WORD FOR WORD. So this check does not type the sentence: it
     makes a database the hub genuinely cannot read, catches the error the hub
     itself would throw, and compares that string with what the screen drew. */
  const { Store } = await import("../apps/relay/dist/store.js");
  const brokenDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-qa-broken-")), "not-a.db");
  fs.writeFileSync(brokenDbPath, "this file is not a database at all\n");
  let hubSentence = "";
  try {
    new Store(brokenDbPath);
  } catch (err) {
    hubSentence = err.name === "StoreOpenError" ? err.message : "";
  }
  ok("the hub really does refuse an unreadable database with a sentence written for a person",
    hubSentence.startsWith("Cloud9 could not open its message database at") &&
    /Nothing has been changed/.test(hubSentence), hubSentence.slice(0, 90));

  const downPage = await owner.newPage();
  downPage.on("console", m => { if (m.type() === "error") consoleErrors.push("hubdown: " + m.text()); });
  await downPage.goto(`${UI}&hubError=${encodeURIComponent(hubSentence)}`);
  await downPage.waitForSelector(".hubdown .hubsay", { timeout: 20000 });
  const shownSentence = (await downPage.locator(".hubdown .hubsay").innerText()).replace(/\s+/g, " ").trim();
  ok("when the hub cannot open its database the screen says its sentence as-is, never a stack trace",
    shownSentence === hubSentence.replace(/\s+/g, " ").trim() &&
    (await downPage.locator(".join").count()) === 0 &&
    !/at Object|at new Store|\.js:\d+/.test(shownSentence),
    shownSentence.slice(0, 90));
  await downPage.screenshot({ path: `${SHOTS}/room-hub-unreadable.png` });
  await downPage.close();
  /* Best effort: SQLite opened the file before it discovered it was not a
     database, and on Windows that handle outlives the failed open for a moment.
     A locked scratch file in the OS temp folder must never be the reason a QA
     run reports a failure it did not find. */
  try { fs.rmSync(path.dirname(brokenDbPath), { recursive: true, force: true }); }
  catch { /* the OS will sweep it — it holds nothing but a line of text */ }

  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# paperwork");
  await page.waitForSelector(".chathead .roomdetailsbtn", { timeout: 20000 });
  // the panel is closed by the trip out to another screen; the checks below are
  // about the panel, so it is opened again rather than assumed
  if ((await page.locator(".roompanel").count()) === 0) await page.click(".chathead .roomdetailsbtn");
  await page.waitForSelector(".roompanel .memberrow", { timeout: 20000 });

  // ---- the details panel must not push the page sideways either ----
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(220);
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      ok(`the room-details panel does not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/rooms-details-${theme}.png` });
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  // the files on a message must not either — a long name is the usual culprit
  await page.click(".roompanel .roomclose");
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(220);
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      ok(`files on a message do not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/files-message-${theme}.png` });
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  /* ================= WHAT AN AGENT ACTUALLY DID (FR-TL-003) =================

     The whole point of this feature is that the screen can show what an agent
     really did instead of repeating what it SAID it did. So these checks are
     written against records that came off the wire, never against anything the
     page invented — and the one they lean on hardest is the absence check:
     a record with no money must render no COST ROW AT ALL. Asserting that the
     row does not say "0" would pass on a card that says "0"; asserting the row
     is not in the document is the only version that means anything. */

  await page.click('.rail-btn[data-go="tasks"]');
  // What the screen is holding, printed before anything is asserted — a missing
  // card and a record that never arrived look identical on screen and are two
  // completely different bugs.
  const jobs = await page.evaluate(() => window.cloud9Runs.jobs());
  console.log("[qa] jobs the screen knows about: " + JSON.stringify(jobs));
  console.log("[qa] runs held by the screen: " + JSON.stringify(
    await page.evaluate(() => window.cloud9Runs.held())));

  const doneJob = jobs.find(j => j.status === "completed" && j.runId);
  ok("a finished job carries the record of what its agent actually did",
    !!doneJob && /^r-/.test(doneJob.runId), JSON.stringify(doneJob ?? null));
  const jobRunId = doneJob?.runId;

  /* This suite reloads the page three times before it gets here, so the record
     that was PUSHED when the job finished is long gone — which is exactly the
     everyday case of opening the app the morning after. The job offers the
     record and the click is what asks for it. Nothing is drawn from a runId
     alone. (The unasked push is proved further down, on a live run.) */
  await page.waitForSelector(`.taskrow .runopen[data-run="${jobRunId}"]`, { timeout: 30000 });
  await page.click(`.taskrow .runopen[data-run="${jobRunId}"]`);
  await page.waitForSelector(`.taskrow .callout.run[data-run="${jobRunId}"]`, { timeout: 30000 });
  const jobCard = page.locator(`.taskrow .callout.run[data-run="${jobRunId}"]`);
  ok("opening it fetches the real record from the hub and draws it as a finished run",
    (await jobCard.getAttribute("data-outcome")) === "ok",
    await jobCard.getAttribute("data-outcome"));

  const jobTook = (await jobCard.locator('dd[data-row="took"]').innerText()).trim();
  const jobSum = (await jobCard.locator(".runsum").innerText()).trim();
  // This demo turn used no tools, so `summarizeRun` has exactly one sentence for
  // it — and the TOOK row is the same `humanDuration` of the same field. If the
  // screen had grown a second way of saying either, these two would disagree.
  ok("the plain-words line is the hub's own sentence, built from the same numbers as the rows",
    jobSum === `Answered straight from what it knew — no tools used, took ${jobTook}.`,
    `${jobSum} :: took=${jobTook}`);

  const jobRows = await jobCard.locator("dl.kv dt").evaluateAll(ds => ds.map(d => d.dataset.row));
  ok("a run the app reported no money for renders NO COST ROW AT ALL — not a zero, not an estimate",
    (await jobCard.locator('[data-row="cost"]').count()) === 0 && !jobRows.includes("cost"),
    jobRows.join("/"));
  ok("and the rows it does carry are the ones the record really holds",
    jobRows.join("/") === "asked-by/ran-on/took", jobRows.join("/"));
  await page.screenshot({ path: `${SHOTS}/run-task.png` });

  /* ---- the same record, under the 📦 result — which lives in the THREAD ----
   * The job was asked for with "@Scout !bg …" typed in the conversation, so the
   * job answers where it was asked: `runTask` carries the ask's thread and
   * `reportFinished` puts the 📦 detail (and its run card) under his message,
   * leaving the room one short "🧵 Finished in the thread: …" line. This check
   * used to look for the card in the scroll and would now never find it — so it
   * looks where the result is, and says so in its name. */
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# trip-goa");
  /* "!bg" is part of the words on purpose: the job's own room line QUOTES the
     ask it finished ("🧵 Finished in the thread: compare 14 villas…") and sits
     below it, so the ask has to be named by something only the ask says. */
  const bgAskRoot = await page.locator('.msgs .msg:has-text("!bg compare 14 villas and shortlist 3")')
    .last().getAttribute("data-msg");
  await page.click(`.msgs .msg[data-msg="${bgAskRoot}"] .threadline`);
  await page.waitForSelector(".threadpanel", { timeout: 20000 });
  await page.waitForSelector(`.threadpanel .msg .callout.run[data-run="${jobRunId}"]`, { timeout: 30000 });
  ok("the 📦 job result — in the thread under the message the job was asked in — carries that job's own record, not a lookalike",
    (await page.locator(`.threadpanel .msg .callout.run[data-run="${jobRunId}"]`).count()) === 1 &&
    (await page.locator(`.msgs .msg .callout.run[data-run="${jobRunId}"]`).count()) === 0,
    `${await page.locator(`.threadpanel .callout.run[data-run="${jobRunId}"]`).count()} in the thread, ` +
    `${await page.locator(`.msgs .callout.run[data-run="${jobRunId}"]`).count()} in the scroll`);
  await page.screenshot({ path: `${SHOTS}/run-chat.png` });

  /* A run card is the widest thing the app draws: a long ask in its title, a
     full URL in a step. It is checked in EVERY place it renders, because the
     column it sits in differs in each of them. */
  const overflowNow = async () => page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  const noSidewaysWithACard = async (where, shot) => {
    for (const [width, height] of [[1280, 800], [1440, 900]]) {
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
        await page.waitForTimeout(220);
        const over = await overflowNow();
        ok(`a run card ${where} does not scroll sideways at ${width} in the ${theme} look`,
          over.doc <= 0 && over.body <= 0, JSON.stringify(over));
        if (width === 1280 && shot) await page.screenshot({ path: `${SHOTS}/${shot}-${theme}.png` });
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  };
  // the run card in its narrowest column of all — a thread beside the room
  await noSidewaysWithACard("under a job result in the thread it was reported in", "run-chat");
  await page.click(".threadpanel .threadclose");
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 10000 });

  await page.click('.rail-btn[data-go="tasks"]');
  await page.waitForSelector(`.taskrow .callout.run[data-run="${jobRunId}"]`, { timeout: 20000 });
  await noSidewaysWithACard("in the Tasks in-tray", "run-tasks");

  /* ---- records with the things a demo turn cannot have ----
     A mock harness reports no tools, no tokens and no money, which is honest and
     is exactly why the absence check above is real. To see the OTHER half — a
     step list, a refused tool, a cost — this opens a second connection as the
     engine and reports three runs through the real frame the real engine uses.
     Nothing is faked on the screen's side: the hub validates them, checks they
     belong to this owner's agent, redacts them and pushes them out like any
     other. */
  const { relayPort } = qaTarget();
  const engineWs = new WebSocket(`ws://127.0.0.1:${relayPort}`);
  const hub = await new Promise((resolve, reject) => {
    const giveUp = setTimeout(() => reject(new Error("the hub never answered the QA engine")), 20000);
    engineWs.onerror = () => { clearTimeout(giveUp); reject(new Error("the QA engine could not connect")); };
    engineWs.onmessage = ev => {
      const f = JSON.parse(ev.data);
      if (f.type === "welcome") { clearTimeout(giveUp); resolve(f.state); }
      if (f.type === "error") { clearTimeout(giveUp); reject(new Error(f.error)); }
    };
    engineWs.onopen = () => engineWs.send(JSON.stringify({
      type: "hello", token: qaOwnerToken(), client: "engine",
    }));
  });
  /* WHAT THE HUB ASKS THIS COMPUTER TO DO. From here on every frame the hub
     sends the engine is kept, because the only honest way to prove the "Look at
     GitHub now" button is to watch the request arrive where the `gh` command
     would really be run. The screen cannot reach GitHub and must not pretend to. */
  const engineFrames = [];
  engineWs.onmessage = ev => { engineFrames.push(JSON.parse(ev.data)); };
  /** Wait for one frame the hub sent the engine. Never a sleep. */
  const engineGot = async (match, why, ms = 20000) => {
    const until = Date.now() + ms;
    for (;;) {
      const found = engineFrames.find(match);
      if (found) return found;
      if (Date.now() > until) return undefined;
      await new Promise(r => setTimeout(r, 50));
    }
  };

  const scout = hub.agents.find(a => a.name === "Scout");
  const general = hub.channels.find(c => c.name === "general");
  if (!scout || !general) throw new Error("the QA engine could not find Scout and #general to report against");

  const base = {
    kind: "chat", agentId: scout.id, agentName: "Scout", channelId: general.id,
    requestedBy: "Vikas", requestedByKind: "human",
    // the newest runs this agent has: "Recent work" shows the last ten, and by
    // now Scout has taken more turns than that
    startedAt: Date.now(), finishedAt: Date.now() + 41000, durationMs: 41000,
    replyChars: 812, events: 24,
  };
  const RICH_URL = "https://villas.example/goa";
  const rich = {
    ...base, id: "r-qa-rich-1", provider: "claude",
    model: "claude-sonnet-5", actualModel: "claude-sonnet-5",
    ask: "find three villas in Goa under 8k", outcome: "ok",
    steps: [
      { seq: 1, kind: "web", label: "Read a web page", detail: RICH_URL, ok: true },
      { seq: 2, kind: "read", label: "Read notes.md", detail: "notes.md", ok: true },
      { seq: 3, kind: "note", label: "Refused to use Bash" },
      { seq: 4, kind: "command", label: "Ran a command", detail: "ls", ok: false },
      { seq: 5, kind: "thinking", label: "Thought it through" },
      { seq: 6, kind: "message", label: "Said something" },
    ],
    usage: { inputTokens: 9291, outputTokens: 640, cachedInputTokens: 4100, costUsd: 0.76 },
    sessionId: "qa-session", numTurns: 3,
  };
  const codexRun = {
    ...base, id: "r-qa-codex-1", provider: "codex", model: "gpt-5.6-sol",
    ask: "tidy the shortlist", outcome: "ok",
    steps: [{ seq: 1, kind: "command", label: "Ran a command", detail: "sort list.txt", ok: true }],
    // tokens but NO money: Codex never reports a cost, and we never compute one
    usage: { inputTokens: 400, outputTokens: 90, reasoningTokens: 120 },
  };
  const brokenRun = {
    ...base, id: "r-qa-failed-1", provider: "claude", model: "claude-sonnet-5",
    ask: "book the second villa", outcome: "failed",
    error: "the booking site refused the card",
    steps: [{ seq: 1, kind: "web", label: "Read a web page", detail: "https://villas.example/book", ok: false }],
    truncated: true,
  };
  for (const record of [rich, codexRun, brokenRun]) {
    engineWs.send(JSON.stringify({ type: "runRecorded", record }));
  }

  /* THE UNASKED PUSH. Nothing on screen asked for these; the hub sends a run to
     everyone who could see the conversation it happened in, the moment it
     finishes. The screen has to hold one that arrives for a room it is not even
     looking at, keyed by the record's own id. */
  await waitFor(page, ids => {
    const held = window.cloud9Runs.held().map(r => r.id);
    return ids.every(id => held.includes(id));
  }, [rich.id, codexRun.id, brokenRun.id], { timeout: 20000, what: "runs to arrive unasked" });
  ok("a run that finishes anywhere this person can see arrives unasked, and is kept by its own id",
    (await page.evaluate(id => window.cloud9Runs.held().find(r => r.id === id)?.steps, rich.id)) === 6);
  // ---- an agent's own history, in its editor. Owner only. ----
  await page.click('.rail-btn[data-go="crew"]');
  await page.click('.cast[data-crew="Scout"] >> text=Edit');
  await page.waitForSelector(".recentwork", { timeout: 20000 });
  await page.waitForSelector(`.recentwork .workrow[data-run="${rich.id}"]`, { timeout: 20000 });
  const richRow = page.locator(`.recentwork .workrow[data-run="${rich.id}"]`);
  ok("an agent's recent work lists what it did, with the ask and the same plain-words line",
    (await richRow.locator(".wr-tx b").innerText()).trim() === rich.ask &&
    (await richRow.locator(".wr-sum").innerText()).trim() === summarizeRun(rich),
    (await richRow.locator(".wr-sum").innerText()).trim());
  await page.screenshot({ path: `${SHOTS}/run-recent-work.png` });

  await richRow.locator(".wr-head").click();
  await page.waitForSelector(`.workrow[data-run="${rich.id}"] .callout.run`, { timeout: 20000 });
  const richCard = page.locator(`.workrow[data-run="${rich.id}"] .callout.run`);
  ok("a run the app DID report money for shows the cost, in the hub's own words",
    (await richCard.locator('dd[data-row="cost"]').innerText()).trim() === humanMoney(0.76),
    (await richCard.locator('dd[data-row="cost"]').innerText()).trim());

  await richCard.locator(".runmore").click();
  await page.waitForSelector(`.workrow[data-run="${rich.id}"] .runsteps .runstep`, { timeout: 20000 });
  const kinds = await richCard.locator(".runstep").evaluateAll(
    ls => ls.map(l => `${l.dataset.seq}:${l.dataset.kind}`));
  ok("every step is listed in the order it happened, each as its own kind of thing",
    kinds.join(" ") === "1:web 2:read 3:note 4:command", kinds.join(" "));
  const link = richCard.locator('.runstep[data-kind="web"] a.dt');
  ok("a web step's detail is a real link to the page it read",
    (await link.getAttribute("href")) === RICH_URL &&
    (await link.innerText()).trim() === RICH_URL,
    await link.getAttribute("href"));
  // The refusal is the one step here the app reported no outcome for. It gets
  // neither a tick nor a cross — the two steps the app DID vouch for get ticks,
  // so this is not passing because no marks are drawn at all.
  ok("a step the app said nothing about gets NO tick and NO cross",
    (await richCard.locator('.runstep[data-ok="unsaid"]').count()) === 1 &&
    (await richCard.locator('.runstep[data-ok="unsaid"] .mk').count()) === 0 &&
    (await richCard.locator('.runstep[data-ok="true"] .mk.yes').count()) === 2,
    `${await richCard.locator('.runstep[data-ok="unsaid"]').count()} unsaid, ` +
    `${await richCard.locator(".mk").count()} marks in all`);
  ok("a step the app said failed is marked failed, and only that one",
    (await richCard.locator(".runstep.bad .mk.no").count()) === 1 &&
    (await richCard.locator('.runstep[data-kind="command"].bad').count()) === 1);
  ok("a refused tool reads as a boundary that held, not as an error",
    (await richCard.locator('.runstep[data-kind="note"].held').count()) === 1 &&
    (await richCard.locator('.runstep[data-kind="note"].bad').count()) === 0 &&
    /Refused to use Bash/.test(await richCard.locator('.runstep[data-kind="note"]').innerText()));
  ok("what it thought and what it said are folded away until they are asked for",
    (await richCard.locator('.runstep[data-kind="thinking"]').count()) === 0 &&
    (await richCard.locator(".runquiet").innerText()).includes("2"));
  await richCard.locator(".runquiet").click();
  await page.waitForSelector(`.workrow[data-run="${rich.id}"] .runstep[data-kind="thinking"]`, { timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/run-steps.png` });

  // ---- the Codex half: tokens, and never a price ----
  await page.locator(`.recentwork .workrow[data-run="${codexRun.id}"] .wr-head`).click();
  await page.waitForSelector(`.workrow[data-run="${codexRun.id}"] .callout.run`, { timeout: 20000 });
  const codexCard = page.locator(`.workrow[data-run="${codexRun.id}"] .callout.run`);
  const codexRows = await codexCard.locator("dl.kv dt").evaluateAll(ds => ds.map(d => d.dataset.row));
  ok("a Codex run shows NO cost row at all — the app reports no money and none is invented",
    (await codexCard.locator('[data-row="cost"]').count()) === 0 && !codexRows.includes("cost") &&
    !/cost|\$|cents/i.test(await codexCard.locator("dl.kv").innerText()),
    codexRows.join("/"));

  // ---- a run that failed says so, in the record's own words ----
  await page.locator(`.recentwork .workrow[data-run="${brokenRun.id}"] .wr-head`).click();
  await page.waitForSelector(`.workrow[data-run="${brokenRun.id}"] .callout.run[data-outcome="failed"]`,
    { timeout: 20000 });
  const brokenCard = page.locator(`.workrow[data-run="${brokenRun.id}"] .callout.run`);
  ok("a run that failed says what went wrong, word for word from the record",
    (await brokenCard.locator('dd[data-row="went-wrong"]').innerText()).trim() === brokenRun.error,
    (await brokenCard.locator('dd[data-row="went-wrong"]').innerText()).trim());
  await brokenCard.locator(".runmore").click();
  await page.waitForSelector(`.workrow[data-run="${brokenRun.id}"] .runtrunc`, { timeout: 10000 });
  ok("a record that had steps dropped to keep it small says so",
    /left out/.test(await brokenCard.locator(".runtrunc").innerText()));
  await page.screenshot({ path: `${SHOTS}/run-failed.png` });

  // ---- and none of it is offered for somebody else's agent ----
  await fpage.click('.rail-btn[data-go="crew"]');
  await fpage.waitForSelector(".cast", { timeout: 20000 });
  ok("a friend is never shown — and never asks for — the history of an agent that isn't theirs",
    (await fpage.locator(".recentwork").count()) === 0 &&
    (await fpage.locator('.cast[data-crew="Scout"] >> text=Edit').count()) === 0);

  // ---- and the third place it renders: an agent's own history ----
  await noSidewaysWithACard("with every step showing, in an agent's history", "run-card");
  await page.click(".editor >> text=← Crew");

  /* ==========================================================================
     PROJECTS — a repository, its pull requests, its issues (his item 7)

     WHAT THIS SECTION IS PROVING. The hub has been able to store projects,
     pull requests and issues for a day, and the desktop dropped all four
     frames on the floor with a comment saying the Projects screen would claim
     them. He said twice that he could not see any of it. So every check below
     asks the SCREEN, never the store: is it drawn, does it say the true thing,
     and does it refuse to say anything nobody has checked.

     The lists are seeded through `projectSynced` on the SAME engine connection
     the run records used — the real frame the real engine sends, validated and
     redacted by the hub on the way through. Nothing is written straight onto
     the screen.
     ====================================================================== */

  const REPO = "vikas53953/cloud9";
  await page.click('.rail-btn[data-go="projects"]');
  await page.waitForSelector(".projects", { timeout: 20000 });

  ok("PROJECTS is in the icon rail, beside the four screens he approved",
    await page.evaluate(() => {
      const rail = [...document.querySelectorAll(".rail .rail-btn")]
        .map(b => b.dataset.go ?? b.title ?? "");
      return rail.includes("projects")
        && ["chat", "crew", "tasks", "activity", "settings"].every(s => rail.includes(s));
    }),
    (await page.$$eval(".rail .rail-btn", bs => bs.map(b => b.dataset.go ?? b.title).join(", "))));

  await page.waitForSelector(".proj-list .railempty, .proj-list .side-item", { timeout: 20000 });
  ok("with nothing connected the screen says so, rather than drawing an empty list of nothing",
    (await page.locator(".proj-main .empty, .proj-main .emptyplate").count()) > 0 ||
    /nothing connected/i.test(await page.locator(".proj-list").innerText()),
    (await page.locator(".proj-main").innerText()).slice(0, 90).replace(/\s+/g, " "));

  /* ---- a name that is not owner/name is refused WHERE HE IS LOOKING ---- */
  await page.click(".projects .topbar [data-connect]");
  await page.waitForSelector(".connectproj", { timeout: 15000 });
  await page.fill("#f-repo", "not a repository");
  await page.click('.connectproj button:has-text("Connect")');
  await page.waitForSelector(".connectproj .problemline", { timeout: 10000 });
  ok("a name that isn't owner/name is refused in the contract's own sentence, in the form",
    (await page.locator(".connectproj .problemline").innerText()).trim()
      === validateRepo("not a repository"),
    (await page.locator(".connectproj .problemline").innerText()).trim());

  /* ---- C12: a repository GitHub has never heard of must not look like a good one ----
     Phase 5 connected `definitely-not-a-real-owner-xyz987/nope` and the form
     closed happily; the row then said "Not looked at GitHub yet" for ever —
     word for word what a correctly-typed repository said. Connecting now ASKS,
     and the answer is on the row. "We could not check" and "it does not exist"
     are different answers and must read differently, so this accepts either the
     no-such-repository sentence or an honest could-not-check one, and fails
     only on silence. */
  const GHOST = "definitely-not-a-real-owner-xyz987/nope";
  await page.fill("#f-repo", GHOST);
  await page.fill("#f-repo-name", "");
  await page.click('.connectproj button:has-text("Connect")');
  await page.waitForSelector(`.proj-list .side-item[data-repo="${GHOST}"]`, { timeout: 20000 });
  await waitFor(page, () => {
    const detail = document.querySelector(".projdetail");
    if (!detail) return false;
    // either GitHub answered (the chip stamps when) or it said why it could not
    return !!detail.querySelector(".pd-problem")
      || !!detail.querySelector('[data-look-state="looked"]');
  }, undefined, { timeout: 90000, what: "the look that connecting started to come back" });
  const ghostSays = (await page.locator(".projdetail").innerText()).replace(/\s+/g, " ").trim();
  ok("C12: a repository GitHub cannot see is told so when he connects it, not left looking like a good one",
    !/not looked at github yet/i.test(ghostSays)
    && /(has no repository called|could not reach|isn't running on the computer|isn't installed|sign in to github)/i.test(ghostSays),
    ghostSays.slice(0, 200));
  await page.screenshot({ path: `${SHOTS}/projects-ghost.png` });
  // and it is taken back off, so the rest of this section sees the list it expects
  await page.click(".projdetail .pd-btns >> text=Disconnect");
  await page.click(".projdetail .pd-btns >> text=Yes, forget it");
  await page.waitForSelector(`.proj-list .side-item[data-repo="${GHOST}"]`, { state: "detached", timeout: 20000 });

  /* ---- connecting a real one ---- */
  await page.click(".projects .topbar [data-connect]");
  await page.waitForSelector(".connectproj", { timeout: 15000 });
  await page.fill("#f-repo", REPO);
  await page.fill("#f-repo-name", "Cloud9 itself");
  await page.click('.connectproj button:has-text("Connect")');
  await page.waitForSelector(`.proj-list .side-item[data-repo="${REPO}"]`, { timeout: 20000 });
  await page.waitForSelector(`.projdetail[data-repo="${REPO}"]`, { timeout: 20000 });
  ok("connecting a repository puts it on screen, named the way GitHub names it",
    (await page.locator(".projdetail .reponame").innerText()).replace(/\s+/g, "") === REPO,
    await page.locator(".projdetail .reponame").innerText());

  /* CONNECTING LOOKS (C12). This check used to assert the opposite — that a
     freshly connected repository says "Not looked at GitHub yet" — and that
     sentence was exactly the bug: it read identically for a typo and for a
     good repository. It now asserts the new promise: connecting asks, and by
     the time he is looking at the row it either says WHEN it looked or says
     why it could not. It never sits in the in-between saying nothing. */
  await waitFor(page, () => {
    const detail = document.querySelector(".projdetail");
    return !!detail && (!!detail.querySelector(".pd-problem")
      || !!detail.querySelector('[data-look-state="looked"]'));
  }, undefined, { timeout: 90000, what: "the look connecting started on the real repository" });
  const realFacts = (await page.locator(".projdetail").innerText()).replace(/\s+/g, " ");
  ok("connecting a repository looks at GitHub there and then, rather than leaving him to find out later",
    !/not looked at github yet/i.test(realFacts)
    && (await page.locator(".pd-never").count()) === 0,
    realFacts.slice(0, 180));

  const projectId = await page.getAttribute(`.proj-list .side-item[data-repo="${REPO}"]`, "data-project");

  /* ---- what GitHub said, reported by the engine through the real frame ---- */
  const nowIso = Date.now();
  const ITEMS = [
    {
      projectId, kind: "pull", number: 41, title: "Add the Projects screen",
      state: "open", author: "vikas53953", branch: "cloud9/architect-1", agentId: scout.id,
      url: "https://github.com/vikas53953/cloud9/pull/41",
      createdAt: nowIso - 3 * 3600_000, updatedAt: nowIso - 600_000,
    },
    {
      projectId, kind: "pull", number: 39, title: "Redact secrets inside a URL",
      state: "merged", author: "vikas53953", branch: "cloud9/redact-2",
      url: "https://github.com/vikas53953/cloud9/pull/39",
      createdAt: nowIso - 26 * 3600_000, updatedAt: nowIso - 20 * 3600_000,
    },
    {
      projectId, kind: "pull", number: 38, title: "Widen visibleChannels",
      state: "closed", author: "vikas53953", branch: "cloud9/widen-1",
      url: "https://github.com/vikas53953/cloud9/pull/38",
      createdAt: nowIso - 40 * 3600_000, updatedAt: nowIso - 30 * 3600_000,
    },
    {
      projectId, kind: "issue", number: 12, title: "Agents cannot hand work to each other",
      state: "open", author: "vikas53953",
      url: "https://github.com/vikas53953/cloud9/issues/12",
      createdAt: nowIso - 50 * 3600_000, updatedAt: nowIso - 2 * 3600_000,
    },
  ];
  /* ==========================================================================
     "LOOK AT GITHUB NOW" — the button, and the round trip behind it

     WHY THIS SECTION EXISTS. The lists below used to be seeded by sending
     `projectSynced` straight down the engine connection, which proved the
     screen DRAWS them and nothing else. The button that asks for them had zero
     coverage: nothing checked that pressing it reaches the copy of Cloud9
     running on this computer, that the screen says a look is under way, or
     that it stops saying so when the answer lands.

     So the lists are now filled the way they are filled in the real app: he
     presses the button, the hub asks the engine, the engine answers. The
     checks below are the whole path, and the seeding is what the answer
     carries.
     ====================================================================== */

  /* The second half of this check used to be "and says it has not yet". That is
     no longer true and must not be asserted: connecting ASKS now (C12), so by
     the time he is here the row already says when it looked. What still has to
     be true — and is what this check is for — is that the button to ask again
     is there, ready, and says so in words. */
  ok("a connected repository offers a way to ask GitHub, ready and named in plain words",
    (await page.locator('.pd-btns button[data-look="ready"]').innerText()).trim()
      === "Look at GitHub now" &&
    (await page.locator('.pd-facts [data-look-state="never"]').count()) === 0,
    (await page.locator(".pd-btns").innerText()).replace(/\s+/g, " "));

  await page.click('.pd-btns button[data-look="ready"]');

  /* THE SCREEN NEVER REACHES GITHUB. The request has to arrive at the engine —
     the only party with the GitHub sign-in — naming the repository the hub
     verified, not one the screen sent along with it. */
  const lookAsk = await engineGot(f => f.type === "lookAtProject" && f.projectId === projectId,
    "the hub to ask this computer to look at GitHub");
  ok("pressing it asks the copy of Cloud9 on this computer to run gh — the screen never reaches GitHub",
    !!lookAsk && lookAsk.repo === REPO,
    JSON.stringify(lookAsk ?? engineFrames.map(f => f.type)));

  /* AND THE WAITING STATE IS THE HUB'S, NOT A SPINNER THE SCREEN STARTED. A
     look he could press twice would run `gh` twice. */
  ok("while it is looking the button says so and cannot be pressed again",
    (await page.locator('.pd-btns button[data-look="busy"]').innerText()).trim()
      === "Looking at GitHub…" &&
    await page.locator('.pd-btns button[data-look="busy"]').isDisabled() &&
    (await page.locator('.pd-facts [data-look-state="busy"]').count()) === 1,
    (await page.locator(".pd-facts").innerText()).replace(/\s+/g, " "));

  engineWs.send(JSON.stringify({
    type: "projectSynced", projectId, defaultBranch: "master", items: ITEMS,
  }));
  await page.waitForSelector('.pd-items .projitem[data-item="pull-41"]', { timeout: 20000 });

  /* ABSENT MEANS ABSENT, AND SO DOES PRESENT. Once the engine has answered, the
     screen stops saying "looking", stops saying "nobody has looked", and stamps
     when it was — from the hub's own `syncedAt`, never from the moment the
     button was pressed.

     WAIT, DON'T SAMPLE. The items and the settled button arrive on separate
     frames; sampling at the instant pull-41 renders read the button as still
     busy one run in three-hundred and failed a truth that was a frame away
     (the 2026-08-01/02 intermittent). "Settles" means eventually-and-bounded,
     so the check now waits for the settled state and fails only if it never
     comes. */
  const settled = await Promise.all([
    page.waitForSelector('.pd-facts [data-look-state="looked"]', { timeout: 15000 }),
    page.waitForSelector('.pd-btns button[data-look="ready"]', { timeout: 15000 }),
  ]).then(() => true).catch(() => false);
  ok("when the answer lands the button settles and the screen stamps when GitHub was last asked",
    settled && (await page.locator(".pd-never").count()) === 0,
    (await page.locator(".pd-facts").innerText()).replace(/\s+/g, " "));

  ok("the pull requests the engine reported are on screen, in the project's own list",
    await page.$$eval(".pd-items .projitem", rows => rows.map(r => r.dataset.item).join(",")) ===
      "pull-41,pull-39,pull-38",
    await page.$$eval(".pd-items .projitem", rows => rows.map(r => r.dataset.item).join(",")));

  ok("the trunk it must never land on is drawn only now that GitHub actually said what it is",
    /master/.test(await page.locator(".pd-facts").innerText()) &&
    (await page.locator(".pd-never").count()) === 0,
    (await page.locator(".pd-facts").innerText()).replace(/\s+/g, " "));

  /* MERGED AND CLOSED ARE THE OPPOSITE OUTCOMES. A list that draws them the
     same way is lying about the work, so the WORDS are compared, not the tint:
     a colour he cannot name is not a difference he can read. */
  const stateWords = await page.$$eval(".pd-items .projitem",
    rows => Object.fromEntries(rows.map(r => [r.dataset.item, r.querySelector(".chip").innerText.trim()])));
  ok("a pull request that landed and one that was thrown away are told apart in words, not only colour",
    stateWords["pull-39"] !== stateWords["pull-38"] &&
    /merged/i.test(stateWords["pull-39"]) && /not merged/i.test(stateWords["pull-38"]),
    JSON.stringify(stateWords));

  ok("a pull request one of his agents opened carries its branch and that agent's face",
    await page.evaluate(() => {
      const row = document.querySelector('.projitem[data-item="pull-41"]');
      const ribbon = row?.querySelector(".branchribbon");
      return !!ribbon && ribbon.dataset.branch === "cloud9/architect-1"
        && !!ribbon.querySelector("svg .portrait, .portrait svg, svg");
    }),
    await page.locator('.projitem[data-item="pull-41"] .branchribbon').innerText());

  ok("the trunk a branch is aimed at is named from what GitHub said, never guessed as main",
    /master/.test(await page.locator('.projitem[data-item="pull-41"] .branchribbon').innerText()),
    await page.locator('.projitem[data-item="pull-41"] .branchribbon').innerText());

  /* ---- who of his crew is standing where ---- */
  await page.waitForSelector(`.pd-crew .crewbranch[data-agent="${scout.id}"]`, { timeout: 15000 });
  ok("the crew panel says which agent is on which branch in this repository",
    /Scout/.test(await page.locator(".pd-crew").innerText()) &&
    /cloud9\/architect-1/.test(await page.locator(".pd-crew").innerText()),
    (await page.locator(".pd-crew").innerText()).replace(/\s+/g, " ").slice(0, 120));

  ok("the folder an agent works in is NOT claimed — it never crosses the wire, and the screen says so",
    /not reported to\s+Cloud9 yet|not reported to Cloud9 yet/i
      .test((await page.locator(".pd-crew .pd-note").innerText()).replace(/\s+/g, " ")),
    (await page.locator(".pd-crew .pd-note").innerText()).replace(/\s+/g, " "));

  /* ---- opening one ---- */
  await page.click('.projitem[data-item="pull-41"] .pi-head');
  await page.waitForSelector('.projitem[data-item="pull-41"] .pi-body', { timeout: 15000 });
  const pullBody = page.locator('.projitem[data-item="pull-41"] .pi-body');
  ok("opening a pull request shows the facts we hold — its number, its branch and where it is aimed",
    /#41/.test(await pullBody.innerText()) &&
    /cloud9\/architect-1/.test(await pullBody.innerText()) &&
    /master/.test(await pullBody.innerText()));
  ok("and says the description and the conversation stay on GitHub rather than pretending to hold them",
    /stay on GitHub/i.test((await pullBody.locator(".pi-note").innerText()).replace(/\s+/g, " ")));
  ok("the link out is GitHub's own address, opened away from this window",
    (await pullBody.locator("a.projlink").getAttribute("href")) === ITEMS[0].url &&
    (await pullBody.locator("a.projlink").getAttribute("rel")).includes("noopener"),
    await pullBody.locator("a.projlink").getAttribute("href"));

  /* TRACEABLE TO THE TURN THAT MADE IT — or honestly not traceable. No run this
     screen holds names that branch, and the screen says exactly that instead of
     drawing a link nobody established. */
  ok("a branch no held run names is reported as untraced, not linked to a turn we guessed at",
    (await pullBody.locator(".tracenone").count()) === 1 &&
    /cloud9\/architect-1/.test(await pullBody.locator(".tracenone").innerText()),
    (await pullBody.locator(".tracenone").innerText()).replace(/\s+/g, " "));

  /* and the same panel offers the agent's real history, from the hub */
  await page.waitForSelector('.projitem[data-item="pull-41"] .recentwork .workrow', { timeout: 20000 });
  ok("a pull request opens onto the work its agent actually did, from the run records the hub holds",
    (await page.locator('.projitem[data-item="pull-41"] .recentwork .workrow').count()) > 0,
    `${await page.locator('.projitem[data-item="pull-41"] .recentwork .workrow').count()} turns`);
  await page.screenshot({ path: `${SHOTS}/projects-pull.png` });

  /* ---- and now a run that DOES name the branch: the trace fills in ---- */
  engineWs.send(JSON.stringify({
    type: "runRecorded",
    record: {
      ...base, id: "r-qa-branch-1", provider: "claude", model: "claude-sonnet-5",
      ask: "open a pull request for the Projects screen", outcome: "ok",
      steps: [
        { seq: 1, kind: "command", label: "Ran a command", detail: "git push origin cloud9/architect-1", ok: true },
      ],
    },
  }));
  await page.waitForSelector('.projitem[data-item="pull-41"] .traced .callout.run', { timeout: 20000 });
  ok("once a turn names the branch, the pull request is traced to the very job that made it",
    (await page.locator('.projitem[data-item="pull-41"] .traced').innerText()).includes("pull request"),
    (await page.locator('.projitem[data-item="pull-41"] .traced .callout.run').innerText())
      .replace(/\s+/g, " ").slice(0, 90));
  await page.click('.projitem[data-item="pull-41"] .pi-head');

  /* ---- issues are their own list, and read honestly ---- */
  await page.click('.pd-tabs .seg button[data-tab="issue"]');
  await page.waitForSelector('.pd-items .projitem[data-item="issue-12"]', { timeout: 15000 });
  ok("issues are a list of their own, and only issues are in it",
    await page.$$eval(".pd-items .projitem", rows => rows.every(r => r.dataset.item.startsWith("issue-"))) &&
    (await page.locator(".pd-items .projitem").count()) === 1);
  await page.click('.projitem[data-item="issue-12"] .pi-head');
  await page.waitForSelector('.projitem[data-item="issue-12"] .pi-body', { timeout: 15000 });
  ok("reading an issue offers GitHub's own address for it, and never a made-up one",
    (await page.locator('.projitem[data-item="issue-12"] a.projlink').getAttribute("href")) === ITEMS[3].url,
    await page.locator('.projitem[data-item="issue-12"] a.projlink').getAttribute("href"));
  await page.screenshot({ path: `${SHOTS}/projects-issue.png` });

  /* ---- the hub's own sentence when the last look failed ---- */
  const PROBLEM = "gh could not reach github.com — check the network";
  engineWs.send(JSON.stringify({ type: "projectSynced", projectId, problem: PROBLEM }));
  await page.waitForSelector(".pd-problem", { timeout: 20000 });
  ok("a failed look at GitHub is shown in the hub's own words, not as an empty list reading 'no open work'",
    (await page.locator(".pd-problem span").innerText()).trim() === PROBLEM,
    (await page.locator(".pd-problem span").innerText()).trim());
  ok("and a project with a problem is flagged in the list beside it",
    (await page.locator(`.proj-list .side-item[data-project="${projectId}"] .cnt.hot`).count()) === 1);


  /* ---- the whole screen, in both looks, at both widths ---- */
  await page.click('.pd-tabs .seg button[data-tab="pull"]');
  await page.waitForSelector('.projitem[data-item="pull-41"]', { timeout: 15000 });
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(220);
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      ok(`the Projects screen does not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) await page.screenshot({ path: `${SHOTS}/projects-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  /* ==========================================================================
     WHERE THE CODE LIVES ON THIS COMPUTER (docs/plans/approval-handoff.md §8)

     THE HOLE THIS CLOSES. A project named a repository on GitHub and NOTHING on
     screen could say where its code was on this machine, so `!code` answered
     "nobody has told Cloud9 where this project's code lives" for every project,
     for ever. The folder now lives on the project, and the copy of Cloud9 that
     runs the agents is told about it on the ordinary `project` frame.

     THE PICKER ITSELF IS THE OPERATING SYSTEM'S. A browser has no
     `window.cloud9`, so "Choose folder" here takes the typed route instead and
     SAYS it is doing that — which is the same frame by another door, and is why
     this suite can drive it at all. The native dialog is Electron's own and is
     not something a page could open.
     ====================================================================== */

  ok("a project says where its code lives on this computer — a row that exists at all",
    (await page.locator(".projdetail .pd-folder").count()) === 1);
  ok("with no folder linked it says so plainly, instead of showing a blank or a guessed path",
    (await page.getAttribute(".pd-folder", "data-folder-state")) === "none" &&
    /No folder linked yet/i.test(await page.locator(".pd-folder").innerText()) &&
    /says so rather than guessing/i.test(
      (await page.locator(".pd-folder").innerText()).replace(/\s+/g, " ")),
    (await page.locator(".pd-folder").innerText()).replace(/\s+/g, " ").slice(0, 120));

  await page.click(".pd-folder [data-folder-choose]");
  await page.waitForSelector("#f-folder", { timeout: 15000 });
  ok("in a window with no folder picker, the button says so rather than doing nothing",
    /cannot open the computer's folder picker/i.test(await page.locator(".pd-folder").innerText()));

  /* A HALF-PATH IS REFUSED IN THE RULE'S OWN SENTENCE — the same function the
     hub checks with, so the screen and the hub can never disagree about what a
     folder is. */
  await page.fill("#f-folder", "code/cloud9");
  await page.click(".pd-folder [data-folder-save]");
  await page.waitForSelector(".pd-folder .problemline", { timeout: 15000 });
  ok("a folder that is not a whole path is refused in the contract's own sentence, in the row",
    (await page.locator(".pd-folder .problemline").innerText()).trim()
      === validateLocalFolder("code/cloud9"),
    (await page.locator(".pd-folder .problemline").innerText()).trim());

  const CODE_FOLDER = process.cwd();
  /* Everything the hub has said to this computer SO FAR is cleared, so the
     check below can only pass on a frame the folder itself caused. */
  engineFrames.length = 0;
  await page.fill("#f-folder", CODE_FOLDER);
  await page.click(".pd-folder [data-folder-save]");
  await waitFor(page, () => document.querySelector(".pd-folder")?.dataset.folderState === "linked",
    undefined, { what: "the project to show the folder it was given" });
  ok("choosing a folder links it to THIS project, and the folder is drawn back to him",
    (await page.getAttribute(".pd-folder", "data-folder")) === CODE_FOLDER &&
    (await page.locator(".pd-folder .folderpath").innerText()).trim() === CODE_FOLDER,
    (await page.locator(".pd-folder .folderpath").innerText()).trim());

  /* AND THE COMPUTER THAT RUNS THE AGENTS IS TOLD. This is the whole point:
     the folder has to reach the engine, or `!code` still has nowhere to work. */
  const folderTold = await engineGot(
    f => f.type === "project" && f.project.id === projectId && f.project.localPath === CODE_FOLDER,
    "the folder to reach the copy of Cloud9 that runs the agents");
  ok("the folder reaches the computer that runs the agents, on the project's own frame",
    !!folderTold, folderTold ? folderTold.project.localPath : "never arrived");

  await page.click(".pd-folder [data-folder-clear]");
  await waitFor(page, () => document.querySelector(".pd-folder")?.dataset.folderState === "none",
    undefined, { what: "the folder to be forgotten" });
  ok("forgetting the folder puts the honest 'nobody has said' state back, not an empty box",
    /No folder linked yet/i.test(await page.locator(".pd-folder").innerText()) &&
    (await page.locator(".pd-folder .folderpath").count()) === 0);

  // put it back, so the screenshots below show the real thing
  await page.click(".pd-folder [data-folder-choose]");
  await page.waitForSelector("#f-folder", { timeout: 15000 });
  await page.fill("#f-folder", CODE_FOLDER);
  await page.click(".pd-folder [data-folder-save]");
  await waitFor(page, () => document.querySelector(".pd-folder")?.dataset.folderState === "linked",
    undefined, { what: "the folder to be linked again" });

  /* ==========================================================================
     THE REPOSITORY PICKER — "show me MY repositories" (his ask, 2026-08-01)

     Connecting made him TYPE `owner/name` from memory. Now the panel asks the
     computer that holds his GitHub sign-in and he clicks a row.

     HOW THE gh ANSWER IS FAKED, and why in this order. Exactly the way this
     suite already fakes a look at GitHub: a SECOND connection to the hub says
     `hello` as an ENGINE and sends the real `repositoriesFound` frame, which
     the hub validates and forwards like any other. Nothing is written onto the
     screen. The QA stack also runs a REAL engine host, which answers the same
     question off the real `gh` — so every fake is sent only AFTER the panel has
     left its "asking" state, i.e. after that real answer has already landed.
     Sending first would let the real answer overwrite the fake a second later.
     ====================================================================== */

  await page.click(".projects .topbar [data-connect]");
  await page.waitForSelector(".connectproj .repopick", { timeout: 15000 });
  const pickerAsked = await engineGot(f => f.type === "listRepositoriesRequested",
    "the hub to ask this computer which repositories it can see");
  ok("opening the connect panel asks the computer with the GitHub sign-in — the screen never reaches GitHub",
    !!pickerAsked);
  await waitFor(page, () => document.querySelector(".repopick")?.dataset.repolist !== "asking",
    undefined, { what: "the repository list to settle" });

  const QA_REPOS = [
    {
      nameWithOwner: "qa-owner/qa-repo", description: "The one the QA engine says he owns",
      visibility: "private", updatedAt: Date.now() - 86_400_000,
    },
    { nameWithOwner: "qa-owner/second-one", visibility: "public", updatedAt: Date.now() - 3_600_000 },
  ];
  engineWs.send(JSON.stringify({ type: "repositoriesFound", repos: QA_REPOS }));
  await page.waitForSelector('.repochoice[data-repo-choice="qa-owner/qa-repo"]', { timeout: 20000 });
  ok("the panel lists the repositories the computer really reported, one row each",
    (await page.locator(".repopick .repochoice").count()) === QA_REPOS.length &&
    (await page.locator('.repochoice[data-repo-choice="qa-owner/second-one"]').count()) === 1,
    `${await page.locator(".repopick .repochoice").count()} rows`);
  ok("a private repository is drawn as private — never as a public one",
    /Private/.test(await page.locator('.repochoice[data-repo-choice="qa-owner/qa-repo"]').innerText()) &&
    /Public/.test(await page.locator('.repochoice[data-repo-choice="qa-owner/second-one"]').innerText()));
  ok("the list says when it was really asked for, rather than pretending to be current",
    (await page.locator(".repopick [data-repolist-when]").count()) === 1 &&
    /Asked GitHub/i.test(await page.locator(".repopick [data-repolist-when]").innerText()),
    (await page.locator(".repopick [data-repolist-when]").innerText()).trim());
  ok("typing a name is still offered, for a repository that is not his",
    (await page.locator(".connectproj #f-repo").count()) === 1);

  await page.click('.repochoice[data-repo-choice="qa-owner/qa-repo"]');
  await page.waitForSelector('.proj-list .side-item[data-repo="qa-owner/qa-repo"]', { timeout: 20000 });
  ok("clicking a repository connects it — the same path typing its name goes down",
    (await page.locator('.proj-list .side-item[data-repo="qa-owner/qa-repo"]').count()) === 1);

  /* ---- and when gh could not be asked, the reason is shown, never an empty list ---- */
  await page.click(".projects .topbar [data-connect]");
  await page.waitForSelector(".connectproj .repopick", { timeout: 15000 });
  await waitFor(page, () => document.querySelector(".repopick")?.dataset.repolist !== "asking",
    undefined, { what: "the repository list to settle before the failure is sent" });
  const NO_LIST = "you're not signed in to GitHub on this computer";
  engineWs.send(JSON.stringify({ type: "repositoriesFound", problem: NO_LIST }));
  await waitFor(page, () => document.querySelector(".repopick")?.dataset.repolist === "problem",
    undefined, { what: "the failed repository listing to be shown as a problem" });
  ok("a listing that failed shows the reason in the hub's own words, never an empty list reading 'you have none'",
    (await page.locator(".repopick .problemtext").innerText()).trim() === NO_LIST &&
    (await page.locator(".repopick .repochoice").count()) === 0,
    (await page.locator(".repopick .problemtext").innerText()).trim());
  const fallbackSaid = (await page.locator(".repopick .rp-fallback").innerText()).trim();
  const typedFieldsLeft = await page.locator(".connectproj #f-repo").count();
  ok("and it points at the way in that still works — typing the name",
    /typ(e|ing)/i.test(fallbackSaid) && typedFieldsLeft === 1,
    `${fallbackSaid} · ${typedFieldsLeft} typed field(s)`);
  await page.screenshot({ path: `${SHOTS}/projects-picker.png` });
  await page.click(".projects .topbar [data-connect]"); // close the panel again

  /* back to the repository the rest of this section is about */
  await page.click(`.proj-list .side-item[data-repo="${REPO}"]`);
  await page.waitForSelector(`.projdetail[data-repo="${REPO}"]`, { timeout: 15000 });

  /* ---- disconnecting forgets OUR copy, and says so before it does ---- */
  await page.click('.pd-btns button:has-text("Disconnect")');
  await page.waitForSelector(".pd-reassure", { timeout: 10000 });
  ok("before disconnecting, the screen promises the repository itself is untouched",
    /repository is not\s*touched/i.test((await page.locator(".pd-reassure").innerText()).replace(/\s+/g, " ")),
    (await page.locator(".pd-reassure").innerText()).replace(/\s+/g, " "));
  await page.click('.pd-btns button:has-text("Yes, forget it")');
  await page.waitForSelector(`.proj-list .side-item[data-repo="${REPO}"]`, { state: "detached", timeout: 20000 });
  ok("a disconnected project takes its pull requests and its issues off the screen with it",
    (await page.locator(".pd-items .projitem").count()) === 0 &&
    (await page.locator(`.projdetail[data-repo="${REPO}"]`).count()) === 0);

  /* ==========================================================================
     THE APPROVAL FOR PUSHING — `kind:"action"` (docs/plans/approval-handoff.md)

     An agent standing still mid-job, asking to do something OUTSIDE this
     computer. The card has to read as clearly as the money moment in the
     prototype: what will happen, to which repository and branch, how many
     commits, and that it runs out. `expired` is its own state — "he never saw
     it" is not "he said no" — and it is never painted as an error.

     Sent through `askApproval` on the engine connection, which is the only
     connection allowed to send it. The SCREEN cannot mint one, deliberately.
     ====================================================================== */

  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# general");
  await page.waitForSelector(".composer textarea", { timeout: 20000 });

  const PUSH_FACTS = {
    action: "push", repo: REPO, branch: "cloud9/scout-7", commits: 2, files: 3,
  };
  engineWs.send(JSON.stringify({
    type: "askApproval", askId: "qa-push-1", agentId: scout.id, channelId: general.id,
    facts: PUSH_FACTS,
  }));
  await page.waitForSelector('.msg[data-kind="action"]', { timeout: 20000 });
  const pushCard = page.locator('.msg[data-kind="action"]').first();

  /* THE SENTENCE, VERBATIM. Every noun in it came from `git` and `gh` rather
     than from the agent, and that is the whole reason he can trust it — so the
     screen is held to the contract's own words, not to something like them. */
  ok("a push request draws the sentence the machine wrote, word for word",
    (await pushCard.locator(".spend .amt").innerText()).trim() === describeRemoteAction(PUSH_FACTS),
    (await pushCard.locator(".spend .amt").innerText()).trim());
  ok("the smaller line under it is the contract's own detail — how much is going up",
    (await pushCard.locator(".spend .apdetail").innerText()).trim() === detailRemoteAction(PUSH_FACTS),
    (await pushCard.locator(".spend .apdetail").innerText()).trim());
  ok("the card names which repository and which branch, in the sentence he judges",
    /vikas53953\/cloud9/.test(await pushCard.innerText()) &&
    /cloud9\/scout-7/.test(await pushCard.innerText()));
  ok("it says this is something outside this computer, and that nothing has left it yet",
    /outside this computer/i.test(await pushCard.innerText()) &&
    /Nothing has been changed yet/i.test(await pushCard.innerText()));
  /* The eyebrow is set in small caps by the sheet, so the WORDS are compared
     and not the casing — `innerText` hands back what the CSS did. */
  ok("and which of the three things Cloud9 asks about this is, from the shared table",
    (await pushCard.locator(".remoteact").innerText()).trim().toLowerCase()
      === REMOTE_ACTIONS.push.toLowerCase(),
    (await pushCard.locator(".remoteact").innerText()).trim());
  ok("it says when it runs out — an agent is standing there waiting for the answer",
    /minutes|about a minute|seconds/.test(
      await pushCard.locator("dl.kv").innerText()) &&
    /EXPIRES/i.test(await pushCard.locator("dl.kv").innerText()),
    (await pushCard.locator("dl.kv").innerText()).replace(/\s+/g, " "));
  ok("a request with no job behind it offers no 'see the job' button to press",
    (await pushCard.locator("text=See the job").count()) === 0);
  /* The pill and the cards read the same list, so the only check worth making
     is that they AGREE — a hard-coded "1" would pass while the two drifted. */
  ok("the gold pill counts a mid-run request as something waiting on him",
    await page.evaluate(() => {
      const pill = document.querySelector(".approvalpill");
      const said = Number((pill?.innerText ?? "").match(/\d+/)?.[0] ?? -1);
      const drawn = document.querySelectorAll('.msg[data-approval][data-state="pending"]').length;
      return said === drawn && drawn >= 1;
    }),
    await page.locator(".approvalpill").innerText());
  await pushCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/projects-approval-push.png` });

  /* A REQUEST WHOSE SIZE WE DO NOT KNOW HAS NO SIZE LINE. Same law as a run
     record: absent is absent, and "0 files changed" is a claim nobody made. */
  engineWs.send(JSON.stringify({
    type: "askApproval", askId: "qa-push-2", agentId: scout.id, channelId: general.id,
    facts: { action: "pullRequest", repo: REPO, branch: "cloud9/scout-7", base: "master" },
  }));
  await waitFor(page, () => document.querySelectorAll('.msg[data-kind="action"]').length === 2,
    undefined, { timeout: 20000, what: "the second mid-run request" });
  const prCard = page.locator('.msg[data-kind="action"]').nth(1);
  ok("a request that reported no size shows NO size line at all — not a zero",
    (await prCard.locator(".apdetail").count()) === 0,
    await prCard.locator(".spend").innerText());

  /* ---- the same request, in the Tasks in-tray ---- */
  await page.click('.rail-btn[data-go="tasks"]');
  await page.waitForSelector('.tasks-side .approval[data-kind="action"]', { timeout: 20000 });
  const trayCard = page.locator('.tasks-side .approval[data-kind="action"]').first();
  ok("the same request is in the Tasks in-tray, carrying its sentence and its deadline",
    (await trayCard.locator("h4").innerText()).trim() === describeRemoteAction(PUSH_FACTS) &&
    /Expires/.test(await trayCard.locator(".apexpiry").innerText()),
    (await trayCard.locator(".apexpiry").innerText()).trim());
  await page.screenshot({ path: `${SHOTS}/projects-approval-tray.png` });

  /* ---- HE SAID NO, and nothing happened ---- */
  const noId = await trayCard.getAttribute("data-appr");
  await trayCard.locator('button:has-text("Not now")').click();
  await waitFor(page, id => !document.querySelector(`.approval[data-appr="${id}"]`), noId,
    { timeout: 20000, what: "the refused request to leave the in-tray" });
  ok("saying 'not now' answers it, and it stops waiting on him",
    (await page.locator(`.tasks-side .approval[data-appr="${noId}"]`).count()) === 0);

  /* ---- NOBODY ANSWERED, which is a different event and is drawn differently.
     The hub's own deadline is ten minutes, so this proves the rendering in a
     throwaway window with a controlled clock: the app decides a card is past
     answering from `expiresAt`, and the hub refuses a late decision anyway — so
     an Approve button after the deadline would be a button that cannot work.
     The main window is untouched. */
  const clockCtx = await browser.newContext();
  const clockPage = await clockCtx.newPage();
  await clockPage.clock.install();
  await clockPage.goto(UI);
  await signInAsOwner(clockPage);
  engineWs.send(JSON.stringify({
    type: "askApproval", askId: "qa-push-3", agentId: scout.id, channelId: general.id,
    facts: { action: "push", repo: REPO, branch: "cloud9/lonely-1", commits: 1 },
  }));
  await clockPage.click(".sidebar >> text=# general");
  await clockPage.waitForSelector('.msg[data-kind="action"][data-state="pending"]', { timeout: 20000 });
  ok("before the deadline the request is answerable, with both buttons on it",
    (await clockPage.locator('.msg[data-kind="action"] button:has-text("Approve")').count()) > 0);
  // eleven minutes, so the ten-minute deadline is certainly behind us. A jump
  // rather than a run: the countdown ticks once a second, and running six
  // hundred of those would be six hundred renders to prove one thing.
  await clockPage.clock.fastForward(11 * 60 * 1000);
  await clockPage.waitForSelector('.msg[data-kind="action"][data-state="expired"]', { timeout: 20000 });
  const deadCard = clockPage.locator('.msg[data-kind="action"][data-state="expired"]').first();
  ok("a request nobody answered says nobody answered — it is not quietly a refusal",
    /Nobody answered/i.test(await deadCard.innerText()) &&
    !/reject/i.test(await deadCard.innerText()),
    (await deadCard.locator(".expiredline").innerText()).replace(/\s+/g, " "));
  ok("and it offers no button, because there is nothing left to answer",
    (await deadCard.locator("button:has-text('Approve')").count()) === 0 &&
    (await deadCard.locator("button:has-text('Not now')").count()) === 0);
  ok("an expired request is not painted as an error — nothing happened, which is the safe outcome",
    (await deadCard.locator(".chip.is-madder, .callout.approval .danger").count()) === 0 &&
    /nothing happened/i.test(await deadCard.locator(".spend .per").innerText()),
    (await deadCard.locator(".spend .per").innerText()).trim());
  ok("the card stays where it was, so a request that ran out while he was away is FOUND, not vanished",
    (await clockPage.locator('.msg[data-kind="action"]').count()) >= 1);
  await deadCard.scrollIntoViewIfNeeded();
  await clockPage.screenshot({ path: `${SHOTS}/projects-approval-expired.png` });
  await clockCtx.close();

  /* ==========================================================================
     THE GITHUB WRITES — the SAME card, not a second one.

     An agent that reaches "open an issue" or "request a review" asks on the
     exact `askApproval` frame the push uses, and it lands on the exact same
     action card. Every noun the owner reads is a COUNTED fact the hub turned
     into words — never the issue title or the comment body, which rode in on
     stdin and appear NOWHERE on the card. A write is a request, so it reads
     "wants to …". Proved on screen here, in his own words.

     Cards are found by their content, not by position — the push section above
     leaves its own action cards on this page, and an index would drift.
     ====================================================================== */
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# general");
  await page.waitForSelector(".composer textarea", { timeout: 20000 });

  const ISSUE_FACTS = { action: "openIssue", repo: REPO, issues: 1 };
  engineWs.send(JSON.stringify({
    type: "askApproval", askId: "qa-issue-1", agentId: scout.id, channelId: general.id,
    facts: ISSUE_FACTS,
  }));
  const issueCard = page.locator('.msg[data-kind="action"]', { hasText: "wants to open an issue" }).first();
  await issueCard.waitFor({ timeout: 20000 });
  /* THE SENTENCE, IN OWNER WORDS. The "wants to" framing is the screen's, but
     every noun is the hub's `describeRemoteAction`, so it is held to the
     contract's own words rather than to something like them. */
  ok("a GitHub write asks on the same card, in owner words that say 'wants to'",
    (await issueCard.locator(".spend .amt").innerText()).trim()
      === `wants to ${describeRemoteAction(ISSUE_FACTS)}`,
    (await issueCard.locator(".spend .amt").innerText()).trim());
  ok("the write card names which repository it acts in, in the sentence he judges",
    /wants to open an issue in vikas53953\/cloud9/.test(await issueCard.innerText()));
  ok("the write card carries the counted fact underneath — one issue, not a zero",
    (await issueCard.locator(".spend .apdetail").innerText()).trim()
      === detailRemoteAction(ISSUE_FACTS),
    (await issueCard.locator(".spend .apdetail").innerText()).trim());
  ok("the write card names which shared kind it is (open an issue on GitHub)",
    (await issueCard.locator(".remoteact").innerText()).trim().toLowerCase()
      === REMOTE_ACTIONS.openIssue.toLowerCase(),
    (await issueCard.locator(".remoteact").innerText()).trim());
  ok("the write card is drawn as a pending request, nothing changed yet",
    (await issueCard.getAttribute("data-state")) === "pending" &&
    /Nothing has been changed yet/i.test(await issueCard.innerText()));
  ok("open-issue is one of the shared GitHub write kinds, and push is not",
    isGitHubWriteKind("openIssue") && !isGitHubWriteKind("push"));
  await issueCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/projects-approval-issue.png` });

  /* A REQUEST-REVIEW WRITE — the reviewer count is the machine's, read with a
     public pull-request number, and no prose from the agent anywhere on it. */
  const REVIEW_FACTS = {
    action: "requestReview", repo: REPO, target: "pullRequest", number: 31,
    pullRequests: 1, reviewers: 3,
  };
  engineWs.send(JSON.stringify({
    type: "askApproval", askId: "qa-review-1", agentId: scout.id, channelId: general.id,
    facts: REVIEW_FACTS,
  }));
  const reviewCard = page.locator('.msg[data-kind="action"]', { hasText: "wants to request 3 reviewers" }).first();
  await reviewCard.waitFor({ timeout: 20000 });
  ok("a request-review write reads with the reviewer count and PR number the machine set",
    (await reviewCard.locator(".spend .amt").innerText()).trim()
      === `wants to request 3 reviewers for pull request #31 in ${REPO}`,
    (await reviewCard.locator(".spend .amt").innerText()).trim());
  ok("no issue title or comment body from the agent appears anywhere on a write card",
    !/A title|A body|Please fix|steps:/i.test(
      (await issueCard.innerText()) + (await reviewCard.innerText())));
  await page.screenshot({ path: `${SHOTS}/projects-approval-review.png` });

  engineWs.close();

  /* ---- PUT THE IN-TRAY BACK THE WAY IT WAS ----------------------------------
   * Every QA script in this run shares one hub, and the next one waits for the
   * rail to read exactly "1" approval. Requests this section left standing were
   * therefore not junk in a throwaway database — they were a failure in the
   * NEXT script, blamed on a feature that was working perfectly. A section that
   * mints approvals answers all of them before it leaves.
   */
  await page.click('.rail-btn[data-go="tasks"]');
  await page.waitForSelector(".tasks-side", { timeout: 20000 });
  for (const left of await page.$$eval('.tasks-side .approval[data-kind="action"]',
    els => els.map(e => e.dataset.appr))) {
    await page.evaluate(id => window.cloud9Wire.ask(
      { type: "decideApproval", approvalId: id, decision: "rejected" }), left);
  }
  await waitFor(page, () => document.querySelectorAll('.tasks-side .approval[data-kind="action"]').length === 0,
    undefined, { timeout: 20000, what: "this section's own requests to be answered and gone" });
  ok("this section leaves nothing waiting behind it — the in-tray is back the way it was",
    (await page.locator('.tasks-side .approval[data-kind="action"]').count()) === 0);

  // ---------- nothing new scrolls sideways, in either look ----------
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# backlog");
  await page.locator(".threadline").last().click();
  await page.waitForSelector(".threadpanel", { timeout: 15000 });
  const overflow = async () => page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(200);
      const over = await overflow();
      ok(`a thread beside the conversation does not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/chat-thread-${theme}.png` });
      }
    }
  }
  await page.evaluate(() => window.cloud9Menu.run("search"));
  await page.waitForSelector(".searchpanel", { timeout: 10000 });
  /* The panel now opens on EVERYTHING (feature 3). These older checks are about
     the message-only question — the one door that understands `in:` and
     `from:` — so they walk to it the way a person would, by clicking it. */
  await page.click('.scopepill[data-scope="messages"]');
  await page.fill(".search-input", "backlog");
  await page.waitForSelector(".searchhit", { timeout: 20000 });
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(200);
      const over = await overflow();
      ok(`search results do not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/chat-search-${theme}.png` });
      }
    }
  }
  await page.keyboard.press("Escape");

  /* ---- the reach ladder, at its widest: top rung, everything disclosed ---- */
  await page.click('.rail-btn[data-go="crew"]');
  await page.waitForSelector(".crew-bar", { timeout: 20000 });
  await page.click('.cast[data-crew="Scout"] button:has-text("Edit")');
  await page.waitForSelector(".editor .reachladder", { timeout: 20000 });
  await page.locator('.editor .reachrung[data-reach="computer"]').click();
  if ((await page.getAttribute(".editor .abilitypick", "data-open")) !== "yes") {
    await page.click(".editor .abilityshow");
  }
  await page.locator(".editor .harnesshonest .hh-more summary").click();
  await page.locator(".editor .reachladder").scrollIntoViewIfNeeded();
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(200);
      const over = await overflow();
      ok(`the reach ladder at full stretch does not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.locator(".editor .reachladder").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${SHOTS}/reach-ladder-${theme}.png` });
        await page.locator(".editor .harnesshonest").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${SHOTS}/reach-honest-${theme}.png` });
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click(".editor .topbar >> text=Cancel");
  await page.waitForSelector(".crew-grid", { timeout: 20000 });

  /* ---- and the casting room, with a brief open over it ---- */
  await page.waitForSelector(".crew-bar .tomarket", { timeout: 20000 });
  await page.click(".crew-bar .tomarket");
  await page.waitForSelector(".market .cast.role", { timeout: 20000 });
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(200);
      const over = await overflow();
      ok(`the casting room's role cards do not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/hall-roles-${theme}.png` });
      }
    }
  }
  await page.click('.market .cast.role[data-role="sw-devops"] .rolesee');
  await page.waitForSelector(".hirepanel", { timeout: 15000 });
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(200);
      const over = await overflow();
      ok(`the casting room and an open brief do not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/market-brief-${theme}.png` });
        await page.screenshot({ path: `${SHOTS}/hall-brief-${theme}.png` });
      }
    }
  }
  await page.click('.hirepanel .foot >> text=Not now');

  /* ---- and the rail carrying a presence line on every agent ---- */
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".sidebar .agentrow", { timeout: 20000 });
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(200);
      const over = await overflow();
      ok(`a rail showing every agent's state does not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/presence-sidebar-${theme}.png` });
      }
    }
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  /* ================= FILES AN AGENT MADE, ON HIS SCREEN =================
   *
   * The store's server half landed first and nothing was ever drawn, so every
   * check below is about the SCREEN. Nothing here is stubbed: the file is
   * published through the hub's own `publishArtifact` frame from an engine
   * connection (`publishAsEngine`), which is the only way any file can enter
   * the store at all — a desktop client sending that frame is refused, and that
   * refusal is the whole value of the attribution. The bytes come back through
   * the one download endpoint an attachment uses, and are compared with what
   * went in.
   */
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# general");
  await page.waitForSelector(".composer textarea", { timeout: 15000 });
  const world9 = await page.evaluate(() => ({
    channels: window.cloud9Wire.channels(),
    agents: window.cloud9Wire.agents(),
    me: window.cloud9Wire.me(),
  }));
  const generalId = world9.channels.find(c => c.name === "general").id;
  /* HIS OWN AGENTS, and only those: the hub refuses to publish a file wearing
     somebody else's agent's name, which is the point. Two different ones,
     because one file with two authors in its history is the thing the store
     exists to make possible. */
  const mineAgents = world9.agents.filter(a => a.ownerId === world9.me);
  const artAgent = mineAgents.find(a => a.name === "Scout") ?? mineAgents[0];
  const artAgent2 = mineAgents.find(a => a.id !== artAgent.id) ?? artAgent;

  const REPORT_V1 = "# Villas in Goa\nThree that fit, with prices.\n";
  const REPORT_V2 = "# Villas in Goa\nThree that fit, with the prices corrected.\n";
  const REPORT_V3 = "# Villas in Goa\nThree that fit, with the final prices corrected.\n";
  const v1 = await publishAsEngine({
    channelId: generalId, agentId: artAgent.id, name: "villas.md", data: REPORT_V1,
  });
  const artId = v1.id;

  const artBox = page.locator(".composer textarea");
  await artBox.fill(`here is the write-up ${artifactRef(artId)}`);
  await artBox.press("Enter");
  await page.waitForSelector(`.msg .artcard[data-artifact="${artId}"]`, { timeout: 20000 });
  const artCard = page.locator(`.msg .artcard[data-artifact="${artId}"]`).last();

  ok("a file an agent made appears in the conversation as a card with its name",
    (await artCard.locator(".artname").innerText()).trim() === "villas.md",
    (await artCard.locator(".artname").innerText()).trim());

  const cardLine = (await artCard.locator(".artby").innerText()).trim();
  const cardFacts = (await artCard.locator(".artfacts").innerText()).trim();
  ok("the card says which agent made it, and how big it is",
    cardLine === describeArtifactVersion(v1.versions[0])
    && cardLine.includes(`made by ${artAgent.name}`)
    && /\d/.test(cardFacts),
    `${cardLine} :: ${cardFacts}`);

  /* VERSION 1 DRAWS NO "v1". Absent means absent, and `describeArtifactVersion`
     is the one owner that decides it — so this is a check on the screen using
     that owner's own answer, never a sentence typed here. */
  ok("version 1 is not labelled with a version number nobody needs",
    !/version 1\b/.test(cardLine), cardLine);

  /* THE PATH IS GONE. The reference is still in the real message — copying and
     editing see it — but the words drawn beside the card must not be the
     machine text the card replaces. */
  const bodyWords = (await page.locator(`.msg:has(.artcard[data-artifact="${artId}"]) .body`)
    .last().innerText());
  ok("the reference itself is not printed beside the card it draws",
    !bodyWords.includes("cloud9://") && bodyWords.includes("here is the write-up"),
    bodyWords.replace(/\s+/g, " ").slice(0, 120));

  /* THE BYTES, back through the same one-use ticket an attachment uses, fetched
     over real HTTP from the app's own method. A card on screen is not evidence
     that a file came back. */
  const gotBack = await page.evaluate(async id => {
    const t = await window.cloud9Artifacts.ticket(id);
    const res = await fetch(t.url);
    return { status: res.status, text: await res.text() };
  }, artId);
  ok("the file really comes back, byte for byte, through the attachment ticket path",
    gotBack.status === 200 && gotBack.text === REPORT_V1,
    `${gotBack.status} ${JSON.stringify(gotBack.text).slice(0, 80)}`);

  /* A SECOND AGENT REVISING THE SAME NAME IS A HANDOFF — one file, two authors,
     and NOT two cards with the same name that nobody can tell apart. */
  const v2 = await publishAsEngine({
    channelId: generalId, agentId: artAgent2.id, name: "villas.md", data: REPORT_V2,
    note: "fixed the numbers",
  });
  await waitFor(page, id => document.querySelector(`.msg .artcard[data-artifact="${id}"]`)
    ?.dataset.version === "2", artId,
  { timeout: 20000, what: "the card on screen to become version 2 by itself" });
  ok("publishing the same name again updates the SAME card, and says so",
    v2.id === artId
    && (await page.locator(`.msg .artcard[data-artifact="${artId}"]`).count()) === 1
    && /version 2/.test(await artCard.locator(".artby").innerText())
    && /fixed the numbers/.test(await artCard.locator(".artby").innerText()),
    (await artCard.locator(".artby").innerText()).trim());

  ok("the newest version names the agent that made THAT version, not the first one",
    artAgent2.id !== artAgent.id
    && (await artCard.locator(".artby").innerText()).includes(`made by ${artAgent2.name}`),
    (await artCard.locator(".artby").innerText()).trim());

  /* THE HISTORY: who made each version, and when — visible, and openable. */
  await artCard.locator(".arthistory").click();
  await page.waitForSelector(`.artcard[data-artifact="${artId}"] .artversion[data-version="1"]`,
    { timeout: 15000 });
  const oldRow = artCard.locator('.artversion[data-version="1"]');
  ok("the history shows the earlier version, who made it and when",
    (await oldRow.locator(".vwho b").innerText()).trim() === artAgent.name
    && /\d/.test(await oldRow.locator(".vwhen").innerText()),
    (await oldRow.innerText()).replace(/\s+/g, " ").slice(0, 100));

  const oldBytes = await page.evaluate(async id => {
    const t = await window.cloud9Artifacts.ticket(id, 1);
    const res = await fetch(t.url);
    return { status: res.status, text: await res.text() };
  }, artId);
  ok("an older version can still be downloaded, and it is the OLD bytes",
    oldBytes.status === 200 && oldBytes.text === REPORT_V1 && oldBytes.text !== REPORT_V2,
    `${oldBytes.status} ${JSON.stringify(oldBytes.text).slice(0, 60)}`);
  await page.screenshot({ path: `${SHOTS}/artifact-artCard.png` });

  /* TEXT MAY BE READ WHERE IT SITS; ANYTHING ELSE IS A DOWNLOAD AND NOTHING
     MORE. Which of the two it is, is the HUB's answer about the bytes. */
  await artCard.locator(".artopen").click();
  await page.waitForSelector(`.artcard[data-artifact="${artId}"] .artpeek pre`, { timeout: 20000 });
  ok("a text file can be read where it sits, and it is the file's own words",
    (await artCard.locator(".artpeek pre").innerText()).includes("prices corrected"),
    (await artCard.locator(".artpeek pre").innerText()).slice(0, 60));

  const shot = pngOfSolidColour(6, 6, [12, 90, 60]);
  const pic = await publishAsEngine({
    channelId: generalId, agentId: artAgent.id, name: "chart.png", data: shot,
  });
  /* A DISTINCT source file makes target identity testable. A self-link lets code
     that ignores target.artifactId accidentally pass as long as it keeps v1. */
  const LINK_TARGET = "villa,nightly budget\nCasa Sol,8000\n";
  const linkTarget = await publishAsEngine({
    channelId: generalId, agentId: artAgent.id, name: "villa-budget.csv", data: LINK_TARGET,
  });
  /* A markdown file may SAY it came from something. That sentence is not a typed
     relationship and must never be guessed into one by the Files screen. */
  const markdownOnly = await publishAsEngine({
    channelId: generalId, agentId: artAgent.id, name: "markdown-only.md",
    data: `[budget source](${artifactRef(linkTarget.id, 1)})\n`,
  });
  /* The third revision carries the typed relationship and names a real Scout turn
     the run-card round above already recorded and rendered. The first two stay
     untouched so their existing chat-card history proof remains independent. */
  const v3 = await publishAsEngine({
    channelId: generalId, agentId: artAgent.id, name: "villas.md", data: REPORT_V3,
    note: "linked the final revision", runId: rich.id,
    links: [{ kind: "made-from", target: { artifactId: linkTarget.id, version: 1 } }],
  });
  if (v3.id !== artId) throw new Error("the linked revision created a second villas file");
  await artBox.fill(`and the chart ${artifactRef(pic.id)}`);
  await artBox.press("Enter");
  await page.waitForSelector(`.msg .artcard[data-artifact="${pic.id}"]`, { timeout: 20000 });
  const picCard = page.locator(`.msg .artcard[data-artifact="${pic.id}"]`).last();
  ok("a file that is not text is a download and is never drawn into the room",
    (await picCard.locator(".artopen").innerText()).trim() === "Save it"
    && (await picCard.locator(".artpeek").count()) === 0,
    (await picCard.locator(".artfacts").innerText()).trim());

  /* A REFERENCE TO SOMETHING THAT IS NOT THERE says so in plain words — and
     gets the same sentence a file you may not see gets, on purpose. */
  await artBox.fill("what about cloud9://artifact/af-nothinghere");
  await artBox.press("Enter");
  /* A CARD FIRST SAYS IT IS LOOKING, AND ONLY THEN THAT IT IS NOT THERE — and
     the gap between the two is the request ledger's own answer window. An
     `error` frame carries no echo of the question it refuses, so a refusal is
     given to the OLDEST question still waiting (see `asked` in `store.ts`); a
     question that never gets one is told so when its window closes. That is
     `ANSWER_WINDOW_MS`, 20 seconds, so this waits past it rather than racing
     it. It never guesses: the card is drawn either way, and neither state is
     an empty box. */
  await waitFor(page, () => document.querySelector('.artcard[data-artifact="af-nothinghere"]')
    ?.dataset.state === "gone",
  undefined, { timeout: 45000, what: "the card for a file that is not there to say so" });
  ok("a reference to a file that is not there says so in plain words, with no jargon",
    /isn't here/i.test(await page.locator('.artcard[data-artifact="af-nothinghere"] .nm').innerText())
    && !/error|null|undefined/i.test(
      await page.locator('.artcard[data-artifact="af-nothinghere"]').innerText()),
    (await page.locator('.artcard[data-artifact="af-nothinghere"]').innerText())
      .replace(/\s+/g, " ").slice(0, 120));

  /* THE ROOM'S OWN LIST of what agents have made in it — and the empty state,
     which only ever appears after the hub has answered. */
  await page.click(".chathead .roomdetailsbtn");
  await page.waitForSelector(".roompanel .roomfiles", { timeout: 15000 });
  await waitFor(page, () => !!document.querySelector('.roomfiles [data-files-state="some"]'),
    undefined, { timeout: 20000, what: "the room's file list to come back from the hub" });
  ok("the room's details list every file agents have made in it",
    (await page.locator(`.roomfiles .artcard[data-artifact="${artId}"]`).count()) === 1
    && (await page.locator(`.roomfiles .artcard[data-artifact="${pic.id}"]`).count()) === 1,
    await page.locator(".roomfiles").getAttribute("data-files"));
  await page.screenshot({ path: `${SHOTS}/artifact-room-files.png` });

  await page.click(".roompanel .roomclose");
  await page.click(".sidebar >> text=# paperwork");
  await page.click(".chathead .roomdetailsbtn");
  await page.waitForSelector(".roompanel .roomfiles", { timeout: 15000 });
  await waitFor(page, () => !!document.querySelector('.roomfiles [data-files-state="empty"]'),
    undefined, { timeout: 20000, what: "the hub to answer that this room holds no agent files" });
  ok("a room where no agent has shared anything says so in plain words, not with a blank",
    /No agent has shared a file here yet/i.test(
      await page.locator('.roomfiles [data-files-state="empty"]').innerText()),
    (await page.locator(".roomfiles").innerText()).replace(/\s+/g, " ").slice(0, 120));
  await page.click(".roompanel .roomclose");

  /* ================= FILES — ONE WORKSPACE ACROSS READABLE ROOMS ===========
   * These seven checks are the permanent screen proof for feature 1. They reuse
   * the real retained file above: its first two versions prove a handoff between
   * agents; its latest revision names a real turn and links exactly back to v1.
   */
  const filesDoor = page.locator('.rail-btn[data-go="files"]');
  await filesDoor.click();
  await page.waitForSelector('[data-files-screen][data-files-state="some"]', { timeout: 20000 });
  ok("Files is in the rail and opens as the bounded cross-room workspace",
    (await filesDoor.count()) === 1
    && (await page.locator('[data-files-screen] .files-index[aria-label="Files you can read"]').count()) === 1
    && (await page.locator('[data-files-screen] h2').innerText()).trim() === "Files");

  const villasRow = page.locator(`.file-index-row[data-file-row="${artId}"]`);
  await villasRow.click();
  await page.waitForSelector(`.files-detail[data-file-detail="${artId}"][data-file-detail-state="here"]`,
    { timeout: 20000 });
  const latestTurnWords = (await villasRow.locator(".file-index-maker").innerText()).replace(/\s+/g, " ").trim();
  ok("Files names the latest maker and the exact turn that made this version",
    (await villasRow.getAttribute("data-maker")) === artAgent.name
    && (await villasRow.getAttribute("data-turn")) === rich.id
    && latestTurnWords.includes(artAgent.name)
    && latestTurnWords.includes(rich.id), latestTurnWords);

  const workspaceCard = page.locator(`.files-detail .artcard[data-artifact="${artId}"]`);
  await workspaceCard.locator(".arthistory").click();
  await page.waitForSelector(`.files-detail .artcard[data-artifact="${artId}"] .artversion[data-version="1"]`,
    { timeout: 15000 });
  const workspaceOld = workspaceCard.locator('.artversion[data-version="1"]');
  await workspaceOld.locator(".artopen-old").click();
  await page.waitForSelector(`.files-detail .artcard[data-artifact="${artId}"] .artversion[data-version="1"] .artpeek pre`,
    { timeout: 15000 });
  const oldWords = await workspaceOld.locator(".artpeek pre").innerText();
  ok("Files opens the immutable earlier version and returns its original bytes",
    (await workspaceCard.getAttribute("data-versions")) === "3"
    && (await workspaceOld.locator(".vwho b").innerText()).trim() === artAgent.name
    && /\d/.test(await workspaceOld.locator(".vwhen").innerText())
    && oldWords === REPORT_V1 && oldWords !== REPORT_V3,
    `${(await workspaceOld.innerText()).replace(/\s+/g, " ").trim()} :: ${JSON.stringify(oldWords)}`);

  const ownerAccess = page.locator(`.files-detail[data-file-detail="${artId}"] .fileaccess`);
  await page.waitForSelector(`.files-detail[data-file-detail="${artId}"] .fileaccess[data-access-editor="yes"]`,
    { timeout: 20000 });
  await fpage.click('.rail-btn[data-go="files"]');
  await fpage.waitForSelector(`.file-index-row[data-file-row="${artId}"]`, { timeout: 20000 });
  await fpage.click(`.file-index-row[data-file-row="${artId}"]`);
  await fpage.waitForSelector(`.files-detail[data-file-detail="${artId}"] .fileaccess[data-access-editor="read-only"]`,
    { timeout: 20000 });
  const memberAccess = fpage.locator(`.files-detail[data-file-detail="${artId}"] .fileaccess`);
  const memberControlsAbsent = (await memberAccess.locator(".accesschoice").count()) === 0
    && (await memberAccess.locator("[data-access-save]").count()) === 0;

  /* Keep the member's actual file contents OPEN while their role and then access
     change. A row disappearing from the left is not revocation if the detail and
     bytes already on the right remain readable. */
  const memberCard = fpage.locator(`.files-detail .artcard[data-artifact="${artId}"]`);
  await memberCard.locator(".artopen").click();
  await fpage.waitForSelector(`.files-detail .artcard[data-artifact="${artId}"] .artpeek pre`,
    { timeout: 15000 });
  const memberPreviewBefore = await memberCard.locator(".artpeek pre").innerText();

  /* Change Priya's role through the room's real manager UI, then return to the
     same Files detail. This proves the rule from both sides: a member gets no
     controls; an admin gets the real choices and Save button, not merely copy. */
  const setPriyaRoleInGeneral = async role => {
    await page.locator("[data-open-file-room]").click();
    await page.waitForSelector(".composer textarea", { timeout: 20000 });
    await page.click(".chathead .roomdetailsbtn");
    await page.waitForSelector('.roommembers .memberrow[data-member="Priya"]', { timeout: 20000 });
    const row = page.locator('.roommembers .memberrow[data-member="Priya"]');
    await row.locator(".memberopen").click();
    await page.waitForSelector('.memberask[data-manage="Priya"]', { timeout: 15000 });
    await page.click(`.memberask[data-manage="Priya"] .roleopt[data-setrole="${role}"]`);
    await waitFor(page, wanted => document.querySelector(
      '.roommembers .memberrow[data-member="Priya"] .rolename')?.dataset.role === wanted,
    role, { timeout: 20000, what: `Priya to become ${role} in #general` });
    await page.click(".roompanel .roomclose");
    await page.click('.rail-btn[data-go="files"]');
    await page.waitForSelector(`.file-index-row[data-file-row="${artId}"]`, { timeout: 20000 });
    await page.click(`.file-index-row[data-file-row="${artId}"]`);
    await page.waitForSelector(`.files-detail[data-file-detail="${artId}"][data-file-detail-state="here"]`,
      { timeout: 20000 });
  };

  await setPriyaRoleInGeneral("admin");
  await fpage.waitForSelector(`.files-detail[data-file-detail="${artId}"] .fileaccess[data-access-editor="yes"]`,
    { timeout: 20000 });
  const adminAccess = fpage.locator(`.files-detail[data-file-detail="${artId}"] .fileaccess`);
  const adminControlsAvailable = (await adminAccess.locator(".accesschoice").count()) === 2
    && (await adminAccess.locator("[data-access-save]").count()) === 1;

  await setPriyaRoleInGeneral("member");
  await fpage.waitForSelector(`.files-detail[data-file-detail="${artId}"] .fileaccess[data-access-editor="read-only"]`,
    { timeout: 20000 });
  ok("Files gives access controls to room managers and removes them for a plain member",
    (await ownerAccess.getAttribute("data-file-access")) === "room"
    && (await ownerAccess.locator('[data-access-choice="room"]').getAttribute("aria-pressed")) === "true"
    && /Everyone currently in the room/i.test(await ownerAccess.innerText())
    && memberControlsAbsent && adminControlsAvailable
    && (await fpage.locator(`.files-detail[data-file-detail="${artId}"] .fileaccess .accesschoice`).count()) === 0,
    `member controls=${memberControlsAbsent ? 0 : "present"}; admin choices=${adminControlsAvailable ? 2 : "missing"}`);

  await ownerAccess.locator('[data-access-choice="restricted"]').click();
  const requiredManager = ownerAccess.locator('.accessperson[data-required="yes"] input:disabled').first();
  await ownerAccess.locator("[data-access-save]").click();
  await page.waitForSelector(`.file-index-row[data-file-row="${artId}"][data-access="restricted"]`,
    { timeout: 20000 });
  await fpage.waitForSelector(".files-detail [data-file-unavailable]", { timeout: 20000 });
  await waitFor(fpage, id => !document.querySelector(`.file-index-row[data-file-row="${id}"]`), artId,
    { timeout: 20000, what: "the restricted file to leave a non-manager's Files list" });
  const memberDetailAfter = await fpage.evaluate(id => window.cloud9Artifacts.detail(id), artId);
  ok("restricting a file revokes an already-open member detail and its shown contents",
    memberPreviewBefore === REPORT_V3
    && (await ownerAccess.getAttribute("data-file-access")) === "restricted"
    && (await requiredManager.count()) >= 1
    && /managers are required/i.test(await ownerAccess.innerText())
    && (await fpage.locator(`.file-index-row[data-file-row="${artId}"]`).count()) === 0
    && (await fpage.locator(`.artcard[data-artifact="${artId}"]`).count()) === 0
    && (await fpage.locator(".files-detail .artpeek pre").count()) === 0
    && memberDetailAfter === null,
    `before=${JSON.stringify(memberPreviewBefore)}; after card=${await fpage.locator(`.artcard[data-artifact="${artId}"]`).count()}`);

  const markdownRow = page.locator(`.file-index-row[data-file-row="${markdownOnly.id}"]`);
  await markdownRow.click();
  await page.waitForSelector(`.files-detail[data-file-detail="${markdownOnly.id}"] [data-relations-state="empty"]`,
    { timeout: 20000 });
  const markdownCard = page.locator(`.files-detail .artcard[data-artifact="${markdownOnly.id}"]`);
  await markdownCard.locator(".artopen").click();
  await page.waitForSelector(`.files-detail .artcard[data-artifact="${markdownOnly.id}"] .artpeek pre`,
    { timeout: 15000 });
  ok("Markdown words inside a file do not become stored artifact links",
    (await page.locator(`.files-detail[data-file-detail="${markdownOnly.id}"] .relationrow`).count()) === 0
    && (await markdownCard.locator(".artpeek pre").innerText()).includes("cloud9://artifact/"));

  await villasRow.click();
  await page.waitForSelector(`.files-detail[data-file-detail="${artId}"] .relationtarget[data-linked-artifact="${linkTarget.id}"][data-linked-version="1"]`,
    { timeout: 20000 });
  const relationRow = page.locator(`.files-detail[data-file-detail="${artId}"] .relationrow[data-relation-kind="made-from"]`).first();
  const typedLink = relationRow.locator(`.relationtarget[data-linked-artifact="${linkTarget.id}"][data-linked-version="1"]`);
  const typedKind = (await relationRow.locator(".relationkind").innerText()).trim();
  const typedName = (await typedLink.locator(".relationname").innerText()).trim();
  const typedWords = (await typedLink.innerText()).replace(/\s+/g, " ").trim();
  await typedLink.click();
  await page.waitForSelector(`.files-detail[data-file-detail="${linkTarget.id}"] .artcard[data-artifact="${linkTarget.id}"][data-version="1"]`,
    { timeout: 15000 });
  const targetCard = page.locator(`.files-detail .artcard[data-artifact="${linkTarget.id}"]`);
  await targetCard.locator(".artopen").click();
  await page.waitForSelector(`.files-detail .artcard[data-artifact="${linkTarget.id}"] .artpeek pre`,
    { timeout: 15000 });
  const targetWords = await targetCard.locator(".artpeek pre").innerText();
  ok("Files names and follows a typed relationship to the distinct exact target bytes",
    typedKind.toLowerCase() === "made from" && typedName === "villa-budget.csv" && /v1/i.test(typedWords)
    && (await page.locator(`.files-detail[data-file-detail="${linkTarget.id}"] .filerelations a.mdlink`).count()) === 0
    && (await targetCard.getAttribute("data-version")) === "1"
    && targetWords === LINK_TARGET,
    `${typedKind} ${typedWords} :: ${JSON.stringify(targetWords)}`);
  await page.screenshot({ path: `${SHOTS}/files-workspace.png`, fullPage: true });

  /* ================= SEARCH EVERYWHERE (feature 3) ========================
   *
   * Seven permanent checks. Everything they look for is REAL: a message typed
   * into the composer, a reply written in a real thread, a file published
   * through the engine socket the way every file must be, and a second version
   * of that file so the first one becomes genuinely old. Nothing is stubbed,
   * because the whole claim of the feature is that words the hub really stored
   * — including words only an EARLIER version ever had — can be found again.
   *
   * The last one is the security check and it is the reason this feature could
   * be dangerous: the plain member's search must not surface the file that was
   * restricted above, and it is checked on that member's own signed-in screen
   * rather than by reading the hub's mind.
   *
   * Rare words on purpose. "wobbegong", "quokkatrail", "nudibranch" and
   * "kelpwarden" appear nowhere else in this suite, so a hit is a hit and not
   * some other row that happened to share a common word.
   */
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# general");
  await page.waitForSelector(".composer textarea", { timeout: 15000 });
  const evBox = page.locator(".composer textarea");
  await evBox.fill("the wobbegong sighting was near the reef");
  await evBox.press("Enter");
  await page.waitForSelector('.msgs .msg:has-text("wobbegong sighting")', { timeout: 25000 });
  const evMessageId = await page.locator('.msgs .msg:has-text("wobbegong sighting")')
    .last().getAttribute("data-msg");

  const evRoot = page.locator('.msgs .msg:has-text("wobbegong sighting")').last();
  await evRoot.hover();
  await evRoot.locator(".ma.reply").click();
  await page.waitForSelector(".threadpanel", { timeout: 15000 });
  await page.fill(".threadcomposer textarea", "the quokkatrail guide confirmed it");
  await page.press(".threadcomposer textarea", "Enter");
  await page.waitForSelector('.threadpanel .msg:has-text("quokkatrail guide")', { timeout: 25000 });
  const evReplyId = await page.locator('.threadpanel .msg:has-text("quokkatrail guide")')
    .last().getAttribute("data-msg");
  await page.click(".threadpanel .threadclose");
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 10000 });

  /* Two versions of one file. The word in the first is gone from the second,
     so finding it can only mean the hub kept and indexed the OLD bytes. */
  const EV_LOG_V1 = "# Reef log\nThe kelpwarden buoy drifted overnight.\n";
  const EV_LOG_V2 = "# Reef log\nThe buoy was recovered at dawn.\n";
  const evLog1 = await publishAsEngine({
    channelId: generalId, agentId: artAgent.id, name: "nudibranch-log.md", data: EV_LOG_V1,
  });
  await publishAsEngine({
    channelId: generalId, agentId: artAgent.id, name: "nudibranch-log.md", data: EV_LOG_V2,
  });
  const evLogId = evLog1.id;

  const openEverywhere = async (p, words) => {
    await p.evaluate(() => window.cloud9Menu.run("search"));
    await p.waitForSelector('.searchpanel .searchscopes[data-search-scope="everywhere"]',
      { timeout: 10000 });
    await p.fill(".search-input", words);
  };

  // --- 1 · the honest empty state, and nothing asked for ---
  await page.evaluate(() => window.cloud9Menu.run("search"));
  await page.waitForSelector(".searchpanel", { timeout: 10000 });
  const evAsksBefore = await page.evaluate(
    () => window.cloud9Wire.seen().searchEverywhereResults ?? 0);
  await page.fill(".search-input", "w");     // one letter is not a question
  await page.waitForTimeout(700);            // longer than the debounce
  const evEmptyWords = (await page.locator("[data-every-empty]").innerText()).replace(/\s+/g, " ");
  ok("search opens on everything, explains what it looks through, and asks the hub nothing yet",
    (await page.getAttribute(".searchscopes", "data-search-scope")) === "everywhere"
    && (await page.getAttribute(".searchbody", "data-every-body")) === "waiting"
    && /reply in a thread/i.test(evEmptyWords) && /older versions/i.test(evEmptyWords)
    && (await page.evaluate(() => window.cloud9Wire.everywhere())) === null
    && (await page.evaluate(() => window.cloud9Wire.seen().searchEverywhereResults ?? 0))
       === evAsksBefore,
    `${evEmptyWords.slice(0, 90)} :: asked ${await page.evaluate(() => window.cloud9Wire.seen().searchEverywhereResults ?? 0)} v ${evAsksBefore}`);

  /* The kind headings are compared in lower case on purpose: `.eyebrow` is
     drawn UPPERCASE by the stylesheet, so the words are what is being checked
     here and the styling is not. Checking "MESSAGE" would make a check about
     the words fail the day the heading stops shouting. */
  // --- 2 · a message ---
  await page.fill(".search-input", "wobbegong");
  await page.waitForSelector('.everyhit[data-every-kind="message"]', { timeout: 25000 });
  const evMsgHit = page.locator(`.everyhit[data-every-kind="message"][data-every-hit="${evMessageId}"]`);
  const evMsgWords = (await evMsgHit.innerText()).replace(/\s+/g, " ").trim();
  ok("search everywhere finds a message, labelled in plain words with its room, who and when",
    (await evMsgHit.count()) === 1
    && (await page.locator('.everygroup[data-every-group="message"] .eyebrow').innerText()).trim().toLowerCase() === "message"
    && (await evMsgHit.locator(".hitwho b").count()) === 1
    && /general/.test(evMsgWords)
    && (await evMsgHit.locator(".snippet mark").count()) >= 1,
    evMsgWords.slice(0, 100));

  // --- 3 · a reply, said to be a reply ---
  await page.fill(".search-input", "quokkatrail");
  await page.waitForSelector('.everyhit[data-every-kind="reply"]', { timeout: 25000 });
  const evReplyHit = page.locator(`.everyhit[data-every-kind="reply"][data-every-hit="${evReplyId}"]`);
  ok("a reply written in a thread is found and called a reply in a thread, not a message",
    (await evReplyHit.count()) === 1
    && (await page.locator('.everygroup[data-every-group="reply"] .eyebrow').innerText()).trim().toLowerCase()
       === "reply in a thread"
    && (await page.locator('.everyhit[data-every-kind="message"]').count()) === 0,
    (await evReplyHit.innerText()).replace(/\s+/g, " ").slice(0, 100));

  // --- 4 · a file, by its name ---
  await page.fill(".search-input", "nudibranch");
  await page.waitForSelector(`.everyhit[data-every-kind="file"][data-every-hit="${evLogId}"]`,
    { timeout: 25000 });
  ok("the shared name of a file an agent made is findable from the same one box",
    (await page.locator('.everygroup[data-every-group="file"] .eyebrow').innerText()).trim().toLowerCase() === "file"
    && (await page.locator(`.everyhit[data-every-kind="file"][data-every-hit="${evLogId}"]`)
      .innerText()).includes("nudibranch-log.md"),
    (await page.locator(`.everyhit[data-every-kind="file"][data-every-hit="${evLogId}"]`)
      .innerText()).replace(/\s+/g, " ").slice(0, 100));

  // --- 5 · words that ONLY an old version ever had, and the way to them ---
  await page.fill(".search-input", "kelpwarden");
  await page.waitForSelector('.everyhit[data-every-kind="fileVersion"]', { timeout: 25000 });
  const evOldHit = page.locator(
    `.everyhit[data-every-kind="fileVersion"][data-every-hit="${evLogId}"][data-every-version="1"]`);
  const evOldWords = (await evOldHit.innerText()).replace(/\s+/g, " ").trim();
  /* Read the heading BEFORE following the result: the click is what closes the
     panel, so anything asked of it afterwards is asking a screen that has
     rightly gone. */
  const evOldHeading = (await page.locator('.everygroup[data-every-group="fileVersion"] .eyebrow')
    .innerText()).trim().toLowerCase();
  await evOldHit.click();
  await page.waitForSelector(
    `.files-detail[data-file-detail="${evLogId}"] .artcard[data-artifact="${evLogId}"][data-version="1"]`,
    { timeout: 25000 });
  const evOldVersionRow = page.locator(
    `.files-detail .artcard[data-artifact="${evLogId}"] .artversion[data-version="2"]`);
  ok("words only an OLD version of a file ever had are found, and open that file's kept history there",
    evOldHeading === "old version of a file"
    && /v1/.test(evOldWords)
    && (await page.locator(".searchpanel").count()) === 0
    && (await page.locator(`.files-detail[data-file-detail="${evLogId}"]`).count()) === 1
    && (await evOldVersionRow.count()) === 1,
    evOldWords.slice(0, 100));
  await page.screenshot({ path: `${SHOTS}/search-everywhere.png`, fullPage: true });

  // --- 6 · clicking a message result lands in the room it was said in ---
  await openEverywhere(page, "wobbegong");
  await page.waitForSelector(
    `.everyhit[data-every-kind="message"][data-every-hit="${evMessageId}"]`, { timeout: 25000 });
  await page.click(`.everyhit[data-every-kind="message"][data-every-hit="${evMessageId}"]`);
  await page.waitForSelector(`.msgs .msg[data-msg="${evMessageId}"].litup`, { timeout: 25000 });
  ok("clicking a message result goes to that message, in the room it was really said in",
    (await page.locator(".searchpanel").count()) === 0
    && (await page.locator(`.msgs .msg[data-msg="${evMessageId}"]`).count()) === 1
    && /general/.test(await page.locator(".thread .topbar").innerText()),
    (await page.locator(".thread .topbar").innerText()).replace(/\s+/g, " ").slice(0, 60));

  // --- 7 · THE SECURITY ONE: a plain member cannot find a restricted file ---
  await openEverywhere(page, "villas.md");
  await page.waitForSelector(`.everyhit[data-every-kind="file"][data-every-hit="${artId}"]`,
    { timeout: 25000 });
  await openEverywhere(fpage, "villas.md");
  await waitFor(fpage, () => {
    const body = document.querySelector(".searchbody");
    return body && body.getAttribute("data-every-body") !== "running"
      && body.getAttribute("data-every-body") !== "waiting";
  }, undefined, { timeout: 25000, what: "the member's search everywhere to be answered" });
  const memberHits = await fpage.$$eval(".everyhit", rows => rows.map(r => ({
    id: `${r.getAttribute("data-every-kind")}:${r.getAttribute("data-every-hit")}`,
    words: (r.textContent ?? "").replace(/\s+/g, " ").trim(),
  })));
  /* The words he typed are echoed back in the honest "nothing you can see says
     …" line, and that is HIS sentence, not the hub's — so the leak is looked
     for in the RESULT ROWS, which are the only thing the hub decided. */
  ok("a plain member searching everywhere is not shown a restricted file, its name, or its words",
    (await page.locator(`.everyhit[data-every-kind="file"][data-every-hit="${artId}"]`).count()) === 1
    && !memberHits.some(h => h.id.endsWith(`:${artId}`))
    && !memberHits.some(h => /villas\.md/i.test(h.words))
    && (await fpage.locator(`.everyhit[data-every-kind="fileVersion"][data-every-hit="${artId}"]`).count()) === 0
    && (await fpage.getAttribute(".searchbody", "data-every-body")) === "nothing",
    `owner sees it; member rows: ${memberHits.map(h => h.id).join(", ") || "none"}`);
  await fpage.evaluate(() => window.cloud9Escape && null);
  await fpage.keyboard.press("Escape");
  await fpage.waitForSelector(".searchpanel", { state: "detached", timeout: 10000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".searchpanel", { state: "detached", timeout: 10000 });

  /* ================= WHAT HE TYPED IS NEVER THROWN AWAY IN SILENCE =========
   *
   * The audit's Major, reproduced first and then held shut: type into an
   * agent's brief, click any icon in the rail, and everything went with no
   * warning and nothing saved. The checks below hold the CLASS — one owner,
   * asked by every way out, on more than one surface.
   */
  await page.click('.rail-btn[data-go="crew"]');
  await page.waitForSelector(".crew-grid", { timeout: 20000 });
  /* One of his own agents — the Edit button only exists on those, which is the
     hub's rule and not a courtesy, so this picks the first card that has one. */
  const editable = page.locator('.crew-grid .cast:has(button:has-text("Edit"))').first();
  const editableName = await editable.getAttribute("data-crew");
  const openEditable = async () => {
    await page.click(`.crew-grid .cast[data-crew="${editableName}"] button:has-text("Edit")`);
    await page.waitForSelector(".editor textarea.persona-input", { timeout: 20000 });
  };
  await openEditable();

  ok("an editor nobody has typed into is not holding unsaved work",
    (await page.evaluate(() => window.cloud9Leave.unsaved())) === null);

  const typed = "AUDIT EDIT: this sentence should not vanish without a word.";
  await page.fill(".editor textarea.persona-input",
    (await page.inputValue(".editor textarea.persona-input")) + "\n" + typed);
  const owns = await page.evaluate(() => window.cloud9Leave.unsaved());
  ok("the agent editor tells the one owner it is holding unsaved words",
    typeof owns === "string" && owns.length > 0, String(owns));

  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".overlay.leaveask", { timeout: 15000 });
  ok("clicking a rail icon with unsaved words ASKS, in plain words, instead of throwing them away",
    (await page.locator(".editor textarea.persona-input").count()) === 1
    && /not been saved/i.test(await page.locator(".overlay.leaveask .body").innerText())
    && (await page.locator(".overlay.leaveask .keepediting").count()) === 1
    && (await page.locator(".overlay.leaveask .discardwork").count()) === 1,
    (await page.locator(".overlay.leaveask .body").innerText()).replace(/\s+/g, " ").slice(0, 120));
  await page.screenshot({ path: `${SHOTS}/unsaved-asks.png` });

  await page.click(".overlay.leaveask .keepediting");
  await page.waitForSelector(".overlay.leaveask", { state: "detached", timeout: 10000 });
  ok("keeping editing leaves every word exactly where it was",
    (await page.inputValue(".editor textarea.persona-input")).includes(typed)
    && (await page.evaluate(() => window.cloud9Leave.asking())) === null);

  /* SAVING IS HIS DECISION ABOUT THE WORDS, not a way out of them — so it must
     never ask. (This is the bug the guard itself would introduce.) */
  await page.click(".editor .topbar >> text=Save");
  await page.waitForSelector(".crew-grid", { timeout: 20000 });
  ok("saving does not ask about unsaved work — there is none left to lose",
    (await page.locator(".overlay.leaveask").count()) === 0
    && (await page.evaluate(() => window.cloud9Leave.unsaved())) === null);

  /* AND THE OTHER WAY: told to throw them away, it really does. */
  await openEditable();
  const kept = await page.inputValue(".editor textarea.persona-input");
  await page.fill(".editor textarea.persona-input", kept + "\nTHROWN AWAY ON PURPOSE");
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".overlay.leaveask", { timeout: 15000 });
  await page.click(".overlay.leaveask .discardwork");
  await page.waitForSelector(".composer textarea", { timeout: 20000 });
  await page.click('.rail-btn[data-go="crew"]');
  await openEditable();
  ok("choosing to throw the words away really leaves, and really discards them",
    !(await page.inputValue(".editor textarea.persona-input")).includes("THROWN AWAY ON PURPOSE")
    && (await page.inputValue(".editor textarea.persona-input")).includes(typed));
  await page.click(".editor .topbar >> text=Cancel");
  await page.waitForSelector(".crew-grid", { timeout: 20000 });

  /* A SECOND, COMPLETELY DIFFERENT SURFACE ON THE SAME OWNER — which is what
     makes this a class fix rather than a guard bolted onto the rail. */
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# general");
  await page.click(".chathead .roomdetailsbtn");
  await page.waitForSelector(".roompanel", { timeout: 15000 });
  await page.click(".roominfo-edit");
  await page.fill(".roomtopic-input", "half-written and not saved");
  ok("the room details panel tells the SAME owner it is holding unsaved words",
    /general/.test(String(await page.evaluate(() => window.cloud9Leave.unsaved()))),
    String(await page.evaluate(() => window.cloud9Leave.unsaved())));

  await page.click(".sidebar >> text=# paperwork");
  await page.waitForSelector(".overlay.leaveask", { timeout: 15000 });
  ok("changing conversation with unsaved room details asks too — the rail is not a special case",
    /not been saved/i.test(await page.locator(".overlay.leaveask .body").innerText()));
  await page.click(".overlay.leaveask .discardwork");
  await waitFor(page, () => !document.querySelector(".overlay.leaveask"),
    undefined, { timeout: 10000, what: "the question to go away" });
  await page.waitForSelector(".composer textarea", { timeout: 15000 });

  /* ================= A FAILURE READS LIKE A SENTENCE ======================
   *
   * The audit photographed one refusal drawn twice on one screen, in two
   * different states of politeness, one of them wearing the word "Error:".
   */
  const says = await page.evaluate(() => ({
    prefixed: window.cloud9Say.says("Error: you already have a project called \"Audit Box\""),
    jargon: window.cloud9Say.says("TypeError: Cannot read properties of undefined (reading 'id')"),
    plain: window.cloud9Say.says("that's too many files (max 4)"),
    sqlite: window.cloud9Say.says("SQLITE_CORRUPT: database disk image is malformed"),
  }));
  ok("the one owner takes the transport's own 'Error:' off a sentence somebody wrote for him",
    says.prefixed.text === 'you already have a project called "Audit Box"'
    && says.prefixed.detail === undefined, JSON.stringify(says.prefixed));
  ok("computer-speak is never shown as the sentence — he gets words he can act on",
    !/TypeError|properties of undefined/.test(says.jargon.text)
    && says.jargon.text.length > 20
    && says.jargon.detail.includes("Cannot read properties"), JSON.stringify(says.jargon));
  ok("a hub refusal already written in plain English passes through untouched",
    says.plain.text === "that's too many files (max 4)" && says.plain.detail === undefined,
    JSON.stringify(says.plain));
  ok("a database code is not what he is shown either",
    !says.sqlite.text.includes("SQLITE_CORRUPT")
    && says.sqlite.detail.includes("SQLITE_CORRUPT"), JSON.stringify(says.sqlite));

  /* ON SCREEN, through the hub's own catch-all: everything it refuses arrives
     as `String(err)`, which is "Error: …". Nothing anywhere may print that. */
  await page.evaluate(() => window.cloud9Wire.ask({ type: "artifact", artifactId: "af_nope_zzz" }));
  await waitFor(page, () => !!document.querySelector(".toast .toast-text"),
    undefined, { timeout: 15000, what: "the hub's refusal to reach the screen" });
  const toastSays = (await page.locator(".toast .toast-text").innerText()).trim();
  ok("a raw refusal from the hub's catch-all never reaches him with 'Error:' on the front",
    !/^Error:/i.test(toastSays) && toastSays.length > 0, toastSays);
  /* AND THE SAME THING WITH THE WRAPPER PUT BACK ON BY HAND. The check above
     goes the whole way through the hub, which is the real path — but the hub's
     catch-all belongs to another round, and if it stops wrapping refusals that
     check would quietly stop being able to fail. This hands the SCREEN the exact
     text a wrapped failure arrives in, through the app's own "say this" method,
     so the screen's own promise is proved whatever the hub does. */
  await page.evaluate(() => window.cloud9Wire.notify(
    "Error: that conversation is archived — nothing new can be said in it"));
  await waitFor(page, () => /archived/.test(
    document.querySelector(".toast .toast-text")?.textContent ?? ""),
  undefined, { timeout: 15000, what: "the wrapped refusal to reach the screen" });
  const anyPrefix = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter(el => el.children.length === 0 && /^\s*Error:/i.test(el.textContent ?? "")).length);
  ok("nothing anywhere on the screen is wearing the word 'Error:'",
    anyPrefix === 0
    && (await page.locator(".toast .toast-text").innerText()).trim()
      === "that conversation is archived — nothing new can be said in it",
    `${anyPrefix} :: ${(await page.locator(".toast .toast-text").innerText()).trim()}`);

  /* THE PICTURE ITSELF: two repositories, one nickname. It used to be said
     twice — a clean toast and an "Error:"-prefixed line under the form. */
  await page.click('.rail-btn[data-go="projects"]');
  await page.waitForSelector(".projects", { timeout: 20000 });
  await page.click(".projects .topbar [data-connect]");
  await page.waitForSelector(".connectproj", { timeout: 20000 });
  await page.fill("#f-repo", "vikas53953/cloud9");
  await page.fill("#f-repo-name", "Audit Box");
  await page.click('.connectproj button:has-text("Connect")');
  await page.waitForSelector('.proj-list .side-item[data-repo="vikas53953/cloud9"]',
    { timeout: 30000 });
  /* AND NOW THE AUDIT'S OWN PICTURE: a second repository given the SAME
     nickname. The hub refuses on the name before it goes anywhere near GitHub,
     and that refusal used to arrive twice — a clean toast, and a line under the
     form with the word "Error:" on the front of it. */
  await page.click(".projects .topbar [data-connect]");
  await page.waitForSelector(".connectproj", { timeout: 20000 });
  await page.fill("#f-repo", "vikas53953/cloud9-audit-box");
  await page.fill("#f-repo-name", "Audit Box");
  await page.click('.connectproj button:has-text("Connect")');
  await page.waitForSelector(".connectproj .problemline", { timeout: 20000 });
  const inlineSays = (await page.locator(".connectproj .problemline").innerText()).trim();
  const toastCount = await page.locator(".toast").count();
  ok("the same refusal is said ONCE on the screen, where the box he must change is",
    !/^Error:/i.test(inlineSays) && inlineSays.length > 0 && toastCount === 0,
    `${inlineSays.slice(0, 80)} :: toasts=${toastCount}`);
  ok("the one owner knows exactly one place is saying that sentence",
    (await page.evaluate(t => window.cloud9Say.showing(t), inlineSays)) === 1,
    String(await page.evaluate(t => window.cloud9Say.showing(t), inlineSays)));
  await page.screenshot({ path: `${SHOTS}/error-said-once.png` });

  /* ================= JOIN A FRIEND'S CLOUD9 (docs/plans/join-hub-handoff.md) =================
   *
   * The owner is on hub A (this QA run's own hub). We stand up a SECOND real hub
   * on another loopback port, mint a join link on it, and walk the owner's own
   * screen through joining it — then kill it and prove the fall-back to self.
   * Loopback is honest here: the mechanism is proved end to end; reaching a
   * friend over the internet needs Tailscale (his sign-in) and is deferred. */
  const hubB = await startSecondHub();
  const joinCodeB = await mintJoinTokenOn(hubB.port, hubB.token);

  // clear whatever overlay the previous check left open, then open the address book
  await page.keyboard.press("Escape");
  await page.click(".rail-btn.hubswitch");
  await page.waitForSelector(".friendspanel", { timeout: 10000 });
  const selfActive = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".friendspanel .hubrow")];
    const self = rows.find(r => r.dataset.self === "1");
    return { count: rows.length, selfActive: !!self && self.classList.contains("is-active") };
  });
  ok("the address book lists this computer's own Cloud9, and it is the live one",
    selfActive.count >= 1 && selfActive.selfActive, JSON.stringify(selfActive));

  // a PUBLIC-INTERNET address is refused in the preview, in plain words
  await page.fill(".friendspanel .joinlink", "cloud9://8.8.8.8:8787");
  await page.waitForSelector(".friendspanel .joinpreview.bad", { timeout: 10000 });
  const publicRefusal = (await page.locator(".friendspanel .joinpreview.bad").innerText()).trim();
  ok("a public-internet address is refused before it can be added, in words",
    /open internet|public internet/i.test(publicRefusal) && !/^Error:/i.test(publicRefusal),
    publicRefusal.slice(0, 90));

  // a valid LOOPBACK link previews honestly — "this computer" reach, host named
  await page.fill(".friendspanel .joinlink", `cloud9://127.0.0.1:${hubB.port}#${process.env.CLOUD9_QA_BREAK_JOIN ? "join_BROKEN_code_xxxxxxxxxxxxxxxx" : joinCodeB}`);
  await page.waitForSelector(".friendspanel .joinpreview.ok", { timeout: 10000 });
  const goodPreview = (await page.locator(".friendspanel .joinpreview.ok").innerText()).trim();
  ok("a valid link previews with its honest reach and names the hub, and sees the join link",
    goodPreview.includes(`127.0.0.1:${hubB.port}`) && /this computer/i.test(goodPreview)
      && /join link/i.test(goodPreview),
    goodPreview.slice(0, 110));

  /* Two break-proof switches (law: a check that cannot fail is not a check),
   * inert unless the env var is set, so the conductor can reproduce the proof:
   *   CLOUD9_QA_BREAK_JOIN=1     — corrupt the token: the "dials it" check fails.
   *   CLOUD9_QA_BREAK_FALLBACK=1 — never kill hub B: the "falls back" check fails. */
  // name it and connect — this really dials the second hub
  await page.fill(".friendspanel .joinlabel", "Priya's Cloud9");
  await page.click(".friendspanel .addhubbtn");
  await waitFor(page, () => {
    const line = document.querySelector(".friendspanel .hubconn")?.textContent ?? "";
    return /Connected to Priya's Cloud9/i.test(line);
  }, undefined, { timeout: 30000, what: "the client to report it is connected to the friend's hub" });
  const nowActive = await page.evaluate(() => {
    const active = document.querySelector(".friendspanel .hubrow.is-active .hubname");
    return active ? active.textContent.replace(/On now/i, "").trim() : "";
  });
  ok("adding a friend's Cloud9 actually dials it — the connection says so, and it is the live hub",
    /Priya's Cloud9/.test(nowActive), nowActive);

  // messages flow on the friend's hub: send one and watch it land
  await page.click(".friendspanel .foot button");            // Done — close the modal
  await page.click('.rail-btn[data-go="chat"]');             // make sure we are on the chat screen
  await page.click("text=# general");
  const jbox = page.locator(".composer textarea");
  await jbox.fill("hello from a joined Cloud9");
  await jbox.press("Enter");
  await page.waitForSelector(".msg p:has-text('hello from a joined Cloud9')", { timeout: 30000 });
  ok("a message sent on the friend's hub round-trips — messages really flow over the join",
    (await page.locator(".msg p:has-text('hello from a joined Cloud9')").count()) >= 1);

  // KILL the friend's hub → the client must fall back to this computer's own
  if (!process.env.CLOUD9_QA_BREAK_FALLBACK) hubB.relay.close();
  await page.click(".rail-btn.hubswitch");
  await page.waitForSelector(".friendspanel", { timeout: 10000 });
  await waitFor(page, () => {
    const rows = [...document.querySelectorAll(".friendspanel .hubrow")];
    const self = rows.find(r => r.dataset.self === "1");
    const line = document.querySelector(".friendspanel .hubconn")?.textContent ?? "";
    return !!self && self.classList.contains("is-active") && /Connected to This computer/i.test(line);
  }, undefined, { timeout: 45000, what: "the client to fall back to this computer's own hub" });
  ok("killing the friend's hub falls the client back to this computer's own — it is never locked out",
    true);

  // the OWNER can mint a join link on this hub, and it is a real cloud9://…#join_
  await page.click(".friendspanel .mintjoin");
  await page.waitForSelector(".friendspanel .joincode", { timeout: 10000 });
  const mintedLink = (await page.locator(".friendspanel .joincode").innerText()).trim();
  ok("the owner can mint a join link, and it is a cloud9:// link carrying a join_ token",
    /^cloud9:\/\/[^#\s]+#join_[A-Za-z0-9_-]+$/.test(mintedLink), mintedLink.slice(0, 80));

  // and the panel is honest that a friend over the internet needs Tailscale (deferred)
  const tailscaleNote = (await page.locator(".friendspanel .honesttailscale").innerText()).trim();
  ok("the panel says plainly that reaching a friend over the internet needs Tailscale, not wired tonight",
    /Tailscale/i.test(tailscaleNote) && /not wired/i.test(tailscaleNote), tailscaleNote.slice(0, 90));

  await page.screenshot({ path: `${SHOTS}/join-a-friend.png` });
  try { hubB.relay.close(); } catch { /* already closed */ }
  try { fs.rmSync(hubB.dir, { recursive: true, force: true }); } catch { /* best effort */ }

  /* ================= A JOB THAT IS STUCK OR FELL OVER (feature 4, slice B) =================
   *
   * HIS BUG: a job that is stuck and a job that is working looked the same, and
   * a job that fell over never said why on the screen he reads.
   *
   * WHAT IS REAL HERE AND WHAT IS SEEDED, said plainly: the JOB is real — it is
   * created through the app's own frame, minted and stored by the hub, run by
   * the engine on this computer, and broadcast back like any other. The STATE is
   * seeded: the engine does not yet report "blocked" at all, and a demo run does
   * not fail on demand, so the final state and its reason are written onto the
   * stored job with the hub's own `updateTask` — the very frame the engine uses
   * (`engine.ts` failed path), through the very gate that only lets an owner
   * write onto their own agent's job. Nothing is faked in the browser and no
   * screen state is injected: everything below is the screen reading the hub.
   *
   * The job is only touched once the engine has finished with it (a job still
   * `not_started` or `working` is one the engine is about to overwrite), so
   * there is no race with the demo run. */
  await page.keyboard.press("Escape");
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# general");
  await page.waitForSelector(".composer textarea", { timeout: 15000 });
  const world4 = await page.evaluate(() => ({
    channels: window.cloud9Wire.channels(),
    agents: window.cloud9Wire.agents(),
    me: window.cloud9Wire.me(),
  }));
  const genId4 = world4.channels.find(c => c.name === "general").id;
  const mine4 = world4.agents.filter(a => a.ownerId === world4.me);
  const stuckAgent = mine4.find(a => a.name === "Scout") ?? mine4[0];
  const failAgent = mine4.find(a => a.id !== stuckAgent.id) ?? stuckAgent;

  /** Hand the hub a real job and then the state the engine cannot yet reach. */
  const seedJob = async ({ agentId, title, status, error, summary }) => {
    const before = await page.evaluate(() => window.cloud9Runs.jobs().map(j => j.id));
    await page.evaluate(([a, c, t]) =>
      window.cloud9Wire.ask({ type: "createTask", agentId: a, channelId: c, title: t }),
    [agentId, genId4, title]);
    let id;
    try {
      const found = await page.waitForFunction(known => {
        const fresh = window.cloud9Runs.jobs().find(j => !known.includes(j.id));
        // only once the engine has let go of it: still queued or running means
        // it is about to be written over by the run's own result
        return fresh && fresh.status !== "not_started" && fresh.status !== "working"
          ? fresh.id : null;
      }, before, { timeout: 120000, polling: 250 });
      id = await found.jsonValue();
    } catch {
      throw new Error(`the hub never settled the job "${title}" — nothing to write a state onto`);
    }
    await page.evaluate(([i, s, e, sm]) => window.cloud9Wire.ask({
      type: "updateTask", taskId: i, status: s,
      // "" is the hub's own "clear it": a job with nothing to say keeps nothing
      error: e ?? "", summary: sm ?? "", result: "",
    }), [id, status, error ?? null, summary ?? null]);
    await waitFor(page, ([i, s]) => window.cloud9Runs.jobs().find(j => j.id === i)?.status === s,
      [id, status], { timeout: 30000, what: `the stored job to read back as ${status}` });
    return id;
  };

  const STUCK_WHY = "waiting on the Architect to answer the question about the budget";
  const FAILED_WHY = "the model was not signed in on this computer";
  const stuckJob = await seedJob({
    agentId: stuckAgent.id, title: "shortlist the villas the Architect picked",
    status: "blocked", error: STUCK_WHY,
  });
  const failedJob = await seedJob({
    agentId: failAgent.id, title: "book the two nights in Anjuna",
    status: "failed", error: FAILED_WHY,
  });
  const silentJob = await seedJob({
    agentId: failAgent.id, title: "email the shortlist to Priya",
    status: "failed",   // nothing recorded: no error, no summary
  });

  await page.click('.rail-btn[data-go="tasks"]');
  await page.waitForSelector(`.taskrow[data-task="${failedJob}"]`, { timeout: 30000 });
  const failedCard = (await page.locator(`.taskrow[data-task="${failedJob}"]`).innerText())
    .replace(/\s+/g, " ").trim();
  ok("a job that fell over says so in plain words AND says why, on the card itself",
    /Failed/.test(failedCard) && failedCard.includes(FAILED_WHY)
      && (await page.locator(`.taskrow[data-task="${failedJob}"] .trouble[data-trouble="failed"]`)
        .count()) === 1
      // never a path, never an argv — the reason is words, and only words
      && !/[A-Za-z]:\\|--[a-z]/.test(failedCard),
    failedCard.slice(0, 160));

  /* STUCK IS NOT RUNNING — the whole bug. The card must carry the stuck words,
     and it must sit under the stuck heading rather than in among the ones that
     are genuinely moving. */
  const stuckPlace = await page.evaluate(id => {
    const main = document.querySelector(".tasks-main");
    const kids = [...main.children];
    const card = main.querySelector(`.taskrow[data-task="${id}"]`);
    const stuckHead = kids.findIndex(k => k.classList.contains("stucklabel"));
    const runHead = kids.findIndex(k =>
      k.classList.contains("eyebrow") && /^Running ·/.test(k.textContent.trim()));
    return {
      words: card ? card.innerText.replace(/\s+/g, " ").trim() : "",
      at: kids.indexOf(card), stuckHead, runHead,
    };
  }, stuckJob);
  ok("a stuck job reads as stuck rather than working, and is not listed in with the running ones",
    /Stuck — waiting on something/.test(stuckPlace.words)
      && stuckPlace.words.includes(STUCK_WHY)
      && !/\bworking\b/i.test(stuckPlace.words)
      && stuckPlace.stuckHead >= 0 && stuckPlace.at > stuckPlace.stuckHead
      && (stuckPlace.runHead < 0 || stuckPlace.at < stuckPlace.runHead),
    JSON.stringify(stuckPlace).slice(0, 200));

  /* NOTHING INVENTED. A job that fell over before it had anything to say has no
     reason, and the screen says exactly that rather than borrowing another
     job's sentence or writing a comforting one. */
  const silentCard = (await page.locator(`.taskrow[data-task="${silentJob}"]`).innerText())
    .replace(/\s+/g, " ").trim();
  ok("a job with no recorded reason says so honestly, and invents nothing",
    /Failed/.test(silentCard) && /no reason was recorded/.test(silentCard)
      && !silentCard.includes(FAILED_WHY) && !silentCard.includes(STUCK_WHY),
    silentCard.slice(0, 160));
  await page.screenshot({ path: `${SHOTS}/jobs-stuck-and-failed.png` });

  /* AND THE PRESENCE ROW — the same one fact, from the same one owner. An agent
     whose job is stuck used to read "Ready · …" on every row in the app. */
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(`.agentrow[data-agent="${stuckAgent.name}"]`, { timeout: 20000 });
  const presenceRow = await page.evaluate(name => {
    const row = document.querySelector(`.agentrow[data-agent="${name}"]`);
    return { trouble: row.dataset.trouble ?? "", words: row.innerText.replace(/\s+/g, " ").trim() };
  }, stuckAgent.name);
  ok("an agent whose job is stuck says so on its presence line, instead of reading as fine",
    presenceRow.trouble === "blocked"
      && /Stuck — waiting on something/.test(presenceRow.words)
      && presenceRow.words.includes(STUCK_WHY)
      && !/\bReady\b/.test(presenceRow.words),
    JSON.stringify(presenceRow).slice(0, 200));

  /* ================= FEATURE 5 · A ROOM HE HAS TURNED DOWN =================
   *
   * Notifications used to be all-or-nothing, so the one busy room was the reason
   * to switch every notification off. Muting is per room now, and the rule is one
   * line: a muted room silences everything EXCEPT somebody mentioning him by
   * name. It is written into `decideNotification` (packages/shared/src/notify.ts)
   * as one more reason inside the ONE gate — never a second gate — so it can only
   * ever silence, never make something louder.
   *
   * Nothing below is stubbed: the mute is set with his own button in the room's
   * details panel, the news is a real hub job reaching a real terminal state, and
   * the mention is a real line typed by the friend in the same room.
   */
  const notifyOn = () => page.locator('input.sw[aria-label="Tell me about new messages"]');
  const openRoom5 = async () => {
    await page.click('.rail-btn[data-go="chat"]');
    await page.click(".sidebar >> text=# general");
    await page.waitForSelector(".composer textarea", { timeout: 15000 });
  };
  await page.click('.rail-btn[data-go="settings"]');
  await page.waitForSelector("#set-notify", { timeout: 15000 });
  if (!(await notifyOn().isChecked())) await notifyOn().click();
  await openRoom5();
  if ((await page.locator(".roommute").count()) === 0) await page.click(".chathead .roomdetailsbtn");
  await page.waitForSelector(".roommute", { timeout: 15000 });

  const muteSaysBefore = (await page.locator(".roommute").innerText()).replace(/\s+/g, " ").trim();
  await page.click(".roommute .roommute-btn");
  await page.waitForSelector('.roommute[data-muted="yes"]', { timeout: 10000 });
  const muteSaysAfter = (await page.locator(".roommute").innerText()).replace(/\s+/g, " ").trim();
  /* WHAT THE CONTROL SAYS IT DOES. A mute that does not say what still gets
     through is a switch he has to test on himself to trust. */
  ok("the mute control says in plain words what muting a room really does",
    /On\. This room can interrupt you/.test(muteSaysBefore) &&
    /Muted\./.test(muteSaysAfter) &&
    /except somebody mentioning you by name/i.test(muteSaysAfter) &&
    /Unmute this room/.test(muteSaysAfter) &&
    (await page.locator(".roommute .roommute-btn").getAttribute("aria-pressed")) === "true",
    `${muteSaysBefore.slice(0, 60)} → ${muteSaysAfter.slice(0, 90)}`);
  /* AND ON THE ROW, so a room that stopped interrupting him is never just a room
     that went quiet for no reason he can see. One list, read by both. */
  ok("the room's own row shows it is muted, and the one stored list agrees",
    (await page.locator('.side-item[data-channel="general"] .mutedmark[data-muted="yes"]').count()) === 1 &&
    (await page.evaluate(() => window.cloud9Notify.muted())).includes(genId4),
    JSON.stringify(await page.evaluate(() => window.cloud9Notify.muted())));
  await page.screenshot({ path: `${SHOTS}/notify-room-muted.png` });

  /* SILENCED: a real job of his, in the muted room, reaching a real terminal
     state. `delivered()` is the app's own record of every notification that got
     through a door — an empty answer for this job is the proof, and it cannot be
     confused with a toast that simply timed out on screen. */
  const mutedJob = await seedJob({
    agentId: stuckAgent.id, title: "tidy the villa shortlist (muted room)",
    status: "failed", error: "nothing to tidy",
  });
  await page.waitForTimeout(2500);
  const mutedDelivered = await page.evaluate(id => window.cloud9Notify.delivered()
    .filter(d => d.id === `job_finished:${id}`), mutedJob);
  ok("news from a muted room does not interrupt him — nothing is delivered and nothing pops",
    mutedDelivered.length === 0 &&
    (await page.locator(`.notify-toast[data-subject="${mutedJob}"]`).count()) === 0,
    `deliveries for that job: ${mutedDelivered.length}`);

  /* AND A THREAD IS PART OF THE ROOM, NOT AN EXCEPTION TO IT.
   *
   * `decideNotification` silences every kind except a direct mention in a muted
   * room, thread replies included — deliberately, because if they pierced it,
   * muting a busy room would still deliver most of its traffic and the setting
   * would be wording rather than behaviour.
   *
   * Nothing is stubbed: a real reply, typed by Priya into the real thread box,
   * in a room he really muted with his own button. The proof is `delivered()`
   * — the app's own record of everything that got through a door — being empty
   * for THAT reply, which cannot be confused with a toast that timed out on
   * screen. And it is silence for the right reason: the identical journey
   * raised a real toast in the notify section above, in an unmuted room.
   * (He is not left blind either — the room's row still says the new thing is
   * inside a thread; muting hides the interruption, never the news.) */
  await page.fill(".composer textarea", "muted-thread-root: the last of the paperwork");
  await page.press(".composer textarea", "Enter");
  const mutedRoot = page.locator('.msgs .msg:has-text("muted-thread-root")').last();
  await mutedRoot.waitFor({ timeout: 20000 });
  const mutedRootId = await mutedRoot.getAttribute("data-msg");
  await fpage.click("text=# general");
  await fpage.waitForSelector(`.msgs .msg[data-msg="${mutedRootId}"]`, { timeout: 25000 });
  const priyaMutedRoot = fpage.locator(`.msgs .msg[data-msg="${mutedRootId}"]`);
  await priyaMutedRoot.hover();
  await priyaMutedRoot.locator(".ma.reply").click();
  await fpage.waitForSelector(".threadpanel", { timeout: 15000 });
  await fpage.fill(".threadcomposer textarea", "muted-thread-reply-should-be-silent");
  await fpage.press(".threadcomposer textarea", "Enter");
  await fpage.waitForSelector('.threadpanel .msg:has-text("muted-thread-reply-should-be-silent")',
    { timeout: 20000 });
  const mutedReplyId = await fpage.locator(
    '.threadpanel .msg:has-text("muted-thread-reply-should-be-silent")').last().getAttribute("data-msg");
  await fpage.click(".threadpanel .threadclose");
  /* Wait until HIS screen has really got the reply, so the only possible reason
     for silence is the mute and not a message his client never received. The
     reply is not a row in the room by design, so the honest proof it arrived is
     the root's own reply count moving on his screen. */
  await waitFor(page, id => {
    const line = document.querySelector(`.msgs .msg[data-msg="${id}"] .threadline`);
    return !!line && Number(line.dataset.replies ?? 0) >= 1;
  }, mutedRootId, { timeout: 30000, what: "his screen to receive the reply written in the muted room" });
  await page.waitForTimeout(2500);
  const mutedThreadDelivered = await page.evaluate(id => window.cloud9Notify.delivered()
    .filter(d => d.id === `thread_reply:${id}`), mutedReplyId);
  ok("a reply in a thread in a muted room stays silent too — a thread is part of the room, not an exception to it",
    mutedThreadDelivered.length === 0 &&
    (await page.locator(`.notify-toast[data-subject="${mutedReplyId}"]`).count()) === 0,
    `deliveries for that reply: ${mutedThreadDelivered.length}`);

  /* THE ONE EXCEPTION, and the reason the rule is worth having: somebody asking
     him a question by name is not the noise he muted the room for. */
  await fpage.click("text=# general");
  await fpage.fill(".composer textarea", "@Vikas muted-room-mention-should-arrive");
  await fpage.press(".composer textarea", "Enter");
  await waitFor(page, () => [...document.querySelectorAll('.notify-toast[data-kind="mention"] .notify-text')]
    .some(t => /muted-room-mention-should-arrive/.test(t.textContent ?? "")),
  undefined, { timeout: 30000, what: "the mention to get through the muted room" });
  ok("somebody mentioning him by name still gets through a room he has muted", true,
    (await page.locator('.notify-toast[data-kind="mention"] .notify-text').last().innerText()).trim());
  await page.screenshot({ path: `${SHOTS}/notify-muted-mention.png` });

  /* AND BACK UP AGAIN — muting is a thing he can undo, and the same news that
     was silenced a minute ago interrupts him again. */
  if ((await page.locator(".roommute").count()) === 0) await page.click(".chathead .roomdetailsbtn");
  await page.click(".roommute .roommute-btn");
  await page.waitForSelector('.roommute[data-muted="no"]', { timeout: 10000 });
  const unmutedJob = await seedJob({
    agentId: stuckAgent.id, title: "tidy the villa shortlist (room turned back up)",
    status: "failed", error: "nothing to tidy",
  });
  await waitFor(page, id => window.cloud9Notify.delivered().some(d => d.id === `job_finished:${id}`),
    unmutedJob, { timeout: 30000, what: "the unmuted room's news to be delivered" });
  ok("turning the room back up lets its news interrupt him again, and the row's mark goes",
    (await page.locator('.side-item[data-channel="general"] .mutedmark').count()) === 0 &&
    (await page.evaluate(() => window.cloud9Notify.muted())).length === 0,
    `still muted: ${JSON.stringify(await page.evaluate(() => window.cloud9Notify.muted()))}`);

  /* ================= WHICH DOOR IT CAME THROUGH — AND NEVER NONE ============
   *
   * `chooseDelivery` decides the door, never whether he is interrupted. This
   * browser has no desktop shell, so there IS no operating-system door: every
   * notification must still arrive as the app's own toast, be recorded, and — when
   * the OS was the right home — be recorded as a FALLBACK with the reason. A
   * notification that goes nowhere in silence is the one outcome that is not
   * allowed, so every raised one is checked against the record.
   */
  const doors = await page.evaluate(() => ({
    door: window.cloud9Notify.door(),
    delivered: window.cloud9Notify.delivered(),
    unfocused: window.cloud9Notify.choose({ windowFocused: false, osSupported: false }),
    focused: window.cloud9Notify.choose({ windowFocused: true, osSupported: false }),
    refused: window.cloud9Notify.choose({ windowFocused: false, osSupported: true, osPermitted: false }),
  }));
  const honestReasons = ["window_focused", "window_not_focused", "os_unsupported", "os_refused"];
  ok("with no operating-system door here, every notification still arrives in the app and is recorded, never dropped",
    doors.door.bridge === false &&
    doors.delivered.length >= 2 &&
    doors.delivered.every(d => d.via === "in_app_toast" && honestReasons.includes(d.reason)) &&
    doors.unfocused.via === "in_app_toast" && doors.unfocused.fellBack === true &&
    doors.unfocused.reason === "os_unsupported" &&
    doors.refused.fellBack === true && doors.refused.reason === "os_refused" &&
    doors.focused.fellBack === false && doors.focused.reason === "window_focused",
    `${doors.delivered.length} delivered, bridge=${doors.door.bridge}, ` +
    `unfocused → ${doors.unfocused.via}/${doors.unfocused.reason}/fellBack=${doors.unfocused.fellBack}`);

  /* WHAT THIS SUITE CANNOT DRIVE, said out loud rather than faked.
   *
   * The other two connections states — a file that is really there ("In use")
   * and one that has really vanished ("That file is gone") — both need the
   * DESKTOP SHELL: the path can only be chosen through the operating system's
   * own file picker, and only the computer that runs the agent may look at the
   * disk to answer "is it still there?". A browser has neither. They are held in
   * `scripts/drive-app.mjs` (the installed app must claim exactly one of the four
   * honest states) and by the engine's own tests over `connectionsFileFor`.
   *
   * The one attempt to short-cut it — writing a stored path straight onto the
   * agent with `updateAgent` from the browser — was taken back out: the QA seam
   * hands back only an agent's id, name and owner, so that frame saved a partial
   * agent and the next screen to read it fell over. See implementation-notes.md.
   */

  await owner.close();
  await friendCtx.close();
} catch (err) {
  ok("UNCAUGHT", false, String(err));
  if (failShot) {
    try {
      await failShot.screenshot({ path: `${SHOTS}/99-uncaught.png`, fullPage: true });
      console.log("state when it broke:", (await failShot.textContent(".chathead")) ?? "(no chat header)");
    } catch { /* the page is already gone */ }
  }
} finally {
  await browser.close();
}

ok("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
fs.writeFileSync(`${SHOTS}/qa-results.json`, JSON.stringify({
  ranAt: new Date().toISOString(), expected: EXPECTED_CHECKS, executed: results.length, results,
}, null, 2));
// a run that stopped early is a FAILURE, not a good score out of a small number
reportAndExit("qa.mjs", results, EXPECTED_CHECKS);
