// DID IT REALLY DO WHAT IT SAID? — the harness's verification pass.
//
// THE GAP THIS CLOSES. Everything else in Cloud9 that reports on a turn reports
// what HAPPENED: the run record lists every command, read, write and search the
// CLI announced; `describeRemoteAction` counts what is about to leave this
// computer; `receipts.ts` derives one tick from those facts. Nothing anywhere
// compared those facts against the SENTENCE the agent posted in the room. So an
// agent could say "I updated the config and the tests pass", do neither, and the
// owner — who cannot open a terminal and check — would have no way to know.
//
// THIS IS THE ANTI-HALLUCINATION PIECE, and it follows `receipts.ts`'s
// discipline exactly:
//
//  * NOTHING HERE ASKS A MODEL ANYTHING. No grader, no second opinion, no
//    "rate your own answer". Every verdict below is derived from a recorded
//    fact: a step the CLI reported, or a counted remote action the approval
//    desk settled.
//  * SILENCE IS THE DEFAULT. A turn whose claims all check out says nothing.
//    The owner hears from this module only when a claim and the record
//    disagree, which is the only time it is news.
//  * "I COULD NOT CHECK" IS A REAL ANSWER AND IS NEVER DRESSED UP AS EITHER
//    OF THE OTHER TWO. A harness that reported no steps at all (demo mode, a
//    provider with no stream) and a run whose step list was truncated both mean
//    the record is not a complete account of the turn — so an absent write is
//    not evidence of a missing write, and this module refuses to call it one.
//    A false accusation would cost more trust than the thing it is guarding.
//  * IT ONLY CHECKS WHAT IT CAN CHECK. Four claim shapes, listed below. A reply
//    that makes none of them produces an empty report, not a guess.
import type { RemoteAction, RemoteActionFacts, RunRecord, RunStep } from "@cloud9/shared";
import { describeRemoteAction } from "@cloud9/shared";

/** The four things a reply can claim that the record can answer. */
export type ClaimKind =
  | "wroteFile"          // "I updated notes.md"
  | "testsPass"          // "the tests pass"
  | "ranCommand"         // "I ran the build"
  | "leftThisComputer";  // "I pushed it" / "I opened a pull request"

/**
 * THREE ANSWERS, AND THE THIRD IS NOT A SHADE OF THE OTHER TWO.
 *  * `matches`      — the record shows it.
 *  * `noRecord`     — the record is complete for this turn and does NOT show it.
 *  * `cannotCheck`  — the record cannot settle it either way, and says so.
 */
export type ClaimVerdict = "matches" | "noRecord" | "cannotCheck";

export interface Claim {
  kind: ClaimKind;
  /** the agent's own words, clipped — so the owner sees exactly what was claimed */
  said: string;
  /** the particular thing named: a file name, or which remote action */
  subject?: string;
  verdict: ClaimVerdict;
  /** what the record shows instead, in plain words */
  because: string;
}

export interface VerifyInput {
  /** what the agent posted in the room */
  reply: string;
  /** what the engine recorded that it did */
  record: Pick<RunRecord, "steps" | "events" | "outcome"> &
    Partial<Pick<RunRecord, "truncated" | "agentName">>;
  /**
   * EVERY REMOTE ACTION THAT WAS SETTLED DURING THIS TURN, as counted facts —
   * the approval desk's ledger, never a sentence the agent wrote. Absent means
   * "nobody recorded any", which is different from "there were none": a caller
   * that cannot supply this passes nothing and every remote claim comes back
   * `cannotCheck`.
   */
  remote?: readonly RemoteActionFacts[];
  /** true when the caller really does know the remote ledger is complete */
  remoteKnown?: boolean;
}

export interface VerificationReport {
  /** every claim this module recognised, in the order the reply made them */
  claims: Claim[];
  /** the subset the record contradicts — the only ones the owner hears about */
  mismatches: Claim[];
  /** the line to post in the room, or absent when there is nothing honest to say */
  line?: string;
}

/** Longest quote of the agent's own words we put on screen. */
export const CLAIM_QUOTE_MAX = 120;
/** Most mismatches listed in one room line — the rest are counted. */
export const CLAIM_LINES_MAX = 5;

// ------------------------------------------------------------- the check

