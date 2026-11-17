// Lista de colaboradores para a TELA DE LOGIN — o único dado que precisa
// ser legível antes de existir sessão (é preciso escolher quem vai digitar
// o PIN).
//
// Por que uma Edge Function e não um SELECT direto: com o RLS corrigido
// (migration 20260807000003) `fa_kiosk_employees` só é legível por
// `authenticated`, e é bom que seja — a tabela tem CPF, PIS, data de
// admissão e cargo. Aqui devolvemos exclusivamente `id` e `full_name` de
// quem está ativo.
//
// O que fica DE FORA, e o motivo: o `role`. Antes, a lista entregava o papel
// de cada um, então quem quisesse atacar o PIN escolhia direto o Owner. Sem
// o papel, um ataque de força bruta não sabe qual dos nomes vale a pena — o
// que, somado à trava por employee_id de login-pin, é o que torna a varredura
// inviável na prática.
//
// A enumeração de NOMES continua possível para quem alcançar a função; é o
// mínimo irredutível de um login em que se escolhe a pessoa numa lista.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { jsonResponse, preflight } from "../_shared/http.ts";
import { requireDevice } from "../_shared/deviceGate.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse(req, { error: "method_not_allowed" }, 405);
  }

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const device = await requireDevice(req, adminClient, "list-employees");
  if (!device.ok) return device.response;

  const { data, error } = await adminClient
    .from("fa_kiosk_employees")
    .select("id, full_name")
    .eq("active", true)
    .order("full_name");

  if (error) return jsonResponse(req, { error: "não foi possível carregar a lista" }, 500);

  return jsonResponse(req, { employees: data ?? [] });
});
