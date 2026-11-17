import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, HelpText, Modal, Select } from "@facaamigos/ui";
import {
  EMPLOYEE_SECTOR_OPTIONS,
  EMPLOYEE_SECTOR_OPTION_LABEL,
  SESSION_REPORT_CATALOG,
  sessionReportProgress,
  type EmployeeSectorOption,
} from "@facaamigos/domain";
import { Api, type SessionReportRow, type SessionReportWhatsappStatus } from "../../../api/client.js";
import { isWhatsappRefusal63049 } from "../../../api/useSessionReports.js";
import { useAppState } from "../../../state/AppState.js";
import { useToast } from "../../../state/ToastContext.js";
import { RequireCapability } from "../../../auth/RequireCapability.js";
import { LevelSegmented } from "../../../components/session-report/LevelSegmented.js";
import { renderEmoji } from "../../../components/Emoji3D.js";

const STATUS_LABEL: Record<SessionReportWhatsappStatus, string> = {
  PENDING: "Aguardando envio",
  SENT: "Enviado",
  SKIPPED_NO_CONSENT: "Sem autorização de WhatsApp",
  SKIPPED_OPT_OUT: "Pediu para não receber",
  SKIPPED_NO_PHONE: "Sem telefone",
  SKIPPED_NO_CHANNEL: "Sem número da unidade",
  SKIPPED_NO_TEMPLATE: "Sem modelo aprovado",
  FAILED: "Falha no envio",
  SENT_MANUAL: "Enviado manualmente",
};

const RETRYABLE: ReadonlySet<SessionReportWhatsappStatus> = new Set([
  "PENDING", "FAILED", "SKIPPED_NO_TEMPLATE", "SKIPPED_NO_CHANNEL", "SKIPPED_NO_CONSENT",
]);

const DAY_MS = 86_400_000;
const PERIODS = [
  { value: "7", label: "Últimos 7 dias" },
  { value: "30", label: "Últimos 30 dias" },
  { value: "90", label: "Últimos 90 dias" },
];

const dt = (ms: number) =>
  new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function RelatoriosSessaoTab() {
  return (
    <RequireCapability capability="relatorio_sessao.read">
      <Content />
    </RequireCapability>
  );
}

