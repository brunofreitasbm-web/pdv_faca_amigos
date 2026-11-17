import { useMemo, useState } from "react";
import { Api } from "../api/client.js";
import { usePlaygroundEval } from "../api/usePlaygroundEval.js";
import { useAuth } from "../auth/AuthContext.js";
import { useAppState } from "../state/AppState.js";
import { useToast } from "../state/ToastContext.js";
import { EvaluationPanel } from "../components/playground/EvaluationPanel.js";
import { PlaygroundAlertStrip } from "../components/playground/PlaygroundAlertStrip.js";
import { VisitCard } from "../components/playground/VisitCard.js";
import { sortVisits } from "../lib/playgroundEval.js";

/**
 * Aba "Avaliações": a fila do dia, uma criança por card. O caixa toca Chegou/Saiu
 * no card; o terapeuta toca no card (depois da chegada) e avalia no painel lateral.
 *
 * Esta tela NÃO envia nada ao responsável: não usa o disparo do Olhar, não grava
 * em relatórios de sessão nem no CRM. Tudo passa pela função playground-eval-bridge.
 */
export function AvaliacoesScreen() {
  const { unit } = useAppState();
  const { can } = useAuth();
  const toast = useToast();
  const canPresence = can("avaliacao_playground.presenca");
  const canEvaluate = can("avaliacao_playground.write");
  const { data, error, loading, refetch } = usePlaygroundEval(unit?.id ?? null);
  const [openVisitId, setOpenVisitId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const visits = useMemo(() => sortVisits(data?.visits ?? []), [data]);
  const open = visits.find((v) => v.visitId === openVisitId) ?? null;

  async function presence(visitId: string, action: "arrive" | "leave") {
    if (!unit) return;
    setBusyId(visitId);
    try {
      await Api.playgroundEval(action, { unitId: unit.id, visitId, at: new Date().toISOString(), deviceId: (await Api.deviceId()) ?? "navegador" });
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível marcar: tente de novo.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: "14px" }}>
      <h1 style={{ margin: 0, fontSize: "24px" }}>Avaliações de hoje</h1>

      {error && (
        <div role="status" style={{ padding: "8px 14px", borderRadius: "10px", background: "var(--surface-sunken)", fontSize: "14px" }}>
          {error}
        </div>
      )}

      {data && <PlaygroundAlertStrip visits={data.visits} pending={data.pendingConclusions ?? []} />}

      {loading && !data && <div style={{ color: "var(--text-muted)" }}>Carregando...</div>}
      {data && !data.protocolConfigured && <div style={{ color: "var(--text-muted)" }}>Avaliação ainda não configurada.</div>}
      {data && data.protocolConfigured && visits.length === 0 && <div style={{ color: "var(--text-muted)" }}>Nenhuma criança agendada para hoje.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {visits.map((v) => (
          <VisitCard
            key={v.visitId}
            visit={v}
            canPresence={canPresence}
            canEvaluate={canEvaluate}
            busy={busyId === v.visitId}
            onOpen={() => setOpenVisitId(v.visitId)}
            onPresence={(a) => void presence(v.visitId, a)}
          />
        ))}
      </div>

      {open && data && unit && canEvaluate && (
        <EvaluationPanel
          key={open.visitId}
          unitId={unit.id}
          visit={open}
          domains={data.catalogs[String(open.level)] ?? []}
          series={data.state[open.seriesId]}
          therapists={data.therapists}
          freeAuthor={data.freeAuthor}
          onClose={() => setOpenVisitId(null)}
          onSaved={() => void refetch()}
        />
      )}
    </div>
  );
}
