// Where a QA run points, who it signs in as, and how it waits — one owner for
// all three, because every QA script needs the same three answers and any two
// of them disagreeing makes the whole suite lie.
//
// Why this exists (security review 2026-07-29, finding #18): `scripts/qa-stack.mjs`
// already stands up a throwaway relay on a brand-new database, but the QA
// scripts DEFAULTED to port 8787 — the real dev relay, holding Vikas's real
// people, agents and conversations. So the safe path was opt-in and the
// dangerous one was what you got by typing `node scripts/qa.mjs`.
//
// The default is now the QA stack's own port, and pointing a QA run at the real
// relay takes a deliberate, named opt-in. QA writes test junk by design; it must
// never write it where real data lives.
//
// Why the owner key lives here too (QA harness round, 2026-07-29): the stack
// minted a fresh random owner key while the suite typed the SHIPPED DEFAULT into
// the join screen. Two places holding "the key", never the same string — so the
// owner could not sign in at all. There is now exactly one function that says
// what the key is, and exactly one that types it.

import crypto from "node:crypto";

/** The port `qa-stack.mjs` starts its throwaway relay on. */
export const QA_RELAY_PORT = "8799";
/** The port a normal `npm run dev:relay` uses — the REAL database. */
export const DEV_RELAY_PORT = "8787";

/**
 * A fresh owner key for one QA run. Called by `qa-stack.mjs` only; it hands the
 * value down to every QA script in `CLOUD9_OWNER_TOKEN`, and `qaOwnerToken()`
 * below reads it back. Random, so a QA stack is never sitting on the key every
 * checkout ships with.
 */
export function newQaOwnerToken() {
  return `qa-owner-${crypto.randomBytes(12).toString("base64url")}`;
}

/**
 * The key this QA run must type into the join screen.
 *
 * Inside `npm run qa` this is the stack's own minted key. Run a script by hand
 * against a hub you started yourself and it falls back to the shipped default,
 * which is what that hub will be using.
 */
export function qaOwnerToken() {
  return process.env.CLOUD9_OWNER_TOKEN ?? "dev-owner-token";
}

export function qaTarget() {
  const relayPort = process.env.CLOUD9_RELAY_PORT ?? QA_RELAY_PORT;
  const uiPort = process.env.CLOUD9_UI_PORT ?? "4173";

  if (relayPort === DEV_RELAY_PORT && process.env.CLOUD9_QA_ALLOW_REAL_DB !== "1") {
    console.error(
      `\nRefusing to run QA against port ${DEV_RELAY_PORT} — that is your real Cloud9,\n` +
      "and a QA run fills it with test people, test agents and test channels.\n\n" +
      "Run:  npm run qa\n" +
      "  (that starts a throwaway hub on a brand-new database and deletes it afterwards)\n",
    );
    process.exit(2);
  }

  return {
    relayPort,
    uiPort,
    ownerToken: qaOwnerToken(),
    ui: `http://127.0.0.1:${uiPort}/?relay=ws://127.0.0.1:${relayPort}`,
  };
}

