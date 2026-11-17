import type { CSSProperties } from "react";

const OPTIONS: ReadonlyArray<{ score: 0 | 1 | 2; label: string; bg: string; fg: string }> = [
  { score: 0, label: "Não", bg: "var(--color-amber)", fg: "#1a1a1a" },
  { score: 1, label: "Parcial", bg: "var(--color-teal)", fg: "#0b2e28" },
  { score: 2, label: "Sim", bg: "var(--color-primary)", fg: "#ffffff" },
];

/** Três botões grandes (Não, Parcial, Sim), um toque por item. Tocar no marcado de novo limpa. */
export function ScoreSegmented({
  value,
  onChange,
  disabled,
  label,
}: {
  value: number | null | undefined;
  onChange: (next: 0 | 1 | 2 | null) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} style={{ display: "flex", gap: "6px", width: "100%" }}>
      {OPTIONS.map((o) => {
        const selected = value === o.score;
        const style: CSSProperties = {
          flex: 1,
          minHeight: "48px",
          borderRadius: "12px",
          border: selected ? "2px solid transparent" : "1px solid var(--border-subtle)",
          background: selected ? o.bg : "var(--surface-card)",
          color: selected ? o.fg : "var(--text-muted)",
          fontFamily: "inherit",
          fontSize: "15px",
          fontWeight: selected ? 700 : 500,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
        };
        return (
          <button key={o.score} type="button" aria-pressed={selected} disabled={disabled} style={style} onClick={() => onChange(selected ? null : o.score)}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
