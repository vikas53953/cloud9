// Where a QA run is allowed to point — one owner for that decision.
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

/** The port `qa-stack.mjs` starts its throwaway relay on. */
export const QA_RELAY_PORT = "8799";
/** The port a normal `npm run dev:relay` uses — the REAL database. */
export const DEV_RELAY_PORT = "8787";

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
    ui: `http://127.0.0.1:${uiPort}/?relay=ws://127.0.0.1:${relayPort}`,
  };
}
