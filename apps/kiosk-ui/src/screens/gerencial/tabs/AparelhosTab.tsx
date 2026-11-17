import { useCallback, useEffect, useState } from "react";
import { HelpText, Button, Input, Select } from "@facaamigos/ui";
import { Card } from "../GCard.js";
import { Api } from "../../../api/client.js";
import type { KioskDevice, Unit } from "../../../api/client.js";

function fmt(ms: number | null) {
  return ms ? new Date(ms).toLocaleString("pt-BR") : "nunca";
}

export function AparelhosTab() {
  const [devices, setDevices] = useState<KioskDevice[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [unitId, setUnitId] = useState("");
  const [label, setLabel] = useState("");
  const [code, setCode] = useState<{ code: string; expiresAtMs: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setDevices(await Api.devicesList());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    Api.units().then((u) => {
      setUnits(u);
      setUnitId((cur) => cur || u[0]?.id || "");
    }).catch(() => undefined);
  }, [reload]);

  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setCode(await Api.deviceCreateCode(unitId, label.trim()));
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(d: KioskDevice) {
    if (!window.confirm(`Revogar "${d.label}"? O aparelho volta para a tela de ativação.`)) return;
    try {
      await Api.deviceRevoke(d.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const remaining = code ? Math.max(0, Math.round((code.expiresAtMs - now) / 1000)) : 0;
  const unitName = (id: string) => units.find((u) => u.id === id)?.name ?? "—";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card>
        <h3 style={{ marginTop: 0 }}>Cadastrar aparelho</h3>
        <HelpText>
          Gere um código, digite no aparelho novo (terminal, navegador ou celular). Vale uma vez e expira em 15 minutos.
        </HelpText>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <Select value={unitId} onChange={(e) => setUnitId(e.target.value)} aria-label="Unidade">
            {units.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </Select>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Nome (ex.: Balcão 1, Celular do Bruno)" maxLength={60} />
          <Button onClick={() => void generate()} disabled={busy || !unitId || !label.trim()}>Gerar código</Button>
        </div>
        {code && (
          <p style={{ fontSize: 32, letterSpacing: "0.25em", fontWeight: 800, margin: "16px 0 0" }}>
            {code.code} <span style={{ fontSize: 13, letterSpacing: 0, fontWeight: 600 }}>{remaining > 0 ? `expira em ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "expirado"}</span>
          </p>
        )}
        {error && <p style={{ color: "var(--color-error-text)" }}>{error}</p>}
      </Card>

      <Card>
        <h3 style={{ marginTop: 0 }}>Aparelhos</h3>
        {devices.length === 0 && <HelpText>Nenhum aparelho cadastrado.</HelpText>}
        {devices.map((d) => (
          <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid var(--border, #eee)", opacity: d.revoked_at_ms ? 0.5 : 1 }}>
            <div>
              <strong>{d.label}</strong> · {unitName(d.unit_id)}
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Ativado {fmt(d.created_at_ms)} · último uso {fmt(d.last_seen_ms)}
                {d.revoked_at_ms ? ` · revogado ${fmt(d.revoked_at_ms)}` : ""}
              </div>
            </div>
            {!d.revoked_at_ms && <Button onClick={() => void revoke(d)}>Revogar</Button>}
          </div>
        ))}
      </Card>
    </div>
  );
}
