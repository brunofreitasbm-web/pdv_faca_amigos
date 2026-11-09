import { useEffect, useState } from "react";
import { Button, Badge, HelpText, Select } from "@facaamigos/ui";
import { Card } from "../GCard.js";
import { useAppState } from "../../../state/AppState.js";
import { Api, businessDateFor } from "../../../api/client.js";
import { money } from "../../../format.js";
import { supabase } from "../../../lib/supabase/client.js";
import { averageScore, summarizeNps } from "../../../lib/nps.js";
import { sumKnownCounts } from "../../../lib/sumKnownCounts.js";
import { Emoji3D, renderEmoji } from "../../../components/Emoji3D.js";

interface UnitMetric {
  unitId: string;
  unitName: string;
  kind: string;
  goalCents: number;
  revenueCents: number;
  ordersCount: number;
  /** null = consulta falhou (desconhecido, não zero). */
  activeSessionsCount: number | null;
}

interface NpsLogItem {
  id: string;
  code: string;
  playgroundScore: number | null;
  circuitoScore: number | null;
  teamScore?: number | null;
  spaceScore?: number | null;
  feedback: string;
  activity: string | null;
  createdAt: string;
}

export function OwnerAcompanhamentoTab() {
  const { units } = useAppState();
  const [selectedUnitId, setSelectedUnitId] = useState<string>("ALL");
  const [unitMetrics, setUnitMetrics] = useState<UnitMetric[]>([]);
  const [npsLogs, setNpsLogs] = useState<NpsLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  async function loadDashboardData() {
    setLoading(true);
    try {
      // 1. Carrega Métricas das Unidades
      const metrics: UnitMetric[] = await Promise.all(
        units.map(async (unit) => {
          const cutoff = unit.business_day_cutoff_hour;
          const [goalCents, revenue, ticketMedio] = await Promise.all([
            Api.todayGoal(unit.id, cutoff).catch(() => 0),
            Api.todayRevenue(unit.id, cutoff).catch(() => ({ totalCents: 0 })),
            Api.todayTicketMedio(unit.id, cutoff).catch(() => ({ ordersCount: 0 })),
          ]);

          // Sessões em andamento. Pausa é paused_at_ms não nulo com status
          // ATIVA (não existe status PAUSADA gravado), então já entram aqui.
          // Falha vira null (desconhecido), nunca 0.
          let activeSessionsCount: number | null = null;
          try {
            const { count, error } = await supabase()
              .from("fa_kiosk_sessions")
              .select("id", { count: "exact", head: true })
              .eq("unit_id", unit.id)
              .eq("status", "ATIVA");
            if (error) console.warn("Owner: falha ao contar sessões ativas", unit.id, error.message);
            else activeSessionsCount = count ?? 0;
          } catch (err) {
            console.warn("Owner: falha ao contar sessões ativas", unit.id, err);
          }

          return {
            unitId: unit.id,
            unitName: unit.name,
            kind: unit.kind,
            goalCents: goalCents || 0,
            revenueCents: revenue.totalCents || 0,
            ordersCount: ticketMedio.ordersCount || 0,
            activeSessionsCount,
          };
        })
      );
      setUnitMetrics(metrics);

      // NPS respondido por WhatsApp (CRM) — a pesquisa não é mais feita na tela
      // de acompanhamento do responsável; todas as notas chegam por aqui.
      try {
        const crm = await Api.crmNpsFeed(20);
        const fromCrm: NpsLogItem[] = crm.map((r) => {
          const circuito = r.brand.toLowerCase().includes("circuito");
          return {
            id: `crm-${r.id}`,
            code: `WhatsApp · ${r.brand}`,
            playgroundScore: circuito ? null : r.score,
            circuitoScore: circuito ? r.score : null,
            teamScore: r.score_team,
            spaceScore: r.score_space,
            feedback: r.feedback ?? "",
            activity: circuito ? "CARRINHO" : "PLAYGROUND",
            createdAt: new Date(Number(r.scored_at_ms)).toISOString(),
          };
        });
        setNpsLogs((prev) =>
          [...prev, ...fromCrm].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 30),
        );
      } catch {
        // sem permissão de CRM ou migration ainda não aplicada: lista de NPS fica vazia
      }
    } catch (err) {
      console.error("Erro ao carregar dados do painel do Owner:", err);
    } finally {
      setLoading(false);
      setLastRefreshed(new Date());
    }
  }

  useEffect(() => {
    loadDashboardData();
    const interval = setInterval(loadDashboardData, 30_000); // Auto-refresh a cada 30s
    return () => clearInterval(interval);
  }, [units]);

  const filteredMetrics = selectedUnitId === "ALL"
    ? unitMetrics
    : unitMetrics.filter((m) => m.unitId === selectedUnitId);

  const totalRevenue = filteredMetrics.reduce((acc, m) => acc + m.revenueCents, 0);
  const totalGoal = filteredMetrics.reduce((acc, m) => acc + m.goalCents, 0);
  const totalOrders = filteredMetrics.reduce((acc, m) => acc + m.ordersCount, 0);
  const totalActiveSessions = sumKnownCounts(filteredMetrics.map((m) => m.activeSessionsCount));

  const goalPercent = totalGoal > 0 ? Math.min(100, Math.round((totalRevenue / totalGoal) * 100)) : null;

  // Cálculo de média NPS
  const validScores = npsLogs.flatMap((n) => [n.playgroundScore, n.circuitoScore].filter((s): s is number => s !== null));
  const avgNps = validScores.length > 0
    ? (validScores.reduce((a, b) => a + b, 0) / validScores.length).toFixed(1)
    : null;
  const npsSummary = summarizeNps(validScores);
  const avgTeam = averageScore(npsLogs.flatMap((n) => (n.teamScore != null ? [n.teamScore] : [])));
  const avgSpace = averageScore(npsLogs.flatMap((n) => (n.spaceScore != null ? [n.spaceScore] : [])));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px", padding: "8px 0 32px" }}>
      {/* Header do Painel Owner */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
          color: "#ffffff",
          padding: "20px 24px",
          borderRadius: "16px",
          boxShadow: "0 8px 24px rgba(15, 23, 42, 0.15)",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <span
              style={{
                background: "linear-gradient(135deg, var(--color-success) 0%, var(--color-success-text) 100%)",
                color: "#ffffff",
                fontSize: "11px",
                fontWeight: "bold",
                padding: "3px 10px",
                borderRadius: "9999px",
                letterSpacing: "0.5px",
              }}
            >
              <Emoji3D e="👑" /> PAINEL OWNER
            </span>
            <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
              Atualizado às {lastRefreshed.toLocaleTimeString("pt-BR")}
            </span>
          </div>
          <h2 style={{ margin: 0, fontSize: "22px", fontFamily: "var(--font-display)", color: "var(--surface-sunken)" }}>
            Visualização & Acompanhamento Geral
          </h2>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ width: "200px" }}>
            <Select
              value={selectedUnitId}
              onChange={(e) => setSelectedUnitId(e.target.value)}
              style={{ background: "#334155", color: "#ffffff", borderColor: "#475569" }}
            >
              <option value="ALL">Todas as 3 Unidades</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" onClick={loadDashboardData} disabled={loading}>
            {loading ? "Atualizando..." : renderEmoji("🔄 Atualizar")}
          </Button>
        </div>
      </div>

      {/* Grid de KPIs Superiores */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "16px",
        }}
      >
        {/* Card Faturamento vs Meta */}
        <Card style={{ padding: "20px", borderLeft: "4px solid var(--color-teal-text)" }}>
          <span style={{ fontSize: "12px", fontWeight: "bold", color: "var(--text-muted)", textTransform: "uppercase" }}>
            Faturamento Consolidado
          </span>
          <div style={{ fontSize: "28px", fontWeight: "bold", color: "var(--text-primary)", margin: "6px 0 2px" }}>
            {money(totalRevenue)}
          </div>
          {totalGoal > 0 ? (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--text-secondary)", marginBottom: "4px" }}>
                <span>Meta: {money(totalGoal)}</span>
                <strong>{goalPercent}%</strong>
              </div>
              <div style={{ width: "100%", height: "6px", background: "var(--border-subtle)", borderRadius: "9999px", overflow: "hidden" }}>
                <div
                  style={{
                    width: `${goalPercent}%`,
                    height: "100%",
                    background: "linear-gradient(90deg, var(--color-teal-text) 0%, var(--color-success) 100%)",
                  }}
                />
              </div>
            </div>
          ) : (
            <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>Sem meta configurada</span>
          )}
        </Card>

        {/* Card Total de Vendas */}
        <Card style={{ padding: "20px", borderLeft: "4px solid var(--color-teal)" }}>
          <span style={{ fontSize: "12px", fontWeight: "bold", color: "var(--text-muted)", textTransform: "uppercase" }}>
            Total de Vendas / Ingressos
          </span>
          <div style={{ fontSize: "28px", fontWeight: "bold", color: "var(--text-primary)", margin: "6px 0 2px" }}>
            {totalOrders}
          </div>
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>Atendimentos registrados hoje</span>
        </Card>

        {/* Card Sessões Ativas Agora */}
        <Card style={{ padding: "20px", borderLeft: "4px solid var(--color-amber)" }}>
          <span style={{ fontSize: "12px", fontWeight: "bold", color: "var(--text-muted)", textTransform: "uppercase" }}>
            Crianças Brincando Agora
          </span>
          <div style={{ fontSize: "28px", fontWeight: "bold", color: "var(--text-primary)", margin: "6px 0 2px" }}>
            {totalActiveSessions ?? "—"}
          </div>
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>Sessões em andamento (inclui pausadas)</span>
        </Card>

        {/* Card Média NPS */}
        <Card style={{ padding: "20px", borderLeft: "4px solid var(--color-amber)" }}>
          <span style={{ fontSize: "12px", fontWeight: "bold", color: "var(--text-muted)", textTransform: "uppercase" }}>
            NPS
          </span>
          <div style={{ fontSize: "28px", fontWeight: "bold", color: "var(--text-primary)", margin: "6px 0 2px" }}>
            {npsSummary.nps !== null ? (npsSummary.nps > 0 ? `+${npsSummary.nps}` : npsSummary.nps) : "—"}
          </div>
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            {npsLogs.length} avaliações · nota média {avgNps ?? "—"}/10
            {avgTeam !== null && ` · equipe ${avgTeam.toFixed(1)}/5`}
            {avgSpace !== null && ` · espaço ${avgSpace.toFixed(1)}/5`}
          </span>
        </Card>
      </div>

      {/* Detalhamento por Unidade */}
      <div>
        <h3 style={{ fontSize: "17px", color: "var(--text-primary)", fontFamily: "var(--font-display)", marginBottom: "12px" }}>
          Acompanhamento por Operação
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
          {filteredMetrics.map((m) => {
            const unitGoalPercent = m.goalCents > 0 ? Math.min(100, Math.round((m.revenueCents / m.goalCents) * 100)) : null;
            return (
              <Card key={m.unitId} style={{ padding: "18px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
                  <strong style={{ fontSize: "16px", color: "var(--text-primary)" }}>{m.unitName}</strong>
                  <Badge variant={m.kind === "QUIOSQUE" ? "vip" : "teal"}>
                    {m.kind === "QUIOSQUE" ? "CIRCUITO" : "PLAYGROUND"}
                  </Badge>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px" }}>
                    <span style={{ color: "var(--text-muted)" }}>Faturamento:</span>
                    <strong style={{ color: "var(--text-primary)" }}>{money(m.revenueCents)}</strong>
                  </div>

                  {m.goalCents > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                      <span style={{ color: "var(--text-muted)" }}>Meta ({money(m.goalCents)}):</span>
                      <strong style={{ color: unitGoalPercent && unitGoalPercent >= 100 ? "var(--color-success)" : "var(--color-teal-text)" }}>
                        {unitGoalPercent}% Atingido
                      </strong>
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                    <span style={{ color: "var(--text-muted)" }}>Vendas Realizadas:</span>
                    <strong>{m.ordersCount} pedidos</strong>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                    <span style={{ color: "var(--text-muted)" }}>Sessões Ativas:</span>
                    <strong>{m.activeSessionsCount === null ? "—" : `${m.activeSessionsCount} ativas`}</strong>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Feed de Avaliações NPS dos Clientes */}
      <Card style={{ padding: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "17px", color: "var(--text-primary)", fontFamily: "var(--font-display)" }}>
              <Emoji3D e="💬" /> Feed de Avaliações NPS (Playground & Circuito)
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: "13px", color: "var(--text-muted)" }}>
              Feed ao vivo das notas de 0 a 10 e opiniões enviadas pelos responsáveis ao término da sessão.
            </p>
          </div>
          {avgNps !== null && (
            <div style={{ textAlign: "right" }}>
              <span style={{ fontSize: "20px", fontWeight: "bold", color: "var(--color-teal-text)" }}>{avgNps} / 10</span>
              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>Nota Global Média</div>
            </div>
          )}
        </div>

        {npsLogs.length === 0 ? (
          <HelpText style={{ textAlign: "center", padding: "24px 0" }}>
            Nenhuma avaliação NPS registrada hoje ainda. As notas respondidas pelos clientes na pesquisa de NPS do WhatsApp (CRM) aparecerão aqui. <Emoji3D e="🌟" />
          </HelpText>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {npsLogs.map((log) => {
              const maxScore = Math.max(log.playgroundScore ?? -1, log.circuitoScore ?? -1);
              let scoreBadgeBg = "var(--border-subtle)";
              let scoreBadgeColor = "var(--text-secondary)";
              let scoreLabel = "Neutro";

              if (maxScore >= 9) {
                scoreBadgeBg = "rgba(40, 200, 128, 0.12)";
                scoreBadgeColor = "var(--color-success-text)";
                scoreLabel = "Promotor ⭐";
              } else if (maxScore >= 7) {
                scoreBadgeBg = "rgba(201, 144, 32, 0.12)";
                scoreBadgeColor = "var(--color-amber-text)";
                scoreLabel = "Neutro";
              } else if (maxScore >= 0) {
                scoreBadgeBg = "rgba(232, 48, 48, 0.1)";
                scoreBadgeColor = "var(--color-error-text)";
                scoreLabel = "Detrator";
              }

              return (
                <div
                  key={log.id}
                  style={{
                    padding: "14px 16px",
                    borderRadius: "12px",
                    background: "var(--surface-sunken)",
                    border: "1px solid var(--border-subtle)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span
                        style={{
                          background: scoreBadgeBg,
                          color: scoreBadgeColor,
                          fontWeight: "bold",
                          fontSize: "12px",
                          padding: "2px 8px",
                          borderRadius: "6px",
                        }}
                      >
                        {renderEmoji(scoreLabel)}
                      </span>
                      <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                        Código: <strong>{log.code}</strong>
                      </span>
                    </div>
                    <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                      {log.createdAt ? new Date(log.createdAt).toLocaleTimeString("pt-BR") : ""}
                    </span>
                  </div>

                  <div style={{ display: "flex", gap: "16px", fontSize: "13px" }}>
                    {log.playgroundScore !== null && (
                      <div>
                        <span style={{ color: "var(--text-muted)" }}>Playground: </span>
                        <strong style={{ color: "var(--text-primary)" }}>{log.playgroundScore} / 10</strong>
                      </div>
                    )}
                    {log.circuitoScore !== null && (
                      <div>
                        <span style={{ color: "var(--text-muted)" }}>Circuito: </span>
                        <strong style={{ color: "var(--text-primary)" }}>{log.circuitoScore} / 10</strong>
                      </div>
                    )}
                    {log.teamScore != null && (
                      <div>
                        <span style={{ color: "var(--text-muted)" }}>Equipe: </span>
                        <strong style={{ color: "var(--text-primary)" }}>{log.teamScore} / 5</strong>
                      </div>
                    )}
                    {log.spaceScore != null && (
                      <div>
                        <span style={{ color: "var(--text-muted)" }}>Espaço: </span>
                        <strong style={{ color: "var(--text-primary)" }}>{log.spaceScore} / 5</strong>
                      </div>
                    )}
                  </div>

                  {log.feedback && (
                    <div style={{ fontSize: "13px", color: "var(--text-secondary)", fontStyle: "italic", background: "var(--surface-card)", padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--border-subtle)" }}>
                      "{log.feedback}"
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
