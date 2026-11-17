import { useState } from "react";
import { Card, Button, HelpText } from "@facaamigos/ui";
import { Api } from "../api/client.js";

/**
 * Primeira camada de acesso: o aparelho só chega à tela de PIN depois de
 * ativado com o código de uso único gerado pelo Owner (Gerencial > Aparelhos).
 * Dura até o Owner revogar o aparelho.
 */
export function DeviceEnrollScreen({ onCancel }: { onCancel?: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await Api.enrollDevice(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível ativar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "80px auto", padding: "0 16px", display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 style={{ fontFamily: "var(--font-display)", textAlign: "center" }}>Ativar aparelho</h1>
      <Card style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <HelpText>
          Peça ao Owner para gerar um código em Gerencial &gt; Aparelhos e digite abaixo. Esse passo é feito uma vez por aparelho.
        </HelpText>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter" && code.replace(/[^A-Z0-9]/gi, "").length === 8 && !busy) void submit();
          }}
          placeholder="CÓDIGO DE 8 CARACTERES"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={12}
          aria-label="Código de ativação"
          style={{ fontSize: 22, letterSpacing: "0.2em", textAlign: "center", padding: 12, borderRadius: 12, border: "1px solid var(--border, #ccc)" }}
        />
        {error && <p style={{ color: "var(--color-error-text)", textAlign: "center", margin: 0 }}>{error}</p>}
        <Button onClick={() => void submit()} disabled={busy || code.replace(/[^A-Z0-9]/gi, "").length !== 8}>
          {busy ? "Ativando…" : "Ativar aparelho"}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            voltar para o PIN
          </Button>
        )}
      </Card>
    </div>
  );
}
