// Dev/QA engine host: runs the owner's agents against a local relay, and owns
// harness detection + sign-in for browser-only dev (no Electron).
//
// Normally NO credential is needed at all: the Claude and Codex apps installed
// on this computer are signed in and own their own credentials, and this host
// simply spawns them (feedback-round-1.md). CLOUD9_CRED remains the dev escape
// hatch for a machine where those apps are signed out.
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
  onReady: () => console.log(
    `[engine-host] online (${cred
      ? "using a saved Claude key"
      : demoMode
        ? "demo mode"
        : "using the Claude and Codex apps' own sign-ins"})`),
});
