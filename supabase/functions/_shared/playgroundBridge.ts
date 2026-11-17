// Regras PURAS da ponte PDV -> clínica da Avaliação no playground.
//
// Fica separado de playground-eval-bridge/index.ts de propósito: aqui não há
// Deno.*, jsr: nem npm:, só WebCrypto (crypto.subtle, que o Node 22 também
// tem). Assim o vitest do repositório (CI: `pnpm --filter @facaamigos/domain test`)
// consegue testar a assinatura, a escolha transitório x definitivo, o backoff,
// o carimbo de horário e a resolução da unidade, sem precisar de Deno.
//
// Contrato com a clínica: docs/playground-bridge-contract.md do repositório da
// clínica (lib/playground/bridge-auth.ts é a referência da assinatura).

import { EMPLOYEE_SECTOR_OPTION_LABEL, type EmployeeSectorOption } from "./sessionReportCatalog.ts";

export const BRIDGE_TIMESTAMP_HEADER = "x-fa-bridge-timestamp";
export const BRIDGE_SIGNATURE_HEADER = "x-fa-bridge-signature";

/** Quanto o relógio do tablet pode estar à frente do servidor antes de ser ignorado. */
export const MAX_CLIENT_CLOCK_AHEAD_MS = 5 * 60_000;
/** Tamanho máximo do áudio em base64 (cerca de 60 s com folga). Igual ao da clínica. */
export const MAX_AUDIO_BASE64_CHARS = 1_572_864;
export const MAX_ENTRIES_PER_BATCH = 50;
export const MAX_EVOLUTION_CHARS = 4000;

