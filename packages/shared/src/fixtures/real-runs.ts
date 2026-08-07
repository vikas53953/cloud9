// 185 RUN RECORDS THE OWNER'S OWN AGENTS REALLY PRODUCED, on this machine,
// between July and August 2026. Lifted straight off disk from
// %APPDATA%/Cloud9/engine/agents/*/runs and reduced to exactly the fields
// `CountableRun` carries.
//
// WHY A REAL FIXTURE IS IN THE REPOSITORY, AND WHY IT IS THE STANDARD NOW.
//
// The first version of this feature shipped with 59 green tests and a token
// count wrong by two to three orders of magnitude. Every fixture in those tests
// was hand-written — and a hand-written Claude usage shape does not have a
// cache in it. `{ inputTokens: 30_000, outputTokens: 500 }` looks entirely
// plausible; the real shape is `{ inputTokens: 2, cachedInputTokens: 13_899 }`.
// So the tests agreed with the code because both were written by somebody
// holding the same wrong idea about what `inputTokens` means. Nothing that was
// hand-written could have caught it. Only real data disagreed:
//
//   Fable5, 23 real turns, $7.79        drew as    0% handed to it / 100% written
//                                       is really 99% handed to it (1,120,105)
//   Architect, 31 real turns, $0.94     drew as    1% / 99%
//                                       is really 90% (301,146)
//
// So the arithmetic in `tokenuse.ts` is now pinned against THIS, and a change
// that quietly re-breaks the accounting fails against the owner's own history
// rather than passing against a shape nobody has ever seen.
//
// WHAT IS AND IS NOT IN HERE. Only what `CountableRun` carries: when it ran,
// which app ran it, whether it finished, whether it used his own setup, and the
// figures. No ask, no reply, no steps, no session ids, no file names, no paths
// and no ids — the same boundary `RunStore.countableRuns` enforces, for exactly
// the same reason. Agent names are kept, because a test that cannot name the
// agent it is asserting about is a test nobody can read.
//
// NOTE THE ONE THING THAT IS ABSENT FROM EVERY ROW: `handedToIt`. These records
// all predate it, which makes them the exact case `handedToItOf` has to rebuild
// — so the fixture proves the rebuilding path as a side effect of existing.
import { CountableRun } from "../tokenuse.js";

/** One real stored run, plus the name of the agent that produced it. */
export interface RealRun extends CountableRun { agentName: string; }

