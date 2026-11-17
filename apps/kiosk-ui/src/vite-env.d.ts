/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Injetadas via `define` em vite.config.ts (ver VersionBadge.tsx).
declare const __APP_VERSION__: string;
declare const __BUILD_SHA__: string;

// Exposto pelo preload do Electron (apps/kiosk/src/main/preload.ts) só
// quando a SPA roda dentro do app desktop que tem o print bridge — não
// existe quando kiosk-ui abre num tablet comum da LAN.
interface Window {
  facaamigos?: {
    listPrinters: () => Promise<{ name: string }[]>;
    getAppVersion: () => Promise<string>;
    getUpdateStatus: () => Promise<{ status: string; version?: string; progress?: number; error?: string }>;
    checkForUpdates: () => Promise<{ status: string; version?: string; progress?: number; error?: string }>;
    saveTerminalKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
    applyUpdate: () => Promise<void>;
    deviceToken?: {
      get: () => Promise<string | null>;
      set: (token: string) => Promise<void>;
      clear: () => Promise<void>;
    };
    onUpdateStatusChange: (
      callback: (data: { status: string; version?: string; progress?: number; error?: string }) => void
    ) => () => void;
  };
}