export function verifyTurn(input: VerifyInput): VerificationReport {
  const claims = readClaims(input.reply);
  if (claims.length === 0) return { claims: [], mismatches: [] };

  // A CANCELLED TURN CLAIMS NOTHING. The owner pulled the plug part-way
  // through, so an unfinished account of an unfinished turn is not evidence of
  // anything. Same rule, same reason, as `turnVerdict`'s first line.
  if (input.record.outcome === "cancelled") {
    return { claims: claims.map(c => cannot(c, "the turn was stopped part-way through")),
      mismatches: [] };
  }

  // IS THE RECORD A COMPLETE ACCOUNT OF THE TURN? Only if the harness reported
  // events at all, and only if we did not stop adding steps. When it is not,
  // every "the record does not show it" below softens to "I could not check",
  // because absence of a step is only evidence when steps were being kept.
  const complete = (input.record.events ?? 0) > 0 && input.record.truncated !== true;
  const incompleteWhy = (input.record.events ?? 0) > 0
    ? "this turn did too much for Cloud9 to keep the whole list"
    : "this app did not report what it did, step by step";

  const steps = input.record.steps ?? [];
  const settled: Claim[] = claims.map(claim => {
    const answer = answerClaim(claim, steps, input);
    if (answer.verdict === "noRecord" && !complete) return cannot(claim, incompleteWhy);
    return { ...claim, ...answer };
  });

  const mismatches = settled.filter(c => c.verdict === "noRecord");
  const line = mismatches.length > 0
    ? roomLine(mismatches, settled, input.record.agentName)
    : undefined;
  return { claims: settled, mismatches, ...(line ? { line } : {}) };
}

function cannot(claim: Claim, why: string): Claim {
  return { ...claim, verdict: "cannotCheck", because: `I could not check — ${why}.` };
}

// --------------------------------------------------- answering one claim

function answerClaim(
  claim: Claim, steps: readonly RunStep[], input: VerifyInput,
): { verdict: ClaimVerdict; because: string } {
  switch (claim.kind) {
    case "wroteFile": {
      const name = (claim.subject ?? "").toLowerCase();
      if (!name) return { verdict: "cannotCheck", because: "I could not tell which file it meant." };
      // A WRITE STEP FOR THAT FILE. A `command` step that names the file counts
      // too: a delete, a rename and a `sed` are real changes the CLI reports as
      // commands, and calling those "never happened" would be the false
      // accusation this module exists to avoid.
      const hit = steps.find(s =>
        (s.kind === "write" || s.kind === "command") && mentions(s, name) && s.ok !== false);
      if (hit) return { verdict: "matches", because: `step ${hit.seq} changed it.` };
      const wrote = steps.filter(s => s.kind === "write");
      return {
        verdict: "noRecord",
        because: wrote.length === 0
          ? "no file was changed at all in this turn."
          : `the only files changed in this turn were ${listNames(wrote)}.`,
      };
    }
    case "testsPass": {
      const ran = steps.filter(s => s.kind === "command" && looksLikeTests(s));
      if (ran.length === 0) {
        return { verdict: "noRecord", because: "no test command was run in this turn." };
      }
      if (ran.every(s => s.ok === false)) {
        return { verdict: "noRecord", because: "the test command that ran reported a failure." };
      }
      const ok = ran.find(s => s.ok !== false);
      return {
        verdict: "matches",
        because: ok?.ok === true
          ? `step ${ok.seq} ran the tests and they finished cleanly.`
          : `step ${ok?.seq} ran the tests (this app does not report a pass or fail).`,
      };
    }
    case "ranCommand": {
      const any = steps.some(s => s.kind === "command");
      return any
        ? { verdict: "matches", because: "a command was run in this turn." }
        : { verdict: "noRecord", because: "no command was run at all in this turn." };
    }
    case "leftThisComputer": {
      if (!input.remoteKnown) {
        return { verdict: "cannotCheck", because: "I could not check what left this computer." };
      }
      const want = claim.subject as RemoteAction | undefined;
      const done = (input.remote ?? []).filter(f => !want || f.action === want);
      if (done.length > 0) {
        return { verdict: "matches", because: `Cloud9 counted it: ${describeRemoteAction(done[0]!)}.` };
      }
      const other = input.remote ?? [];
      return {
        verdict: "noRecord",
        because: other.length === 0
          ? "nothing left this computer in this turn."
          : `the only thing that left this computer was ${describeRemoteAction(other[0]!)}.`,
      };
    }
  }
}

