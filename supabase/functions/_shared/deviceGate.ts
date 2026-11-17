// Portão de aparelho: login-pin e list-employees só respondem a um aparelho
// cadastrado (header x-device-token). É a checagem de servidor que impede
// chamar as funções direto, de fora do app.
//
// DEVICE_GATE_ENFORCE (env da função):
//   "true"  -> sem aparelho válido, 401 device_not_enrolled.
//   outro   -> transição: só registra no log e deixa passar.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { jsonResponse } from "./http.ts";

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DeviceOk {
  ok: true;
  deviceId: string | null;
  unitId: string | null;
}
export interface DeviceDenied {
  ok: false;
  response: Response;
}

const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

export function gateEnforced(): boolean {
  return Deno.env.get("DEVICE_GATE_ENFORCE") === "true";
}

export async function requireDevice(
  req: Request,
  adminClient: SupabaseClient,
  fnName: string,
): Promise<DeviceOk | DeviceDenied> {
  const token = req.headers.get("x-device-token")?.trim() ?? "";
  let device: { id: string; unit_id: string; last_seen_ms: number | null } | null = null;

  if (token.length >= 32 && token.length <= 128) {
    const { data } = await adminClient
      .from("fa_kiosk_devices")
      .select("id, unit_id, last_seen_ms")
      .eq("token_hash", await sha256Hex(token))
      .is("revoked_at_ms", null)
      .maybeSingle();
    device = data ?? null;
  }

  if (device) {
    const now = Date.now();
    if (device.last_seen_ms == null || now - device.last_seen_ms > LAST_SEEN_THROTTLE_MS) {
      await adminClient.from("fa_kiosk_devices").update({ last_seen_ms: now }).eq("id", device.id);
    }
    return { ok: true, deviceId: device.id, unitId: device.unit_id };
  }

  if (gateEnforced()) {
    return { ok: false, response: jsonResponse(req, { error: "device_not_enrolled" }, 401) };
  }
  console.warn(`[deviceGate] ${fnName}: chamada sem aparelho válido (gate em modo transição)`);
  return { ok: true, deviceId: null, unitId: null };
}
