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

/**
 * Credential variables we know by name and always remove.
 * Kept explicit as well as pattern-matched: names we have actually seen in the
 * wild are documented here, and the pattern below catches the rest.
 */
export const CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

/**
 * The shape of a secret's NAME. A deny-list of known variables only ever
 * protects against the secrets we thought of; this catches the class —
 * anything that calls itself a key, token, secret, password or credential
 * (finding #19).
 *
 * A strict allow-list was considered and rejected for now: a CLI needs an
 * unknowable set of ordinary OS variables (PATH, HOME, APPDATA, SystemRoot,
 * TEMP, proxy settings, locale) and guessing that list wrong breaks the app on
 * someone's machine. Naming the dangerous SHAPE is the part that generalises.
 */
const SECRET_NAME_RE = /(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|_TOKEN$|^TOKEN$|AUTH_TOKEN|SESSION_KEY|PRIVATE_KEY)/i;

/** Is this variable name credential-shaped? Exported so tests can pin the rule. */
export function isCredentialVar(name: string): boolean {
  if ((CREDENTIAL_ENV_VARS as readonly string[]).includes(name)) return true;
  return SECRET_NAME_RE.test(name);
}

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
