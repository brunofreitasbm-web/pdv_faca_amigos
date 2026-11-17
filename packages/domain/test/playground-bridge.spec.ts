import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FREE_AUTHOR_SPECIALTIES,
  parseFreeAuthor,
  BACKOFF_CAP_MS,
  backoffMs,
  batchIdempotencyKey,
  classifyClinicStatus,
  clampClientInstant,
  parseSpkiPublicKey,
  sealEnvelope,
  friendlyErrorMessage,
  isTransientStatus,
  resolveUnit,
  sealedPlaintext,
  sectorLabel,
  signBridgeBody,
  validateEntries,
} from "../../../supabase/functions/_shared/playgroundBridge.ts";
import { EMPLOYEE_SECTORS, EMPLOYEE_SECTOR_OPTIONS, EMPLOYEE_SECTOR_OPTION_LABEL, sectorHasOlharItems, sessionReportProgress, summarizeAnswersBySector } from "../src/session-report/catalog.js";

describe("assinatura da ponte", () => {
  it("é igual ao HMAC-SHA256 hex de `${ts}.${corpo}` da clínica (signBridgeBody)", async () => {
    const body = JSON.stringify({ posUnitId: "u1", a: "ação ç" });
    const expected = createHmac("sha256", "segredo").update(`1700000000.${body}`).digest("hex");
    expect(await signBridgeBody("segredo", 1700000000, body)).toBe(expected);
  });
  it("muda com o corpo, o horário e o segredo", async () => {
    const base = await signBridgeBody("s", 1, "{}");
    expect(await signBridgeBody("s", 1, "{ }")).not.toBe(base);
    expect(await signBridgeBody("s", 2, "{}")).not.toBe(base);
    expect(await signBridgeBody("t", 1, "{}")).not.toBe(base);
  });
});

describe("transitório x definitivo", () => {
  it("rede, timeout e 5xx são transitórios", () => {
    for (const s of [0, 500, 502, 503, 504]) expect(classifyClinicStatus(s)).toBe("transient");
  });
  it("408, 429 e 401 (configuração) também reenviam", () => {
    for (const s of [408, 429, 401]) expect(isTransientStatus(s)).toBe(true);
  });
  it("4xx do contrato é definitivo", () => {
    for (const s of [400, 403, 404, 409, 422]) expect(classifyClinicStatus(s)).toBe("permanent");
  });
  it("2xx é ok", () => {
    expect(classifyClinicStatus(200)).toBe("ok");
    expect(classifyClinicStatus(204)).toBe("ok");
  });
});

describe("backoff", () => {
  it("dobra a cada tentativa e respeita o teto", () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(1)).toBe(120_000);
    expect(backoffMs(2)).toBe(240_000);
    expect(backoffMs(10)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(1000)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(-3)).toBe(60_000);
  });
});

describe("carimbo de horário do tablet", () => {
  const now = Date.parse("2026-11-17T18:00:00.000Z");
  it("mantém o instante no passado e até 5 min à frente", () => {
    expect(clampClientInstant("2026-11-17T17:00:00.000Z", now)).toBe("2026-11-17T17:00:00.000Z");
    expect(clampClientInstant("2026-11-17T18:04:59.000Z", now)).toBe("2026-11-17T18:04:59.000Z");
  });
  it("usa o relógio do servidor se estiver mais de 5 min à frente ou for inválido", () => {
    expect(clampClientInstant("2026-11-17T18:06:00.000Z", now)).toBe("2026-11-17T18:00:00.000Z");
    expect(clampClientInstant("lixo", now)).toBe("2026-11-17T18:00:00.000Z");
    expect(clampClientInstant(undefined, now)).toBe("2026-11-17T18:00:00.000Z");
  });
});

describe("unidade vem do usuário, não do cliente", () => {
  const known = ["a", "b", "c"];
  it("1 unidade vinculada ignora o que o cliente mandar", () => {
    expect(resolveUnit({ assignedUnitIds: ["a"], requestedUnitId: "b", role: "ESTAGIARIO", knownUnitIds: known })).toEqual({ ok: true, unitId: "a" });
  });
  it("várias: só escolhe entre as vinculadas", () => {
    expect(resolveUnit({ assignedUnitIds: ["a", "b"], requestedUnitId: "b", role: "OPERADOR", knownUnitIds: known })).toEqual({ ok: true, unitId: "b" });
    expect(resolveUnit({ assignedUnitIds: ["a", "b"], requestedUnitId: "c", role: "OPERADOR", knownUnitIds: known }).ok).toBe(false);
    expect(resolveUnit({ assignedUnitIds: ["a", "b"], requestedUnitId: undefined, role: "OPERADOR", knownUnitIds: known }).ok).toBe(false);
  });
  it("sem vínculo: só Líder/Owner escolhem uma unidade existente", () => {
    expect(resolveUnit({ assignedUnitIds: [], requestedUnitId: "c", role: "ADMIN", knownUnitIds: known })).toEqual({ ok: true, unitId: "c" });
    expect(resolveUnit({ assignedUnitIds: [], requestedUnitId: "zzz", role: "ADMIN", knownUnitIds: known }).ok).toBe(false);
    expect(resolveUnit({ assignedUnitIds: [], requestedUnitId: "c", role: "OPERADOR", knownUnitIds: known }).ok).toBe(false);
  });
});

