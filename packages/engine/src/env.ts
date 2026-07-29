// The environment a spawned harness is allowed to see.
//
// ONE owner for this decision (security review 2026-07-29, finding #9). The
// Claude path stripped credential variables; the Codex path passed
// `env: undefined`, which means "inherit everything this process was started
// with" — so a stray ANTHROPIC_API_KEY exported in someone's shell could
// quietly pay for a Codex turn, and every other secret in the environment was
// handed to a child process that had no business seeing it.
//
// Both providers now call the same function, so the two can never drift apart.

// WHAT COUNTS AS A SECRET now lives in `@cloud9/shared`, because two programs
// ask the question: this file, deciding what a spawned CLI may see, and the
// redactor, deciding what may leave the machine. Re-exported here so every
// existing caller and test keeps working against one definition.
//
// A strict allow-list was considered and rejected for now: a CLI needs an
// unknowable set of ordinary OS variables (PATH, HOME, APPDATA, SystemRoot,
// TEMP, proxy settings, locale) and guessing that list wrong breaks the app on
// someone's machine. Naming the dangerous SHAPE is the part that generalises.
export { CREDENTIAL_ENV_VARS, isCredentialVar } from "@cloud9/shared";
import { isCredentialVar } from "@cloud9/shared";

/**
 * A copy of the environment with every credential variable stripped out.
 *
 * Exported so tests can assert on it directly — this is the whole promise of
 * the CLI-login path: if a turn runs, it runs on the app's own sign-in.
 *
 * `extra` is added AFTER the stripping, for the one case where a credential is
 * deliberately handed to its own CLI (the Codex API-key fallback).
 */
export function envWithoutCredentials(
  base: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (isCredentialVar(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
