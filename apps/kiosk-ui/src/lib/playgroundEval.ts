/**
 * Regras puras da aba "Avaliações" (lista do dia, selo, lote de salvamento,
 * rascunho local). Sem React e sem rede, para testar com vitest.
 *
 * Linguagem: a tela fala em "criança" e "avaliação". Nada aqui cita clínica,
 * prontuário ou paciente.
 */

export type VisitStatus =
  | "futura" | "aguardando_chegada" | "no_playground" | "confirmar_saida" | "avaliar_agora" | "atrasada"
  | "registrada_no_prazo" | "registrada_com_atraso" | "nao_feita" | "faltou" | "cancelada";

export interface PlaygroundVisit {
  visitId: string;
  seriesId: string;
  visitNo: number;
  totalVisits: number;
  scheduledStart: string;
  durationMin: number;
  displayName: string;
  ageLabel: string;
  level: 1 | 2 | 3;
  status: VisitStatus;
  arrivedAt: string | null;
  leftAt: string | null;
  entryCount: number;
  authorCount: number;
  conclusionPending: boolean;
}

export interface CatalogItem { id: string; code: string; description: string }
export interface CatalogDomain { domain: string; label: string; items: CatalogItem[] }
export interface SeriesItemState { itemId: string; score: number; authorName: string; authorSpecialty: string; visitNo: number; savedAt: string }
export interface SeriesEvolutionState { visitId: string; text: string; authorName: string; savedAt: string }
export interface SeriesState { items: SeriesItemState[]; evolutions: SeriesEvolutionState[] }
export interface PendingConclusion { seriesId: string; displayName: string; ageLabel: string; lastVisitStart: string }
export interface Therapist { id: string; name: string; specialty: string }

export interface PlaygroundToday {
  ok: true;
  serverNow: string;
  protocolConfigured: boolean;
  scale: { min: number; max: number; labels: Record<string, string> };
  visits: PlaygroundVisit[];
  catalogs: Record<string, CatalogDomain[]>;
  pendingConclusions?: PendingConclusion[];
  state: Record<string, SeriesState>;
  therapists: Therapist[];
  /** Tablet do avaliador: o profissional digita o nome e escolhe a especialidade (sem cadastro). */
  freeAuthor?: boolean;
}

/** Igual a FREE_AUTHOR_SPECIALTIES de supabase/functions/_shared/playgroundBridge.ts. */
export const FREE_AUTHOR_SPECIALTIES = [
  "Psicólogo(a)",
  "Terapeuta Ocupacional",
  "Educador(a) Físico(a)",
  "Pedagogo(a)",
  "Fisioterapeuta",
  "Fonoaudiólogo(a)",
  "Outro",
] as const;

export interface FreeAuthor { name: string; specialty: string }

export class PlaygroundEvalError extends Error {
  constructor(message: string, readonly code: string, readonly offline = false) {
    super(message);
    this.name = "PlaygroundEvalError";
  }
}

// ---------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------

export const STATUS_LABEL: Record<VisitStatus, string> = {
  futura: "Mais tarde",
  aguardando_chegada: "Aguardando chegada",
  no_playground: "No playground",
  confirmar_saida: "Confirmar saída",
  avaliar_agora: "Avaliar agora",
  atrasada: "Atrasada",
  registrada_no_prazo: "Registrada",
  registrada_com_atraso: "Registrada",
  nao_feita: "Não feita",
  faltou: "Faltou",
  cancelada: "Cancelada",
};

/** Menor = mais urgente. Os encerrados (>= 90) ficam esmaecidos no fim. */
const URGENCY: Record<VisitStatus, number> = {
  atrasada: 0,
  confirmar_saida: 1,
  avaliar_agora: 2,
  no_playground: 3,
  aguardando_chegada: 4,
  futura: 5,
  registrada_no_prazo: 90,
  registrada_com_atraso: 90,
  nao_feita: 91,
  faltou: 92,
  cancelada: 93,
};

export const isClosedStatus = (s: VisitStatus): boolean => URGENCY[s] >= 90;

/** Atrasada primeiro, depois por urgência e horário. Encerradas no fim. */
export function sortVisits(visits: readonly PlaygroundVisit[]): PlaygroundVisit[] {
  return [...visits].sort(
    (a, b) =>
      URGENCY[a.status] - URGENCY[b.status] ||
      Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart) ||
      a.visitId.localeCompare(b.visitId),
  );
}

