// Diz a um aparelho ativado a que unidade ele está vinculado (nome do
// aparelho, unidade e id). Só responde a quem apresenta um token de aparelho
// válido (header x-device-token); sem token válido devolve { device: null }.
// Não faz parte do portão de login: é só informativa, para o operador
// conferir no próprio aparelho com a lista do Owner (Gerencial > Aparelhos).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { jsonResponse, preflight } from "../_shared/http.ts";
import { sha256Hex } from "../_shared/deviceGate.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse(req, { error: "method_not_allowed" }, 405);
  }

  const token = req.headers.get("x-device-token")?.trim() ?? "";
  if (token.length < 32 || token.length > 128) return jsonResponse(req, { device: null });

  const adminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: device } = await adminClient
    .from("fa_kiosk_devices")
    .select("id, label, unit_id")
    .eq("token_hash", await sha256Hex(token))
    .is("revoked_at_ms", null)
    .maybeSingle();
  if (!device) return jsonResponse(req, { device: null });

  const { data: unit } = await adminClient.from("fa_kiosk_units").select("name").eq("id", device.unit_id).maybeSingle();

  return jsonResponse(req, {
    device: { id: device.id, label: device.label, unitId: device.unit_id, unitName: unit?.name ?? null },
  });
});
