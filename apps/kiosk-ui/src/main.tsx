import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./fonts.js";
import "@facaamigos/ui/styles.css";
import "./app.css";
import { App } from "./App.js";
import { AppStateProvider } from "./state/AppState.js";
import { AuthProvider } from "./auth/AuthContext.js";
import { ToastProvider } from "./state/ToastContext.js";
import { ConfirmProvider } from "./state/ConfirmContext.js";
import { SystemStatusOverlay } from "./components/SystemStatusOverlay.js";
import { VersionBadge } from "./components/VersionBadge.js";
import { flushOfflineQueue } from "./lib/supabase/offlineQueue.js";
import { setupPwa } from "./pwa.js";

setupPwa();

window.addEventListener("online", () => void flushOfflineQueue());
setInterval(() => void flushOfflineQueue(), 30_000);
void flushOfflineQueue();

import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { SecretVaultReader } from "./screens/SecretVaultReader.js";
import { consumeHubSsoTicket } from "./lib/supabase/hubSso.js";

// Depois de um deploy novo na Vercel, uma aba antiga tenta baixar chunks que
// não existem mais (hash mudou) e o Vite dispara este evento. Recarrega UMA vez
// para pegar o index.html novo; a trava em sessionStorage evita loop de
// recarga se o problema for outro (rede fora do ar, por exemplo), caso em que
// o ErrorBoundary mostra a tela de recuperação.
window.addEventListener("vite:preloadError", (event) => {
  try {
    const last = Number(sessionStorage.getItem("fa_preload_reload_at") ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem("fa_preload_reload_at", String(Date.now()));
  } catch {
    return; // sem sessionStorage não dá para garantir ausência de loop
  }
  event.preventDefault();
  window.location.reload();
});

const container = document.getElementById("root");
if (!container) throw new Error("#root não encontrado");

const pathname = window.location.pathname;
const isSecretRoute = pathname.startsWith("/segredo/");
const secretId = isSecretRoute ? pathname.split("/segredo/")[1]?.split("?")[0] : null;

// /sso (entrada pelo Hub de Gestão) troca o ticket por sessão antes do primeiro render.
void consumeHubSsoTicket().finally(() => createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <ConfirmProvider>
          {isSecretRoute && secretId ? (
            <SecretVaultReader secretId={secretId} />
          ) : (
            <AuthProvider>
              <AppStateProvider>
                <App />
              </AppStateProvider>
            </AuthProvider>
          )}
          <SystemStatusOverlay />
          <VersionBadge />
        </ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
));

