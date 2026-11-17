// Gestão de aparelhos pelo Owner (capacidade dispositivos.manage).
// Ações: create_code, list, revoke, rename.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { jsonResponse, preflight } from "../_shared/http.ts";
import { requireCapability } from "../_shared/requireCapability.ts";
import { sha256Hex } from "../_shared/deviceGate.ts";
import { ENROLL_CODE_TTL_MS, generateEnrollCode } from "../_shared/deviceCodes.ts";

interface Body {
  action: "create_code" | "list" | "revoke" | "rename";
  unitId?: string;
  label?: string;
  deviceId?: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse(req, { error: "method_not_allowed" }, 405);

  const guard = await requireCapability(req, "dispositivos.manage");
  if (!guard.ok) return guard.response;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, { error: "corpo inválido" }, 400);
  }

  const adminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: me } = await adminClient
    .from("fa_kiosk_employees")
    .select("id")
    .eq("auth_user_id", guard.userId)
    .maybeSingle();
  const myEmployeeId: string | null = me?.id ?? null;
  const nowMs = Date.now();
  const label = String(body.label ?? "").trim().slice(0, 60);

  switch (body.action) {
    case "create_code": {
      if (!body.unitId || !label) return jsonResponse(req, { error: "unitId e nome são obrigatórios" }, 400);
      const code = generateEnrollCode();
      const expiresAtMs = nowMs + ENROLL_CODE_TTL_MS;
      const { error } = await adminClient.from("fa_kiosk_device_enroll_codes").insert({
        code_hash: await sha256Hex(`enroll:${code}`),
        unit_id: body.unitId,
        label,
        created_by_employee_id: myEmployeeId,
        expires_at_ms: expiresAtMs,
      });
      if (error) return jsonResponse(req, { error: "não foi possível gerar o código" }, 500);
      // O código em texto só existe nesta resposta.
      return jsonResponse(req, { code, expiresAtMs });
    }
    case "list": {
      const { data, error } = await adminClient
        .from("fa_kiosk_devices")
        .select("id, unit_id, label, created_at_ms, last_seen_ms, revoked_at_ms")
        .order("created_at_ms", { ascending: false });
      if (error) return jsonResponse(req, { error: "não foi possível listar" }, 500);
      return jsonResponse(req, { devices: data ?? [] });
    }
    case "revoke": {
      if (!body.deviceId) return jsonResponse(req, { error: "deviceId obrigatório" }, 400);
      const { error } = await adminClient
        .from("fa_kiosk_devices")
        .update({ revoked_at_ms: nowMs, revoked_by_employee_id: myEmployeeId })
        .eq("id", body.deviceId)
        .is("revoked_at_ms", null);
      if (error) return jsonResponse(req, { error: "não foi possível revogar" }, 500);
      await adminClient.from("fa_kiosk_audit_log").insert({
        employee_id: myEmployeeId,
        action: "DEVICE_REVOKED",
        severity: "ALERTA",
        device_id: body.deviceId,
      });
      return jsonResponse(req, { ok: true });
    }
    case "rename": {
      if (!body.deviceId || !label) return jsonResponse(req, { error: "deviceId e nome obrigatórios" }, 400);
      const { error } = await adminClient.from("fa_kiosk_devices").update({ label }).eq("id", body.deviceId);
      if (error) return jsonResponse(req, { error: "não foi possível renomear" }, 500);
      return jsonResponse(req, { ok: true });
    }
    default:
      return jsonResponse(req, { error: "ação inválida" }, 400);
  }
});
