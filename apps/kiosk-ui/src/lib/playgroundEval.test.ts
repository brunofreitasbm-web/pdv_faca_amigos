import { describe, expect, it, vi } from "vitest";
import {
  badgeBlinks,
  badgeCount,
  badgeTotal,
  badgeIsUrgent,
  canOpenEvaluation,
  createBatcher,
  emptyDraft,
  formatCountdown,
  isFixedTabletUser,
  loadDraft,
  loadLastTherapist,
  newlyOverdue,
  otherAuthorLabel,
  presenceAction,
  remainingSeconds,
  saveDraft,
  saveLastTherapist,
  sortVisits,
  type PlaygroundVisit,
  type VisitStatus,
} from "./playgroundEval.js";

const visit = (id: string, status: VisitStatus, start = "2026-11-17T17:00:00.000Z", extra: Partial<PlaygroundVisit> = {}): PlaygroundVisit => ({
  visitId: id, seriesId: "s", visitNo: 1, totalVisits: 3, scheduledStart: start, durationMin: 60, displayName: id, ageLabel: "6 anos",
  level: 1, status, arrivedAt: null, leftAt: null, entryCount: 0, authorCount: 0, conclusionPending: false, ...extra,
});

describe("ordem da lista", () => {
  it("atrasada primeiro, depois urgência e horário; encerradas esmaecidas no fim", () => {
    const sorted = sortVisits([
      visit("reg", "registrada_no_prazo", "2026-11-17T12:00:00.000Z"),
      visit("agu", "aguardando_chegada", "2026-11-17T13:00:00.000Z"),
      visit("ava2", "avaliar_agora", "2026-11-17T15:00:00.000Z"),
      visit("ava1", "avaliar_agora", "2026-11-17T14:00:00.000Z"),
      visit("atr", "atrasada", "2026-11-17T18:00:00.000Z"),
      visit("fal", "faltou", "2026-11-17T11:00:00.000Z"),
      visit("sai", "confirmar_saida", "2026-11-17T16:00:00.000Z"),
    ]).map((v) => v.visitId);
    expect(sorted).toEqual(["atr", "sai", "ava1", "ava2", "agu", "reg", "fal"]);
  });
});

describe("selo da navegação", () => {
  const vs = [visit("a", "avaliar_agora"), visit("b", "atrasada"), visit("c", "confirmar_saida"), visit("d", "no_playground"), visit("e", "registrada_no_prazo")];
  it("conta avaliar agora + atrasada + confirmar saída + conclusão pendente", () => {
    expect(badgeCount(vs, [])).toBe(3);
    expect(badgeCount(vs, [{ seriesId: "x", displayName: "Ana", ageLabel: "6 anos", lastVisitStart: "" }])).toBe(4);
    expect(badgeCount([], undefined)).toBe(0);
  });
  it("total do selo é o dia inteiro (sem canceladas) e pisca só com ação pendente", () => {
    expect(badgeTotal(vs)).toBe(5);
    expect(badgeTotal([visit("a", "cancelada"), visit("b", "futura")])).toBe(1);
    expect(badgeBlinks([visit("a", "futura"), visit("b", "registrada_no_prazo")], [])).toBe(false);
    expect(badgeBlinks(vs, [])).toBe(true);
    expect(badgeBlinks([], [{ seriesId: "x", displayName: "A", ageLabel: "", lastVisitStart: "" }])).toBe(true);
  });
  it("fica vermelho com atrasada ou conclusão pendente", () => {
    expect(badgeIsUrgent([visit("a", "avaliar_agora")], [])).toBe(false);
    expect(badgeIsUrgent(vs, [])).toBe(true);
    expect(badgeIsUrgent([], [{ seriesId: "x", displayName: "A", ageLabel: "", lastVisitStart: "" }])).toBe(true);
  });
});

describe("aviso de atraso", () => {
  it("só na virada, nunca na primeira leitura", () => {
    const before = [visit("a", "avaliar_agora"), visit("b", "atrasada")];
    const after = [visit("a", "atrasada"), visit("b", "atrasada"), visit("c", "atrasada")];
    expect(newlyOverdue(null, after)).toEqual([]);
    expect(newlyOverdue(before, after).map((v) => v.visitId)).toEqual(["a"]);
  });
});

