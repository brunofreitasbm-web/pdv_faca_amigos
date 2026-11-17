import { describe, expect, it, beforeEach, vi } from "vitest";
import { clearDeviceToken, deviceHeaders, getDeviceToken, initDeviceToken, isDeviceRejected, setDeviceToken } from "../src/lib/supabase/deviceToken.js";

const TOKEN = "a".repeat(64);

describe("deviceToken", () => {
  beforeEach(async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    await clearDeviceToken();
  });

  it("sem token não envia header", () => {
    expect(getDeviceToken()).toBeNull();
    expect(deviceHeaders()).toEqual({});
  });

  it("guarda e limpa o token", async () => {
    await setDeviceToken(TOKEN);
    expect(deviceHeaders()).toEqual({ "x-device-token": TOKEN });
    await clearDeviceToken();
    expect(getDeviceToken()).toBeNull();
  });

  it("init recupera do localStorage", async () => {
    await setDeviceToken(TOKEN);
    await initDeviceToken();
    expect(getDeviceToken()).toBe(TOKEN);
  });

  it("reconhece device_not_enrolled só em 401", async () => {
    const r401 = new Response(JSON.stringify({ error: "device_not_enrolled" }), { status: 401 });
    const r429 = new Response(JSON.stringify({ error: "x" }), { status: 429 });
    expect(await isDeviceRejected({ context: r401 })).toBe(true);
    expect(await isDeviceRejected({ context: r429 })).toBe(false);
    expect(await isDeviceRejected(new Error("x"))).toBe(false);
  });
});