const BADGE_STATUSES: ReadonlySet<VisitStatus> = new Set(["avaliar_agora", "atrasada", "confirmar_saida"]);

/** Selo da navegação: Avaliar agora + Atrasada + Confirmar saída + Conclusão pendente. */
export function badgeCount(visits: readonly PlaygroundVisit[], pending: readonly PendingConclusion[] | undefined): number {
  return visits.filter((v) => BADGE_STATUSES.has(v.status)).length + (pending?.length ?? 0);
}

/** Total do selo: avaliações agendadas para hoje (canceladas ficam de fora). */
export function badgeTotal(visits: readonly PlaygroundVisit[]): number {
  return visits.filter((v) => v.status !== "cancelada").length;
}

/** O selo pisca só quando há ação a tomar (avaliar agora, atrasada, confirmar saída ou conclusão pendente). */
export function badgeBlinks(visits: readonly PlaygroundVisit[], pending: readonly PendingConclusion[] | undefined): boolean {
  return badgeCount(visits, pending) > 0;
}

/** Selo vermelho quando há algo atrasado ou com conclusão pendente. */
export function badgeIsUrgent(visits: readonly PlaygroundVisit[], pending: readonly PendingConclusion[] | undefined): boolean {
  return (pending?.length ?? 0) > 0 || visits.some((v) => v.status === "atrasada");
}

/** Visitas que passaram a Atrasada entre duas leituras (para o aviso, uma vez só). */
export function newlyOverdue(prev: readonly PlaygroundVisit[] | null, next: readonly PlaygroundVisit[]): PlaygroundVisit[] {
  if (!prev) return [];
  const before = new Map(prev.map((v) => [v.visitId, v.status]));
  return next.filter((v) => v.status === "atrasada" && before.has(v.visitId) && before.get(v.visitId) !== "atrasada");
}

export function overdueMessage(displayName: string): string {
  return `Avaliação de ${displayName} atrasada: chame o terapeuta`;
}

/** Botão do caixa no card: Chegou antes da chegada, Saiu depois dela, nada depois da saída. */
export function presenceAction(v: Pick<PlaygroundVisit, "arrivedAt" | "leftAt" | "status">): "arrive" | "leave" | null {
  if (isClosedStatus(v.status)) return null;
  if (v.leftAt) return null;
  if (v.arrivedAt) return "leave";
  return v.status === "aguardando_chegada" || v.status === "futura" ? "arrive" : null;
}

/** O terapeuta só abre a avaliação depois da chegada. */
export const canOpenEvaluation = (v: Pick<PlaygroundVisit, "arrivedAt" | "status">): boolean =>
  !!v.arrivedAt && v.status !== "cancelada";

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
}

/** "Fulano (Psicologia)" quando o item foi preenchido por outra pessoa; null se foi a própria. */
export function otherAuthorLabel(item: Pick<SeriesItemState, "authorName" | "authorSpecialty"> | undefined, activeName: string | null): string | null {
  if (!item) return null;
  if (activeName && item.authorName === activeName) return null;
  const first = item.authorName.trim().split(/\s+/)[0] ?? item.authorName;
  return item.authorSpecialty ? `${first} (${item.authorSpecialty})` : first;
}

export const firstName = (full: string): string => full.trim().split(/\s+/)[0] ?? full;

/** Tablet fixo: o usuário só enxerga a aba Avaliações. */
export function isFixedTabletUser(visibleScreens: readonly string[]): boolean {
  return visibleScreens.length === 1 && visibleScreens[0] === "AVALIACOES";
}

// ---------------------------------------------------------------------
// Lote de salvamento com debounce (último valor de cada item vence)
// ---------------------------------------------------------------------

export interface TimerApi {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

const realTimers: TimerApi = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };

export interface Batcher<T> {
  /** Põe/atualiza o valor da chave e (re)arma o debounce. */
  put(key: string, value: T): void;
  /** Dispara agora o que estiver acumulado. */
  flushNow(): void;
  pending(): ReadonlyMap<string, T>;
  /** Devolve itens que não foram enviados (ex.: sem conexão) sem sobrescrever os mais novos. */
  requeue(items: ReadonlyMap<string, T>): void;
  cancel(): void;
}

