import { usePlaygroundBadge } from "../../api/usePlaygroundEval.js";

/** Selo da navegação: Avaliar agora + Atrasada + Confirmar saída + Conclusão pendente. */
export function PlaygroundBadge({ unitId }: { unitId: string | null }) {
  const { count, urgent } = usePlaygroundBadge(unitId);
  if (count === 0) return null;
  return (
    <span
      aria-label={`${count} avaliações precisam de atenção`}
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