/** Keep legacy broad QA rail journeys operable without changing shipped Focus CSS. */
export async function keepQaStudioVisible(page) {
  const content =
    ".chatgrid.focus-workspace{grid-template-columns:var(--side-w) minmax(0,1fr)!important}" +
    ".chatgrid.focus-workspace>.sidebar{display:flex!important}";
  // `addStyleTag` belongs to the current document and disappears on reload.
  // Install the same QA-only override for every future document as well: the
  // broad journey deliberately reloads while continuing to drive the Studio
  // rail, whereas the shipped Focus layout correctly hides that rail.
  await page.addInitScript(css => {
    const install = () => {
      if (document.querySelector("style[data-cloud9-qa-studio]")) return;
      const style = document.createElement("style");
      style.dataset.cloud9QaStudio = "";
      style.textContent = css;
      (document.head ?? document.documentElement).appendChild(style);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
    else install();
  }, content);
  await page.addStyleTag({ content });
}

/**
 * Sign in as the owner. The ONE place a QA script does this.
 *
 * The join screen pre-fills the shipped default key, which is right for a
 * developer and wrong for every QA run — so the field is cleared and this run's
 * real key typed in. Then it waits for the thing that proves the sign-in
 * worked: #general on screen. If that never appears the run stops HERE with a
 * plain sentence, instead of limping on and blaming the next check.
 */
export async function signInAsOwner(page, { timeout = 30000 } = {}) {
  await page.waitForSelector("text=Welcome to Cloud9", { timeout });
  // The broad QA journeys intentionally exercise the Studio sidebar (agents,
  // channels, invites). Seed an explicit split workspace before authentication
  // so React starts in that supported mode; changing it after first render can
  // race the access-loss fail-closed effect during the welcome transition.
  await page.evaluate(() => {
    const key = "cloud9.prefs";
    let value = {};
    try { value = JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { /* replace malformed QA-only input */ }
    localStorage.setItem(key, JSON.stringify({ ...value, workspaceLayout: "chat-files" }));
  });
  await page.reload();
  // Once a journey deliberately dismisses the split workspace, Focus hides the
  // Studio rail by design. The legacy broad suite still drives room/agent
  // controls through that rail, so keep it visible only inside this throwaway
  // browser. Product screenshots for Focus remain covered by the dedicated
  // workspace-layout tests; this override never ships in the app.
  await keepQaStudioVisible(page);
  await page.waitForSelector("text=Welcome to Cloud9", { timeout });
  const key = page.locator('.join .panel input[type="password"]');
  await key.waitFor({ timeout });
  await key.fill(qaOwnerToken());
  await page.click("text=Enter Cloud9");
  try {
    // Focus workspace intentionally hides the Studio sidebar. The visible
    // channel header is the stable proof that authentication completed and the
    // initial authorized room opened, regardless of the chosen workspace.
    await page.locator(".app .chatgrid").waitFor({ state: "attached", timeout });
    await page.locator(".sidebar").waitFor({ state: "visible", timeout });
    await page.locator('.sidebar button[title="New agent"]').waitFor({ state: "visible", timeout });
  } catch {
    throw new Error(
      "the owner could not sign in — the hub and this QA run disagree about the owner key. " +
      "Run the suite with `npm run qa` so the stack hands its key down.");
  }
}

/**
 * How long a cold engine may take to answer.
 *
 * A freshly-built engine host has to connect, detect both harnesses and start a
 * CLI before it says a word; on this machine that is 15-25s. It used to be
 * hidden because the long-lived dev hub was always warm, so the suite waited 8s
 * and blamed the feature. Every wait on an agent's answer uses THIS number, so
 * a slow machine can never be mistaken for a broken feature again.
 */
export const AGENT_REPLY_TIMEOUT_MS = Number(process.env.CLOUD9_QA_REPLY_TIMEOUT ?? 90000);

/**
 * Wait for a condition instead of sleeping for a guess. `check` runs in the
 * page and returns true when the thing we actually need has happened.
 */
export async function waitFor(page, check, arg, { timeout = AGENT_REPLY_TIMEOUT_MS, what = "" } = {}) {
  try {
    await page.waitForFunction(check, arg, { timeout, polling: 250 });
  } catch {
    throw new Error(`gave up after ${Math.round(timeout / 1000)}s waiting for ${what || "a condition"}`);
  }
}

/**
 * WHERE AN AGENT'S ANSWER LIVES NOW — the ONE place every QA script asks.
 *
 * WHAT CHANGED (2026-08-04, deliberate and owner-requested). An agent's answer
 * hangs off the message it answers: `threadOf()` in the engine returns
 * `trigger.replyTo ?? trigger.id`, so a question typed in the CHANNEL becomes
 * its own thread root and the answer is a reply under it. The hub keeps threads
 * one level deep (`resolveReplyTo` re-parents onto the root), and the desktop's
 * default `Prefs.replies = "thread"` HIDES replies from the main scroll. So an
 * agent's answer to a question is no longer a row in `.msgs` at all: the room
 * shows his question with an "N replies" line under it, and the words are in the
 * thread panel.
 *
 * THE THREE THINGS THAT STILL REACH THE ROOM ON THEIR OWN, because there is no
 * message for them to answer: a schedule firing, a received handoff, and a
 * proactive line (including the one-line "🧵 Finished in the thread: …" a long
 * job posts back when it ends). Those are the `inRoom: true` cases.
 *
 * Every wait on an agent's answer in every QA script goes through here, so the
 * next time this rule moves there is exactly one place to move it — the reason
 * the old `waitForAgentReply` had to be replaced rather than patched at 15 call
 * sites, each of which had quietly grown its own idea of where to look.
 *
 * IT CANNOT PASS ON SILENCE. Every step is a bounded wait on something that has
 * to appear: the question in the room, then the reply line ON that question,
 * then the thread panel showing that question, then an agent-authored row in
 * the panel carrying the words. Nothing here is satisfied by an absence, and a
 * step that never happens throws with a sentence naming what was waited for.
 *
 * Options:
 *   under   — the question the answer hangs off: a message id, or `{ text }` to
 *             find the last row in the conversation carrying those words.
 *             Required unless `inRoom`.
 *   text    — words the answer must carry (case-insensitive). "" means any.
 *   author  — the agent's name as the row prints it, when WHO answered is the
 *             point of the check.
 *   inRoom  — true for the paths that are still channel-level (see above).
 *   close   — shut the thread panel again afterwards (default true), so a check
 *             never leaves the screen in a state the next one did not ask for.
 *
 * Returns the facts, and judges only "did it arrive": `{ where, rootId,
 * answerIds, replies, alsoInRoom }`. `alsoInRoom` is the answer's own message
 * id looked for in the conversation behind the panel — the caller decides what
 * a leak means, because for one check (the headline one) it IS the check.
 */
export async function waitForAgentAnswer(page, opts = {}) {
  const {
    under, text = "", author = "", inRoom = false,
    timeout = AGENT_REPLY_TIMEOUT_MS, close = true, what,
  } = opts;
  const needle = { text: text.toLowerCase(), author };

  /* ONE matcher, asked twice — once to wait and once to report. Two spellings of
     "an agent answered" is how a suite ends up waiting for one thing and then
     reporting a different one. `[data-msg]` is part of it on purpose: an
     approval card is also a `.msg.from-agent` and it is nobody's answer. */
  const MATCH = ([sel, n]) =>
    [...document.querySelectorAll(`${sel} .msg.from-agent[data-msg]`)]
      .filter(m => (m.innerText ?? "").toLowerCase().includes(n.text))
      .filter(m => !n.author
        || (m.querySelector(".who b")?.textContent ?? "").trim() === n.author)
      .map(m => m.dataset.msg);
  const answersIn = scope => page.evaluate(MATCH, [scope, needle]);

  const said = [text && `mentioning "${text}"`, author && `from ${author}`]
    .filter(Boolean).join(" ");

  /* The wait and the report ask the SAME matcher, so this polls from here rather
     than handing `waitForFunction` a second copy of the query. It is still a
     bounded wait that throws in the same words `waitFor` uses — silence can
     never come back as a pass. */
  const untilAnswered = async (scope, why) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if ((await answersIn(scope)).length > 0) return;
      if (Date.now() >= deadline) {
        throw new Error(`gave up after ${Math.round(timeout / 1000)}s waiting for ${why}`);
      }
      await new Promise(r => setTimeout(r, 250));
    }
  };

  if (inRoom) {
    /* Still a room message, and that is the whole point of this branch — a
       schedule, a received handoff or a proactive line has no question to hang
       off. If one of these ever starts landing in a thread it fails HERE, which
       is the failure we want: the rule would have changed. */
    await untilAnswered(".msgs",
      what ?? `an agent line in the conversation ${said || "to arrive"}`);
    const answerIds = await answersIn(".msgs");
    return { where: "room", rootId: null, answerIds, replies: null, alsoInRoom: answerIds };
  }

  if (!under) throw new Error("waitForAgentAnswer needs `under` (the question the answer hangs off)");

  // ---- 1. the question itself, in the conversation ----
  /* A QUESTION IS SOMETHING A PERSON TYPED, so agent-authored rows are skipped
     when finding it by words. That is not tidiness — it is a trap this walked
     into on its first run: a long job's own room line QUOTES the ask it
     finished ("🧵 Finished in the thread: compare 14 villas…"), sits BELOW the
     ask, and matches the same words. Taking the last match handed back the
     agent's line, which of course has no thread of its own, and the check then
     waited ninety seconds for a reply line that could never appear and blamed
     the feature. Pass the message id directly when the question really is an
     agent's. */
  let rootId = typeof under === "string" ? under : null;
  if (!rootId) {
    const words = under.text;
    await waitFor(page, w => [...document.querySelectorAll(".msgs .msg[data-msg]")]
      .filter(m => !m.classList.contains("from-agent"))
      .some(m => (m.innerText ?? "").includes(w)),
    words, { timeout: 30000, what: `the question "${words}" to appear in the conversation` });
    rootId = await page.evaluate(w => [...document.querySelectorAll(".msgs .msg[data-msg]")]
      .filter(m => !m.classList.contains("from-agent"))
      .filter(m => (m.innerText ?? "").includes(w)).map(m => m.dataset.msg).pop(), words);
  }

  // ---- 2. the room says the question has been answered ----
  await waitFor(page, id => {
    const line = document.querySelector(`.msgs .msg[data-msg="${id}"] .threadline`);
    return !!line && Number(line.dataset.replies ?? 0) >= 1;
  }, rootId, { timeout,
    /* Its OWN sentence, never the caller's — this step and the one below both
       used to borrow `what`, so a failure could not say WHICH of them gave up:
       "the answer never came" and "the room never even said there was one" are
       two different bugs. */
    what: `the question to grow a replies line under it in the conversation${said ? ` (${said})` : ""}` });

  // ---- 3. open that thread ----
  const alreadyOpen = await page.locator(`.threadpanel .msg[data-msg="${rootId}"]`).count();
  if (!alreadyOpen) {
    await page.click(`.msgs .msg[data-msg="${rootId}"] .threadline`);
    await page.waitForSelector(".threadpanel", { timeout: 20000 });
    await waitFor(page, id => !!document.querySelector(`.threadpanel .msg[data-msg="${id}"]`),
      rootId, { timeout: 20000, what: "the thread panel to show the question it hangs off" });
  }

  // ---- 4. the answer, in that thread ----
  await untilAnswered(".threadpanel",
    what ?? `an agent answer inside the thread under the question ${said}`);

  const answerIds = await answersIn(".threadpanel");
  const alsoInRoom = await page.evaluate(ids =>
    ids.filter(i => !!document.querySelector(`.msgs .msg[data-msg="${i}"]`)), answerIds);
  const replies = Number(await page.getAttribute(
    `.msgs .msg[data-msg="${rootId}"] .threadline`, "data-replies"));

  if (close && await page.locator(".threadpanel .threadclose").count()) {
    await page.click(".threadpanel .threadclose");
    await page.waitForSelector(".threadpanel", { state: "detached", timeout: 10000 })
      .catch(() => { /* another check may have opened one of its own */ });
  }
  return { where: "thread", rootId, answerIds, replies, alsoInRoom };
}