describe("validação das entradas", () => {
  const now = Date.parse("2026-11-17T18:00:00.000Z");
  const item = { idempotencyKey: "key-12345678", kind: "item", itemId: "item-12345678", score: 1, savedAt: "2026-11-17T17:59:00.000Z" };
  it("aceita item, limpeza (null) e evolução", () => {
    const v = validateEntries([item, { ...item, idempotencyKey: "key-22345678", score: null }, { idempotencyKey: "key-32345678", kind: "evolution", text: "  ok  ", savedAt: "x" }], now);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.entries).toHaveLength(3);
      expect(v.entries[2]).toMatchObject({ kind: "evolution", text: "ok", savedAt: "2026-11-17T18:00:00.000Z" });
    }
  });
  it("recusa nota fora de 0 a 2, lote vazio ou grande demais, evolução vazia", () => {
    expect(validateEntries([{ ...item, score: 3 }], now).ok).toBe(false);
    expect(validateEntries([], now).ok).toBe(false);
    expect(validateEntries(Array.from({ length: 51 }, () => item), now).ok).toBe(false);
    expect(validateEntries([{ idempotencyKey: "key-12345678", kind: "evolution", text: "  " }], now).ok).toBe(false);
  });
});

describe("fila e mensagens", () => {
  it("a chave do lote independe da ordem", async () => {
    expect(await batchIdempotencyKey("v1", ["b", "a"])).toBe(await batchIdempotencyKey("v1", ["a", "b"]));
    expect(await batchIdempotencyKey("v1", ["a"])).not.toBe(await batchIdempotencyKey("v2", ["a"]));
  });
  it("o envelope RSA-OAEP + AES-GCM abre com a chave privada e leva ação e corpo", async () => {
    const kp = await crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"],
    );
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
    const b64 = Buffer.from(spki).toString("base64");
    expect(parseSpkiPublicKey(b64)).toEqual(spki);
    expect(parseSpkiPublicKey(`-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`)).toEqual(spki);
    expect(parseSpkiPublicKey("")).toBeNull();

    const plain = sealedPlaintext("entries", { posUnitId: "u", savedAt: "2026-11-17T17:00:00.000Z" });
    const env = await sealEnvelope(plain, spki);
    expect(env).not.toContain("posUnitId");
    const [v, w, iv, ct] = env.split(".");
    expect(v).toBe("v1");
    const un = (t: string) => Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, kp.privateKey, un(w!));
    expect(raw.byteLength).toBe(32);
    const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    expect(un(iv!).length).toBe(12);
    const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: un(iv!) }, aes, un(ct!));
    expect(JSON.parse(new TextDecoder().decode(out))).toEqual({ action: "entries", body: { posUnitId: "u", savedAt: "2026-11-17T17:00:00.000Z" } });
  });
  it("texto cifrado leva ação e corpo", () => {
    expect(JSON.parse(sealedPlaintext("entries", { a: 1 }))).toEqual({ action: "entries", body: { a: 1 } });
  });
  it("mensagens ao terapeuta não falam em clínica, prontuário ou paciente", () => {
    for (const c of ["bad_request", "unauthorized", "not_found", "day_closed", "not_arrived", "series_closed", "conflict", "outro"]) {
      expect(friendlyErrorMessage(c)).not.toMatch(/cl[ií]nica|prontu[aá]rio|paciente/i);
    }
  });
});

describe("setor Fisioterapia e o Olhar", () => {
  it("existe como opção de colaborador e tem rótulo", () => {
    expect(EMPLOYEE_SECTOR_OPTIONS).toContain("FISIOTERAPIA");
    expect(EMPLOYEE_SECTOR_OPTION_LABEL.FISIOTERAPIA).toBe("Fisioterapia");
    expect(sectorLabel("FISIOTERAPIA")).toBe("Fisioterapia");
    expect(sectorLabel("PSICOLOGIA")).toBe("Psicologia");
    expect(sectorLabel(null)).toBeNull();
  });
  it("não entra no catálogo do Olhar: o formulário (16 itens) segue igual", () => {
    expect(EMPLOYEE_SECTORS).not.toContain("FISIOTERAPIA");
    expect(sectorHasOlharItems("FISIOTERAPIA")).toBe(false);
    expect(sectorHasOlharItems("PSICOLOGIA")).toBe(true);
    expect(sessionReportProgress({}).total).toBe(16);
    expect(summarizeAnswersBySector({})).toEqual([]);
  });
});

describe("identidade livre do tablet do avaliador", () => {
  it("aceita nome digitado + especialidade da lista e limpa espaços e caracteres de controle", () => {
    expect(parseFreeAuthor({ name: "  Ana   Souza\n", specialty: "Psicólogo(a)" })).toEqual({ name: "Ana Souza", specialty: "Psicólogo(a)" });
  });
  it("recusa nome curto, nome longo, especialidade fora da lista e entrada inválida", () => {
    expect(parseFreeAuthor({ name: "A", specialty: "Psicólogo(a)" })).toBeNull();
    expect(parseFreeAuthor({ name: "x".repeat(81), specialty: "Psicólogo(a)" })).toBeNull();
    expect(parseFreeAuthor({ name: "Ana", specialty: "Médico" })).toBeNull();
    expect(parseFreeAuthor(null)).toBeNull();
    expect(parseFreeAuthor({ name: 5, specialty: "Outro" })).toBeNull();
  });
  it("a lista de especialidades do tablet é igual à do kiosk-ui", async () => {
    const ui = await import("../../../apps/kiosk-ui/src/lib/playgroundEval.ts");
    expect([...ui.FREE_AUTHOR_SPECIALTIES]).toEqual([...FREE_AUTHOR_SPECIALTIES]);
  });
});
