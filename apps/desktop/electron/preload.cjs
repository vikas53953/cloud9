const { contextBridge, ipcRenderer } = require("electron");

// The renderer can SET or CLEAR a fallback key per app, and ASK whether one is
// stored. It can never read a stored secret back — that stays in the main
// process, encrypted by the OS (harness-signin.md decision 4).
contextBridge.exposeInMainWorld("cloud9", {
  isDesktop: true,
  setApiKey: (harness, kind, value) => ipcRenderer.invoke("cloud9:setApiKey", harness, kind, value),
  clearCredential: harness => ipcRenderer.invoke("cloud9:clearCredential", harness),
  credentialStatus: () => ipcRenderer.invoke("cloud9:credentialStatus"),
});
