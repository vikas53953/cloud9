const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cloud9", {
  setCred: (kind, value) => ipcRenderer.send("cloud9:setCred", kind, value),
});
