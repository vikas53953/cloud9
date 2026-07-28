const { contextBridge, ipcRenderer } = require("electron");

/* ---------- signing the owner in, in the installed app ----------
 * The installed Cloud9 runs its own hub and made its own random key on first
 * run. Nobody can type a key they were never shown, so the shell hands it to
 * the app screen here — before any app code runs — and the sign-in screen is
 * skipped. Dev gets null back and behaves exactly as it does today.
 * This is the hub session key only. Claude/Codex sign-ins never come through
 * this bridge; they stay in the main process, encrypted by the OS. */
try {
  const ownerToken = ipcRenderer.sendSync("cloud9:ownerToken");
  if (ownerToken && window.localStorage.getItem("cloud9.token") !== ownerToken) {
    window.localStorage.setItem("cloud9.token", ownerToken);
  }
} catch {
  /* no storage here — the app screen falls back to its sign-in screen */
}

// The renderer can SET or CLEAR a fallback key per app, and ASK whether one is
// stored. It can never read a stored secret back — that stays in the main
// process, encrypted by the OS (harness-signin.md decision 4).
contextBridge.exposeInMainWorld("cloud9", {
  isDesktop: true,
  setApiKey: (harness, kind, value) => ipcRenderer.invoke("cloud9:setApiKey", harness, kind, value),
  clearCredential: harness => ipcRenderer.invoke("cloud9:clearCredential", harness),
  credentialStatus: () => ipcRenderer.invoke("cloud9:credentialStatus"),

  /** Where this computer keeps each agent's own files, and a button to open it. */
  agentFolder: () => ipcRenderer.invoke("cloud9:agentFolder"),
  openAgentFolder: () => ipcRenderer.invoke("cloud9:openAgentFolder"),

  /**
   * Menu bar → app screen. The callback is handed the action name only
   * ("new-agent", "settings", "toggle-theme", …) — never the raw IPC event, so
   * the renderer can't reach back through it. Returns an unsubscribe function.
   */
  onMenu: handler => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, action) => {
      if (typeof action === "string") handler(action);
    };
    ipcRenderer.on("cloud9:menu", listener);
    return () => ipcRenderer.removeListener("cloud9:menu", listener);
  },
});