function mentions(step: RunStep, needle: string): boolean {
  const hay = `${step.label} ${step.detail ?? ""}`.toLowerCase();
  return hay.includes(needle);
}

function listNames(steps: readonly RunStep[]): string {
  const names = [...new Set(steps.map(s => s.detail ?? s.label))].slice(0, 3);
  return names.join(", ");
}

/**
 * IS THIS COMMAND A TEST RUN? Named runners only. "the tests pass" is checked
 * against a command that a person would agree is a test command — a broad
 * "contains the word test" would pass a `git commit -m "add tests"`.
 */
const TEST_COMMANDS =
  /\b(npm\s+(run\s+)?test|npm\s+t\b|yarn\s+test|pnpm\s+(run\s+)?test|npx\s+(vitest|jest|mocha)|vitest|jest|mocha|pytest|py\.test|unittest|go\s+test|cargo\s+test|dotnet\s+test|rspec|phpunit|gradle\s+test|mvn\s+test|node\s+--test|ctest|tox|make\s+test)\b/i;

function looksLikeTests(step: RunStep): boolean {
  return TEST_COMMANDS.test(`${step.label} ${step.detail ?? ""}`);
}

// ------------------------------------------------- reading the claims

/**
 * WORDS THAT MEAN "NOT YET". A sentence carrying any of these is describing a
 * plan, an option, a suggestion or a failure — none of which is a claim that
 * something happened, and all of which would otherwise be flagged as lies.
 *
 * DELIBERATELY GREEDY. Skipping a real claim costs one missed check; treating
 * a suggestion as a claim costs the owner's trust in every line this module
 * ever posts. When the two are in tension this file always chooses to say less.
 */
