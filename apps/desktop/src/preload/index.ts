import { contextBridge, ipcRenderer } from "electron";
import type { CrewyardApi } from "../shared/api.ts";

// The only surface the renderer gets. No Node APIs, no raw ipcRenderer.
const api: CrewyardApi = {
  call: (method, params) => ipcRenderer.invoke("crewyard:call", method, params),
  on: (topic, listener) => {
    const handler = (_e: unknown, t: string, payload: unknown) => {
      if (t === topic) listener(payload);
    };
    ipcRenderer.on("crewyard:event", handler);
    return () => ipcRenderer.off("crewyard:event", handler);
  },
  appInfo: () => ipcRenderer.invoke("crewyard:app-info"),
  pickFolder: () => ipcRenderer.invoke("crewyard:pick-folder"),
  setTitleBar: (colors) => ipcRenderer.send("crewyard:titlebar", colors),
  startup: () => ipcRenderer.invoke("crewyard:startup"),
  setStartup: (next) => ipcRenderer.invoke("crewyard:set-startup", next),
  pickDatabase: (mode, defaultName) => ipcRenderer.invoke("crewyard:pick-database", mode, defaultName),
  saveExport: (kind, defaultName, content) => ipcRenderer.invoke("crewyard:save-export", kind, defaultName, content),
  revealPath: (path) => ipcRenderer.send("crewyard:reveal", path),
  setLanguage: (language) => ipcRenderer.send("crewyard:language", language),
  testToast: () => ipcRenderer.send("crewyard:test-toast"),
  keepAwake: () => ipcRenderer.invoke("crewyard:keep-awake"),
  reportBattery: (reading) => ipcRenderer.send("crewyard:battery", reading),
  updates: () => ipcRenderer.invoke("crewyard:update", "state"),
  checkForUpdates: () => ipcRenderer.invoke("crewyard:update", "check"),
  downloadUpdate: () => ipcRenderer.invoke("crewyard:update", "download"),
  cancelUpdate: () => ipcRenderer.invoke("crewyard:update", "cancel"),
  installUpdate: () => ipcRenderer.invoke("crewyard:update", "install"),
  setUpdateAutoCheck: (on) => ipcRenderer.invoke("crewyard:update", on ? "auto-on" : "auto-off"),
  openLicenses: () => ipcRenderer.invoke("crewyard:open-licenses"),
};

contextBridge.exposeInMainWorld("crewyard", api);
