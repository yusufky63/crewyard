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
};

contextBridge.exposeInMainWorld("crewyard", api);
