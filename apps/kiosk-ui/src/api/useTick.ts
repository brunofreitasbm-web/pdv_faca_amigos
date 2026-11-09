import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase/client.js";
import { fetchActiveSessionsRaw, computeActiveSessionEntries } from "./client.js";
import type { ActiveSessionEntry, ActiveSessionsRaw } from "./client.js";

export type ActiveSessionsStatus = "loading" | "ready" | "error";

export interface ActiveSessionsResult {
  entries: ActiveSessionEntry[];
  /**
   * "loading" só é verdade na primeira busca de uma unidade. Existe
   * porque `entries` começa como `[]` e o Painel usava esse `[]` pra
   * decidir "nenhuma criança em atividade" — um estado vazio confiante e
   * ERRADO toda vez que a tela abria, na tela que controla quem paga.
   */
  status: ActiveSessionsStatus;
  /** Mensagem da última falha de busca, se `status === "error"`. */
  errorMessage: string | null;
  /** Força atualização imediata da lista sem esperar o Realtime ou polling. */
  refetch: () => Promise<void>;
}

/**
 * Fase 3: substitui o antigo canal WS de 1Hz (apps/kiosk/src/server/ws-tick.ts,
 * que reconsultava o SQLite local a cada segundo). Agora:
 * 1) os dados crus só são buscados quando algo muda de verdade (Supabase
 *    Realtime em fa_kiosk_sessions, ou uma vez no início);
 * 2) o valor/tempo exibido é recalculado localmente a cada segundo com
 *    `computeSessionTiming`/`quoteForSession` (packages/domain, puro),
 *    sem round-trip de rede — mais responsivo que o 1Hz antigo, porque
 *    uma troca de plano/checkout aparece na hora, via Realtime, em vez de
 *    esperar o próximo tick do servidor.
 */
export function useActiveSessions(unitId: string | null): ActiveSessionsResult {
  const [raw, setRaw] = useState<ActiveSessionsRaw>({
    sessions: [],
    planById: new Map(),
    guardianById: new Map(),
    assetById: new Map(),
    childById: new Map(),
    packageBalanceByGuardian: new Map(),
    clockOffsetMs: 0,
  });
  const [entries, setEntries] = useState<ActiveSessionEntry[]>([]);
  const [status, setStatus] = useState<ActiveSessionsStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const loadedOnce = useRef(false);

  const refetch = useCallback(async () => {
    if (!unitId) return;
    try {
      const data = await fetchActiveSessionsRaw(unitId);
      setRaw(data);
      setStatus("ready");
      setErrorMessage(null);
      loadedOnce.current = true;
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Não foi possível atualizar o painel.");
    }
  }, [unitId]);

  useEffect(() => {
    if (!unitId) return;
    loadedOnce.current = false;
    setStatus("loading");

    refetch();

    // Um check-in/checkout costuma gerar vários UPDATEs seguidos em
    // fa_kiosk_sessions, e cada evento disparava uma recarga completa (2
    // etapas, ~7 requisições) em CADA terminal da unidade. Agrupa a rajada
    // numa recarga só, 400 ms depois do último evento.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const onRealtimeEvent = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void refetch();
      }, 400);
    };

    let channel: ReturnType<ReturnType<typeof supabase>["channel"]> | null = null;
    try {
      // Nome único por instância e cleanup remove só o PRÓPRIO canal. Antes,
      // este efeito removia todo canal cujo tópico contivesse "fa_kiosk_sessions",
      // inclusive o de outra instância do hook montada ao mesmo tempo
      // (MobileShell + MobilePainel), que ficava sem Realtime.
      const channelName = `fa_kiosk_sessions_unit_${unitId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      channel = supabase()
        .channel(channelName)
        .on("postgres_changes", { event: "*", schema: "public", table: "fa_kiosk_sessions", filter: `unit_id=eq.${unitId}` }, onRealtimeEvent);

      channel.subscribe();
    } catch (err) {
      console.warn("Failed to subscribe to Realtime fa_kiosk_sessions:", err);
    }

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (channel) {
        try {
          supabase().removeChannel(channel);
        } catch (_) { /* melhor esforço: falha ignorada */ }
      }
    };
  }, [unitId, refetch]);

  useEffect(() => {
    setEntries(computeActiveSessionEntries(raw, Date.now()));
    const interval = setInterval(() => setEntries(computeActiveSessionEntries(rawRef.current, Date.now())), 1000);
    return () => clearInterval(interval);
  }, [raw]);

  return { entries, status, errorMessage, refetch };
}
