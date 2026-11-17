import { usePlaygroundBadge } from "../../api/usePlaygroundEval.js";

/** Selo da navegação: total de avaliações do dia; pisca só quando alguma pede ação. */
export function PlaygroundBadge({ unitId }: { unitId: string | null }) {
  const { count, attention, blink, urgent } = usePlaygroundBadge(unitId);
  if (count === 0) return null;
  return (
    <span
      className={blink ? "playground-badge-blink" : undefined}
      aria-label={
        attention > 0
          ? `${count} avaliações hoje, ${attention} precisam de atenção`
          : `${count} avaliações agendadas hoje`
      }
      style={{
        marginLeft: "6px",
        minWidth: "20px",
        padding: "0 6px",
        borderRadius: "999px",
        fontSize: "12px",
        fontWeight: 700,
        lineHeight: "20px",
        textAlign: "center",
        display: "inline-block",
        background: urgent ? "var(--color-error-text, #b3261e)" : "var(--color-amber)",
        color: urgent ? "#fff" : "#1a1a1a",
      }}
    >
      {count}
    </span>
  );
}
