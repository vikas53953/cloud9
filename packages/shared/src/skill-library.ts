/* ============================================================
   THE SKILL LIBRARY — ready-made skills Cloud9 ships with.
   ============================================================

   Same shape as the hiring hall: it ships INSIDE the app. No
   server, no download, no account, works with the network off.
   Taking a skill copies its words into an agent as an ORDINARY
   skill (`AgentSkill`) — from that moment there is nothing left
   pointing back here, and every word of it is his to change.

   WHY THESE SKILLS AND NOT OTHERS
   -------------------------------
   Researched before it was written (2026-07-30), from what people
   actually use rather than what sounds impressive. Sources, all
   read rather than remembered:

     · Claude Code's own bundled skills — /code-review, /debug,
       /verify, /simplify, /security-review
       https://code.claude.com/docs/en/skills
     · Anthropic, "Lessons from building Claude Code: how we use
       skills" — the team's own finding that VERIFICATION skills
       had the largest measured effect on output quality
       https://claude.com/blog/lessons-from-building-claude-code-how-we-use-skills
     · Anthropic's published security-review prompt (scope to the
       diff, exploitability floor, explicit non-findings list)
       https://github.com/anthropics/claude-code-security-review
     · obra/superpowers — the most-copied procedural skill set:
       systematic-debugging, test-driven-development,
       verification-before-completion, requesting-code-review,
       finishing-a-development-branch
       https://github.com/obra/superpowers
     · github/awesome-copilot — ~400 skills from GitHub/Microsoft;
       the severity ladder in the review skill and the "audit
       dependencies first" ordering in the security skill are theirs
       https://github.com/github/awesome-copilot
     · Anthropic's Agent Skills best practices — third-person
       descriptions that say WHEN to use the skill, numbered steps
       over prose, and matching how strict the wording is to how
       much damage a wrong move does
       https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
     · Role split taken from the two independent subagent
       catalogues that agree with each other —
       https://github.com/VoltAgent/awesome-claude-code-subagents
       and https://github.com/wshobson/agents

   The categories that recur across every one of those sources are
   the ones on the shelves below. Categories that only ever appear
   tied to one technology (upgrade React 18 to 19, Oracle to
   Postgres) were deliberately left out: a generic version of those
   is filler, and filler is what the research says kills a library.

   GROWING IT
   ----------
   Add a shelf to `SKILL_CATEGORIES` and rows to `SKILL_LIBRARY`.
   That is the whole job. The screen, the filters, the grouping and
   the per-role advice all read from these two lists, so no skill
   ever gets its own branch of code. Which roles a skill suits is a
   COLUMN (`recommendedFor`), holding the same role ids the hiring
   hall uses — so an Architect and a QA engineer see different
   things at the top without either of them losing access to
   anything.
*/

import type { AgentSkill, ID } from "./index.js";
import { newId } from "./index.js";

export interface SkillCategory {
  /** stable id — used by the screen and by the rows below, never shown */
  id: string;
  /** what he sees on the filter bar */
  label: string;
  /** one line under the heading of that group */
  blurb: string;
}

export interface LibrarySkill {
  /** stable id — used by the screen and by QA, never shown */
  id: string;
  category: SkillCategory["id"];
  /** the skill's name once it is on an agent */
  name: string;
  emoji: string;
  /** plain words: WHEN this helps. This is what he reads on the card. */
  description: string;
  /** the product. What the agent will actually be told to do. */
  instructions: string;
  /**
   * Hiring-hall role ids this suits, best first. Advice, never a gate: every
   * role can still take every skill.
   */
  recommendedFor: string[];
  /** where the procedure came from, so he can go and check it */
  source: string;
}

export const SKILL_CATEGORIES: SkillCategory[] = [
  {
    id: "review",
    label: "Checking work",
    blurb: "Reading something that already exists and saying what is wrong with it.",
  },
  {
    id: "build",
    label: "Building it right",
    blurb: "How to go about making the change in the first place.",
  },
  {
    id: "fix",
    label: "Finding and fixing",
    blurb: "Something is broken, slow, or on fire, and nobody knows why yet.",
  },
  {
    id: "ship",
    label: "Shipping safely",
    blurb: "Getting the work out without breaking anything or claiming too much.",
  },
  {
    id: "explain",
    label: "Writing it down",
    blurb: "Leaving something behind that the next person can read.",
  },
];