export const REAL_RUNS: readonly RealRun[] = [
 {
  "agentName": "sonnet",
  "startedAt": 1785349741562,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 76,
   "cachedInputTokens": 0,
   "costUsd": 0.06233500000000001
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785349741596,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 37,
   "cachedInputTokens": 0,
   "costUsd": 0.066973
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785349931815,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 903,
   "cachedInputTokens": 12424,
   "costUsd": 0.11742099999999998
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785350293411,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 431,
   "cachedInputTokens": 13191,
   "costUsd": 0.037643499999999996
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785350308932,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18473,
   "outputTokens": 74,
   "cachedInputTokens": 9472,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785350310177,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 633,
   "cachedInputTokens": 5765,
   "costUsd": 0.0384835
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785350319479,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 21279,
   "outputTokens": 90,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785350329826,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18793,
   "outputTokens": 85,
   "cachedInputTokens": 9472,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785350330504,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 21508,
   "outputTokens": 75,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785350338940,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 20496,
   "outputTokens": 72,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785350341122,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19121,
   "outputTokens": 74,
   "cachedInputTokens": 18176,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785350347214,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 6,
   "outputTokens": 6177,
   "cachedInputTokens": 28448,
   "costUsd": 0.30058
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785350353068,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 6,
   "outputTokens": 4638,
   "cachedInputTokens": 23339,
   "costUsd": 0.2041155
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785350442301,
  "provider": "claude",
  "outcome": "failed"
 },
 {
  "agentName": "Opus",
  "startedAt": 1785350455924,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 336,
   "cachedInputTokens": 14911,
   "costUsd": 0.054156499999999996
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785350547014,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 290,
   "cachedInputTokens": 15366,
   "costUsd": 0.057916999999999996
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785350624461,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 22554,
   "outputTokens": 66,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785350636729,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 20020,
   "outputTokens": 69,
   "cachedInputTokens": 18688,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785350638436,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 22578,
   "outputTokens": 70,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785350650538,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 20190,
   "outputTokens": 72,
   "cachedInputTokens": 9472,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785350660577,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4494,
   "outputTokens": 6337,
   "cachedInputTokens": 41938,
   "costUsd": 0.362647
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785350680520,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 211,
   "cachedInputTokens": 15908,
   "costUsd": 0.061591999999999994
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785350752012,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 22594,
   "outputTokens": 65,
   "cachedInputTokens": 12032,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785350775626,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 20036,
   "outputTokens": 71,
   "cachedInputTokens": 16128,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785350777724,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 21474,
   "outputTokens": 66,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785416825430,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18607,
   "outputTokens": 197,
   "cachedInputTokens": 0,
   "reasoningTokens": 66
  }
 },
 {
  "agentName": "sonnet",
  "startedAt": 1785416838549,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 374,
   "cachedInputTokens": 0,
   "costUsd": 0.11544700000000001
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785416838578,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 742,
   "cachedInputTokens": 0,
   "costUsd": 0.193403
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785416850746,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 17487,
   "outputTokens": 124,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785416857721,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18734,
   "outputTokens": 153,
   "cachedInputTokens": 5888,
   "reasoningTokens": 38
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785416860344,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18783,
   "outputTokens": 192,
   "cachedInputTokens": 5888,
   "reasoningTokens": 39
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785416866231,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19091,
   "outputTokens": 178,
   "cachedInputTokens": 5888,
   "reasoningTokens": 47
  }
 },
 {
  "agentName": "sonnet",
  "startedAt": 1785416872539,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 180,
   "cachedInputTokens": 13899,
   "costUsd": 0.0385817
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785416875552,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 243,
   "cachedInputTokens": 13275,
   "costUsd": 0.06241449999999999
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785416881761,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 17710,
   "outputTokens": 114,
   "cachedInputTokens": 14080,
   "reasoningTokens": 32
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785416894499,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 842,
   "cachedInputTokens": 30923,
   "costUsd": 0.1273445
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785416894849,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18854,
   "outputTokens": 105,
   "cachedInputTokens": 5888,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785416904353,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18948,
   "outputTokens": 218,
   "cachedInputTokens": 5888,
   "reasoningTokens": 99
  }
 },
 {
  "agentName": "sonnet",
  "startedAt": 1785416942440,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 192,
   "cachedInputTokens": 13899,
   "costUsd": 0.041453699999999996
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785416942504,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19251,
   "outputTokens": 103,
   "cachedInputTokens": 5888,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785416953348,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 170,
   "cachedInputTokens": 13275,
   "costUsd": 0.06617750000000001
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785416953453,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19214,
   "outputTokens": 85,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "sonnet",
  "startedAt": 1785416963424,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 134,
   "cachedInputTokens": 13899,
   "costUsd": 0.0415137
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785416975483,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 2213,
   "cachedInputTokens": 31818,
   "costUsd": 0.14817000000000002
  }
 },
 {
  "agentName": "sonnet",
  "startedAt": 1785417012998,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 1531,
   "cachedInputTokens": 33241,
   "costUsd": 0.0784473
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785417013023,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19387,
   "outputTokens": 75,
   "cachedInputTokens": 15104,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785417039067,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 142,
   "cachedInputTokens": 13275,
   "costUsd": 0.0687505
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785417155798,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18822,
   "outputTokens": 64,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785417163485,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 144,
   "cachedInputTokens": 13275,
   "costUsd": 0.0582375
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785417173668,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18719,
   "outputTokens": 82,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785417181432,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 710,
   "cachedInputTokens": 30760,
   "costUsd": 0.099102
  }
 },
 {
  "agentName": "sonnet",
  "startedAt": 1785417200014,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 240,
   "cachedInputTokens": 32335,
   "costUsd": 0.04503050000000001
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785417200046,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18901,
   "outputTokens": 114,
   "cachedInputTokens": 5888,
   "reasoningTokens": 52
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785417211507,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 17742,
   "outputTokens": 77,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785417214850,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 310,
   "cachedInputTokens": 13275,
   "costUsd": 0.0620895
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785557772404,
  "provider": "codex",
  "outcome": "failed"
 },
 {
  "agentName": "sonnet",
  "startedAt": 1785557809036,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 272,
   "cachedInputTokens": 0,
   "costUsd": 0.149602
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785557809056,
  "provider": "codex",
  "outcome": "failed"
 },
 {
  "agentName": "Architect",
  "startedAt": 1785557867318,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 469,
   "cachedInputTokens": 0,
   "costUsd": 0.045117000000000004
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785557903589,
  "provider": "codex",
  "outcome": "failed"
 },
 {
  "agentName": "terra",
  "startedAt": 1785557903590,
  "provider": "codex",
  "outcome": "failed"
 },
 {
  "agentName": "Architect",
  "startedAt": 1785557903607,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 1253,
   "cachedInputTokens": 10303,
   "costUsd": 0.029387299999999998
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785557920646,
  "provider": "codex",
  "outcome": "failed"
 },
 {
  "agentName": "terra",
  "startedAt": 1785557920646,
  "provider": "codex",
  "outcome": "failed"
 },
 {
  "agentName": "terra",
  "startedAt": 1785558606601,
  "provider": "codex",
  "outcome": "failed"
 },
 {
  "agentName": "Opus",
  "startedAt": 1785558634912,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 273,
   "cachedInputTokens": 0,
   "costUsd": 0.238871
  }
 },
 {
  "agentName": "sonnet",
  "startedAt": 1785558648490,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 118,
   "cachedInputTokens": 13899,
   "costUsd": 0.07040070000000001
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785558648583,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 411,
   "cachedInputTokens": 10303,
   "costUsd": 0.0254693
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785558664055,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 168,
   "cachedInputTokens": 13275,
   "costUsd": 0.11294349999999999
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785558674991,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 583,
   "cachedInputTokens": 10303,
   "costUsd": 0.026162300000000003
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785558690825,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 141,
   "cachedInputTokens": 13275,
   "costUsd": 0.1125145
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785558701691,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 603,
   "cachedInputTokens": 10303,
   "costUsd": 0.0259463
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785558713934,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 195,
   "cachedInputTokens": 13275,
   "costUsd": 0.11185550000000001
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785558722903,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 3209,
   "cachedInputTokens": 10303,
   "costUsd": 0.0394913
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785559310079,
  "provider": "codex",
  "outcome": "failed"
 },
 {
  "agentName": "Sol",
  "startedAt": 1785565325647,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18191,
   "outputTokens": 31,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785565396447,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18236,
   "outputTokens": 75,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785658679439,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 17933,
   "outputTokens": 157,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785658679489,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 713,
   "cachedInputTokens": 0,
   "costUsd": 0.040049
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785658692568,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18564,
   "outputTokens": 69,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785658698862,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 503,
   "cachedInputTokens": 10303,
   "costUsd": 0.0211943
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785696826598,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 216,
   "cachedInputTokens": 0,
   "costUsd": 0.207739
  }
 },
 {
  "agentName": "sonnet",
  "startedAt": 1785696837492,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 185,
   "cachedInputTokens": 0,
   "costUsd": 0.132683
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785696837512,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 588,
   "cachedInputTokens": 0,
   "costUsd": 0.040633999999999997
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785696851382,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 1332,
   "cachedInputTokens": 33616,
   "costUsd": 0.138281
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785696875951,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18655,
   "outputTokens": 65,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785696876032,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18658,
   "outputTokens": 64,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785696881055,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 4533,
   "cachedInputTokens": 10303,
   "costUsd": 0.0419663
  }
 },
 {
  "agentName": "sonnet",
  "startedAt": 1785696881468,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 96,
   "cachedInputTokens": 13899,
   "costUsd": 0.0558967
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785696891473,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 133,
   "cachedInputTokens": 13275,
   "costUsd": 0.0901115
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785696899677,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18748,
   "outputTokens": 55,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785696906000,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 516,
   "cachedInputTokens": 10303,
   "costUsd": 0.022482299999999997
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785696917282,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18889,
   "outputTokens": 70,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785696923209,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19005,
   "outputTokens": 80,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785696930357,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19076,
   "outputTokens": 50,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785696935307,
  "provider": "claude",
  "outcome": "failed"
 },
 {
  "agentName": "Opus",
  "startedAt": 1785696936096,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 276,
   "cachedInputTokens": 13275,
   "costUsd": 0.1019135
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785696937776,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19241,
   "outputTokens": 74,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "sonnet",
  "startedAt": 1785696945711,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 87,
   "cachedInputTokens": 13899,
   "costUsd": 0.0615567
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785696947470,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 991,
   "cachedInputTokens": 34940,
   "costUsd": 0.147372
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785696956641,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19458,
   "outputTokens": 64,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785696962788,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 1715,
   "cachedInputTokens": 10303,
   "costUsd": 0.030696299999999996
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785696972008,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 863,
   "cachedInputTokens": 35357,
   "costUsd": 0.1465045
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785696993295,
  "provider": "claude",
  "outcome": "failed"
 },
 {
  "agentName": "Sol",
  "startedAt": 1785696993505,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19818,
   "outputTokens": 164,
   "cachedInputTokens": 0,
   "reasoningTokens": 53
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785696994525,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 762,
   "cachedInputTokens": 10303,
   "costUsd": 0.0269893
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785697004619,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 20086,
   "outputTokens": 216,
   "cachedInputTokens": 0,
   "reasoningTokens": 27
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785697010095,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 20128,
   "outputTokens": 74,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785697016182,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 5992,
   "cachedInputTokens": 10303,
   "costUsd": 0.054084299999999995
  }
 },
 {
  "agentName": "sonnet",
  "startedAt": 1785697018942,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 107,
   "cachedInputTokens": 13899,
   "costUsd": 0.0718057
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785697026527,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 20150,
   "outputTokens": 119,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785697035911,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 20159,
   "outputTokens": 58,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785697040557,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 1359,
   "cachedInputTokens": 10303,
   "costUsd": 0.0307813
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785697063386,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 2036,
   "cachedInputTokens": 10303,
   "costUsd": 0.0332883
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785697191157,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 363,
   "cachedInputTokens": 13275,
   "costUsd": 0.1147975
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785697201269,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19919,
   "outputTokens": 68,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785697201334,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19927,
   "outputTokens": 81,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785697207714,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 516,
   "cachedInputTokens": 10303,
   "costUsd": 0.026139299999999997
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785697219903,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19873,
   "outputTokens": 102,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785697219985,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19871,
   "outputTokens": 86,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785697477740,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 477,
   "cachedInputTokens": 13275,
   "costUsd": 0.11745349999999999
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785697489856,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19904,
   "outputTokens": 68,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785697489919,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19907,
   "outputTokens": 77,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785697495552,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 660,
   "cachedInputTokens": 10303,
   "costUsd": 0.026764299999999998
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785697508201,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19840,
   "outputTokens": 78,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785697508289,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19843,
   "outputTokens": 67,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785781241149,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 8,
   "outputTokens": 3861,
   "cachedInputTokens": 101410,
   "costUsd": 1.071868
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785781315292,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19715,
   "outputTokens": 111,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785781441102,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 346,
   "cachedInputTokens": 22411,
   "costUsd": 0.24669899999999997
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785781451602,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19416,
   "outputTokens": 89,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785781472810,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19389,
   "outputTokens": 103,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785781580848,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 681,
   "cachedInputTokens": 22411,
   "costUsd": 0.265339
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785781597576,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19965,
   "outputTokens": 153,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785781607316,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 323,
   "cachedInputTokens": 22411,
   "costUsd": 0.254782
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785781619820,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19807,
   "outputTokens": 108,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785781627218,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 684,
   "cachedInputTokens": 0,
   "costUsd": 0.045888000000000005
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785781642486,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 312,
   "cachedInputTokens": 22411,
   "costUsd": 0.25275099999999995
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785781655025,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19285,
   "outputTokens": 73,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785781661964,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 6,
   "outputTokens": 882,
   "cachedInputTokens": 88401,
   "costUsd": 0.385023
  }
 },
 {
  "agentName": "terra",
  "startedAt": 1785781682217,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19403,
   "outputTokens": 81,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785781925006,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 700,
   "cachedInputTokens": 22411,
   "costUsd": 0.25953899999999996
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785781941702,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 458,
   "cachedInputTokens": 0,
   "costUsd": 0.241517
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785781960443,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 1157,
   "cachedInputTokens": 10303,
   "costUsd": 0.0285163
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785781980934,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 158,
   "cachedInputTokens": 13275,
   "costUsd": 0.1075315
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785781993040,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 6,
   "outputTokens": 864,
   "cachedInputTokens": 89940,
   "costUsd": 0.403424
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785782019727,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 290,
   "cachedInputTokens": 13275,
   "costUsd": 0.11607950000000002
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785782039501,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 6,
   "outputTokens": 756,
   "cachedInputTokens": 86714,
   "costUsd": 0.343132
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785782064894,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 210,
   "cachedInputTokens": 13275,
   "costUsd": 0.10465050000000001
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785782079408,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 6,
   "outputTokens": 701,
   "cachedInputTokens": 87131,
   "costUsd": 0.33923600000000004
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785782101298,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 136,
   "cachedInputTokens": 13275,
   "costUsd": 0.1071105
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785782110786,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 198,
   "cachedInputTokens": 22411,
   "costUsd": 0.24005100000000001
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785782120983,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 442,
   "cachedInputTokens": 13275,
   "costUsd": 0.1186495
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785782134656,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 187,
   "cachedInputTokens": 22411,
   "costUsd": 0.24174400000000001
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785782147676,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 83,
   "cachedInputTokens": 13275,
   "costUsd": 0.1091245
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785782370716,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 4,
   "outputTokens": 934,
   "cachedInputTokens": 35832,
   "costUsd": 0.21110600000000002
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785782474330,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 8,
   "outputTokens": 1246,
   "cachedInputTokens": 126415,
   "costUsd": 0.49498100000000006
  }
 },
 {
  "agentName": "Opus",
  "startedAt": 1785782567908,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 272,
   "cachedInputTokens": 13275,
   "costUsd": 0.1161035
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785782603624,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 8,
   "outputTokens": 1303,
   "cachedInputTokens": 123782,
   "costUsd": 0.458904
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785782686729,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 14505,
   "outputTokens": 36,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785782900527,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 14550,
   "outputTokens": 43,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785782954482,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 14608,
   "outputTokens": 67,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785783042701,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 349,
   "cachedInputTokens": 10303,
   "costUsd": 0.0060693
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785783075152,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 14711,
   "outputTokens": 92,
   "cachedInputTokens": 8960,
   "reasoningTokens": 39
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785783141208,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 14774,
   "outputTokens": 43,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785783412057,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 14907,
   "outputTokens": 89,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785785023041,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 6,
   "outputTokens": 1391,
   "cachedInputTokens": 91669,
   "costUsd": 0.46718099999999996
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785785063557,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 20104,
   "outputTokens": 139,
   "cachedInputTokens": 8960,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785785074889,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 8,
   "outputTokens": 1475,
   "cachedInputTokens": 122910,
   "costUsd": 0.461141
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785785106281,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 19869,
   "outputTokens": 127,
   "cachedInputTokens": 0,
   "reasoningTokens": 53
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785815741938,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 70,
   "cachedInputTokens": 0,
   "costUsd": 0.507973
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785816338014,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 219,
   "cachedInputTokens": 22428,
   "costUsd": 0.091749
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785816470728,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 2,
   "outputTokens": 565,
   "cachedInputTokens": 22428,
   "costUsd": 0.114074
  }
 },
 {
  "agentName": "Sol",
  "startedAt": 1785816516862,
  "provider": "codex",
  "outcome": "ok",
  "usage": {
   "inputTokens": 15632,
   "outputTokens": 124,
   "cachedInputTokens": 0,
   "reasoningTokens": 0
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1785816534226,
  "provider": "claude",
  "outcome": "failed"
 },
 {
  "agentName": "Architect",
  "startedAt": 1785867979584,
  "provider": "claude",
  "outcome": "failed"
 },
 {
  "agentName": "Architect",
  "startedAt": 1785898896254,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 858,
   "cachedInputTokens": 0,
   "costUsd": 0.047694
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785900531834,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 1166,
   "cachedInputTokens": 10299,
   "costUsd": 0.042801900000000004
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785912267944,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 18,
   "outputTokens": 1289,
   "cachedInputTokens": 18285,
   "costUsd": 0.07845550000000001
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1785952495407,
  "provider": "claude",
  "outcome": "ok",
  "usage": {
   "inputTokens": 10,
   "outputTokens": 558,
   "cachedInputTokens": 0,
   "costUsd": 0.048749999999999995
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1786041254394,
  "provider": "claude",
  "outcome": "ok",
  "ownerSetup": false,
  "usage": {
   "inputTokens": 10,
   "outputTokens": 1032,
   "cachedInputTokens": 21107,
   "costUsd": 0.0399367
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1786041930469,
  "provider": "claude",
  "outcome": "ok",
  "ownerSetup": false,
  "usage": {
   "inputTokens": 10,
   "outputTokens": 212,
   "cachedInputTokens": 37435,
   "costUsd": 0.0076815
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1786041965913,
  "provider": "claude",
  "outcome": "ok",
  "ownerSetup": false,
  "usage": {
   "inputTokens": 2,
   "outputTokens": 700,
   "cachedInputTokens": 0,
   "costUsd": 0.8855999999999999
  }
 },
 {
  "agentName": "Architect",
  "startedAt": 1786042007338,
  "provider": "claude",
  "outcome": "ok",
  "ownerSetup": false,
  "usage": {
   "inputTokens": 10,
   "outputTokens": 286,
   "cachedInputTokens": 38869,
   "costUsd": 0.0071749000000000005
  }
 },
 {
  "agentName": "Fable5",
  "startedAt": 1786042279650,
  "provider": "claude",
  "outcome": "failed",
  "ownerSetup": false
 },
 {
  "agentName": "Fable5",
  "startedAt": 1786042365334,
  "provider": "claude",
  "outcome": "failed",
  "ownerSetup": false
 }
];
