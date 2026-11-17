// Ponte entre a aba "Avaliações" do PDV e a API da clínica (avaliação no playground).
//
// Uma função só, com `action` no corpo: today, arrive, leave, entries, conclude,
// transcribe (chamadas pelo tablet/PDV com o JWT do usuário) e flush (chamada
// só pelo pg_cron, sem JWT, como as demais funções de cron deste projeto).
//
// verify_jwt = false (config.toml) + requireCapability próprio, igual a
// session-report-dispatch: a autorização é decidida por fa_kiosk_can no banco.
//   today                     -> avaliacao_playground.write OU .presenca
//   arrive, leave             -> avaliacao_playground.presenca (caixa)
//   entries, conclude, transcribe -> avaliacao_playground.write (terapeuta)
//
// Regras que não dependem do cliente:
//  - A UNIDADE vem do cadastro do usuário autenticado (resolveUnit), nunca do corpo.
//  - O AUTOR de entries/conclude é conferido no banco: colaborador ativo, com
//    setor e vinculado à unidade; nome e especialidade vêm do banco.
//  - Chegou/Saiu usam o colaborador autenticado (o caixa), do banco.
//  - `savedAt`/`at` do tablet são limitados ao relógio do servidor (+5 min).
//  - Rede/5xx/timeout em arrive, leave, entries e conclude: a requisição já
//    montada é CIFRADA (envelope RSA-OAEP + AES-GCM, chave pública da clínica) e fica na fila
//    fa_kiosk_playground_eval_outbox. O PDV não consegue ler o que está na fila.
//    A ação `flush` reenvia com backoff exponencial.
//  - A transcrição NÃO entra na fila.
//
// Configuração: CLINIC_URL, CLINIC_BRIDGE_SECRET, PLAYGROUND_BRIDGE_PUBLIC_KEY. Vêm do
// Vault do banco (fa_playground_bridge_config) e, se não houver valor lá, dos secrets
// da função.
//
// Fila cifrada: envelope híbrido RSA-OAEP + AES-GCM (WebCrypto) com a chave pública
// da clínica (SPKI em PLAYGROUND_BRIDGE_PUBLIC_KEY). Só o envelope e a ação ficam em
// claro na fila. O reenvio é POST ${CLINIC_URL}/api/playground/replay com { sealed },
// assinado como as demais; a clínica decifra, executa e devolve a resposta da ação.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { jsonResponse, preflight } from "../_shared/http.ts";
import { requireCapability } from "../_shared/requireCapability.ts";
import {
  BACKOFF_CAP_MS,
  BRIDGE_SIGNATURE_HEADER,
  BRIDGE_TIMESTAMP_HEADER,
  MAX_AUDIO_BASE64_CHARS,
  MAX_FLUSH_ATTEMPTS,
  backoffMs,
  batchIdempotencyKey,
  classifyClinicStatus,
  clampClientInstant,
  friendlyErrorMessage,
  isValidId,
  resolveUnit,
  parseSpkiPublicKey,
  sealEnvelope,
  sealedPlaintext,
  sectorLabel,
  signBridgeBody,
  validateEntries,
} from "../_shared/playgroundBridge.ts";

const CALL_TIMEOUT_MS = 10_000;
const TRANSCRIBE_TIMEOUT_MS = 30_000;
const FLUSH_BATCH = 20;

type Action = "today" | "arrive" | "leave" | "entries" | "conclude" | "transcribe" | "flush";
const ACTIONS: readonly Action[] = ["today", "arrive", "leave", "entries", "conclude", "transcribe", "flush"];

type Admin = SupabaseClient;

interface Caller {
  employeeId: string;
  fullName: string;
  role: string;
  unitId: string;
}

