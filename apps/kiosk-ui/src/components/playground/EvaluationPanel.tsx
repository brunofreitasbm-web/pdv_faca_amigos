import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@facaamigos/ui";
import { Api } from "../../api/client.js";
import { useConfirm } from "../../state/ConfirmContext.js";
import { useToast } from "../../state/ToastContext.js";
import { useVoiceRecorder } from "../../hooks/useVoiceRecorder.js";
import {
  PlaygroundEvalError,
  STATUS_LABEL,
  clearDraft,
  createBatcher,
  firstName,
  formatCountdown,
  loadDraft,
  FREE_AUTHOR_SPECIALTIES,
  isValidFreeAuthor,
  loadFreeAuthor,
  loadLastTherapist,
  saveFreeAuthor,
  type FreeAuthor,
  newEntryKey,
  otherAuthorLabel,
  saveDraft,
  saveLastTherapist,
  type CatalogDomain,
  type LocalDraft,
  type PlaygroundVisit,
  type SeriesState,
  type Therapist,
} from "../../lib/playgroundEval.js";
import { ScoreSegmented } from "./ScoreSegmented.js";

const AUTOSAVE_MS = 2000;
const MAX_VOICE_SECONDS = 60;

type SaveState = "idle" | "saving" | "saved" | "offline" | "error";
type Pending = { score: 0 | 1 | 2 | null; key: string; savedAt: string };
type Override = { score: 0 | 1 | 2 | null; authorName: string; authorSpecialty: string };

const SAVE_TEXT: Record<SaveState, string> = {
  idle: "",
  saving: "Salvando...",
  saved: "Salvo",
  offline: "Sem conexão: salvo neste aparelho, tente de novo",
  error: "Não foi possível salvar: tente de novo",
};

const FREE_ID = "livre";

interface Props {
  unitId: string;
  visit: PlaygroundVisit;
  domains: CatalogDomain[];
  series: SeriesState | undefined;
  therapists: Therapist[];
  /** Tablet do avaliador: nome digitado + especialidade da lista, em vez de escolher um colaborador. */
  freeAuthor?: boolean;
  onClose: () => void;
  /** Releitura da lista depois de salvar. */
  onSaved: () => void;
}

