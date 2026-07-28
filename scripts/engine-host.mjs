// Dev/QA engine host: runs the owner's agents against a local relay, and owns
// harness detection + sign-in for browser-only dev (no Electron).
//
// Credentials: CLOUD9_CRED remains the dev escape hatch (harness-signin.md
// decision 4). A token captured by "Sign in with Claude" is kept in memory for
// this run only — the dev host has no OS keychain; the Electron shell does.
import { startEngineHost } from "@cloud9/engine";

const relayUrl = process.env.CLOUD9_RELAY_URL ?? "ws://127.0.0.1:8787";
const token = process.env.CLOUD9_OWNER_TOKEN ?? "dev-owner-token";
const dataDir = process.env.CLOUD9_ENGINE_DATA ?? "./cloud9-engine-data";
const cred = process.env.CLOUD9_CRED;
const kind = process.env.CLOUD9_CRED_KIND === "oauthToken" ? "oauthToken" : "apiKey";
const codexKey = process.env.CLOUD9_CODEX_CRED;
// Demo mode (canned replies) must be asked for: CLOUD9_DEMO=1. Without a
// credential and without this flag, agents say their engine isn't connected
// rather than inventing answers that look real.
const demoMode = process.env.CLOUD9_DEMO === "1";

startEngineHost({
  relayUrl,
  token,
  dataDir,
  demoMode,
  credentials: {
    ...(cred ? { claude: { kind, value: cred } } : {}),
    ...(codexKey ? { codex: { kind: "apiKey", value: codexKey } } : {}),
  },
  onClaudeToken: t => {
    // never log the value — length only
    console.log(`[engine-host] captured a Claude sign-in token (length ${t.length}); ` +
      "it lives in memory for this dev run only — the desktop app stores it encrypted");
  },
  onReady: () => console.log(
    `[engine-host] online (${cred ? "live Claude" : demoMode ? "demo mode" : "no Claude credential yet"})`),
});