function Content() {
  const { units } = useAppState();
  const toast = useToast();
  const [unitId, setUnitId] = useState("");
  const [days, setDays] = useState("30");
  const [sector, setSector] = useState<"" | EmployeeSectorOption>("");
  const [status, setStatus] = useState<"" | SessionReportWhatsappStatus>("");
  const [rows, setRows] = useState<SessionReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionReportRow | null>(null);
  const [resending, setResending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const until = Date.now() + 60_000;
      setRows(await Api.sessionReportsList({ unitId: unitId || null, sinceMs: until - Number(days) * DAY_MS, untilMs: until }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar os relatórios");
    } finally {
      setLoading(false);
    }
  }, [unitId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) => (!sector || r.filled_by_sector_snapshot === sector) && (!status || r.whatsapp_status === status),
      ),
    [rows, sector, status],
  );

  const kpi = useMemo(() => {
    const total = filtered.length;
    const onTime = filtered.filter((r) => !r.late).length;
    const sent = filtered.filter((r) => r.whatsapp_status === "SENT").length;
    const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : "—");
    return { total, onTime: pct(onTime), sent: pct(sent) };
  }, [filtered]);

  const resend = async (r: SessionReportRow, regenerate = false) => {
    setResending(true);
    try {
      const res = await Api.sessionReportDispatch(r.id, { regenerate });
      if (res.status === "SENT" || res.alreadySent) toast.success("Registro enviado ao responsável.");
      else toast.error(res.error ?? "Não foi possível enviar.");
      await load();
      setDetail(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível enviar.");
    } finally {
      setResending(false);
    }
  };

  const openPdf = async (r: SessionReportRow) => {
    if (!r.pdf_path) return;
    try {
      window.open(await Api.sessionReportPdfUrl(r.pdf_path), "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível abrir o PDF.");
    }
  };

  const copyLink = async (r: SessionReportRow) => {
    if (!r.public_token) return;
    try {
      await navigator.clipboard.writeText(Api.sessionReportPublicLink(r.public_token));
      toast.success("Link copiado.");
    } catch {
      toast.error("Não foi possível copiar o link.");
    }
  };

  const sendManualPdf = async (r: SessionReportRow) => {
    setResending(true);
    try {
      await Api.sessionReportSendManualPdf(r.id);
      toast.success("WhatsApp aberto com a mensagem padrão e o PDF!");
      await load();
      setDetail(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível preparar o envio do PDF.");
    } finally {
      setResending(false);
    }
  };

  const unitName = (id: string) => units.find((u) => u.id === id)?.name ?? "—";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div>
        <HelpText>
          Mapa de observação de cada sessão de 1h ou mais: quem preencheu, em qual setor, se foi no prazo de 40 minutos e a mensagem enviada ao responsável.
        </HelpText>
      </div>

      <div style={{ display: "flex", gap: "10px 20px", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between" }}>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <Select aria-label="Unidade" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          <option value="">Todas as unidades</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </Select>
        <Select aria-label="Período" value={days} onChange={(e) => setDays(e.target.value)}>
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </Select>
        <Select aria-label="Setor de quem preencheu" value={sector} onChange={(e) => setSector(e.target.value as "" | EmployeeSectorOption)}>
          <option value="">Todos os setores</option>
          {EMPLOYEE_SECTOR_OPTIONS.map((s) => (
            <option key={s} value={s}>{EMPLOYEE_SECTOR_OPTION_LABEL[s]}</option>
          ))}
        </Select>
        <Select aria-label="Situação do envio" value={status} onChange={(e) => setStatus(e.target.value as "" | SessionReportWhatsappStatus)}>
          <option value="">Todos os envios</option>
          {(Object.keys(STATUS_LABEL) as SessionReportWhatsappStatus[]).map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </Select>
      </div>

      <div style={{ display: "flex", gap: "18px", flexWrap: "wrap" }}>
        {[
          { label: "Relatórios", value: String(kpi.total) },
          { label: "Dentro do prazo (40 min)", value: kpi.onTime },
          { label: "Enviados ao responsável", value: kpi.sent },
        ].map((k) => (
          <div key={k.label} style={{ lineHeight: 1.1 }}>
            <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{k.label}</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: "20px" }}>{k.value}</div>
          </div>
        ))}
      </div>
      </div>

      {error && (
        <div role="alert" style={{ color: "var(--color-error-text)", fontSize: "14px" }}>{error}</div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table className="report-table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>Criança</th>
              <th>Unidade</th>
              <th>Saída</th>
              <th>Preenchido por</th>
              <th>Prazo</th>
              <th>Itens</th>
              <th>WhatsApp</th>
              <th style={{ textAlign: "right" }}>Enviar Manual</th>
            </tr>
          </thead>
          <tbody>
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={8} style={{ color: "var(--text-muted)" }}>Nenhum relatório neste filtro.</td>
              </tr>
            )}
            {filtered.map((r) => (
              <tr key={r.id} onClick={() => setDetail(r)} style={{ cursor: "pointer" }}>
                <td>
                  {r.child_name_snapshot}
                  {r.olhar_seq ? (
                    <span style={{ marginLeft: "6px" }}>
                      <Badge variant={r.olhar_edition === "MARCO" ? "teal" : "amber"}>
                        {r.olhar_seq}º Olhar{r.olhar_edition === "MARCO" ? " · Marco" : ""}
                      </Badge>
                    </span>
                  ) : null}
                </td>
                <td>{unitName(r.unit_id)}</td>
                <td>{dt(r.session_checkout_at_ms)}</td>
                <td>
                  {r.employee?.full_name ?? "—"}
                  {r.filled_by_sector_snapshot ? ` · ${EMPLOYEE_SECTOR_OPTION_LABEL[r.filled_by_sector_snapshot]}` : ""}
                </td>
                <td>{r.late ? <Badge variant="amber">Atrasado</Badge> : <Badge variant="teal">No prazo</Badge>}</td>
                <td>{sessionReportProgress(r.answers).answered}/{sessionReportProgress(r.answers).total}</td>
                <td>{STATUS_LABEL[r.whatsapp_status]}</td>
                <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right" }}>
                  <Button variant="teal" size="sm" loading={resending} onClick={() => void sendManualPdf(r)}>
                    Enviar Olhar FaçaAmigos em PDF (MANUAL)
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && (
        <Modal title={renderEmoji(`📝 ${detail.child_name_snapshot}`)} onClose={() => setDetail(null)} maxWidth="720px">
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ fontSize: "13px", color: "var(--text-muted)", lineHeight: 1.6 }}>
              Sessão de {detail.eligible_minutes} min · saída {dt(detail.session_checkout_at_ms)} · preenchido {dt(detail.filled_at_ms)}
              {detail.late ? " (fora do prazo)" : ""}
              <br />
              Por {detail.employee?.full_name ?? "—"}
              {detail.filled_by_sector_snapshot ? ` (${EMPLOYEE_SECTOR_OPTION_LABEL[detail.filled_by_sector_snapshot]})` : ""}
              {detail.device_id ? ` · terminal ${detail.device_id.slice(0, 8)}` : ""} · catálogo v{detail.catalog_version}
            </div>

            {SESSION_REPORT_CATALOG.map((sec) => {
              const answered = sec.items.filter((i) => detail.answers[i.key] != null);
              if (answered.length === 0) return null;
              return (
                <div key={sec.sector} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: "15px" }}>{renderEmoji(sec.emoji)} {sec.label}</div>
                  {answered.map((i) => (
                    <div key={i.key} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      <div style={{ fontSize: "13px", fontWeight: 600 }}>{i.label}</div>
                      <LevelSegmented label={i.label} value={detail.answers[i.key]} readOnly />
                    </div>
                  ))}
                </div>
              );
            })}

            {detail.observacao && (
              <div>
                <div style={{ fontWeight: 600, fontSize: "14px" }}>Observação</div>
                <div style={{ fontSize: "14px" }}>{detail.observacao}</div>
              </div>
            )}

            <div>
              <div style={{ fontWeight: 600, fontSize: "14px" }}>
                Mensagem ao responsável — {STATUS_LABEL[detail.whatsapp_status]}
                {detail.send_mode ? ` (${detail.send_mode === "TEMPLATE" ? "modelo aprovado" : "texto livre"})` : ""}
              </div>
              {detail.ai_message ? (
                <div style={{ fontSize: "14px", marginTop: "4px" }}>
                  {detail.ai_message}
                  {detail.ai_fallback && (
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
                      Texto padrão do sistema (a IA não respondeu ou usou termo não permitido).
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>Mensagem ainda não gerada.</div>
              )}
              {detail.whatsapp_error && (
                <div style={{ fontSize: "13px", color: "var(--color-error-text)", marginTop: "4px" }}>{detail.whatsapp_error}</div>
              )}
            </div>

            <div>
              <div style={{ fontWeight: 600, fontSize: "14px" }}>Olhar FaçaAmigos (PDF)</div>
              {detail.pdf_path ? (
                <div style={{ fontSize: "13px", color: "var(--text-muted)", marginTop: "2px" }}>
                  {detail.pdf_view_count > 0
                    ? `Aberto pelo responsável ${detail.pdf_view_count}× · última vez ${detail.pdf_last_viewed_at_ms ? dt(detail.pdf_last_viewed_at_ms) : "—"}`
                    : "Ainda não aberto pelo responsável."}
                  {detail.ai_report?.titulo ? ` · "${detail.ai_report.titulo}"` : ""}
                </div>
              ) : (
                <div style={{ fontSize: "13px", color: "var(--text-muted)", marginTop: "2px" }}>PDF ainda não gerado.</div>
              )}
            </div>

            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <Button variant="teal" loading={resending} onClick={() => void sendManualPdf(detail)}>
                Enviar Olhar FaçaAmigos em PDF (MANUAL)
              </Button>
              {detail.pdf_path && (
                <Button variant="secondary" onClick={() => void openPdf(detail)}>Abrir PDF</Button>
              )}
              {detail.public_token && detail.pdf_path && (
                <Button variant="secondary" onClick={() => void copyLink(detail)}>Copiar link</Button>
              )}
              {RETRYABLE.has(detail.whatsapp_status) && !isWhatsappRefusal63049(detail.whatsapp_error) && (
                <Button variant="secondary" loading={resending} onClick={() => void resend(detail)}>
                  Reenviar ao responsável
                </Button>
              )}
              {!isWhatsappRefusal63049(detail.whatsapp_error) && (
                <Button variant="secondary" loading={resending} onClick={() => void resend(detail, true)}>
                  Regerar e reenviar
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
