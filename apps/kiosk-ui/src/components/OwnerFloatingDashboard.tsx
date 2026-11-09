import React, { useEffect, useState, useCallback } from "react";
import { useAppState } from "../state/AppState.js";
import { useAuth } from "../auth/AuthContext.js";
import { Api, businessDateFor } from "../api/client.js";
import type { Unit } from "../api/client.js";
import { money } from "../format.js";
import { Emoji3D } from "./Emoji3D.js";
import { startVisiblePolling } from "../lib/visiblePolling.js";

interface UnitSummary {
  unitId: string;
  unitName: string;
  revenueCents: number;
  sessionsCount: number;
}

export function OwnerFloatingDashboard() {
  const { employee, units } = useAppState();
  const { can } = useAuth();

  // Verifica se o usuário é OWNER (ADMIN ou possui capacidade de gestão)
  const isOwner = employee?.role === "ADMIN" || can("notificacoes.owner_push") || can("config.rbac.write");

  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [unitSummaries, setUnitSummaries] = useState<UnitSummary[]>([]);

  const totalRevenueCents = unitSummaries.reduce((acc, u) => acc + u.revenueCents, 0);
  const totalSessionsCount = unitSummaries.reduce((acc, u) => acc + u.sessionsCount, 0);

  const loadDashboardData = useCallback(async () => {
    if (!isOwner || units.length === 0) return;
    setLoading(true);

    try {
      const todayStr = businessDateFor(Date.now(), 3); // cutoff 3h

      const rawHourly = await Api.reportCheckinsByHour(null, todayStr, todayStr).catch(() => []);
      const sessionsCountByUnit = new Map<string, number>();
      for (const row of rawHourly) {
        const key = row.unit_id || row.unit_name;
        sessionsCountByUnit.set(key, (sessionsCountByUnit.get(key) ?? 0) + row.count);
      }

      const summaries: UnitSummary[] = await Promise.all(
        units.map(async (u: Unit) => {
          const cutoff = u.business_day_cutoff_hour ?? 3;
          const rev = await Api.todayRevenue(u.id, cutoff).catch(() => ({ totalCents: 0 }));
          const sessionsCount = sessionsCountByUnit.get(u.id) ?? sessionsCountByUnit.get(u.name) ?? 0;

          return {
            unitId: u.id,
            unitName: u.name,
            revenueCents: rev.totalCents,
            sessionsCount,
          };
        })
      );

      setUnitSummaries(summaries);
      setLastUpdated(
        new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      );
    } catch (err) {
      console.error("Erro ao carregar Dashboard Flutuante OWNER:", err);
    } finally {
      setLoading(false);
    }
  }, [isOwner, units]);

  useEffect(() => {
    if (!isOwner) return;
    // Antes: a cada 1 min em qualquer tela, mesmo escondida. Agora o ritmo
    // segue o uso (cartão aberto = alguém olhando) e para com a janela
    // oculta. Abrir o cartão reinicia o poll e recarrega na hora.
    return startVisiblePolling(() => void loadDashboardData(), isOpen ? 60_000 : 180_000);
  }, [isOwner, loadDashboardData, isOpen]);

  if (!isOwner) return null;

  // Botão flutuante fechado
  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        title="Abrir resumo do dia"
        style={{
          position: "fixed",
          bottom: "calc(24px + var(--install-banner-height, 0px))",
          right: "24px",
          zIndex: 999,
          padding: "10px 16px",
          borderRadius: "9999px",
          background: "linear-gradient(135deg, #0F172A 0%, #1E293B 100%)",
          color: "#2ECFB5",
          border: "1px solid rgba(46, 207, 181, 0.4)",
          boxShadow: "0 8px 30px rgba(0, 0, 0, 0.4)",
          fontWeight: 700,
          fontSize: "13px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <span><Emoji3D e="👑" /> {money(totalRevenueCents)}</span>
        <span style={{ color: "#CBD5E1", fontWeight: 500 }}>· {totalSessionsCount} sessões</span>
      </button>
    );
  }

  // Cartão compacto ancorado no canto — não é uma modal de tela cheia
  return (
    <div
      style={{
        position: "fixed",
        bottom: "calc(24px + var(--install-banner-height, 0px))",
        right: "24px",
        zIndex: 999,
        width: "300px",
        maxWidth: "calc(100vw - 32px)",
        background: "#0F172A",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        borderRadius: "16px",
        boxShadow: "0 20px 50px rgba(0, 0, 0, 0.6)",
        color: "#F8FAFC",
        overflow: "hidden",
      }}
    >
      {/* CABEÇALHO */}
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "linear-gradient(180deg, rgba(30, 41, 59, 0.6) 0%, rgba(15, 23, 42, 0.6) 100%)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: "13px", fontWeight: 800, color: "#FFFFFF" }}><Emoji3D e="👑" /> Hoje</span>
          <span style={{ fontSize: "11px", color: "#94A3B8" }}>
            {loading ? "Atualizando…" : lastUpdated ? `Atualizado às ${lastUpdated}` : ""}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <button
            type="button"
            onClick={loadDashboardData}
            disabled={loading}
            title="Atualizar agora"
            style={{
              background: "transparent",
              border: "none",
              color: "#94A3B8",
              fontSize: "14px",
              cursor: "pointer",
              padding: "4px",
              borderRadius: "6px",
            }}
          >
            <Emoji3D e="🔄" />
          </button>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            title="Fechar"
            style={{
              background: "transparent",
              border: "none",
              color: "#64748B",
              fontSize: "16px",
              cursor: "pointer",
              padding: "4px 6px",
              borderRadius: "6px",
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* LISTA POR UNIDADE */}
      <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: "10px" }}>
        {unitSummaries.map((u) => (
          <div
            key={u.unitId}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}
          >
            <span style={{ fontSize: "13px", color: "#CBD5E1", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <Emoji3D e="📍" /> {u.unitName}
            </span>
            <div style={{ display: "flex", alignItems: "baseline", gap: "6px", flexShrink: 0 }}>
              <span style={{ fontSize: "14px", fontWeight: 800, color: "#2ECFB5" }}>{money(u.revenueCents)}</span>
              <span style={{ fontSize: "12px", color: "#94A3B8" }}>· {u.sessionsCount} sessões</span>
            </div>
          </div>
        ))}

        {unitSummaries.length === 0 && !loading && (
          <span style={{ fontSize: "12px", color: "#64748B" }}>Sem dados para hoje ainda.</span>
        )}

        {units.length > 1 && unitSummaries.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              marginTop: "2px",
              paddingTop: "10px",
              borderTop: "1px solid rgba(255, 255, 255, 0.08)",
            }}
          >
            <span style={{ fontSize: "13px", color: "#F8FAFC", fontWeight: 800 }}>Total</span>
            <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
              <span style={{ fontSize: "15px", fontWeight: 800, color: "#2ECFB5" }}>{money(totalRevenueCents)}</span>
              <span style={{ fontSize: "12px", color: "#94A3B8" }}>· {totalSessionsCount} sessões</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
