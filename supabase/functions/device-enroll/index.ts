// Ativa um aparelho com o código de uso único gerado pelo Owner
// (device-admin/create_code). Anônima por necessidade: o aparelho novo ainda
// não tem sessão. Proteções: código de 8 chars (~10^12), uso único,
// expiração de 15 min e trava por IP contra varredura.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { jsonResponse, preflight } from "../_shared/http.ts";
import { sha256Hex } from "../_shared/deviceGate.ts";
import { generateDeviceToken, normalizeEnrollCode } from "../_shared/deviceCodes.ts";

const GENERIC_ERROR = "Código inválido ou expirado";
const LOCKED_ERROR = "Muitas tentativas. Aguarde alguns minutos.";
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;
const DECAY_MS = 30 * 60_000;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse(req, { error: "method_not_allowed" }, 405);

  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, { error: "corpo inválido" }, 400);
  }
  const code = normalizeEnrollCode(String(body.code ?? ""));
  if (code.length !== 8) return jsonResponse(req, { error: GENERIC_ERROR }, 400);

  const adminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const nowMs = Date.now();

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
  const ipHash = await sha256Hex(`ip:${ip}`);

  const { data: attempts } = await adminClient
    .from("fa_kiosk_device_enroll_attempts")
    .select("failed_count, last_failed_ms, locked_until_ms")
    .eq("ip_hash", ipHash)
    .maybeSingle();
  if (attempts?.locked_until_ms && attempts.locked_until_ms > nowMs) {
    return jsonResponse(req, { error: LOCKED_ERROR }, 429);
  }
  const decayed = attempts?.last_failed_ms != null && nowMs - attempts.last_failed_ms > DECAY_MS;
  const previous = decayed ? 0 : (attempts?.failed_count ?? 0);

  async function fail(): Promise<Response> {
    const failed = previous + 1;
    await adminClient.from("fa_kiosk_device_enroll_attempts").upsert(
      {
        ip_hash: ipHash,
        failed_count: failed,
        last_failed_ms: nowMs,
        locked_until_ms: failed >= LOCK_AFTER ? nowMs + LOCK_MS : null,
      },
      { onConflict: "ip_hash" },
    );
    return jsonResponse(req, { error: failed >= LOCK_AFTER ? LOCKED_ERROR : GENERIC_ERROR }, failed >= LOCK_AFTER ? 429 : 401);
  }

  const codeHash = await sha256Hex(`enroll:${code}`);

  // Consumo atômico: só um UPDATE ... WHERE used_at_ms IS NULL vence a corrida.
  const { data: claimed } = await adminClient
    .from("fa_kiosk_device_enroll_codes")
    .update({ used_at_ms: nowMs })
    .eq("code_hash", codeHash)
    .is("used_at_ms", null)
    .gt("expires_at_ms", nowMs)
    .select("unit_id, label, created_by_employee_id")
    .maybeSingle();
  if (!claimed) return await fail();

  const token = generateDeviceToken();
  const { data: device, error: deviceError } = await adminClient
    .from("fa_kiosk_devices")
    .insert({
      unit_id: claimed.unit_id,
      label: claimed.label,
      token_hash: await sha256Hex(token),
      created_by_employee_id: claimed.created_by_employee_id,
      last_seen_ms: nowMs,
    })
    .select("id")
    .single();
  if (deviceError || !device) {
    // Devolve o código para o Owner poder tentar de novo.
    await adminClient.from("fa_kiosk_device_enroll_codes").update({ used_at_ms: null }).eq("code_hash", codeHash);
    return jsonResponse(req, { error: "não foi possível ativar o aparelho" }, 500);
  }

  await adminClient.from("fa_kiosk_device_enroll_codes").update({ device_id: device.id }).eq("code_hash", codeHash);
  await adminClient.from("fa_kiosk_device_enroll_attempts").delete().eq("ip_hash", ipHash);
  await adminClient.from("fa_kiosk_audit_log").insert({
    employee_id: claimed.created_by_employee_id,
    action: "DEVICE_ENROLLED",
    severity: "INFO",
    device_id: device.id,
    details_json: { unit_id: claimed.unit_id, label: claimed.label },
  });

  return jsonResponse(req, { token, deviceId: device.id, unitId: claimed.unit_id, label: claimed.label });
});