interface ClinicResult {
  status: number; // 0 = rede/timeout
  json: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------
// Configuração (CLINIC_URL, CLINIC_BRIDGE_SECRET, PLAYGROUND_BRIDGE_PUBLIC_KEY)
// ---------------------------------------------------------------------

const CONFIG_TTL_MS = 60_000;
const configCache = new Map<string, { value: string; at: number }>();
let serviceClient: SupabaseClient | null = null;

/**
 * Lê a configuração da ponte. Primeiro o Vault do banco, pela RPC
 * fa_playground_bridge_config (só a service role executa); se não houver valor lá,
 * a variável de ambiente da função. O Vault vem primeiro para que um valor antigo
 * esquecido nos secrets da função nunca sobreponha o vigente. Cache curto: trocar
 * o segredo vale em até 1 minuto.
 */
async function getConfig(name: string): Promise<string | null> {
  const hit = configCache.get(name);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.value;
  serviceClient ??= createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await serviceClient.rpc("fa_playground_bridge_config", { p_name: name });
  if (error) console.error("[playground-bridge] config do Vault falhou", name, error.message);
  const value = typeof data === "string" && data.length > 0 ? data : (Deno.env.get(name) ?? null);
  if (value) configCache.set(name, { value, at: Date.now() });
  return value;
}

// ---------------------------------------------------------------------
// Clínica
// ---------------------------------------------------------------------

async function callClinic(path: string, body: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<ClinicResult> {
  const base = ((await getConfig("CLINIC_URL")) ?? "").replace(/\/+$/, "");
  const secret = await getConfig("CLINIC_BRIDGE_SECRET");
  if (!base || !secret) {
    console.error("[playground-bridge] CLINIC_URL/CLINIC_BRIDGE_SECRET não configurados");
    return { status: 0, json: null };
  }
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const signature = await signBridgeBody(secret, ts, raw);
  try {
    const res = await fetch(`${base}/api/playground/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [BRIDGE_TIMESTAMP_HEADER]: String(ts),
        [BRIDGE_SIGNATURE_HEADER]: signature,
      },
      body: raw,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json };
  } catch (e) {
    console.error("[playground-bridge] falha de rede ao chamar a clínica", e instanceof Error ? e.message : e);
    return { status: 0, json: null };
  }
}

const clinicCode = (r: ClinicResult): string | null => (typeof r.json?.code === "string" ? (r.json.code as string) : null);

// ---------------------------------------------------------------------
// Banco
// ---------------------------------------------------------------------

async function recordReceipt(
  admin: Admin,
  r: {
    unitId: string; visitId: string; kind: string; evaluatorEmployeeId: string | null;
    deviceId: string | null; status: "SENT" | "FAILED"; error?: string | null;
  },
) {
  const { error } = await admin.from("fa_kiosk_playground_eval_receipts").insert({
    unit_id: r.unitId,
    clinic_visit_id: r.visitId,
    kind: r.kind,
    evaluator_employee_id: r.evaluatorEmployeeId,
    device_id: r.deviceId,
    status: r.status,
    error: r.error ?? null,
    sent_at_ms: Date.now(),
  });
  if (error) console.error("[playground-bridge] receipt falhou", error.message);
}

async function resolveCaller(admin: Admin, authUserId: string, requestedUnitId: unknown): Promise<Caller | { error: string }> {
  const { data: emp } = await admin
    .from("fa_kiosk_employees")
    .select("id, full_name, role, active")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (!emp || emp.active !== true) return { error: "Usuário inativo." };

  const { data: links } = await admin.from("fa_kiosk_employee_units").select("unit_id").eq("employee_id", emp.id);
  const assigned = (links ?? []).map((l) => l.unit_id as string);

  let known: string[] = [];
  if (assigned.length === 0 && typeof requestedUnitId === "string") {
    const { data: units } = await admin.from("fa_kiosk_units").select("id").eq("id", requestedUnitId);
    known = (units ?? []).map((u) => u.id as string);
  }
  const unit = resolveUnit({ assignedUnitIds: assigned, requestedUnitId, role: emp.role as string, knownUnitIds: known });
  if (!unit.ok) return { error: unit.error };
  return { employeeId: emp.id as string, fullName: emp.full_name as string, role: emp.role as string, unitId: unit.unitId };
}

interface Therapist {
  id: string;
  name: string;
  specialty: string;
}

/** Colaboradores ativos, com setor, vinculados à unidade. */
async function listTherapists(admin: Admin, unitId: string): Promise<Therapist[]> {
  const { data: links } = await admin.from("fa_kiosk_employee_units").select("employee_id").eq("unit_id", unitId);
  const ids = (links ?? []).map((l) => l.employee_id as string);
  if (ids.length === 0) return [];
  const { data: emps } = await admin
    .from("fa_kiosk_employees")
    .select("id, full_name, sector")
    .in("id", ids)
    .eq("active", true)
    .not("sector", "is", null)
    .order("full_name", { ascending: true });
  const out: Therapist[] = [];
  for (const e of emps ?? []) {
    const label = sectorLabel(e.sector as string);
    if (label) out.push({ id: e.id as string, name: e.full_name as string, specialty: label });
  }
  return out;
}

/** Confere o autor escolhido no tablet: nome e especialidade vêm do banco. */
async function resolveAuthor(admin: Admin, unitId: string, authorEmployeeId: unknown): Promise<Therapist | null> {
  if (!isValidId(authorEmployeeId)) return null;
  return (await listTherapists(admin, unitId)).find((t) => t.id === authorEmployeeId) ?? null;
}

// ---------------------------------------------------------------------
// Fila cifrada
// ---------------------------------------------------------------------

async function seal(plaintext: string): Promise<string | null> {
  const pk = parseSpkiPublicKey(await getConfig("PLAYGROUND_BRIDGE_PUBLIC_KEY"));
  if (!pk) {
    console.error("[playground-bridge] PLAYGROUND_BRIDGE_PUBLIC_KEY ausente ou inválida");
    return null;
  }
  try {
    return await sealEnvelope(plaintext, pk);
  } catch (e) {
    console.error("[playground-bridge] falha ao cifrar", e instanceof Error ? e.message : e);
    return null;
  }
}

interface Sendable {
  path: "visit" | "entries" | "conclude";
  /** Corpo exato que a clínica espera nesse caminho. */
  body: Record<string, unknown>;
  idempotencyKey: string;
  kind: "arrive" | "leave" | "entries" | "conclude";
  visitId: string;
  evaluatorEmployeeId: string;
  deviceId: string | null;
}

/** Envia na hora; se a clínica estiver fora, cifra e enfileira. */
async function sendOrQueue(req: Request, admin: Admin, caller: Caller, s: Sendable): Promise<Response> {
  const res = await callClinic(s.path, s.body);
  const outcome = classifyClinicStatus(res.status);

  if (outcome === "ok") {
    await recordReceipt(admin, {
      unitId: caller.unitId, visitId: s.visitId, kind: s.kind, evaluatorEmployeeId: s.evaluatorEmployeeId,
      deviceId: s.deviceId, status: "SENT",
    });
    return jsonResponse(req, { ...(res.json ?? {}), ok: true });
  }

  if (outcome === "permanent") {
    const code = clinicCode(res) ?? "bad_request";
    await recordReceipt(admin, {
      unitId: caller.unitId, visitId: s.visitId, kind: s.kind, evaluatorEmployeeId: s.evaluatorEmployeeId,
      deviceId: s.deviceId, status: "FAILED", error: `${code}: ${String(res.json?.error ?? "").slice(0, 300)}`,
    });
    return jsonResponse(req, { ok: false, code, error: friendlyErrorMessage(code) }, res.status >= 400 && res.status < 500 ? res.status : 400);
  }

  // Transitório: guarda cifrado e devolve "salvo".
  const sealed = await seal(sealedPlaintext(s.path, s.body));
  if (!sealed) {
    return jsonResponse(req, { ok: false, code: "unavailable", error: "Sem conexão: tente de novo em instantes." }, 503);
  }
  const { error } = await admin.from("fa_kiosk_playground_eval_outbox").upsert(
    {
      unit_id: caller.unitId,
      action: s.kind,
      payload_sealed: sealed,
      idempotency_key: s.idempotencyKey,
      attempts: 0,
      next_attempt_at_ms: Date.now() + backoffMs(0),
      last_error: res.status === 0 ? "sem conexão" : `HTTP ${res.status}`,
      created_at_ms: Date.now(),
    },
    { onConflict: "idempotency_key", ignoreDuplicates: true },
  );
  if (error) {
    console.error("[playground-bridge] enfileirar falhou", error.message);
    return jsonResponse(req, { ok: false, code: "unavailable", error: "Sem conexão: tente de novo em instantes." }, 503);
  }
  return jsonResponse(req, { ok: true, queued: true });
}

// ---------------------------------------------------------------------
// Flush (pg_cron, a cada 5 min)
// ---------------------------------------------------------------------

async function handleFlush(req: Request, admin: Admin): Promise<Response> {
  const now = Date.now();
  const { data: due } = await admin
    .from("fa_kiosk_playground_eval_outbox")
    .select("id, unit_id, action, payload_sealed, idempotency_key, attempts, next_attempt_at_ms")
    .lte("next_attempt_at_ms", now)
    .order("created_at_ms", { ascending: true })
    .limit(FLUSH_BATCH);

  let sent = 0;
  let failed = 0;
  let retry = 0;

  for (const row of due ?? []) {
    // Reserva a linha (outra execução do cron não pega a mesma): só adianta o próximo horário.
    const { data: claimed } = await admin
      .from("fa_kiosk_playground_eval_outbox")
      .update({ next_attempt_at_ms: now + BACKOFF_CAP_MS })
      .eq("id", row.id)
      .eq("next_attempt_at_ms", row.next_attempt_at_ms)
      .select("id");
    if (!claimed || claimed.length === 0) continue;

    const res = await callClinic("replay", { sealed: row.payload_sealed });
    const outcome = classifyClinicStatus(res.status);
    const receipt = {
      unitId: row.unit_id as string,
      visitId: "", // a fila guarda só o envelope e a ação: sem visita nem autor em claro
      kind: row.action as string,
      evaluatorEmployeeId: null,
      deviceId: null,
    };

    if (outcome === "ok") {
      // Em lote, a clínica pode recusar entradas (rejected[]): se NADA foi aceito, é falha com motivo.
      const accepted = Number(res.json?.accepted ?? 0) + Number(res.json?.duplicates ?? 0);
      const rejected = Array.isArray(res.json?.rejected) ? (res.json!.rejected as Array<{ code?: string }>) : [];
      const allRejected = row.action === "entries" && accepted === 0 && rejected.length > 0;
      await admin.from("fa_kiosk_playground_eval_outbox").delete().eq("id", row.id);
      if (allRejected) {
        failed++;
        await recordReceipt(admin, { ...receipt, status: "FAILED", error: `${rejected[0]?.code ?? "rejeitado"}: itens recusados` });
      } else {
        sent++;
        await recordReceipt(admin, { ...receipt, status: "SENT" });
      }
    } else if (outcome === "permanent") {
      failed++;
      await admin.from("fa_kiosk_playground_eval_outbox").delete().eq("id", row.id);
      await recordReceipt(admin, {
        ...receipt, status: "FAILED", error: `${clinicCode(res) ?? "recusado"}: ${String(res.json?.error ?? "").slice(0, 300)}`,
      });
    } else {
      const attempts = Number(row.attempts) + 1;
      const reason = res.status === 0 ? "sem conexão" : `HTTP ${res.status}`;
      if (attempts >= MAX_FLUSH_ATTEMPTS) {
        failed++;
        await admin.from("fa_kiosk_playground_eval_outbox").delete().eq("id", row.id);
        await recordReceipt(admin, { ...receipt, status: "FAILED", error: `tempo esgotado após ${attempts} tentativas (${reason})` });
      } else {
        retry++;
        await admin
          .from("fa_kiosk_playground_eval_outbox")
          .update({ attempts, next_attempt_at_ms: Date.now() + backoffMs(attempts), last_error: reason })
          .eq("id", row.id);
      }
    }
  }
  return jsonResponse(req, { ok: true, processed: (due ?? []).length, sent, failed, retry });
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

const err = (req: Request, status: number, code: string, message: string) =>
  jsonResponse(req, { ok: false, code, error: message }, status);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse(req, { error: "method_not_allowed" }, 405);

  let input: Record<string, unknown>;
  try {
    input = (await req.json()) as Record<string, unknown>;
  } catch {
    return err(req, 400, "bad_request", "Corpo inválido.");
  }
  const action = input.action as Action;
  if (!ACTIONS.includes(action)) return err(req, 400, "bad_request", "Ação inválida.");

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Cron: sem JWT. Só reenvia o que já está na fila; rodar a mais não duplica nada
  // (idempotencyKey) e o próprio backoff segura as tentativas.
  if (action === "flush") return handleFlush(req, admin);

  // Autorização por capacidade (fa_kiosk_can no banco).
  let auth = await requireCapability(
    req,
    action === "arrive" || action === "leave" ? "avaliacao_playground.presenca" : "avaliacao_playground.write",
  );
  if (!auth.ok && action === "today") auth = await requireCapability(req, "avaliacao_playground.presenca");
  if (!auth.ok) return auth.response;

  const caller = await resolveCaller(admin, auth.userId, input.unitId);
  if ("error" in caller) return err(req, 403, "forbidden", caller.error);

  const nowMs = Date.now();
  const deviceId = typeof input.deviceId === "string" ? input.deviceId.slice(0, 80) : null;

  switch (action) {
    case "today": {
      const res = await callClinic("today", { posUnitId: caller.unitId });
      if (classifyClinicStatus(res.status) !== "ok") {
        return err(req, 503, "unavailable", "Sem conexão: mostrando a última lista carregada.");
      }
      const therapists = await listTherapists(admin, caller.unitId);
      return jsonResponse(req, { ...(res.json ?? {}), ok: true, therapists });
    }

    case "arrive":
    case "leave": {
      if (!isValidId(input.visitId)) return err(req, 400, "bad_request", "Visita inválida.");
      const visitId = input.visitId;
      const at = clampClientInstant(input.at, nowMs);
      const idempotencyKey = `${action}:${visitId}`;
      return sendOrQueue(req, admin, caller, {
        path: "visit",
        body: { posUnitId: caller.unitId, visitId, action, employeeId: caller.employeeId, employeeName: caller.fullName, at, idempotencyKey },
        idempotencyKey,
        kind: action,
        visitId,
        evaluatorEmployeeId: caller.employeeId,
        deviceId,
      });
    }

    case "entries": {
      if (!isValidId(input.visitId)) return err(req, 400, "bad_request", "Visita inválida.");
      const author = await resolveAuthor(admin, caller.unitId, input.authorEmployeeId);
      if (!author) return err(req, 400, "bad_request", "Escolha quem está avaliando.");
      const v = validateEntries(input.entries, nowMs);
      if (!v.ok) return err(req, 400, "bad_request", v.error);
      const visitId = input.visitId;
      const entries = v.entries.map((e) =>
        e.kind === "item"
          ? { idempotencyKey: e.idempotencyKey, kind: "item", itemId: e.itemId, score: e.score, savedAt: e.savedAt }
          : { idempotencyKey: e.idempotencyKey, kind: "evolution", text: e.text, savedAt: e.savedAt },
      );
      return sendOrQueue(req, admin, caller, {
        path: "entries",
        body: {
          posUnitId: caller.unitId,
          visitId,
          deviceId: deviceId ?? "pdv",
          author: { employeeId: author.id, name: author.name, specialty: author.specialty },
          entries,
        },
        idempotencyKey: await batchIdempotencyKey(visitId, entries.map((e) => e.idempotencyKey)),
        kind: "entries",
        visitId,
        evaluatorEmployeeId: author.id,
        deviceId,
      });
    }

    case "conclude": {
      if (!isValidId(input.visitId)) return err(req, 400, "bad_request", "Visita inválida.");
      const author = await resolveAuthor(admin, caller.unitId, input.authorEmployeeId);
      if (!author) return err(req, 400, "bad_request", "Escolha quem está avaliando.");
      const visitId = input.visitId;
      const idempotencyKey = `conclude:${visitId}`;
      return sendOrQueue(req, admin, caller, {
        path: "conclude",
        body: {
          posUnitId: caller.unitId,
          visitId,
          deviceId: deviceId ?? "pdv",
          author: { employeeId: author.id, name: author.name, specialty: author.specialty },
          savedAt: clampClientInstant(input.savedAt, nowMs),
          idempotencyKey,
        },
        idempotencyKey,
        kind: "conclude",
        visitId,
        evaluatorEmployeeId: author.id,
        deviceId,
      });
    }

    case "transcribe": {
      const audio = input.audioBase64;
      const mime = typeof input.mimeType === "string" ? input.mimeType.slice(0, 60) : "audio/webm";
      if (typeof audio !== "string" || audio.length === 0 || audio.length > MAX_AUDIO_BASE64_CHARS) {
        return err(req, 400, "bad_request", "Áudio longo demais ou vazio: grave de novo (até 1 minuto) ou digite a evolução.");
      }
      // Sem fila: se a clínica estiver fora, o terapeuta digita.
      const res = await callClinic("transcribe", { audioBase64: audio, mimeType: mime }, TRANSCRIBE_TIMEOUT_MS);
      if (classifyClinicStatus(res.status) === "ok" && typeof res.json?.text === "string") {
        return jsonResponse(req, { ok: true, text: res.json.text });
      }
      return err(req, 503, "unavailable", "Transcrição indisponível agora: digite a evolução.");
    }
  }
  return err(req, 400, "bad_request", "Ação inválida.");
});
