import { useSyncExternalStore } from "react";

/**
 * Token do aparelho (primeiro fator, antes do PIN). Emitido por
 * `device-enroll` e conferido no servidor por list-employees/login-pin.
 *
 * No Electron fica no processo principal (safeStorage, em userData) porque
 * a SPA roda em http(s)://127.0.0.1:7317 e a troca de protocolo muda a
 * origem e apaga o localStorage. No navegador/celular usa localStorage.
 * Cache em memória: `initDeviceToken()` roda antes do primeiro render.
 */
const STORAGE_KEY = "fa_kiosk_device_token";

let cached: string | null = null;
const listeners = new Set<() => void>();

function readLocal(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLocal(token: string | null) {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // modo privado/sem storage: o token vale só até fechar a aba
  }
}

function emit() {
  for (const l of listeners) l();
}

export async function initDeviceToken(): Promise<void> {
  const bridge = typeof window !== "undefined" ? window.facaamigos?.deviceToken : undefined;
  if (bridge) {
    try {
      cached = (await bridge.get()) ?? null;
      if (!cached) {
        // Migra um token que já estivesse no localStorage desta origem.
        const legacy = readLocal();
        if (legacy) {
          await bridge.set(legacy);
          cached = legacy;
        }
      }
      return;
    } catch {
      // cai para localStorage
    }
  }
  cached = readLocal();
}

export function getDeviceToken(): string | null {
  return cached;
}

export async function setDeviceToken(token: string): Promise<void> {
  cached = token;
  writeLocal(token);
  try {
    await (typeof window !== "undefined" ? window.facaamigos?.deviceToken?.set(token) : undefined);
  } catch {
    // mantém o cache e o localStorage
  }
  emit();
}

export async function clearDeviceToken(): Promise<void> {
  cached = null;
  writeLocal(null);
  try {
    await (typeof window !== "undefined" ? window.facaamigos?.deviceToken?.clear() : undefined);
  } catch {
    // idem
  }
  emit();
}

/** Header enviado às Edge Functions de login. */
export function deviceHeaders(): Record<string, string> {
  return cached ? { "x-device-token": cached } : {};
}

/** True quando a resposta de uma Edge Function indica aparelho não cadastrado/revogado. */
export async function isDeviceRejected(error: unknown): Promise<boolean> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (!(ctx instanceof Response) || ctx.status !== 401) return false;
  try {
    const body = (await ctx.clone().json()) as { error?: string };
    return body.error === "device_not_enrolled";
  } catch {
    return false;
  }
}

export function useHasDeviceToken(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cached !== null,
  );
}
