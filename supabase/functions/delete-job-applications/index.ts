import { createClient } from "jsr:@supabase/supabase-js@2";
import { jsonResponse, preflight } from "../_shared/http.ts";

// Exclusão definitiva de candidaturas do Banco de Talentos (registro + currículo
// no bucket privado `curriculos`). Chamada servidor-a-servidor pela Edge
// Function `purge-talent-candidates` do projeto controle-de-estagiario, depois
// que ela revalidou elegibilidade e proteções (arquivado há 7 dias, DISC sem
// resposta há 10 dias, duplicado mesclado ou exclusão manual do gestor).
//
// Diferente do export-job-applications, FALHA FECHADO: sem TALENT_API_KEY
// configurada, nada é apagado — ação destrutiva nunca fica aberta por falta
// de configuração.
//
// Body: { ids: string[] }  (máx. 100)
// Resposta: { deleted: string[], failed: { id, why }[] }

const MAX_IDS = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Método HTTP não suportado" }, 405);
  }

  const expectedKey = Deno.env.get("TALENT_API_KEY");
  if (!expectedKey) {
    console.error("[delete-job-applications] TALENT_API_KEY não configurada — recusando");
    return jsonResponse(req, { error: "TALENT_API_KEY_MISSING" }, 503);
  }
  if (!(await constantTimeEqual(req.headers.get("x-api-key") ?? "", expectedKey))) {
    return jsonResponse(req, { error: "Acesso não autorizado: API Key inválida" }, 401);
  }

  let body: { ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, { error: "Corpo JSON inválido" }, 400);
  }

  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((v) => String(v).trim()))];
  if (ids.length === 0 || ids.length > MAX_IDS || ids.some((id) => !UUID_RE.test(id))) {
    return jsonResponse(req, { error: `Informe de 1 a ${MAX_IDS} ids (uuid)` }, 400);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: rows, error: readError } = await admin
    .from("fa_kiosk_job_applications")
    .select("id, resume_path")
    .in("id", ids);
  if (readError) {
    console.error("[delete-job-applications] Erro ao ler candidaturas:", readError);
    return jsonResponse(req, { error: "Falha ao ler candidaturas" }, 500);
  }

  const found = new Map((rows ?? []).map((r) => [r.id as string, r.resume_path as string | null]));
  const deleted: string[] = [];
  const failed: { id: string; why: string }[] = [];

  // Já inexistente = objetivo atingido (idempotente: retry após falha parcial).
  for (const id of ids) if (!found.has(id)) deleted.push(id);

  const present = ids.filter((id) => found.has(id));
  if (present.length > 0) {
    // 1) Currículo primeiro: se o arquivo não sair, a linha fica e dá para tentar de novo
    //    (o contrário deixaria um PDF com dados pessoais órfão e inalcançável).
    const paths = present.map((id) => found.get(id)).filter((p): p is string => Boolean(p));
    if (paths.length > 0) {
      const { error: rmError } = await admin.storage.from("curriculos").remove(paths);
      if (rmError) {
        console.error("[delete-job-applications] Erro ao remover currículos:", rmError);
        present.forEach((id) => failed.push({ id, why: "storage_remove_failed" }));
        return jsonResponse(req, { deleted, failed });
      }
    }

    // 2) Linha da candidatura.
    const { data: removed, error: delError } = await admin
      .from("fa_kiosk_job_applications")
      .delete()
      .in("id", present)
      .select("id");
    if (delError) {
      console.error("[delete-job-applications] Erro ao apagar candidaturas:", delError);
      present.forEach((id) => failed.push({ id, why: "delete_failed" }));
    } else {
      const gone = new Set((removed ?? []).map((r) => r.id as string));
      present.forEach((id) => (gone.has(id) ? deleted.push(id) : failed.push({ id, why: "not_deleted" })));
    }
  }

  console.log(`[delete-job-applications] deleted=${deleted.length} failed=${failed.length}`);
  return jsonResponse(req, { deleted, failed });
});

/** Compara em tempo constante (hash SHA-256 dos dois lados iguala o tamanho). */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}