/** Painel lateral da avaliação: terapeuta, itens por domínio, evolução e o botão "Salvar como". */
export function EvaluationPanel({ unitId, visit, domains, series, therapists: registeredTherapists, freeAuthor = false, onClose, onSaved }: Props) {
  const toast = useToast();
  const confirm = useConfirm();

  const initialDraft = useMemo<LocalDraft>(() => loadDraft(visit.visitId), [visit.visitId]);
  const draftRef = useRef<LocalDraft>(initialDraft);

  // Avaliador do tablet: confirma nome e especialidade com OK; um rascunho já salvo neste aparelho reaproveita a última identidade.
  const [freeForm, setFreeForm] = useState<FreeAuthor>(() => loadFreeAuthor(unitId) ?? { name: "", specialty: "" });
  const [freeConfirmed, setFreeConfirmed] = useState<boolean>(
    () => freeAuthor && initialDraft.authorId === FREE_ID && loadFreeAuthor(unitId) !== null,
  );
  const therapists = useMemo<Therapist[]>(
    () => (freeAuthor ? (freeConfirmed ? [{ id: FREE_ID, name: freeForm.name.replace(/\s+/g, " ").trim(), specialty: freeForm.specialty }] : []) : registeredTherapists),
    [freeAuthor, freeConfirmed, freeForm, registeredTherapists],
  );
  const freeRef = useRef<FreeAuthor | null>(null);
  freeRef.current = freeAuthor && freeConfirmed ? { name: freeForm.name.replace(/\s+/g, " ").trim(), specialty: freeForm.specialty } : null;
  /** Autor no envio: o colaborador escolhido, ou o nome digitado no tablet do avaliador. */
  const authorFields = () => (freeAuthor ? { authorFree: freeRef.current } : { authorEmployeeId: authorRef.current });

  const [authorId, setAuthorId] = useState<string | null>(() => {
    if (freeAuthor) return freeConfirmed ? FREE_ID : null;
    if (initialDraft.authorId && therapists.some((t) => t.id === initialDraft.authorId)) return initialDraft.authorId;
    const last = loadLastTherapist(unitId);
    return last && therapists.some((t) => t.id === last) ? last : null;
  });
  const authorRef = useRef(authorId);
  authorRef.current = authorId;
  const author = therapists.find((t) => t.id === authorId) ?? null;

  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [openDomains, setOpenDomains] = useState<Record<string, boolean>>(() => (domains[0] ? { [domains[0].domain]: true } : {}));
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [dirty, setDirty] = useState(0);
  const [evoText, setEvoText] = useState(initialDraft.evolution?.text ?? "");
  const [transcribing, setTranscribing] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const items = series?.items ?? [];
  const serverByItem = useMemo(() => new Map(items.map((i) => [i.itemId, i])), [items]);

  // ---- envio ----------------------------------------------------------
  const sendRef = useRef<(items: Map<string, Pending>) => Promise<void>>(async () => {});
  const batcher = useMemo(
    () => createBatcher<Pending>({ delayMs: AUTOSAVE_MS, onFlush: (m) => void sendRef.current(m) }),
    [],
  );

  const persistDraft = useCallback(() => {
    draftRef.current = {
      ...draftRef.current,
      authorId: authorRef.current,
      // mescla: o que está em voo continua no rascunho até o envio ser confirmado
      items: { ...draftRef.current.items, ...Object.fromEntries(batcher.pending()) },
    };
    saveDraft(visit.visitId, draftRef.current);
    setDirty(batcher.pending().size + (draftRef.current.evolution ? 1 : 0));
  }, [batcher, visit.visitId]);

  const send = useCallback(
    async (batch: Map<string, Pending>, evo?: { text: string; key: string; savedAt: string } | null) => {
      const authorEmployeeId = authorRef.current;
      if (!authorEmployeeId) {
        batcher.requeue(batch);
        persistDraft();
        return;
      }
      const entries: Array<Record<string, unknown>> = [...batch].map(([itemId, p]) => ({
        idempotencyKey: p.key,
        kind: "item",
        itemId,
        score: p.score,
        savedAt: p.savedAt,
      }));
      if (evo) entries.push({ idempotencyKey: evo.key, kind: "evolution", text: evo.text, savedAt: evo.savedAt });
      if (entries.length === 0) return;
      setSaveState("saving");
      try {
        await Api.playgroundEval("entries", {
          unitId,
          visitId: visit.visitId,
          deviceId: (await Api.deviceId()) ?? "navegador",
          ...authorFields(),
          entries,
        });
        // Confirmado (ou guardado para reenvio): sai do rascunho local o que foi enviado.
        const sentKeys = new Set(entries.map((e) => e.idempotencyKey as string));
        const rest = Object.fromEntries(Object.entries(draftRef.current.items).filter(([, p]) => !sentKeys.has(p.key)));
        draftRef.current = {
          ...draftRef.current,
          items: rest,
          evolution: evo && draftRef.current.evolution?.key === evo.key ? null : draftRef.current.evolution,
        };
        if (Object.keys(draftRef.current.items).length === 0 && !draftRef.current.evolution) clearDraft(visit.visitId);
        else saveDraft(visit.visitId, draftRef.current);
        setDirty(batcher.pending().size + (draftRef.current.evolution ? 1 : 0));
        if (evo) setEvoText((t) => (t.trim() === evo.text ? "" : t));
        setSaveState("saved");
        onSaved();
      } catch (e) {
        batcher.requeue(batch);
        persistDraft();
        const offline = e instanceof PlaygroundEvalError && e.offline;
        setSaveState(offline ? "offline" : "error");
        if (!offline) toast.error(e instanceof Error ? e.message : SAVE_TEXT.error);
        throw e;
      }
    },
    [batcher, onSaved, persistDraft, toast, unitId, visit.visitId],
  );
  sendRef.current = async (m) => {
    try {
      await send(m);
    } catch {
      /* estado já mostrado; o rascunho fica para "Salvar" tentar de novo */
    }
  };

  // Restaura o que ficou sem enviar (queda de conexão, aba recarregada).
  useEffect(() => {
    const restored = Object.entries(initialDraft.items);
    if (restored.length === 0 || !authorRef.current) return;
    const a = therapists.find((t) => t.id === authorRef.current);
    setOverrides((o) => {
      const n = { ...o };
      for (const [itemId, p] of restored) n[itemId] = { score: p.score, authorName: a?.name ?? "", authorSpecialty: a?.specialty ?? "" };
      return n;
    });
    for (const [itemId, p] of restored) batcher.put(itemId, p);
    setDirty(restored.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => batcher.flushNow(), [batcher]);

  // ---- ações ----------------------------------------------------------
  function confirmFreeAuthor() {
    if (!isValidFreeAuthor(freeForm)) return;
    saveFreeAuthor(unitId, { name: freeForm.name.replace(/\s+/g, " ").trim(), specialty: freeForm.specialty });
    setFreeConfirmed(true);
    setAuthorId(FREE_ID);
    authorRef.current = FREE_ID;
    freeRef.current = { name: freeForm.name.replace(/\s+/g, " ").trim(), specialty: freeForm.specialty };
  }

  function changeFreeAuthor() {
    batcher.flushNow(); // o que já estava marcado sai no nome de quem marcou
    setFreeConfirmed(false);
    setAuthorId(null);
    authorRef.current = null;
  }

  function chooseTherapist(t: Therapist) {
    if (t.id === authorRef.current) return;
    batcher.flushNow(); // o que já estava marcado sai no nome de quem marcou
    setAuthorId(t.id);
    authorRef.current = t.id;
    saveLastTherapist(unitId, t.id);
  }

  function setScore(itemId: string, score: 0 | 1 | 2 | null) {
    if (!author) return;
    setOverrides((o) => ({ ...o, [itemId]: { score, authorName: author.name, authorSpecialty: author.specialty } }));
    batcher.put(itemId, { score, key: newEntryKey(visit.visitId, itemId), savedAt: new Date().toISOString() });
    setSaveState("idle");
    persistDraft();
  }

  const onAudio = useCallback(
    async (audio: { audioBase64: string; mimeType: string }) => {
      setTranscribing(true);
      setVoiceMsg(null);
      try {
        const res = await Api.playgroundEval<{ text: string }>("transcribe", { unitId, ...audio });
        setEvoText((t) => (t.trim() ? `${t.trim()}\n${res.text}` : res.text));
      } catch (e) {
        setVoiceMsg(e instanceof Error ? e.message : "Transcrição indisponível agora: digite a evolução.");
      } finally {
        setTranscribing(false);
      }
    },
    [unitId],
  );
  const voice = useVoiceRecorder({ maxSeconds: MAX_VOICE_SECONDS, onAudio });

  async function saveAll() {
    const text = evoText.trim();
    let evo: { text: string; key: string; savedAt: string } | null = null;
    if (text) {
      const prev = draftRef.current.evolution;
      evo = prev && prev.text === text ? prev : { text, key: newEntryKey(visit.visitId, "evolucao"), savedAt: new Date().toISOString() };
      draftRef.current = { ...draftRef.current, evolution: evo };
    }
    const pending = new Map(batcher.pending());
    batcher.cancel();
    saveDraft(visit.visitId, { ...draftRef.current, authorId: authorRef.current });
    try {
      await send(pending, evo);
    } catch {
      /* estado já mostrado */
    }
  }

  async function conclude() {
    if (!author) return;
    setMoreOpen(false);
    const ok = await confirm({
      title: "Concluir avaliação?",
      message: `Esta é a última visita de ${visit.displayName}. As visitas futuras serão canceladas e a avaliação será encerrada. Isso não pode ser desfeito.`,
      confirmLabel: "Concluir avaliação",
      cancelLabel: "Voltar",
      variant: "danger",
    });
    if (!ok) return;
    await saveAll();
    try {
      await Api.playgroundEval("conclude", {
        unitId,
        visitId: visit.visitId,
        deviceId: (await Api.deviceId()) ?? "navegador",
        ...authorFields(),
        savedAt: new Date().toISOString(),
      });
      toast.success("Avaliação concluída");
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível concluir: tente de novo.");
    }
  }

  const nothingToSave = dirty === 0 && !evoText.trim();
  const previousEvolutions = (series?.evolutions ?? []).filter((e) => e.visitId === visit.visitId);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", justifyContent: "flex-end" }}>
      <div
        aria-hidden="true"
        onClick={() => {
          batcher.flushNow();
          onClose();
        }}
        style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.35)" }}
      />
      <aside
        role="dialog"
        aria-label={`Avaliação de ${visit.displayName}`}
        style={{ position: "relative", width: "min(600px, 100vw)", height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-page, #fff)", boxShadow: "-8px 0 24px rgba(0,0,0,.2)" }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: "12px", padding: "14px 18px", borderBottom: "1px solid var(--border-subtle)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "22px", fontWeight: 800 }}>{visit.displayName}</div>
            <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              {visit.ageLabel} · visita {visit.visitNo} de {visit.totalVisits} · {STATUS_LABEL[visit.status]}
            </div>
          </div>
          <button
            type="button"
            aria-label="Fechar"
            onClick={() => {
              batcher.flushNow();
              onClose();
            }}
            style={{ width: "48px", height: "48px", borderRadius: "50%", border: "1px solid var(--border-subtle)", background: "var(--surface-card)", fontSize: "20px", cursor: "pointer" }}
          >
            ✕
          </button>
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Quem está avaliando */}
          <section aria-label="Quem está avaliando">
            <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-secondary)", marginBottom: "6px" }}>Quem está avaliando</div>
            {freeAuthor ? (
              freeConfirmed ? (
                <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                  <div style={{ fontSize: "16px", fontWeight: 700 }}>
                    {firstName(freeForm.name)} <span style={{ fontWeight: 500, color: "var(--text-muted)" }}>· {freeForm.specialty}</span>
                  </div>
                  <button type="button" onClick={changeFreeAuthor} style={{ minHeight: "44px", padding: "6px 14px", borderRadius: "999px", border: "1px solid var(--border-subtle)", background: "var(--surface-card)", fontFamily: "inherit", fontSize: "14px", cursor: "pointer" }}>
                    Trocar
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
                  <input
                    aria-label="Seu nome"
                    placeholder="Seu nome"
                    value={freeForm.name}
                    maxLength={80}
                    onChange={(e) => setFreeForm((f) => ({ ...f, name: e.target.value }))}
                    style={{ minHeight: "48px", padding: "6px 14px", borderRadius: "10px", border: "1px solid var(--border-subtle)", fontFamily: "inherit", fontSize: "16px", flex: "1 1 180px" }}
                  />
                  <select
                    aria-label="Especialidade"
                    value={freeForm.specialty}
                    onChange={(e) => setFreeForm((f) => ({ ...f, specialty: e.target.value }))}
                    style={{ minHeight: "48px", padding: "6px 10px", borderRadius: "10px", border: "1px solid var(--border-subtle)", fontFamily: "inherit", fontSize: "16px" }}
                  >
                    <option value="" disabled>
                      Especialidade
                    </option>
                    {FREE_AUTHOR_SPECIALTIES.map((sp) => (
                      <option key={sp} value={sp}>
                        {sp}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!isValidFreeAuthor(freeForm)}
                    onClick={confirmFreeAuthor}
                    style={{ minHeight: "48px", padding: "6px 22px", borderRadius: "999px", border: "none", background: "var(--color-primary)", color: "#fff", fontFamily: "inherit", fontSize: "16px", fontWeight: 700, cursor: "pointer", opacity: isValidFreeAuthor(freeForm) ? 1 : 0.5 }}
                  >
                    OK
                  </button>
                </div>
              )
            ) : therapists.length === 0 ? (
              <div style={{ fontSize: "14px", color: "var(--text-muted)" }}>Nenhum profissional cadastrado para esta unidade: peça ao responsável para cadastrar.</div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {therapists.map((t) => {
                  const sel = t.id === authorId;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={sel}
                      onClick={() => chooseTherapist(t)}
                      style={{
                        minHeight: "48px",
                        padding: "6px 16px",
                        borderRadius: "999px",
                        border: sel ? "2px solid transparent" : "1px solid var(--border-subtle)",
                        background: sel ? "var(--color-primary)" : "var(--surface-card)",
                        color: sel ? "#fff" : "inherit",
                        fontFamily: "inherit",
                        fontSize: "16px",
                        fontWeight: sel ? 700 : 500,
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <div>{firstName(t.name)}</div>
                      <div style={{ fontSize: "11px", opacity: 0.85 }}>{t.specialty}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Itens por domínio */}
          {domains.map((d) => {
            const answered = d.items.filter((i) => (overrides[i.id] ? overrides[i.id]!.score !== null : serverByItem.has(i.id))).length;
            const open = !!openDomains[d.domain];
            return (
              <section key={d.domain} style={{ border: "1px solid var(--border-subtle)", borderRadius: "14px", overflow: "hidden" }}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenDomains((o) => ({ ...o, [d.domain]: !open }))}
                  style={{ width: "100%", minHeight: "52px", display: "flex", alignItems: "center", gap: "8px", padding: "10px 14px", background: "var(--surface-sunken)", border: "none", fontFamily: "inherit", fontSize: "16px", fontWeight: 700, cursor: "pointer", textAlign: "left" }}
                >
                  <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                  <span style={{ flex: 1 }}>{d.label}</span>
                  <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--text-muted)" }}>
                    {answered}/{d.items.length}
                  </span>
                </button>
                {open && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "12px 14px" }}>
                    {d.items.map((item) => {
                      const ov = overrides[item.id];
                      const server = serverByItem.get(item.id);
                      const value = ov ? ov.score : (server?.score ?? null);
                      const by = ov ? otherAuthorLabel({ authorName: ov.authorName, authorSpecialty: ov.authorSpecialty }, author?.name ?? null) : otherAuthorLabel(server, author?.name ?? null);
                      return (
                        <div key={item.id} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                          <div style={{ fontSize: "15px" }}>{item.description}</div>
                          <ScoreSegmented value={value} disabled={!author} label={item.description} onChange={(s) => setScore(item.id, s)} />
                          {value !== null && by && <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>Marcado por {by}</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
          {!author && (therapists.length > 0 || freeAuthor) && <div style={{ fontSize: "14px", color: "var(--text-muted)" }}>{freeAuthor ? "Informe seu nome e especialidade e toque em OK para marcar os itens." : "Escolha quem está avaliando para marcar os itens."}</div>}

          {/* Evolução */}
          <section aria-label="Evolução" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-secondary)" }}>Evolução da visita</div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              {voice.state === "recording" ? (
                <Button variant="primary" size="md" onClick={voice.stop} style={{ minHeight: "48px" }}>
                  ⏹ Parar ({formatCountdown(voice.secondsLeft)})
                </Button>
              ) : (
                <Button variant="secondary" size="md" disabled={transcribing} onClick={() => void voice.start()} style={{ minHeight: "48px" }}>
                  🎤 Falar a evolução
                </Button>
              )}
              {voice.state === "recording" && <span role="timer" style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatCountdown(voice.secondsLeft)}</span>}
              {transcribing && <span style={{ fontSize: "14px", color: "var(--text-muted)" }}>Transformando em texto...</span>}
            </div>
            {(voice.error || voiceMsg) && <div role="alert" style={{ fontSize: "14px", color: "var(--color-error-text, #b3261e)" }}>{voice.error ?? voiceMsg}</div>}
            <textarea
              aria-label="Evolução"
              rows={3}
              value={evoText}
              onChange={(e) => setEvoText(e.target.value)}
              placeholder="Escreva ou fale como foi a visita"
              style={{ width: "100%", minHeight: "84px", padding: "10px 12px", borderRadius: "12px", border: "1px solid var(--border-subtle)", fontFamily: "inherit", fontSize: "16px", resize: "vertical" }}
            />
            {previousEvolutions.length > 0 && (
              <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                {previousEvolutions.map((e, i) => (
                  <div key={i}>
                    {firstName(e.authorName)}: {e.text}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <footer style={{ padding: "12px 18px", borderTop: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: "8px" }}>
          <div role="status" style={{ minHeight: "18px", fontSize: "13px", color: saveState === "saved" ? "var(--color-teal-text, #0b6b5a)" : saveState === "idle" || saveState === "saving" ? "var(--text-muted)" : "var(--color-error-text, #b3261e)" }}>
            {SAVE_TEXT[saveState]}
          </div>
          <Button variant="primary" size="lg" fullWidth disabled={!author || saveState === "saving" || nothingToSave} onClick={() => void saveAll()} style={{ minHeight: "56px" }}>
            {author ? `Salvar como ${firstName(author.name)}` : "Escolha quem está avaliando"}
          </Button>
          <div style={{ position: "relative", alignSelf: "center" }}>
            <button
              type="button"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
              style={{ minHeight: "44px", padding: "0 16px", background: "none", border: "none", fontFamily: "inherit", fontSize: "14px", color: "var(--text-secondary)", cursor: "pointer", textDecoration: "underline" }}
            >
              Mais ações
            </button>
            {moreOpen && (
              <div style={{ position: "absolute", bottom: "100%", left: "50%", transform: "translateX(-50%)", background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: "12px", padding: "6px", boxShadow: "0 8px 24px rgba(0,0,0,.2)", whiteSpace: "nowrap" }}>
                <button
                  type="button"
                  disabled={!author}
                  onClick={() => void conclude()}
                  style={{ minHeight: "48px", padding: "0 16px", background: "none", border: "none", fontFamily: "inherit", fontSize: "15px", cursor: author ? "pointer" : "not-allowed" }}
                >
                  Concluir avaliação (última visita)
                </button>
              </div>
            )}
          </div>
        </footer>
      </aside>
    </div>
  );
}