describe("presença e abertura", () => {
  it("Chegou antes da chegada, Saiu depois, nada depois da saída", () => {
    expect(presenceAction({ arrivedAt: null, leftAt: null, status: "aguardando_chegada" })).toBe("arrive");
    expect(presenceAction({ arrivedAt: "x", leftAt: null, status: "no_playground" })).toBe("leave");
    expect(presenceAction({ arrivedAt: "x", leftAt: null, status: "confirmar_saida" })).toBe("leave");
    expect(presenceAction({ arrivedAt: "x", leftAt: "y", status: "avaliar_agora" })).toBeNull();
    expect(presenceAction({ arrivedAt: null, leftAt: null, status: "faltou" })).toBeNull();
  });
  it("o terapeuta só abre depois da chegada", () => {
    expect(canOpenEvaluation({ arrivedAt: null, status: "aguardando_chegada" })).toBe(false);
    expect(canOpenEvaluation({ arrivedAt: "x", status: "no_playground" })).toBe(true);
  });
  it("mostra 'Fulano (Psicologia)' só para itens de outra pessoa", () => {
    const item = { authorName: "Fulano de Tal", authorSpecialty: "Psicologia" };
    expect(otherAuthorLabel(item, "Beltrano")).toBe("Fulano (Psicologia)");
    expect(otherAuthorLabel(item, "Fulano de Tal")).toBeNull();
    expect(otherAuthorLabel(undefined, "x")).toBeNull();
  });
  it("tablet fixo: só a aba Avaliações", () => {
    expect(isFixedTabletUser(["AVALIACOES"])).toBe(true);
    expect(isFixedTabletUser(["AVALIACOES", "PDV"])).toBe(false);
    expect(isFixedTabletUser([])).toBe(false);
  });
});

describe("lote com debounce", () => {
  function fakeTimers() {
    let fn: (() => void) | null = null;
    let id = 0;
    return {
      api: { set: (f: () => void) => ((fn = f), ++id), clear: () => { fn = null; } },
      fire: () => { const f = fn; fn = null; f?.(); },
      armed: () => fn !== null,
    };
  }
  it("junta toques, o último valor de cada item vence e só dispara depois do debounce", () => {
    const t = fakeTimers();
    const onFlush = vi.fn();
    const b = createBatcher<number>({ delayMs: 2000, onFlush, timers: t.api });
    b.put("i1", 0); b.put("i2", 1); b.put("i1", 2);
    expect(onFlush).not.toHaveBeenCalled();
    t.fire();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect([...onFlush.mock.calls[0]![0] as Map<string, number>]).toEqual([["i1", 2], ["i2", 1]]);
    expect(b.pending().size).toBe(0);
  });
  it("flushNow envia na hora e requeue não sobrescreve valor mais novo", () => {
    const t = fakeTimers();
    const onFlush = vi.fn();
    const b = createBatcher<number>({ delayMs: 2000, onFlush, timers: t.api });
    b.put("i1", 1);
    b.flushNow();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(t.armed()).toBe(false);
    b.put("i1", 2);
    b.requeue(new Map([["i1", 1], ["i3", 0]]));
    expect([...b.pending()]).toEqual([["i1", 2], ["i3", 0]]);
    b.cancel();
    expect(b.pending().size).toBe(0);
  });
  it("sem nada acumulado não dispara", () => {
    const onFlush = vi.fn();
    createBatcher<number>({ delayMs: 1, onFlush }).flushNow();
    expect(onFlush).not.toHaveBeenCalled();
  });
});

describe("contagem regressiva da gravação", () => {
  it("conta de 60 até 0 e para", () => {
    expect(remainingSeconds(0, 0, 60)).toBe(60);
    expect(remainingSeconds(0, 30_500, 60)).toBe(30);
    expect(remainingSeconds(0, 60_000, 60)).toBe(0);
    expect(remainingSeconds(0, 90_000, 60)).toBe(0);
    expect(formatCountdown(60)).toBe("01:00");
    expect(formatCountdown(7)).toBe("00:07");
  });
});

describe("armazenamento local com falha", () => {
  const broken = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); }, removeItem: () => { throw new Error("bloqueado"); } };
  it("não quebra quando o storage está bloqueado", () => {
    expect(loadDraft("v1", broken)).toEqual(emptyDraft());
    expect(() => saveDraft("v1", { ...emptyDraft(), evolution: { text: "x", key: "k", savedAt: "" } }, broken)).not.toThrow();
    expect(loadLastTherapist("u", broken)).toBeNull();
    expect(() => saveLastTherapist("u", "t", broken)).not.toThrow();
  });
  it("guarda e recupera o rascunho e o último terapeuta", () => {
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const d = { authorId: "t1", items: { i1: { score: 2 as const, key: "k1", savedAt: "x" } }, evolution: null };
    saveDraft("v1", d, st);
    expect(loadDraft("v1", st)).toEqual(d);
    saveDraft("v1", emptyDraft(), st);
    expect(mem.size).toBe(0);
    saveLastTherapist("u", "t9", st);
    expect(loadLastTherapist("u", st)).toBe("t9");
  });
});
