import { useEffect, useSyncExternalStore } from "react";
import { Api } from "./client.js";
import { startVisiblePolling } from "../lib/visiblePolling.js";
import { badgeBlinks, badgeCount, badgeIsUrgent, badgeTotal, PlaygroundEvalError, type PlaygroundToday } from "../lib/playgroundEval.js";

const POLL_MS = 60_000;

export interface PlaygroundSnapshot {
  unitId: string | null;
  data: PlaygroundToday | null;
  /** Última leitura que deu certo; mantida se a próxima falhar (aba mostra a última lista). */
  error: string | null;
  loading: boolean;
}

/**
 * Uma leitura compartilhada por quem precisar (tela, selo da navegação, aviso
 * de atraso): evita três polls iguais. Atualiza a cada 60 s e quando a aba
 * volta a ficar visível (padrão de useSessionReports). Falha de rede mantém a
 * última lista: sumir com a fila por um soluço faria o prazo de 40 min passar.
 */
let snapshot: PlaygroundSnapshot = { unitId: null, data: null, error: null, loading: false };
const listeners = new Set<() => void>();
let holders = 0;
let stopPolling: (() => void) | null = null;
let activeUnit: string | null = null;
let inFlight = false;

const emit = () => listeners.forEach((l) => l());
const set = (next: Partial<PlaygroundSnapshot>) => {
  snapshot = { ...snapshot, ...next };
  emit();
};

export async function refetchPlaygroundEval(): Promise<void> {
  const unitId = activeUnit;
  if (!unitId || inFlight) return;
  inFlight = true;
  try {
    const data = await Api.playgroundEval<PlaygroundToday>("today", { unitId });
    if (activeUnit === unitId) set({ data, error: null, loading: false });
  } catch (e) {
    if (activeUnit === unitId) {
      set({ error: e instanceof PlaygroundEvalError ? e.message : "Sem conexão: mostrando a última lista.", loading: false });
    }
  } finally {
    inFlight = false;
  }
}

function retain(unitId: string) {
  holders++;
  if (activeUnit !== unitId) {
    stopPolling?.();
    activeUnit = unitId;
    snapshot = { unitId, data: null, error: null, loading: true };
    emit();
    stopPolling = startVisiblePolling(() => void refetchPlaygroundEval(), POLL_MS);
  } else if (!stopPolling) {
    stopPolling = startVisiblePolling(() => void refetchPlaygroundEval(), POLL_MS);
  }
}

function release() {
  holders = Math.max(0, holders - 1);
  if (holders === 0) {
    stopPolling?.();
    stopPolling = null;
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** `enabled` falso = sem leitura (quem não tem a capacidade nunca chama a função). */
export function usePlaygroundEval(unitId: string | null, enabled = true): PlaygroundSnapshot & { refetch: () => Promise<void> } {
  useEffect(() => {
    if (!unitId || !enabled) return;
    retain(unitId);
    return release;
  }, [unitId, enabled]);
  const snap = useSyncExternalStore(subscribe, () => snapshot);
  return { ...snap, refetch: refetchPlaygroundEval };
}

/** Contagem do selo da navegação. */
export function usePlaygroundBadge(unitId: string | null, enabled = true) {
  const { data } = usePlaygroundEval(unitId, enabled);
  const visits = data?.visits ?? [];
  const pending = data?.pendingConclusions;
  const total = badgeTotal(visits);
  const attention = badgeCount(visits, pending);
  // Conclusão pendente é de visitas de dias anteriores: sem agendadas hoje, o selo mostra quantas faltam concluir.
  return {
    count: total > 0 ? total : (pending?.length ?? 0),
    attention,
    blink: badgeBlinks(visits, pending),
    urgent: badgeIsUrgent(visits, pending),
  };
}