/** Backoff do reenvio: 1 min, 2, 4, ... até 60 min. */
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_CAP_MS = 60 * 60_000;
/** Depois de tantas tentativas o item vira FAILED (com o motivo) em vez de tentar para sempre. */
export const MAX_FLUSH_ATTEMPTS = 30;

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 hex de `${timestamp}.${corpoBruto}` (mesmo formato de signBridgeBody da clínica). */
export async function signBridgeBody(secret: string, timestampSeconds: number, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestampSeconds}.${rawBody}`));
  return toHex(sig);
}

/** SHA-256 hex de um texto (chave de idempotência de lote). */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** Chave estável de um lote: o mesmo conjunto de entradas gera sempre a mesma chave, em qualquer ordem. */
export async function batchIdempotencyKey(visitId: string, entryKeys: readonly string[]): Promise<string> {
  const sorted = [...entryKeys].sort();
  return `entries:${visitId}:${(await sha256Hex(sorted.join("|"))).slice(0, 32)}`;
}

/**
 * Instante que o tablet diz ter acontecido, limitado pelo relógio do servidor:
 * inválido, ou mais de 5 min à frente, vira o "agora" do servidor. No passado
 * vale como veio (entrada que ficou na fila continua valendo; a janela do dia
 * é conferida pela clínica).
 */
export function clampClientInstant(clientIso: unknown, nowMs: number, maxAheadMs = MAX_CLIENT_CLOCK_AHEAD_MS): string {
  if (typeof clientIso !== "string") return new Date(nowMs).toISOString();
  const t = Date.parse(clientIso);
  if (!Number.isFinite(t) || t > nowMs + maxAheadMs) return new Date(nowMs).toISOString();
  return new Date(t).toISOString();
}

/**
 * 0 = falha de rede/timeout (não houve resposta HTTP).
 * Transitório = vale reenviar mais tarde: rede, timeout, 5xx, 408, 429 e 401
 * (401 é segredo/relógio desalinhado: erro de configuração que se corrige e
 * não deve jogar a avaliação fora). Qualquer outro 4xx é definitivo, como no
 * contrato: reenviar não adianta.
 */
export function isTransientStatus(status: number): boolean {
  if (!Number.isFinite(status) || status <= 0) return true;
  if (status >= 500) return true;
  return status === 408 || status === 429 || status === 401;
}

export type ClinicOutcome = "ok" | "transient" | "permanent";

export function classifyClinicStatus(status: number): ClinicOutcome {
  if (status >= 200 && status < 300) return "ok";
  return isTransientStatus(status) ? "transient" : "permanent";
}

/** Espera antes da próxima tentativa, dado quantas já foram feitas (1ª falha = 1 min). */
export function backoffMs(attempts: number): number {
  const n = Math.max(0, Math.floor(attempts));
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(n, 20));
}

/** Mensagens neutras (o terapeuta lê isto): dizem o que fazer e nunca falam em clínica/prontuário. */
const FRIENDLY: Record<string, string> = {
  bad_request: "Não foi possível salvar: confira os dados e tente de novo.",
  unauthorized: "Avaliação indisponível neste aparelho: avise o responsável pelo sistema.",
  not_found: "Esta visita não está mais disponível: atualize a lista.",
  day_closed: "O prazo desta avaliação terminou: ela não pode mais ser alterada.",
  not_arrived: "Marque a chegada da criança antes de avaliar.",
  series_closed: "Esta avaliação já foi concluída.",
  conflict: "Esta avaliação mudou: atualize a lista e tente de novo.",
};

export function friendlyErrorMessage(code: string | null | undefined): string {
  return (code && FRIENDLY[code]) || "Não foi possível salvar agora. Tente de novo.";
}

export function sectorLabel(sector: string | null | undefined): string | null {
  if (!sector) return null;
  return (EMPLOYEE_SECTOR_OPTION_LABEL as Record<string, string>)[sector as EmployeeSectorOption] ?? null;
}

/** Especialidades que o avaliador do tablet escolhe na lista. Igual a FREE_AUTHOR_SPECIALTIES do kiosk-ui (playgroundEval.ts). */
export const FREE_AUTHOR_SPECIALTIES = [
  "Psicólogo(a)",
  "Terapeuta Ocupacional",
  "Educador(a) Físico(a)",
  "Pedagogo(a)",
  "Fisioterapeuta",
  "Fonoaudiólogo(a)",
  "Outro",
] as const;

/**
 * Identidade digitada no tablet do avaliador: nome livre + especialidade da lista.
 * Devolve null se faltar algo ou se a especialidade não estiver na lista.
 */
export function parseFreeAuthor(raw: unknown): { name: string; specialty: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.specialty !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const name = r.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80) return null;
  if (!(FREE_AUTHOR_SPECIALTIES as readonly string[]).includes(r.specialty)) return null;
  return { name, specialty: r.specialty };
}

export type UnitResolution = { ok: true; unitId: string } | { ok: false; error: string };

/**
 * A unidade nasce do cadastro do usuário autenticado (fa_kiosk_employee_units),
 * não do texto do cliente:
 *  - 1 unidade vinculada: é ela, qualquer coisa que o cliente mande é ignorada;
 *  - várias: o cliente só ESCOLHE entre as vinculadas (a unidade que o operador
 *    selecionou na tela), e uma fora da lista é recusada;
 *  - nenhuma: só Líder/Owner, que já enxergam todas as unidades no app, podem
 *    escolher uma unidade existente (`knownUnitIds`); os demais são recusados.
 */
export function resolveUnit(args: {
  assignedUnitIds: readonly string[];
  requestedUnitId: unknown;
  role: string;
  knownUnitIds: readonly string[];
}): UnitResolution {
  const { assignedUnitIds, role, knownUnitIds } = args;
  const requested = typeof args.requestedUnitId === "string" ? args.requestedUnitId : null;
  if (assignedUnitIds.length === 1) return { ok: true, unitId: assignedUnitIds[0]! };
  if (assignedUnitIds.length > 1) {
    if (requested && assignedUnitIds.includes(requested)) return { ok: true, unitId: requested };
    return { ok: false, error: "Escolha a unidade da avaliação." };
  }
  if ((role === "GERENTE" || role === "ADMIN") && requested && knownUnitIds.includes(requested)) {
    return { ok: true, unitId: requested };
  }
  return { ok: false, error: "Este usuário não está vinculado a uma unidade: peça ao responsável para vinculá-lo." };
}

// ---------------------------------------------------------------------
// Validação das entradas vindas do tablet (nada daqui confia no cliente)
// ---------------------------------------------------------------------

export type EntryInput =
  | { idempotencyKey: string; kind: "item"; itemId: string; score: 0 | 1 | 2 | null; savedAt: string }
  | { idempotencyKey: string; kind: "evolution"; text: string; savedAt: string };

export type EntriesValidation = { ok: true; entries: EntryInput[] } | { ok: false; error: string };

const KEY_RE = /^[A-Za-z0-9_.:\-]{8,120}$/;
const ID_RE = /^[A-Za-z0-9_\-]{8,64}$/;

export function isValidId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

export function validateEntries(raw: unknown, nowMs: number): EntriesValidation {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "Nada para salvar." };
  if (raw.length > MAX_ENTRIES_PER_BATCH) return { ok: false, error: "Itens demais de uma vez: salve em partes." };
  const out: EntryInput[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return { ok: false, error: "Item inválido." };
    const e = r as Record<string, unknown>;
    if (typeof e.idempotencyKey !== "string" || !KEY_RE.test(e.idempotencyKey)) return { ok: false, error: "Item inválido." };
    const savedAt = clampClientInstant(e.savedAt, nowMs);
    if (e.kind === "item") {
      if (!isValidId(e.itemId)) return { ok: false, error: "Item inválido." };
      const score = e.score;
      if (score !== null && score !== 0 && score !== 1 && score !== 2) return { ok: false, error: "Resposta inválida." };
      out.push({ idempotencyKey: e.idempotencyKey, kind: "item", itemId: e.itemId, score, savedAt });
    } else if (e.kind === "evolution") {
      const text = typeof e.text === "string" ? e.text.trim() : "";
      if (!text) return { ok: false, error: "Escreva a evolução antes de salvar." };
      out.push({ idempotencyKey: e.idempotencyKey, kind: "evolution", text: text.slice(0, MAX_EVOLUTION_CHARS), savedAt });
    } else {
      return { ok: false, error: "Item inválido." };
    }
  }
  return { ok: true, entries: out };
}

// ---------------------------------------------------------------------
// Envelope cifrado da fila (RSA-OAEP + AES-GCM, WebCrypto)
// ---------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Chave pública RSA-2048 em SPKI: base64 do DER ou PEM. null se não decodificar. */
export function parseSpkiPublicKey(text: string | undefined | null): Uint8Array | null {
  const t = (text ?? "")
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!t) return null;
  try {
    const bin = atob(t.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Envelope "v1.<b64url(chave AES cifrada com RSA-OAEP/SHA-256)>.<b64url(iv)>.<b64url(ct||tag)>".
 * O PDV só tem a chave pública: não consegue abrir o que enfileira.
 */
export async function sealEnvelope(plaintext: string, spki: Uint8Array): Promise<string> {
  const rsa = await crypto.subtle.importKey("spki", spki, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, enc.encode(plaintext)));
  const rawKey = await crypto.subtle.exportKey("raw", aes);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, rawKey));
  return `v1.${b64url(wrapped)}.${b64url(iv)}.${b64url(ct)}`;
}

/** JSON que vai dentro do envelope: o corpo exato do contrato da ação (com posUnitId e savedAt/at originais). */
export function sealedPlaintext(action: "visit" | "entries" | "conclude", body: unknown): string {
  return JSON.stringify({ action, body });
}
