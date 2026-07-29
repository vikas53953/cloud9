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
  const key = page.locator('.join .panel input[type="password"]');
  await key.waitFor({ timeout });
  await key.fill(qaOwnerToken());
  await page.click("text=Enter Cloud9");
  try {
    await page.waitForSelector(".sidebar >> text=# general", { timeout });
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

/** Wait until an agent has answered in the open conversation, mentioning `contains`. */
export async function waitForAgentReply(page, contains, opts = {}) {
  await waitFor(page, needle => [...document.querySelectorAll(".msg")]
    .some(m => m.querySelector(".badge") && m.textContent.toLowerCase().includes(needle.toLowerCase())),
  contains, { ...opts, what: `an agent reply mentioning "${contains}"` });
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
