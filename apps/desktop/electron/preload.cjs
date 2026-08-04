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
   * Ask the OWNER which folder a project's code is in, using the operating
   * system's own picker. The renderer never touches the filesystem: it gets
   * back `{ ok: true, path }` for the one folder the owner chose,
   * `{ ok: false, cancelled: true }` when they closed it, or
   * `{ ok: false, error }` with a sentence it may print.
   */
  chooseFolder: current => ipcRenderer.invoke("cloud9:chooseFolder", current),

  /* ---------- ONE AGENT'S CONNECTIONS FILE (feature 5, slice 2) ----------
   * Its own block, and it borrows nothing from the lines around it.
   *
   * "Connections" are extra tools an agent can reach that Cloud9 did not write;
   * whoever makes the tool hands you a small config file, and the owner picks
   * that file for ONE agent. The window never touches the filesystem: it asks
   * for the OS's own file picker, and it may ask whether the one path it was
   * given back is still there.
   *
   * `chooseConnectionsFile` → `{ ok: true, path }`, `{ ok: false, cancelled: true }`
   * when the picker was closed, or `{ ok: false, error }` with a sentence to print.
   * `connectionsFileHere` → `{ here, checkedAt }` — a yes/no and when it was asked.
   * Nothing inside the file ever crosses this bridge.
   */
  chooseConnectionsFile: current =>
    ipcRenderer.invoke("cloud9:chooseConnectionsFile", current),
  connectionsFileHere: file => ipcRenderer.invoke("cloud9:connectionsFileHere", file),

  /* ---------- THE FOLDERS ONE AGENT MAY REACH OUTSIDE ITS OWN ----------
   * Its own block, and it borrows nothing from the lines around it.
   *
   * In plain words: folders on this computer this agent may read and change,
   * besides its own. The window never touches the filesystem: it asks for the
   * OS's own folder picker (several folders at once), and it may ask which of
   * the paths it was already given back are still there.
   *
   * `chooseWholeComputerFolders` → `{ ok: true, paths }`,
   * `{ ok: false, cancelled: true }` when the picker was closed, or
   * `{ ok: false, error }` with a sentence to print.
   * `wholeComputerFoldersHere` → `{ here, checkedAt }` — the subset that is
   * really there and when it was asked. Nothing inside any folder is ever
   * listed or read across this bridge.
   */
  chooseWholeComputerFolders: () => ipcRenderer.invoke("cloud9:chooseWholeComputerFolders"),
  wholeComputerFoldersHere: folders =>
    ipcRenderer.invoke("cloud9:wholeComputerFoldersHere", folders),

  /**
   * The computer-wide quick-chat hotkey. OFF by default, because a global
   * shortcut takes that key away from every other program on the machine.
   * `get` → { enabled, key, defaultKey, active }, `set(enabled, key)` → same,
   * having actually tried to claim it (so the screen can say "another program
   * already uses that one").
   */
  quickChatHotkey: () => ipcRenderer.invoke("cloud9:quickChatHotkey"),
  setQuickChatHotkey: (enabled, key) =>
    ipcRenderer.invoke("cloud9:setQuickChatHotkey", enabled, key),

  /**
   * Which address this computer's hub answers on, so a friend on another
   * computer can reach it over a private (Tailscale) network. Loopback — this
   * computer only — unless changed. `set` takes effect the next time Cloud9
   * starts; a wildcard address is refused, never quietly narrowed.
   */
  hubNetwork: () => ipcRenderer.invoke("cloud9:hubNetwork"),
  setHubNetwork: address => ipcRenderer.invoke("cloud9:setHubNetwork", address),

  /**
   * WINDOWS' OWN NOTIFICATIONS — the door that reaches him when Cloud9 is
   * minimised. The window has already decided (shared `decideNotification`,
   * then `chooseDelivery`) that this news is worth an interruption and that the
   * operating system is the right door; this only carries it across.
   *
   * `osNotify` answers `{ ok: true }`, or `{ ok: false, supported, error }` with
   * a sentence the screen may print — it never throws away the news in silence.
   * Only plain words cross: a title, a body, and the ids needed to land on the
   * thing when it is clicked.
   */
  notificationsSupported: () => ipcRenderer.invoke("cloud9:notifySupported"),
  osNotify: note => ipcRenderer.invoke("cloud9:osNotify", {
    id: note?.id, kind: note?.kind, title: note?.title, body: note?.body,
    channelId: note?.channelId, subjectId: note?.subjectId,
  }),
  /**
   * He clicked one. The callback is handed the note's own ids only — never the
   * raw IPC event, so the page cannot reach back through it. Returns an
   * unsubscribe function, the same shape as `onMenu` below.
   */
  onNotificationClick: handler => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, note) => {
      if (note && typeof note === "object") handler(note);
    };
    ipcRenderer.on("cloud9:notificationClicked", listener);
    return () => ipcRenderer.removeListener("cloud9:notificationClicked", listener);
  },

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
