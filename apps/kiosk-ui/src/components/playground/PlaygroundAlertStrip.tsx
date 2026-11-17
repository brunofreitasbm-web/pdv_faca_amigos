import type { PendingConclusion, PlaygroundVisit } from "../../lib/playgroundEval.js";

const dayMonth = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });

/** Faixa de alerta no topo: atrasadas (chamar o terapeuta) e conclusões pendentes. Sem botão de concluir. */
export function PlaygroundAlertStrip({ visits, pending }: { visits: readonly PlaygroundVisit[]; pending: readonly PendingConclusion[] }) {
  const overdue = visits.filter((v) => v.status === "atrasada");
  if (overdue.length === 0 && pending.length === 0) return null;
  const box = { padding: "10px 16px", borderRadius: "12px", fontSize: "15px", fontWeight: 600 } as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {overdue.length > 0 && (
        <div role="alert" style={{ ...box, background: "var(--color-error-text, #b3261e)", color: "#fff" }}>
          {overdue.length === 1 ? `Avaliação de ${overdue[0]!.displayName} atrasada: chame o terapeuta` : `${overdue.length} avaliações atrasadas: chame o terapeuta`}
        </div>
      )}
      {pending.length > 0 && (
        <div role="alert" style={{ ...box, background: "var(--color-amber)", color: "#1a1a1a" }}>
          Conclusão pendente: {pending.map((p) => `${p.displayName} (última visita em ${dayMonth(p.lastVisitStart)})`).join(", ")}
        </div>
      )}
    </div>
  );
}