export const SKILL_LIBRARY: LibrarySkill[] = [
  // ---------------------------------------------------------------- review
  {
    id: "sk-code-review",
    category: "review",
    name: "Code review",
    emoji: "🔍",
    description: "Read a change and say what must be fixed before it goes in, "
      + "sorted by how badly it matters.",
    recommendedFor: ["sw-reviewer", "sw-architect", "sw-backend", "sw-frontend", "sw-security"],
    source: "Claude Code's /code-review, obra/superpowers requesting-code-review, "
      + "github/awesome-copilot code-review-generic",
    instructions: [
      "Review ONLY the change, not the whole codebase. Work out the exact range first",
      "(`git diff --merge-base origin/HEAD`, or the two commits you were given) and say",
      "in your reply which range you read. Never move HEAD, never commit, never fix",
      "anything while reviewing — a review that edits the code is not a review.",
      "",
      "Read the change against five questions, in this order:",
      "1. Does it do what it was asked to do? Find the request, the issue or the plan.",
      "   List anything the change does that nobody asked for, and anything asked for",
      "   that is missing.",
      "2. Is it correct? Look for logic that is wrong, data that can be lost, ordering",
      "   that can race, edge cases with nothing handling them, and errors swallowed",
      "   silently.",
      "3. Does it fit? Compare it with how this codebase already does the same kind of",
      "   thing. A change that invents a second way of doing something is a finding.",
      "4. Is it tested? A test that only checks a mock replied is not a test. Say which",
      "   behaviours have no test at all.",
      "5. Can it be deployed? Schema changes, config the deployer does not have yet,",
      "   anything that breaks an existing caller.",
      "",
      "Then sort every finding into exactly one of three buckets, and never inflate:",
      "- MUST FIX — security holes, data loss, wrong results, a broken public promise.",
      "- SHOULD FIX — missing tests on an important path, duplication that will rot,",
      "  an obvious performance trap like a query inside a loop.",
      "- WORTH A THOUGHT — naming, readability, small tidying.",
      "",
      "For every finding give four things and nothing else: the file and line, what is",
      "wrong, why it matters in practice, and the corrected code. A complaint with no",
      "suggested fix is half a finding.",
      "",
      "Finish with a one-line verdict: ready to merge, ready with fixes, or not ready —",
      "and one sentence of reasoning. Never end a review without a verdict, and never",
      "say it looks good if you did not read all of it. Say plainly which parts you did",
      "not read.",
    ].join("\n"),
  },
  {
    id: "sk-security-review",
    category: "review",
    name: "Security review",
    emoji: "🛡️",
    description: "Look for ways a change could be attacked — and stay quiet about "
      + "things that only look scary.",
    recommendedFor: ["sw-security", "sw-reviewer", "sw-backend"],
    source: "anthropics/claude-code-security-review, github/awesome-copilot security-review",
    instructions: [
      "Look only at what this change ADDS. Pre-existing problems are somebody else's",
      "ticket; naming them here buries the real finding. This is not a general code",
      "review — say nothing about style, structure or naming.",
      "",
      "Work in this order, because the cheap wins come first:",
      "1. Dependencies. Anything newly added or bumped: is it the package you think it",
      "   is, and does it have known advisories?",
      "2. Secrets. Scan every added line of config, CI, Dockerfile and infrastructure",
      "   for keys, tokens, passwords and connection strings.",
      "3. The code itself, one file at a time.",
      "4. Data flow. For every place user input enters, follow it all the way to where",
      "   it lands — a database, a shell, a file path, a template, a browser.",
      "",
      "What to look for:",
      "- Input reaching a command line, an SQL statement, a file path, a template, or",
      "  an HTML page without being parameterised or escaped.",
      "- Authentication and authorisation: a route with no check, a check that trusts",
      "  something the client sent, a token that is not verified, a session that never",
      "  ends.",
      "- Secrets and crypto: hardcoded keys, home-made encryption, randomness from a",
      "  source that is not cryptographic, certificate checking turned off.",
      "- Deserialising or evaluating anything that came from outside.",
      "- Data leaking out: secrets in logs, personal data in error messages, an endpoint",
      "  returning more than the caller should see.",
      "",
      "Then throw away everything you are not sure about. Report a finding only if you",
      "would bet on it being genuinely exploitable. Do NOT report: theoretical races,",
      "denial of service, missing rate limits, missing hardening, findings in test files",
      "or documentation, or a framework doing something it is designed to do. Treat",
      "environment variables and command-line flags as trusted input, and treat UUIDs as",
      "unguessable.",
      "",
      "Before you write it up, do one pass asking the opposite question: is there",
      "sanitising, middleware or a framework guarantee elsewhere that already handles",
      "this? Delete anything that survives that question.",
      "",
      "For each surviving finding: file and line, how bad, what an attacker would",
      "actually do step by step, and the fix. Fix nothing yourself unless you were asked",
      "to. If you found nothing, say so — an empty security review is a real result.",
    ].join("\n"),
  },
  {
    id: "sk-api-review",
    category: "review",
    name: "API design review",
    emoji: "🔌",
    description: "Check an interface other people will have to live with before it "
      + "becomes impossible to change.",
    recommendedFor: ["sw-architect", "sw-backend", "sw-reviewer", "sw-security"],
    source: "VoltAgent API Designer, github/awesome-copilot typespec-api-operations",
    instructions: [
      "An interface is a promise you cannot take back once somebody depends on it.",
      "Review it as a promise, not as code.",
      "",
      "1. Name the callers. Who will use this, and can they be changed later? An",
      "   internal caller you control is a different risk from a published one.",
      "2. Read the shape out loud as a sentence. If you cannot say what an operation",
      "   does in one sentence without the word 'and', it is doing two things.",
      "3. Check consistency against the interfaces this project already has: naming,",
      "   pluralisation, date format, how errors come back, how paging works. A second",
      "   convention is worse than an imperfect first one.",
      "4. Errors. Every failure a caller has to act on differently needs its own",
      "   distinguishable answer. Never return a 200 with a failure inside it.",
      "5. Nullability and defaults. For every field: can it be absent, what does absent",
      "   mean, and is that different from empty?",
      "6. Growth. What is the next obvious thing someone will ask for, and can it be",
      "   added without breaking today's callers? Prefer adding an optional field over",
      "   overloading an existing one.",
      "7. Size and cost. Is there any call whose answer grows without limit? Every list",
      "   needs paging from day one.",
      "8. Permission. Who is allowed to call each operation, and is that checked in one",
      "   place or scattered?",
      "",
      "Do not redesign it. Report: what you would change before it ships, what can wait,",
      "and what is fine. Never wave through an unbounded list, an untyped blob field, or",
      "an operation with no stated permission — those three are the ones that cannot be",
      "fixed later.",
    ].join("\n"),
  },
  {
    id: "sk-accessibility",
    category: "review",
    name: "Accessibility check",
    emoji: "♿",
    description: "Make sure the screen works for someone using a keyboard, a screen "
      + "reader, or a phone in bright sun.",
    recommendedFor: ["sw-frontend", "sw-qa", "sw-writer"],
    source: "Vercel Web Design Guidelines, wshobson accessibility-expert, WCAG 2.2 AA",
    instructions: [
      "Test the real screen, not the code. Open it and try these in order:",
      "",
      "1. Unplug the mouse. Tab through the whole screen. Every control must be",
      "   reachable, the focus ring must be visible at every stop, and the order must",
      "   follow the reading order. Escape must close anything that opened.",
      "2. Check nothing traps you: if focus enters a dialog it must be able to leave,",
      "   and it must go back where it came from.",
      "3. Read the page as a screen reader would. Every image needs alternative text or",
      "   an explicit mark saying it is decoration. Every input needs a real label, not",
      "   just placeholder text. Every button needs words, not only an icon.",
      "4. Check the headings form an outline — one h1, no levels skipped.",
      "5. Contrast: ordinary text needs 4.5:1 against its background, large text 3:1,",
      "   and so do the borders of controls. Measure it, do not eyeball it.",
      "6. Never let colour be the only thing carrying meaning. A red border needs a word",
      "   beside it.",
      "7. Errors: when something is rejected, the message must be near the field, in",
      "   words, and announced — not just a red outline.",
      "8. Zoom the browser to 200% and narrow the window to a phone width. Nothing may",
      "   be cut off and nothing may need sideways scrolling.",
      "9. Turn on 'reduce motion' and check nothing important only happens in animation.",
      "",
      "Report each problem as: what a person would experience, which check it fails, and",
      "the smallest fix. Do not rewrite the design. Never close this off with an",
      "automated checker alone — it cannot see focus order, meaning, or whether a label",
      "is honest.",
    ].join("\n"),
  },

  // ----------------------------------------------------------------- build
  {
    id: "sk-plan-first",
    category: "build",
    name: "Plan before code",
    emoji: "🗺️",
    description: "Agree what is being built, and how, before a single line is written.",
    recommendedFor: ["sw-architect", "sw-backend", "sw-frontend", "sw-devops"],
    source: "obra/superpowers brainstorming and writing-plans, "
      + "github/awesome-copilot create-implementation-plan",
    instructions: [
      "Write no code until the plan is agreed. This holds for small jobs too — a job",
      "that looks small is the usual reason a plan gets skipped and the wrong thing gets",
      "built.",
      "",
      "1. Read the ground first: the files involved, anything already written down, and",
      "   the last few changes in that area. Say what you found.",
      "2. Ask what you do not know — ONE question at a time, each with your own",
      "   recommendation attached. Never present a menu of open questions.",
      "3. Offer two or three ways to do it, each with what it costs and what it buys.",
      "   Lead with the one you recommend and say why.",
      "4. Once a direction is chosen, write the plan down:",
      "   - the goal, in one sentence a non-engineer would understand",
      "   - the constraints, copied exactly from what you were told, not paraphrased",
      "   - which files are created and which are changed",
      "   - the steps, in order, each small enough to test on its own",
      "   - for each step: what it must do, and how you will know it worked",
      "5. Re-read the plan hunting for placeholders. 'Handle errors appropriately',",
      "   'add tests', 'similar to step 3' and 'TBD' are all failures — replace each one",
      "   with the actual thing to do.",
      "6. Check the names you used are the same in every step. Two names for one thing",
      "   is a bug you are planning in advance.",
      "7. Show the plan and wait. Do not start because the plan seems obviously right.",
      "",
      "Cut anything nobody asked for. If you find yourself planning for a need that has",
      "not appeared yet, delete it and say you left it out.",
    ].join("\n"),
  },
  {
    id: "sk-tdd",
    category: "build",
    name: "Test first",
    emoji: "🧪",
    description: "Write the failing test before the code, so you know the test can "
      + "actually catch the mistake.",
    recommendedFor: ["sw-qa", "sw-backend", "sw-frontend"],
    source: "obra/superpowers test-driven-development",
    instructions: [
      "The rule: no new behaviour without a test that failed first. If you wrote the",
      "code before the test, delete the code and start again — a test written",
      "afterwards proves only that you can describe what you already did.",
      "",
      "For each behaviour, in this order:",
      "1. Write ONE test for ONE behaviour. If its name needs the word 'and', it is two",
      "   tests. Use real objects; reach for a fake only where the real thing cannot be",
      "   used at all.",
      "2. Run it. Watch it FAIL. Check three things before going on: it failed rather",
      "   than errored, the message is the one you expected, and it failed because the",
      "   behaviour is missing — not because of a typo or a missing import. A test that",
      "   passes here is testing something that already worked; fix the test.",
      "3. Write the smallest code that makes it pass. No extra options, no arguments",
      "   nobody asked for, no 'while I am here'.",
      "4. Run it. Watch it PASS, watch every other test still pass, and check the output",
      "   is clean — a new warning is a result too.",
      "5. Only now tidy up: remove duplication, improve names, pull things apart. Add no",
      "   behaviour while tidying. Run everything again.",
      "",
      "Before writing each test, answer this out loud: what change to the real code",
      "would make this test fail? If you cannot name one, the test is checking nothing.",
      "",
      "Never assert that a fake was called and call that a test. Never put test-only",
      "branches into the real code. If a test is getting complicated, that is the design",
      "telling you something — say so instead of fighting it.",
    ].join("\n"),
  },
  {
    id: "sk-refactor",
    category: "build",
    name: "Refactor safely",
    emoji: "🧹",
    description: "Make code simpler without changing what it does — and be able to "
      + "prove nothing changed.",
    recommendedFor: ["sw-backend", "sw-frontend", "sw-reviewer", "sw-architect"],
    source: "Claude Code's /simplify, github/awesome-copilot refactor and refactor-plan",
    instructions: [
      "Behaviour must come out identical. That is the whole promise, and it is the only",
      "thing that makes a refactor safe to approve quickly.",
      "",
      "1. First, get a safety net. Run the tests that cover this code. If there are",
      "   none, write them for the CURRENT behaviour — including the behaviour you think",
      "   is wrong — before changing anything. Do not fix bugs during a refactor.",
      "2. Say what is actually wrong before you touch it: too long, doing several jobs,",
      "   repeated in four places, named after what it used to do. Pick ONE.",
      "3. Make one kind of change at a time, and run the tests after each one:",
      "   - pull a well-named piece out of a long function",
      "   - give something a name that says what it is now",
      "   - collapse duplication only where the copies are genuinely the same thing",
      "   - remove a parameter, a branch, or a layer nobody uses",
      "4. After each step the tests must be green and the output clean. If a step needs",
      "   a test changed, stop — you are changing behaviour, not shape.",
      "5. Delete code you have made unreachable. A refactor that only adds is not one.",
      "",
      "Never mix a refactor with a fix or a feature in the same change: the reviewer",
      "then has to check every line instead of trusting the tests. Never abstract two",
      "things that merely look alike — wait until there are three and they have moved",
      "together at least once.",
      "",
      "Finish by saying what is measurably better: lines removed, branches removed,",
      "duplicated blocks gone.",
    ].join("\n"),
  },

  // ------------------------------------------------------------------- fix
  {
    id: "sk-debug",
    category: "fix",
    name: "Find the root cause",
    emoji: "🐛",
    description: "Something is broken — find out why before changing anything.",
    recommendedFor: ["sw-backend", "sw-qa", "sw-devops", "sw-frontend"],
    source: "Claude Code's /debug, obra/superpowers systematic-debugging",
    instructions: [
      "No fix before the cause is known. A change made to see if it helps is a guess,",
      "and guesses are what turn one bug into three.",
      "",
      "1. Read the actual evidence. The full error, the whole stack trace, the log lines",
      "   either side of it, the exit code. Quote them; do not summarise them.",
      "2. Reproduce it. Write down the exact steps that make it happen every time. If it",
      "   is not reproducible yet, that is the job — add logging and wait, do not start",
      "   guessing.",
      "3. Ask what changed. Recent commits, new dependencies, config, environment. A",
      "   thing that used to work has a diff behind it.",
      "4. If several parts talk to each other, do not guess which one is wrong. Log what",
      "   goes IN and what comes OUT at each boundary, run it once, and read which layer",
      "   the good value turned bad in. Then look only there.",
      "5. Trace the wrong value backwards to where it was born, and fix it there — not",
      "   where you noticed it.",
      "6. Find working examples of the same thing elsewhere in this codebase. Read one",
      "   completely, and list every difference, however small. The difference you",
      "   dismiss is usually the one.",
      "7. State your theory in one sentence: 'X is happening because Y'. Test it with",
      "   the smallest possible change, changing ONE thing. If you were wrong, form a",
      "   NEW theory — never stack another change on top of a failed one.",
      "8. Write a test that fails because of this bug BEFORE fixing it. Fix it. Watch",
      "   that test go green, and everything else stay green.",
      "",
      "Count your failed attempts. At three, STOP and say so out loud: three failures",
      "means the problem is not where you are looking, and the next step is to question",
      "the design, not to try a fourth patch. Say 'I do not understand X yet' rather",
      "than acting as if you do.",
    ].join("\n"),
  },
  {
    id: "sk-performance",
    category: "fix",
    name: "Make it faster",
    emoji: "⚡",
    description: "Something is slow — measure it before touching it, and prove the "
      + "change helped.",
    recommendedFor: ["sw-backend", "sw-devops", "sw-architect"],
    source: "wshobson performance-engineer and database-optimizer, "
      + "github/awesome-copilot sql-optimization",
    instructions: [
      "Never optimise by reading code and having a hunch. Every step here is a",
      "measurement.",
      "",
      "1. Get a number first. What exactly is slow, how slow, and how is it being",
      "   measured? 'The page feels sluggish' is not a starting point — 'this request",
      "   takes 4.2 seconds at the 95th percentile' is.",
      "2. Write down the target before you begin. Without one there is no way to stop.",
      "3. Find where the time actually goes: a profiler, timings around each stage, the",
      "   database's own query plan. Do not skip this because you think you know.",
      "4. Check the usual suspects in this order, because they are ordered by how often",
      "   they turn out to be it:",
      "   - a query inside a loop (one call per row instead of one call)",
      "   - a missing index, or an index the query cannot use",
      "   - fetching far more data than is used",
      "   - doing work on every request that could be done once",
      "   - waiting on things one after another that could happen at the same time",
      "5. Change ONE thing. Measure again the same way. Keep the change only if the",
      "   number moved; revert it if it did not, even if it 'should' have helped.",
      "6. Re-run the tests. A fast wrong answer is worthless.",
      "",
      "Never trade correctness, clarity or safety for speed without saying so explicitly",
      "and getting agreement. Never add a cache before you understand why the thing is",
      "slow — a cache over a bug hides the bug and adds a second one about staleness.",
      "",
      "Report: the before number, the after number, measured how, and what you changed.",
    ].join("\n"),
  },
  {
    id: "sk-incident",
    category: "fix",
    name: "Handle a live incident",
    emoji: "🚨",
    description: "Something is down right now — stop the bleeding first, understand it "
      + "afterwards.",
    recommendedFor: ["sw-devops", "sw-backend", "sw-qa"],
    source: "Anthropic's runbook skill category, wshobson incident-responder, "
      + "github/awesome-copilot incident-postmortem",
    instructions: [
      "During an incident the order is: stop the harm, then find the cause. Those are",
      "two different jobs and doing them in the wrong order costs users.",
      "",
      "WHILE IT IS BURNING",
      "1. Say what is broken, for whom, and since when. One line, updated as you learn.",
      "2. Check what changed in the last few hours before anything else — deploys,",
      "   config, feature flags, certificates, quota. Most incidents have a diff.",
      "3. Prefer reversing over repairing. Roll back, turn the flag off, fail over. A",
      "   rollback is reversible; a fix written under pressure is not.",
      "4. Before any action that changes production, say exactly what you are about to",
      "   run and what you expect to happen. Ask first for anything that deletes data,",
      "   spends money, or cannot be undone. There is no emergency exception to that.",
      "5. Keep a running timeline as you go: time, what you observed, what you did.",
      "   Nobody can reconstruct it afterwards.",
      "",
      "ONCE IT IS QUIET",
      "6. Confirm recovery with the same measurement that showed the problem, not by",
      "   looking at the screen once.",
      "7. Write up what happened: timeline, what users experienced, the actual cause,",
      "   why it was not caught earlier, and why it took as long as it did to notice.",
      "8. Name the alert or test that would have caught it, and file that as work.",
      "",
      "Never blame a person in the write-up — describe the system that allowed it.",
      "Never close an incident with 'restarted it and it went away': that is a symptom",
      "disappearing, not a cause found. Say plainly that the cause is still unknown.",
    ].join("\n"),
  },

  // ------------------------------------------------------------------ ship
  {
    id: "sk-verify",
    category: "ship",
    name: "Prove it before saying done",
    emoji: "✅",
    description: "Never claim something works without having just run the thing that "
      + "shows it works.",
    recommendedFor: ["sw-qa", "sw-reviewer", "sw-backend", "sw-frontend", "sw-devops"],
    source: "obra/superpowers verification-before-completion; Anthropic report this "
      + "kind of skill had the largest measured effect on quality",
    instructions: [
      "The rule: if you have not run the check in THIS piece of work, you cannot say it",
      "passes. Not a previous run, not a run before your last edit, not 'it should'.",
      "",
      "Before any sentence containing done, fixed, works, passing or ready:",
      "1. Name the one command or action that would prove it.",
      "2. Run it, in full. Do not run a subset because the full thing is slow.",
      "3. Read the whole output — the summary line, the failure count, and the exit",
      "   code. A test run that ends '2 failed' after 300 passes has failed.",
      "4. Only then make the claim, and paste the evidence with it.",
      "",
      "What counts as proof:",
      "- 'Tests pass' — the test output, from just now, with zero failures.",
      "- 'It builds' — the build finishing with exit code 0.",
      "- 'Lint is clean' — the linter, not the compiler.",
      "- 'The bug is fixed' — the ORIGINAL symptom retried, the way it was originally",
      "  reported.",
      "- 'This test would catch it' — write it, see it pass, undo the fix, see it FAIL,",
      "  put the fix back, see it pass. A regression test never proved to fail is",
      "  decoration.",
      "- 'The agent finished the job' — the actual diff of what changed, never the",
      "  agent's own report.",
      "- 'It does what was asked' — the request, gone through line by line. Green tests",
      "  do not prove the right thing was built.",
      "",
      "Words that mean you have not checked yet: should, probably, seems to, I believe,",
      "looks right. If one appears in your reply, go and run something.",
      "",
      "Finish with what someone else should do to see it for themselves: the steps, in",
      "order, in plain words.",
    ].join("\n"),
  },
  {
    id: "sk-branch-pr",
    category: "ship",
    name: "Branch and pull request",
    emoji: "🌿",
    description: "Do the work on its own branch and open a pull request — nothing "
      + "lands on the main branch by itself.",
    recommendedFor: ["sw-backend", "sw-frontend", "sw-devops", "sw-reviewer", "sw-architect"],
    source: "obra/superpowers finishing-a-development-branch and using-git-worktrees, "
      + "github/awesome-copilot conventional-commit",
    instructions: [
      "Every piece of work gets its own branch and its own pull request. Nothing is",
      "pushed to the default branch, ever, whatever the reason.",
      "",
      "1. Before starting, check where you are: which repository, which branch, and",
      "   whether there are changes already sitting there that are not yours. If the",
      "   working copy is not clean, stop and ask.",
      "2. Branch from an up-to-date default branch. Name it after the work, not after",
      "   yourself.",
      "3. Commit in pieces that each make sense on their own. Write the message as: a",
      "   short line saying what changed and why, then a blank line, then the detail.",
      "   Describe the change, not the files.",
      "4. Never commit a secret, a credentials file, a build folder, or a large binary.",
      "   Check what you are about to commit before you commit it.",
      "5. Before opening the pull request, run the full test suite on the branch and",
      "   read the result.",
      "6. Open the pull request with: what changed, why, how it was tested, and anything",
      "   the reviewer should look at hardest. Link the request it came from.",
      "7. Say the pull request URL in your reply so it can be found without hunting.",
      "",
      "Ask before anything that leaves this machine or changes a remote: pushing,",
      "opening or merging a pull request, creating a repository, changing settings. Ask",
      "even when it seems obviously wanted.",
      "",
      "Never force-push a branch someone else may have. Never merge your own pull",
      "request. Never rewrite history that has already been pushed.",
    ].join("\n"),
  },
  {
    id: "sk-dependencies",
    category: "ship",
    name: "Update dependencies",
    emoji: "📦",
    description: "Move to newer versions of other people's code without breaking "
      + "yours.",
    recommendedFor: ["sw-security", "sw-devops", "sw-backend", "sw-frontend"],
    source: "github/awesome-copilot dependabot and nuget-manager, "
      + "VoltAgent Dependency Manager",
    instructions: [
      "Updating everything at once produces a failure nobody can attribute. Work in",
      "small, separable pieces.",
      "",
      "1. List what is out of date, and mark each one: security fix, major version,",
      "   minor version, patch.",
      "2. Do security fixes first, on their own, and say what the advisory was.",
      "3. Group the rest: all the patch and minor updates can go together in one change;",
      "   every MAJOR version gets its own change, on its own branch.",
      "4. For each major version, read the release notes and the migration guide before",
      "   touching anything. List the breaking changes that actually apply to this",
      "   codebase, with the files they affect.",
      "5. Update, then run the full test suite, then start the app and use it. Tests",
      "   passing after a dependency bump is a weaker signal than usual — a library can",
      "   change behaviour the tests never look at.",
      "6. Check the lock file changed the way you expected and nothing else came along",
      "   with it.",
      "7. If a package has been renamed, abandoned, or has changed owner, say so — that",
      "   is a decision for a person, not an update.",
      "",
      "Never bypass a failing test to get an update through. Never update a dependency",
      "in the same change as a feature. If an update cannot be made to work, revert it",
      "and write down why, rather than leaving it half applied.",
    ].join("\n"),
  },

  // --------------------------------------------------------------- explain
  {
    id: "sk-docs",
    category: "explain",
    name: "Write it down",
    emoji: "📘",
    description: "Explain something so the next person can use it without asking "
      + "anyone.",
    recommendedFor: ["sw-writer", "sw-architect", "sw-backend"],
    source: "anthropics/skills doc-coauthoring, github/awesome-copilot create-readme "
      + "and the blueprint-generator family",
    instructions: [
      "Documentation is derived from the code, never from memory. If you cannot point",
      "at the file that makes a sentence true, do not write the sentence.",
      "",
      "1. Read the thing first — the entry points, the configuration, the tests. The",
      "   tests tell you what it really does, as opposed to what it was meant to do.",
      "2. Decide who is reading and what they are trying to do. Write for that person",
      "   and nobody else.",
      "3. Lead with the shortest path that works: the smallest complete example someone",
      "   can copy, run, and see succeed. Put it above the explanation, not below it.",
      "4. Then explain, in this order: what it is for, how to set it up, how to use it,",
      "   what can go wrong and what to do about it.",
      "5. Every command and every code sample must be run before it is published. An",
      "   example that does not work is worse than no example.",
      "6. Say what it does NOT do, and what it deliberately leaves out. That is usually",
      "   the paragraph people needed.",
      "7. Cut every word that carries no information. No 'simply', no 'just', no",
      "   'obviously' — if it were obvious the page would not exist.",
      "8. Avoid anything that will silently go stale: version numbers, dates, counts,",
      "   'currently'. Where you must, mark it clearly.",
      "",
      "Never invent a flag, an option or an endpoint that you have not seen in the code.",
      "Never describe intended behaviour as if it already works. Where something is",
      "unclear, write the question down in the page rather than guessing at the answer.",
    ].join("\n"),
  },
  {
    id: "sk-decision-record",
    category: "explain",
    name: "Record a decision",
    emoji: "🧭",
    description: "Capture why a choice was made, so nobody has to relitigate it in six "
      + "months.",
    recommendedFor: ["sw-architect", "sw-writer", "sw-reviewer", "sw-devops"],
    source: "github/awesome-copilot create-architectural-decision-record",
    instructions: [
      "Write this when a choice is hard to reverse or was argued about. The value is in",
      "the reasoning, not the conclusion — the conclusion is already in the code.",
      "",
      "Keep it to one page, with these parts and no others:",
      "1. The decision, in one sentence, in the present tense.",
      "2. The date, and who decided.",
      "3. The situation that forced a choice. What was true at the time — the",
      "   constraints, the deadline, the thing that was already built. Be honest about",
      "   pressures, including the ones that were not technical.",
      "4. What else was considered. At least two real alternatives, each with why it was",
      "   not chosen. An option listed only to be dismissed in half a line was not",
      "   considered.",
      "5. What this costs us. Every real decision has a downside — name it. A record",
      "   with no downside is marketing.",
      "6. What would make us change our minds. The specific thing that, if it happened,",
      "   should reopen this.",
      "",
      "Rules: never edit a past record to match what happened later — write a new one",
      "that supersedes it and link the two. Never write it in a way that only the people",
      "who were in the room can understand: spell out the acronyms and name the systems",
      "in full. Never record a decision nobody actually made.",
    ].join("\n"),
  },
];

