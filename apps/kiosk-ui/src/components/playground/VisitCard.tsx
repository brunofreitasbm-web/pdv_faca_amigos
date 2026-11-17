import type { KeyboardEvent, MouseEvent } from "react";
import { Button } from "@facaamigos/ui";
import {
  STATUS_LABEL,
  canOpenEvaluation,
  formatTime,
  isClosedStatus,
  presenceAction,
  type PlaygroundVisit,
  type VisitStatus,
} from "../../lib/playgroundEval.js";

const TONE: Record<VisitStatus, { bg: string; fg: string }> = {
  futura: { bg: "var(--surface-sunken)", fg: "var(--text-secondary)" },
  aguardando_chegada: { bg: "var(--surface-sunken)", fg: "var(--text-secondary)" },
  no_playground: { bg: "var(--color-teal)", fg: "#0b2e28" },
  confirmar_saida: { bg: "var(--color-amber)", fg: "#1a1a1a" },
  avaliar_agora: { bg: "var(--color-primary)", fg: "#ffffff" },
  atrasada: { bg: "var(--color-error-text, #b3261e)", fg: "#ffffff" },
  registrada_no_prazo: { bg: "var(--surface-sunken)", fg: "var(--text-secondary)" },
  registrada_com_atraso: { bg: "var(--surface-sunken)", fg: "var(--text-secondary)" },
  nao_feita: { bg: "var(--surface-sunken)", fg: "var(--text-secondary)" },
  faltou: { bg: "var(--surface-sunken)", fg: "var(--text-secondary)" },
  cancelada: { bg: "var(--surface-sunken)", fg: "var(--text-secondary)" },
};

/**
 * Um card grande por criança, clicável por inteiro (>= 48 px). O caixa
 * (`canPresence`) vê Chegou/Saiu no próprio card; o terapeuta toca no card
 * depois da chegada. Só primeiro nome, horário em destaque e idade.
 */
export function VisitCard({
  visit,
  canPresence,
  canEvaluate,
  busy,
  onOpen,
  onPresence,
}: {
  visit: PlaygroundVisit;
  canPresence: boolean;
  canEvaluate: boolean;
  busy: boolean;
  onOpen: () => void;
  onPresence: (action: "arrive" | "leave") => void;
}) {
  const tone = TONE[visit.status];
  const closed = isClosedStatus(visit.status);
  const openable = canEvaluate && canOpenEvaluation(visit);
  const action = canPresence ? presenceAction(visit) : null;

  const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

  return (
    <div
      role={openable ? "button" : undefined}
      tabIndex={openable ? 0 : undefined}
      aria-label={`${visit.displayName}, ${formatTime(visit.scheduledStart)}, ${STATUS_LABEL[visit.status]}`}
      onClick={openable ? onOpen : undefined}
      onKeyDown={openable ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen()) : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "16px",
        minHeight: "88px",
        padding: "14px 18px",
        borderRadius: "16px",
        border: `1px solid var(--border-subtle)`,
        borderLeft: `8px solid ${tone.bg}`,
        background: "var(--surface-card)",
        cursor: openable ? "pointer" : "default",
        opacity: closed ? 0.55 : 1,
      }}
    >
      <div style={{ minWidth: "76px", fontSize: "26px", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{formatTime(visit.scheduledStart)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "20px", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{visit.displayName}</div>
        <div style={{ fontSize: "14px", color: "var(--text-muted)" }}>
          {visit.ageLabel} · visita {visit.visitNo} de {visit.totalVisits}
        </div>
      </div>
      <span
        style={{ padding: "6px 12px", borderRadius: "999px", fontSize: "14px", fontWeight: 700, background: tone.bg, color: tone.fg, whiteSpace: "nowrap" }}
      >
        {STATUS_LABEL[visit.status]}
      </span>
      {action && (
        <Button
          variant={action === "arrive" ? "primary" : "teal"}
          size="lg"
          disabled={busy}
          onClick={(e) => {
            stop(e);
            onPresence(action);
          }}
          onKeyDown={stop}
          style={{ minHeight: "52px", minWidth: "110px" }}
        >
          {action === "arrive" ? "Chegou" : "Saiu"}
        </Button>
      )}
    </div>
  );
}