const NOT_YET =
  /\b(should|shall|would|could|will|i'?ll|we'?ll|let me|i can|you can|you could|you should|if you|once you|try|next|todo|to-do|plan(?:ning)?\s+to|going to|about to|recommend|recommends|suggest|suggests|please|need to|needs to|make sure|consider|might|may|maybe|perhaps|instead|rather than|before|after you|when you|couldn'?t|could not|cannot|can'?t|unable|failed|failing|did ?n[o']t|do ?n[o']t|does ?n[o']t|was ?n[o']t|were ?n[o']t|have ?n[o']t|has ?n[o']t|no changes|nothing|without|attempt|tried|would have|proposed|draft)\b/i;

/** A file name with a real extension — `notes.md`, `src/app.ts`, "package.json". */
const FILE_TOKEN = /(?:^|[\s`'"(\[])([\w.\-]*[\w\-](?:[\\/][\w.\-]+)*\.[A-Za-z][A-Za-z0-9]{0,5})(?=$|[\s`'")\],:;.!?])/g;

const DID_WRITE =
  /\b(created|creating|updated|updating|edited|editing|wrote|rewrote|writing|changed|changing|modified|modifying|added|adding|saved|saving|deleted|deleting|removed|removing|renamed|renaming|patched|patching|fixed|fixing|replaced|replacing|appended)\b/i;

const TESTS_PASS =
  /\b(tests?|test\s+suite|unit\s+tests?|suite)\b[^.]{0,60}\b(pass|passes|passed|passing|green|succeed|succeeds|succeeded|clean|all\s+good)\b|\ball\s+(tests?|specs?)\s+(pass|passed|passing|green)\b/i;

const DID_RUN = /\b(i\s+ran|we\s+ran|ran\s+the|running\s+the|executed|i\s+built|rebuilt)\b/i;

/** The remote verbs, and which counted action each one is a claim about. */
const REMOTE_CLAIMS: ReadonlyArray<[RegExp, RemoteAction]> = [
  [/\b(pushed|push(ed)?\s+up|pushed\s+the\s+branch)\b/i, "push"],
  [/\b(opened|raised|created|submitted)\s+(a\s+)?(pull\s+request|pr|merge\s+request)\b/i, "pullRequest"],
  [/\b(opened|filed|raised|created)\s+(an?\s+)?issue\b/i, "openIssue"],
  [/\b(commented|left\s+a\s+comment|posted\s+a\s+comment)\b/i, "comment"],
];

/**
 * PULL THE CHECKABLE CLAIMS OUT OF A REPLY.
 *
 * Sentence by sentence. A question is not a claim. A sentence carrying any
 * `NOT_YET` word is not a claim. Everything else is matched against the four
 * shapes above, and anything that matches none of them is simply not checked —
 * which is most of what an agent ever says, and that is fine.
 */
export function readClaims(reply: string): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<string>();
  for (const raw of sentences(reply)) {
    const s = raw.trim();
    if (s.length < 4) continue;
    if (s.endsWith("?")) continue;
    if (NOT_YET.test(s)) continue;
    const said = clip(s, CLAIM_QUOTE_MAX);

    if (TESTS_PASS.test(s)) push(out, seen, { kind: "testsPass", said, verdict: "cannotCheck", because: "" });

    if (DID_WRITE.test(s)) {
      for (const name of fileNames(s)) {
        push(out, seen, {
          kind: "wroteFile", said, subject: name, verdict: "cannotCheck", because: "",
        });
      }
    }

    for (const [pattern, action] of REMOTE_CLAIMS) {
      if (pattern.test(s)) {
        push(out, seen, {
          kind: "leftThisComputer", said, subject: action, verdict: "cannotCheck", because: "",
        });
      }
    }

    // Checked LAST and only when the sentence made no better claim: "I ran the
    // tests and they pass" is a tests claim, and adding a second, weaker claim
    // about the same sentence would report the same fact twice.
    if (DID_RUN.test(s) && !out.some(c => c.said === said)) {
      push(out, seen, { kind: "ranCommand", said, verdict: "cannotCheck", because: "" });
    }
  }
  return out;
}

function push(out: Claim[], seen: Set<string>, claim: Claim): void {
  const key = `${claim.kind}:${(claim.subject ?? "").toLowerCase()}`;
  if (seen.has(key)) return;      // one claim per thing, however often it is said
  seen.add(key);
  out.push(claim);
}

/** Split into sentences without splitting a file name in half. */
function sentences(reply: string): string[] {
  return reply
    // a full stop only ends a sentence when whitespace or the end follows it,
    // so "notes.md" survives and "…done. Next" splits
    .split(/(?<=[.!?;:])\s+|\n+|(?:^|\s)[-*•]\s+/g)
    .map(s => s.trim())
    .filter(s => s !== "");
}

function fileNames(sentence: string): string[] {
  const out: string[] = [];
  FILE_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_TOKEN.exec(sentence)) !== null) {
    const token = m[1];
    if (!token) continue;
    const base = token.split(/[\\/]/).pop() ?? token;
    // A BARE VERSION NUMBER ("2.1") IS NOT A FILE — the part after the dot has
    // to start with a letter. AND NEITHER IS AN ABBREVIATION: "i.e", "e.g" and
    // friends are one letter, a dot and one letter, so a name is only believed
    // when the part BEFORE the dot is at least two characters long. A one-letter
    // file name is the rare thing we would rather miss than accuse someone over.
    if (!/^[\w.\-]+\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(base)) continue;
    const stem = base.slice(0, base.lastIndexOf("."));
    if (stem.length < 2) continue;
    if (/^(etc|vs|no|mr|mrs|dr)$/i.test(stem)) continue;
    if (!out.includes(base.toLowerCase())) out.push(base.toLowerCase());
    if (out.length >= 3) break;   // three names is plenty for one sentence
  }
  return out;
}

// ----------------------------------------------------- what he reads

/**
 * THE LINE IN THE ROOM. Plain words, his words back to him, and what the
 * machine's own record says instead. No jargon, no step ids beyond "step 4",
 * and never a suggestion that the agent lied — only that the two do not agree,
 * which is all this module can honestly know.
 */
function roomLine(
  mismatches: readonly Claim[], all: readonly Claim[], agentName?: string,
): string {
  const who = agentName ? `${agentName}` : "this agent";
  const head = `⚠️ Cloud9 checked what ${who} just said against what it actually did — `
    + `${mismatches.length === 1 ? "one thing does" : `${mismatches.length} things do`} not match:`;
  const shown = mismatches.slice(0, CLAIM_LINES_MAX);
  const bullets = shown.map(c => `• It said “${c.said}” — but ${c.because}`);
  const more = mismatches.length > shown.length
    ? [`• …and ${mismatches.length - shown.length} more.`] : [];
  const matched = all.filter(c => c.verdict === "matches").length;
  const tail = matched > 0
    ? [`Everything else it said (${matched} ${matched === 1 ? "thing" : "things"}) `
      + `did match the record.`]
    : [];
  return [head, ...bullets, ...more, ...tail].join("\n");
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim().replace(/[.;:]+$/, "");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