/** The shelf a skill sits on, or undefined if the id is not one of ours. */
export function libraryCategory(id: string): SkillCategory | undefined {
  return SKILL_CATEGORIES.find(c => c.id === id);
}

/**
 * The whole library, ordered for one role: the ones recommended to that role
 * first, in the order the row lists them, then everything else in shelf order.
 *
 * Advice, not a gate — the length never changes. An Architect is simply not
 * shown "Test first" at the top, and a QA engineer is not shown "Record a
 * decision" at the top. A role nobody has written advice for gets the library
 * in its natural order, which is a sensible default rather than an error.
 */
export function librarySkillsFor(roleId: string): LibrarySkill[] {
  const rank = (s: LibrarySkill): number => {
    const at = s.recommendedFor.indexOf(roleId);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  return SKILL_LIBRARY
    .map((skill, order) => ({ skill, order }))
    .sort((a, b) => rank(a.skill) - rank(b.skill) || a.order - b.order)
    .map(x => x.skill);
}

/**
 * Take a skill off the shelf. What comes back is an ORDINARY `AgentSkill` and
 * nothing more — no category, no source, no id pointing back here. That is the
 * promise: once it is on his agent it is his, and it is exactly as editable as
 * one he typed out himself.
 */
export function skillFromLibrary(source: LibrarySkill, id?: ID): AgentSkill {
  return {
    id: id ?? newId("sk"),
    name: source.name,
    description: source.description,
    instructions: source.instructions,
  };
}
