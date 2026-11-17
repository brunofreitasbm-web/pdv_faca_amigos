import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("facaamigos", {
  listPrinters: () => ipcRenderer.invoke("list-printers") as Promise<{ name: string }[]>,
  getAppVersion: () => ipcRenderer.invoke("get-app-version") as Promise<string>,
  getUpdateStatus: () => ipcRenderer.invoke("get-update-status") as Promise<unknown>,
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates") as Promise<unknown>,
  saveTerminalKey: (key: string) => ipcRenderer.invoke("save-terminal-key", key) as Promise<{ ok: boolean; error?: string }>,
  deviceToken: {
    get: () => ipcRenderer.invoke("device-token-get") as Promise<string | null>,
    set: (token: string) => ipcRenderer.invoke("device-token-set", token) as Promise<void>,
    clear: () => ipcRenderer.invoke("device-token-clear") as Promise<void>,
  },
  applyUpdate: () => ipcRenderer.invoke("apply-update") as Promise<void>,
  onUpdateStatusChange: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("update-status-change", handler);
    return () => {
      ipcRenderer.removeListener("update-status-change", handler);
    };
  },
});