/**
 * Prove the harness itself is honest before trusting a single result.
 *
 * Two controls, run against the REAL page rather than a mock of it:
 *  - a known-good check that must come back true;
 *  - a deliberately-broken check that must come back false.
 * If the broken one "passes", the query path is not really looking at the page
 * and every green result after it is worthless. A suite that cannot fail cannot
 * pass either — so this throws rather than politely reporting.
 */
export async function assertHarnessIsHonest(page) {
  const present = await page.locator(".sidebar").count();
  const impossible = await page.locator(".cloud9-no-such-element-exists-anywhere").count();
  if (present < 1) {
    throw new Error("harness self-check failed: the known-good check (.sidebar exists) did not pass — " +
      "the page is not what this suite thinks it is, so no result below can be trusted");
  }
  if (impossible !== 0) {
    throw new Error("harness self-check failed: a deliberately-broken check PASSED — " +
      "the page queries are not really running, so every green result is meaningless");
  }
}

/**
 * The last word on whether a run may be called a pass.
 *
 * A run that stopped early used to print "12/13 passed" and read like a
 * near-miss, when it was in fact a suite that never reached 36 of its checks.
 * Checks that never ran are FAILURES, not absences — and a run that executed
 * nothing at all is the worst of them: silence is not a green light.
 */
export function reportAndExit(name, results, expected) {
  const fails = results.filter(r => !r.pass).length;
  const executed = results.length;
  const passed = executed - fails;
  console.log(`\n${passed}/${executed} passed`);

  let short = false;
  if (executed === 0) {
    console.error(`\nFAIL — ${name} executed 0 checks. A run that checked nothing is not a pass.`);
    short = true;
  } else if (executed < expected) {
    console.error(
      `\nFAIL — ${name} stopped early: ${executed} of ${expected} checks executed, ` +
      `${expected - executed} never ran.\n` +
      `Do not read this as "${passed}/${executed} passed" — the checks that never ran ` +
      "are unknown, not fine.");
    short = true;
  } else {
    console.log(`${name}: all ${expected} expected checks executed.`);
  }
  process.exit(fails || short ? 1 : 0);
}