export function createBatcher<T>(opts: { delayMs: number; onFlush: (items: Map<string, T>) => void; timers?: TimerApi }): Batcher<T> {
  const timers = opts.timers ?? realTimers;
  let items = new Map<string, T>();
  let handle: unknown = null;
  const clear = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
  const flushNow = () => {
    clear();
    if (items.size === 0) return;
    const out = items;
    items = new Map();
    opts.onFlush(out);
  };
  return {
    put(key, value) {
      items.set(key, value);
      clear();
      handle = timers.set(flushNow, opts.delayMs);
    },
    flushNow,
    pending: () => items,
    requeue(back) {
      for (const [k, v] of back) if (!items.has(k)) items.set(k, v);
    },
    cancel() {
      clear();
      items = new Map();
    },
  };
}

// ---------------------------------------------------------------------
// Gravação por voz: contagem regressiva
// ---------------------------------------------------------------------

export function remainingSeconds(startedAtMs: number, nowMs: number, maxSeconds: number): number {
  return Math.max(0, Math.ceil(maxSeconds - (nowMs - startedAtMs) / 1000));
}

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------
// Armazenamento local (sempre com try/catch: pode estar bloqueado)
// ---------------------------------------------------------------------

export interface LocalDraft {
  authorId: string | null;
  items: Record<string, { score: 0 | 1 | 2 | null; key: string; savedAt: string }>;
  evolution: { text: string; key: string; savedAt: string } | null;
}

export const emptyDraft = (): LocalDraft => ({ authorId: null, items: {}, evolution: null });
const draftKey = (visitId: string) => `fa-playground-draft-${visitId}`;

export function loadDraft(visitId: string, storage?: Pick<Storage, "getItem">): LocalDraft {
  try {
    const raw = (storage ?? sessionStorage).getItem(draftKey(visitId));
    if (raw) {
      const d = JSON.parse(raw) as LocalDraft;
      if (d && typeof d === "object" && d.items) return { authorId: d.authorId ?? null, items: d.items, evolution: d.evolution ?? null };
    }
  } catch {
    /* storage indisponível: começa vazio */
  }
  return emptyDraft();
}

export function saveDraft(visitId: string, draft: LocalDraft, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const s = storage ?? sessionStorage;
    if (Object.keys(draft.items).length === 0 && !draft.evolution) s.removeItem(draftKey(visitId));
    else s.setItem(draftKey(visitId), JSON.stringify(draft));
  } catch {
    /* sem rascunho local */
  }
}

export function clearDraft(visitId: string, storage?: Pick<Storage, "removeItem">): void {
  try {
    (storage ?? sessionStorage).removeItem(draftKey(visitId));
  } catch {
    /* nada a limpar */
  }
}

const lastTherapistKey = (unitId: string) => `fa-playground-last-therapist-${unitId}`;

export function loadLastTherapist(unitId: string, storage?: Pick<Storage, "getItem">): string | null {
  try {
    return (storage ?? localStorage).getItem(lastTherapistKey(unitId));
  } catch {
    return null;
  }
}

export function saveLastTherapist(unitId: string, therapistId: string, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? localStorage).setItem(lastTherapistKey(unitId), therapistId);
  } catch {
    /* sem memória do último usado */
  }
}

const freeAuthorKey = (unitId: string) => `fa-playground-free-author-${unitId}`;

/** Último nome e especialidade usados neste tablet (só lembra; o profissional confirma com OK). */
export function loadFreeAuthor(unitId: string, storage?: Pick<Storage, "getItem">): FreeAuthor | null {
  try {
    const raw = (storage ?? localStorage).getItem(freeAuthorKey(unitId));
    const v = raw ? (JSON.parse(raw) as Partial<FreeAuthor>) : null;
    if (v && typeof v.name === "string" && typeof v.specialty === "string") return { name: v.name, specialty: v.specialty };
  } catch {
    /* sem memória */
  }
  return null;
}

export function saveFreeAuthor(unitId: string, a: FreeAuthor, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? localStorage).setItem(freeAuthorKey(unitId), JSON.stringify(a));
  } catch {
    /* sem memória do último usado */
  }
}

export function isValidFreeAuthor(a: FreeAuthor): boolean {
  const name = a.name.replace(/\s+/g, " ").trim();
  return name.length >= 2 && name.length <= 80 && (FREE_AUTHOR_SPECIALTIES as readonly string[]).includes(a.specialty);
}

export function newEntryKey(visitId: string, suffix: string): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${visitId.slice(0, 12)}:${suffix.slice(0, 12)}:${Date.now().toString(36)}${rand}`;
}
