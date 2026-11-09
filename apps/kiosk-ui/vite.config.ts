import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Versão exibida no badge discreto (VersionBadge.tsx): usa a mesma versão
// do apps/kiosk (o número que de fato é bumpado a cada release, ver
// scripts/release-kiosk.mjs) — kiosk-ui não tem versionamento próprio.
const kioskPackageJson = fileURLToPath(new URL("../kiosk/package.json", import.meta.url));
const appVersion = JSON.parse(readFileSync(kioskPackageJson, "utf-8")).version as string;

function shortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: fileURLToPath(new URL(".", import.meta.url)) })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

function generateVersionJsonPlugin(version: string, sha: string) {
  const content = JSON.stringify({ version, buildSha: sha, timestamp: Date.now() }, null, 2);
  return {
    name: "generate-version-json",
    buildStart() {
      try {
        const publicDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "public");
        mkdirSync(publicDir, { recursive: true });
        writeFileSync(resolve(publicDir, "version.json"), content);
      } catch (e) {
        console.warn("Falha ao escrever public/version.json:", e);
      }
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: content,
      });
    },
  };
}

// D1 do plano: mesma SPA para o Electron (127.0.0.1:7317) e para os
// tablets da LAN. Em dev, o proxy evita CORS entre o Vite (5173) e o
// servidor Fastify local (apps/kiosk).
//
// PWA: o deploy da Vercel (HTTPS) é o que os celulares/tablets instalam.
// O service worker é registrado manualmente em src/pwa.ts — NUNCA na
// origem local do Electron (127.0.0.1 é secure context e o SW congelaria
// uma shell antiga no desktop após updates).
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_SHA__: JSON.stringify(shortSha()),
  },
  plugins: [
    generateVersionJsonPlugin(appVersion, shortSha()),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: null,
      includeAssets: ["favicon.png", "icons/apple-touch-icon.png"],
      manifest: {
        id: "/",
        name: "FaçaAmigos",
        short_name: "FaçaAmigos",
        description: "Playground Inclusivo — operação",
        lang: "pt-BR",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        theme_color: "#F0196B",
        background_color: "#141414",
        icons: [
          { src: "/icons/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Handler de Web Push (alerta em segundo plano do painel do
        // responsável) — generateSW não permite eventos custom no config,
        // então isso injeta um importScripts() apontando pro arquivo em
        // public/push-sw.js dentro do sw.js gerado.
        importScripts: ["push-sw.js"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /^\/mcp/, /^\/oauth\//, /^\/\.well-known\//],
        // json/bin: manifests e pesos dos modelos do face-api.js em
        // public/models, self-hosted de propósito (ver faceRecognition.ts)
        // para o reconhecimento facial funcionar offline/com internet
        // instável no local. Sem isso o SW nunca precacheava os modelos e
        // o fetch falhava direto ("Load failed") quando a rede caía.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,json,bin}"],
        // face_recognition_model.bin tem ~6.44MB — o limite de 4MB padrão
        // excluía esse arquivo do precache mesmo com o glob correto.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // Fontes agora são woff2 empacotados (precache, glob acima): não há
        // mais Google Fonts em runtime. Sem handler para *.supabase.co de
        // propósito: auth/realtime/RPC passam direto, nunca cacheados.
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7317",
      "/ws": { target: "ws://127.0.0.1:7317", ws: true },
    },
  },
});
