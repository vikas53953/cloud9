// Dev/QA engine host: runs the owner's agents against a local relay.
// Live Claude when CLOUD9_CRED is set, demo mode otherwise.
import { Engine, MockProvider, SdkProvider } from "@cloud9/engine";

const relayUrl = process.env.CLOUD9_RELAY_URL ?? "ws://127.0.0.1:8787";
const token = process.env.CLOUD9_OWNER_TOKEN ?? "dev-owner-token";
const dataDir = process.env.CLOUD9_ENGINE_DATA ?? "./cloud9-engine-data";

const engine = new Engine({ relayUrl, token, dataDir });
const cred = process.env.CLOUD9_CRED;
const kind = process.env.CLOUD9_CRED_KIND ?? "apiKey";
engine.provider = cred
  ? new SdkProvider(kind === "apiKey" ? { apiKey: cred } : { oauthToken: cred }, engine.agentDataDir)
  : new MockProvider();
engine.onReady = () => console.log(`[engine-host] online (${cred ? "live Claude" : "demo mode"})`);
engine.connect();
