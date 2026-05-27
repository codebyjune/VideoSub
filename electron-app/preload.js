const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  startWorkflow: (config) => ipcRenderer.invoke("start-workflow", config),
  onLog: (callback) => {
    ipcRenderer.on("log", (_, msg) => callback(msg));
  },
  onProgress: (callback) => {
    ipcRenderer.on("progress", (_, data) => callback(data));
  },
  onStatus: (callback) => {
    ipcRenderer.on("status", (_, status) => callback(status));
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners("log");
    ipcRenderer.removeAllListeners("progress");
    ipcRenderer.removeAllListeners("status");
  },
});
