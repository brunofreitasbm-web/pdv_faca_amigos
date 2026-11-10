import { useState } from "react";
import { Card, Button, BrandLockup } from "@facaamigos/ui";
import { Emoji3D, renderEmoji } from "../components/Emoji3D.js";

interface SecretVaultReaderProps {
  secretId: string;
}

export function SecretVaultReader({ secretId }: SecretVaultReaderProps) {
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<string | null>(null);
  const [destroyed, setDestroyed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchSecret = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/secret/${secretId}`);
      const json = await res.json();

      if (!res.ok || json.error) {
        setError(json.message || "Este link seguro já foi lido e destruído ou expirou permanentemente.");
      } else {
        setPayload(json.payload);
        setDestroyed(json.destroyed);
      }
    } catch (err) {
      setError("Este link seguro expirou ou foi destruído após a primeira leitura.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!payload) return;
    navigator.clipboard.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div style={{ maxWidth: "560px", margin: "60px auto", padding: "24px", fontFamily: "var(--font-sans, sans-serif)" }}>
      <div style={{ textAlign: "center", marginBottom: "32px" }}>
        <BrandLockup />
      </div>

      <Card style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "20px", background: "rgba(255,255,255,0.9)", backdropFilter: "blur(10px)", border: "1px solid var(--border-color, #e0e0e0)", borderRadius: "16px", boxShadow: "0 12px 32px rgba(0,0,0,0.08)" }}>
        <div style={{ textAlign: "center" }}>
          <span style={{ fontSize: "42px", display: "block", marginBottom: "8px" }}><Emoji3D e="🔒" /></span>
          <h2 style={{ fontFamily: "var(--font-display, sans-serif)", margin: "0 0 8px 0", color: "#111827" }}>
            Cofre Seguro de Credenciais
          </h2>
          <p style={{ color: "#6b7280", fontSize: "14px", margin: 0 }}>
            Transmissão criptografada de chaves de API da Integração com Shopping.
          </p>
        </div>

        {error && (
          <div style={{ padding: "20px", borderRadius: "12px", background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", textAlign: "center" }}>
            <span style={{ fontSize: "32px", display: "block", marginBottom: "8px" }}><Emoji3D e="⏰" /></span>
            <strong style={{ fontSize: "16px" }}>Link Expirado ou Indisponível</strong>
            <p style={{ margin: "8px 0 0 0", fontSize: "13px", color: "#7f1d1d" }}>
              Este link de acesso ao cofre atingiu seu tempo limite de validade. Caso precise de um novo link, solicite o reenvio diretamente para seu e-mail de desenvolvimento.
            </p>
          </div>
        )}

        {!payload && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px", alignItems: "center" }}>
            <div style={{ padding: "12px 16px", borderRadius: "8px", background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af", fontSize: "13px", textAlign: "center" }}>
              <Emoji3D e="ℹ️" /> <strong>Link Permanente de Integração:</strong> Este link foi configurado para permanecer ativo durante o desenvolvimento da API sem autodestruir no primeiro clique.
            </div>

            <Button variant="primary" onClick={fetchSecret} disabled={loading} style={{ width: "100%", padding: "14px", fontSize: "16px" }}>
              {loading ? "Descriptografando..." : renderEmoji("🔓 Revelar Credenciais da API")}
            </Button>
          </div>
        )}

        {payload && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={{ padding: "12px 16px", borderRadius: "8px", background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", fontSize: "13px", textAlign: "center" }}>
              ✅ <strong>Credenciais Resgatadas com Sucesso!</strong> Link ativo e reutilizável pela equipe técnica durante a integração.
            </div>

            <div style={{ position: "relative" }}>
              <pre style={{ padding: "16px", background: "#1e293b", color: "#f8fafc", borderRadius: "8px", overflowX: "auto", fontSize: "13px", lineHeight: "1.5", margin: 0 }}>
                <code>{payload}</code>
              </pre>
            </div>

            <Button variant="primary" onClick={handleCopy} style={{ width: "100%", padding: "12px" }}>
              {copied ? "✓ Copiado para a Área de Transferência!" : renderEmoji("📋 Copiar Credenciais")}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
