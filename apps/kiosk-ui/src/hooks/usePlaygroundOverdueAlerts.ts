import { useEffect, useRef } from "react";
import { usePlaygroundEval } from "../api/usePlaygroundEval.js";
import { newlyOverdue, overdueMessage, type PlaygroundVisit } from "../lib/playgroundEval.js";
import { useToast } from "../state/ToastContext.js";

/**
 * Avisa por toast, em qualquer tela, quando uma avaliação passa a Atrasada:
 * "Avaliação de Fulano atrasada: chame o terapeuta". Só dispara na virada
 * (comparando duas leituras seguidas), nunca na primeira leitura.
 */
export function usePlaygroundOverdueAlerts(unitId: string | null | undefined, enabled: boolean): void {
  const toast = useToast();
  const { data } = usePlaygroundEval(unitId ?? null, enabled);
  const prev = useRef<PlaygroundVisit[] | null>(null);

  useEffect(() => {
    if (!enabled || !data) return;
    for (const v of newlyOverdue(prev.current, data.visits)) toast.error(overdueMessage(v.displayName));
    prev.current = data.visits;
  }, [data, enabled, toast]);

  useEffect(() => {
    prev.current = null;
  }, [unitId]);
}
