import { useCallback, useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { Button, Input, Tag, HelpText, AsyncState, AutismRibbonIcon } from "@facaamigos/ui";
import { formatAccessCode } from "@facaamigos/domain";
import { Api, isWifiClinicCoupon } from "../api/client.js";
import type { ActiveSessionEntry, ResolvedAccessCode, Package, Coupon } from "../api/client.js";
import { useActiveSessions } from "../api/useTick.js";
import { useAppState } from "../state/AppState.js";
import { useToast } from "../state/ToastContext.js";
import { QrScanner } from "../components/QrScanner.js";
import { CheckoutModal } from "../components/CheckoutModal.js";
import { GeminiSalesCard } from "../components/GeminiSalesCard.js";
import { generateCheckoutSuggestions, type CheckoutOffer } from "../lib/geminiAgent.js";
import { formatElapsed, money } from "../format.js";

/**
 * Saída pela câmera do celular — o caminho padrão de check-out.
 *
 * O desenho da tela responde a uma restrição de operação: quem faz a saída
 * está de pé, com o celular numa mão, uma criança e um responsável na frente,
 * e normalmente mais gente esperando. Então:
 *
 *   - a câmera abre sozinha, sem botão de "iniciar";
 *   - a leitura já traz a criança e o VALOR na tela, sem passo intermediário;
 *   - o caminho feliz é um único toque depois de bipar ("Cobrar e liberar");
 *   - o preço não é recalculado aqui: sai do mesmo motor que o Painel usa,
 *     conferido de novo pelo banco no instante do fechamento.
 *
 * Digitar o código à mão fica sempre visível como segunda via — é o que
 * salva a operação quando a câmera está bloqueada, suja ou o celular é
 * antigo demais. Se nem isso resolver (recibo perdido E etiqueta danificada),
 * o caminho é o Painel: cada card tem "Saída manual" com conferência de
 * documento.
 */

const REASON_MESSAGE: Record<ResolvedAccessCode["reason"], string> = {
  OK: "",
  PAUSADA: "Esta criança está com o tempo pausado. Retome no Painel antes de fechar.",
  CODIGO_INVALIDO: "Código não reconhecido. Confira se leu o QR da pulseira ou do recibo de guarda.",
  NAO_ENCONTRADO: "Nenhuma criança no parque com este código.",
  OUTRA_UNIDADE: "Esta pulseira é de outra operação. Troque de módulo para fechar esta saída.",
  JA_FINALIZADA: "Esta criança já saiu — o atendimento dela foi fechado.",
};

export interface SaidaScreenProps {
  entriesOverride?: ActiveSessionEntry[];
}

export function SaidaScreen({ entriesOverride }: SaidaScreenProps = {}) {
  const { unit, employee } = useAppState();
  const toast = useToast();
  const activeSessionsRes = useActiveSessions(entriesOverride ? null : (unit?.id ?? null));
  const entries = entriesOverride ?? activeSessionsRes.entries;
  const sessionsStatus = entriesOverride ? "ready" : activeSessionsRes.status;

  const [resolved, setResolved] = useState<ResolvedAccessCode | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [lastReleased, setLastReleased] = useState<string | null>(null);
  // Congela o card no instante do clique em "Cobrar e liberar" — o
  // CheckoutModal já trava o valor cobrado nesse instante (closedAtMs),
  // mas sem isto o painel de confirmação por baixo do modal seguia
  // recalculando a cada segundo enquanto o operador escolhia a forma de
  // pagamento, dando a impressão de que o tempo/excedente continuava subindo.
  const [closingSnapshot, setClosingSnapshot] = useState<ActiveSessionEntry | null>(null);

  // A sessão vem da lista já carregada em vez de uma consulta nova: o valor a
  // cobrar precisa ser exatamente o mesmo que o Painel mostra no balcão, e
  // são no máximo algumas dezenas de crianças no espaço.
  const liveEntry: ActiveSessionEntry | undefined = resolved?.sessionId
    ? entries.find((e) => e.session.id === resolved.sessionId)
    : undefined;
  const entry: ActiveSessionEntry | undefined = closingSnapshot ?? liveEntry;
  const isNeurodivergent = Boolean(
    entry &&
      (entry.session.child_inclusive_eligible ||
        (entry.session.sensory_tags?.length ?? 0) > 0 ||
        entry.session.notes?.toLowerCase().includes("neuro") ||
        entry.session.notes?.toLowerCase().includes("autis") ||
        entry.session.notes?.toLowerCase().includes("tea") ||
        entry.session.child_name_snapshot.includes("🧩")),
  );

  const busyRef = useRef(false);
  // Desktop (mouse/teclado, leitor de código de barras USB que "digita" o
  // código): a tela solta cuida de foco e teclado. Embutida no modal do
  // Painel (entriesOverride) o próprio modal já gerencia o foco.
  const standalone = !entriesOverride;
  const codeInputRef = useRef<HTMLInputElement>(null);
  const resolvedAtRef = useRef(0);

  const handleCode = useCallback(
    async (rawValue: string) => {
      if (!unit || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setProblem(null);
      setLastReleased(null);
      try {
        const result = await Api.resolveAccessCode(unit.id, rawValue, employee?.id);
        if (result.reason === "OK") {
          resolvedAtRef.current = Date.now();
          setResolved(result);
        } else {
          setResolved(null);
          setProblem(
            result.reason === "JA_FINALIZADA" && result.childName
              ? `${result.childName} já saiu — o atendimento dela foi fechado.`
              : REASON_MESSAGE[result.reason],
          );
        }
      } catch (err) {
        setResolved(null);
        setProblem(err instanceof Error ? err.message : "Não foi possível consultar este código.");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [unit, employee?.id],
  );

  // A leitura resolvida vira nula se a criança sumir da lista de ativas
  // (outro terminal fechou a sessão enquanto esta tela estava aberta).
  useEffect(() => {
    if (resolved?.sessionId && sessionsStatus === "ready" && !entry && !checkoutOpen) {
      setResolved(null);
      setProblem("Esta sessão foi fechada em outro dispositivo.");
    }
  }, [resolved?.sessionId, sessionsStatus, entry, checkoutOpen]);

  const [checkoutOffers, setCheckoutOffers] = useState<CheckoutOffer[]>([]);
  const [loadingCheckoutOffers, setLoadingCheckoutOffers] = useState(false);
  const [checkoutPackages, setCheckoutPackages] = useState<Package[]>([]);
  const [checkoutCoupons, setCheckoutCoupons] = useState<Coupon[]>([]);

  // Catálogo real de pacotes e cupons desta unidade, para a ZoeIA só sugerir
  // ofertas de retenção que existem de fato — nunca nomes inventados.
  useEffect(() => {
    if (!unit) return;
    const activity = unit.kind === "QUIOSQUE" ? "CARRINHO" : "PLAYGROUND";
    Api.packages(unit.id, activity).then(setCheckoutPackages);
    Api.coupons(unit.id).then((list) => setCheckoutCoupons(list.filter((c) => !isWifiClinicCoupon(c.code))));
  }, [unit?.id, unit?.kind]);

  useEffect(() => {
    if (!resolved?.sessionId || !entry || !unit) {
      setCheckoutOffers([]);
      return;
    }
    let active = true;
    setLoadingCheckoutOffers(true);
    const elapsedMin = Math.round((entry.quote.timing.elapsedMs || 0) / 60_000);
    generateCheckoutSuggestions({
      childName: entry.session.child_name_snapshot,
      durationMinutes: elapsedMin,
      extraMinutes: entry.quote.timing.overMinutes,
      totalPaidCents: entry.quote.totalCents,
      unitName: unit.name,
      availablePackages: checkoutPackages.map((p) => ({
        id: p.id,
        name: p.name,
        priceCents: p.priceCents,
        includedMinutes: p.includedMinutes,
      })),
      availableCoupons: checkoutCoupons.map((c) => ({
        code: c.code,
        discountText: c.kind === "DESCONTO_PCT" ? `${c.value}% OFF` : `R$ ${(c.value / 100).toFixed(2)} OFF`,
      })),
    })
      .then((offers) => {
        if (active) setCheckoutOffers(offers);
      })
      .finally(() => {
        if (active) setLoadingCheckoutOffers(false);
      });

    return () => {
      active = false;
    };
  }, [resolved?.sessionId, entry?.session.id, unit?.id, checkoutPackages, checkoutCoupons]);

  function handleApplyCheckoutOffer(offer: CheckoutOffer) {
    toast.success(`Oferta "${offer.title}" recomendada ao responsável!`);
  }

  // O campo de código fica sempre pronto: o operador bipa/digita sem clicar.
  // Volta o foco ao terminar cada atendimento; ao resolver uma criança, tira
  // o foco para o Enter seguinte abrir a cobrança em vez de reenviar o código.
  useEffect(() => {
    if (!standalone || checkoutOpen) return;
    if (resolved) {
      codeInputRef.current?.blur();
    } else {
      // select(): depois de um código recusado o texto continua no campo, e a
      // próxima leitura do bipador seria anexada a ele (ex.: "ERRADO" + novo).
      codeInputRef.current?.focus();
      codeInputRef.current?.select();
    }
  }, [standalone, resolved, checkoutOpen, problem]);

  const openCheckout = useCallback(() => {
    if (!entry) return;
    setClosingSnapshot(entry);
    setCheckoutOpen(true);
  }, [entry]);

  useEffect(() => {
    if (!standalone || !resolved || !entry || checkoutOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if ((e.target as HTMLElement | null)?.closest("button, input, textarea, select")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        clear();
      } else if (e.key === "Enter") {
        // Leitores costumam mandar Enter (às vezes dois) logo depois do código:
        // sem esta janela, o sufixo da própria leitura abriria a cobrança
        // antes de o operador ver o valor na tela.
        if (Date.now() - resolvedAtRef.current < 600) return;
        e.preventDefault();
        openCheckout();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [standalone, resolved, entry, checkoutOpen, openCheckout]);

  function clear() {
    setResolved(null);
    setProblem(null);
    setManualCode("");
  }

  async function submitManual() {
    if (!manualCode.trim()) return;
    await handleCode(manualCode);
  }

  if (!unit) return null;

  return (
    <div
      className={standalone ? "saida-shell saida-desktop" : "saida-shell"}
      style={{
        height: "100%",
        minHeight: 0,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        padding: "clamp(12px, 3vw, 20px)",
        maxWidth: "560px",
        margin: "0 auto",
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      <div className="saida-head">
        <h1 style={{ fontFamily: "var(--font-display)", margin: 0, fontSize: "clamp(20px, 5vw, 26px)" }}>Saída</h1>
        <HelpText>
          Digite o código de saída ou o PIN de 4 dígitos impressos no recibo de guarda para consultar o atendimento. A criança aparece na tela com o valor a pagar — confirme e ela está liberada.
        </HelpText>
      </div>

      <div className="saida-col saida-col-left">
      {busy && (
        <div className="saida-status">
          <Tag color="var(--color-teal)">Consultando código…</Tag>
        </div>
      )}

      {lastReleased && !resolved && (
        <div
          role="status"
          className="saida-status"
          style={{
            background: "rgba(29, 155, 132, 0.10)",
            border: "1px solid var(--color-teal)",
            color: "var(--color-teal-text)",
            borderRadius: "14px",
            padding: "14px 16px",
            fontWeight: "bold",
          }}
        >
          ✓ {lastReleased} liberado(a). Pode ler a próxima pulseira.
        </div>
      )}

      {problem && !resolved && (
        <div
          role="alert"
          className="saida-status"
          style={{
            background: "rgba(232, 48, 48, 0.08)",
            border: "1px solid var(--color-error)",
            color: "var(--color-error-text)",
            borderRadius: "14px",
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <span style={{ fontWeight: "bold" }}>{problem}</span>
          <Button variant="ghost" size="sm" onClick={clear} style={{ alignSelf: "flex-start" }}>
            Ler de novo
          </Button>
        </div>
      )}

      {/* Segunda via, sempre visível — não escondida atrás de "problemas?" */}
      <div
        className="saida-manual"
        style={{
          border: "1px solid var(--border-subtle)",
          borderRadius: "14px",
          padding: "14px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <strong style={{ fontSize: "14px" }}>Câmera não leu? Digite o código da pulseira</strong>
        <HelpText>
          Digite o código impresso na pulseira ou recibo (ex.:{" "}
          {formatAccessCode("K7M2P9QX3B7")}) para consultar a criança.
        </HelpText>
        <div style={{ display: "flex", gap: "8px" }}>
          <Input
            ref={standalone ? (codeInputRef as Ref<HTMLInputElement>) : undefined}
            placeholder="0000"
            inputMode="numeric"
            value={manualCode}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setManualCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitManual();
            }}
            style={{ flex: 1, letterSpacing: "2px", fontFamily: "var(--font-display)" }}
          />
          <Button variant="secondary" onClick={submitManual} loading={busy} disabled={!manualCode.trim() || busy}>
            Buscar
          </Button>
        </div>
      </div>

      <div className="saida-help">
        <HelpText>
          Recibo perdido <strong>e</strong> etiqueta danificada? A liberação é feita no <strong>Painel</strong>, no botão
          "Saída manual" do card da criança, conferindo o documento do responsável.
        </HelpText>
      </div>
      </div>
      <div className="saida-col saida-col-right">
      {resolved && entry && (
        <div
          className="saida-result"
          style={{
            position: "relative",
            overflow: "hidden",
            border: "2px solid var(--color-primary)",
            background: "var(--surface-card)",
            borderRadius: "18px",
            padding: "18px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            boxShadow: "var(--shadow-md)",
          }}
        >
          {isNeurodivergent && (
            <div
              aria-hidden="true"
              title="Criança Neurodivergente / TEA — Sinalização para o operador"
              style={{
                position: "absolute",
                right: "16px",
                bottom: "16px",
                opacity: 0.12,
                pointerEvents: "none",
                zIndex: 0,
                userSelect: "none",
              }}
            >
              <AutismRibbonIcon width={58} height={72} />
            </div>
          )}
          <div style={{ position: "relative", zIndex: 1 }}>
            <strong style={{ fontSize: "22px", fontFamily: "var(--font-display)", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span>{entry.session.child_name_snapshot}</span>
              {isNeurodivergent && (
                <span
                  title="Criança com Autismo / Neurodivergente — Atendimento Inclusivo"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "2px 8px",
                    borderRadius: "10px",
                    background: "rgba(0, 168, 89, 0.08)",
                    border: "1px solid rgba(0, 168, 89, 0.25)",
                    fontSize: "12px",
                    fontWeight: 700,
                    color: "var(--color-teal-hover, #007A3E)",
                  }}
                >
                  <AutismRibbonIcon width={13} height={16} />
                  <span>Neurodivergente</span>
                </span>
              )}
            </strong>
            {entry.session.guardian_name_snapshot && (
              <span style={{ fontSize: "14px", color: "var(--text-muted)", display: "block" }}>
                Responsável: {entry.session.guardian_name_snapshot}
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", fontSize: "13px", color: "var(--text-muted)" }}>
            <Tag color={entry.plan.color}>{entry.plan.name}</Tag>
            <span>Permanência: {formatElapsed(entry.quote.timing.elapsedMs)}</span>
            {entry.quote.timing.overMinutes > 0 && (
              <Tag color="var(--color-error)">+{entry.quote.timing.overMinutes} min excedente</Tag>
            )}
          </div>

          {/* Cuidados informados na entrada aparecem na saída de propósito:
              é o último momento em que a equipe fala com o responsável. */}
          {/* Sugestões de Retenção do Agente IA Gemini */}
          <GeminiSalesCard
            type="CHECKOUT"
            offers={checkoutOffers}
            loading={loadingCheckoutOffers}
            onApplyOffer={handleApplyCheckoutOffer}
          />

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              paddingTop: "10px",
              borderTop: "1px dashed var(--border-subtle)",
            }}
          >
            <span style={{ fontSize: "14px", color: "var(--text-muted)" }}>Total a pagar</span>
            <div style={{ textAlign: "right" }}>
              <strong style={{ fontSize: "30px", color: entry.quote.totalCents === 0 ? "var(--color-teal-hover, #007A3E)" : "var(--color-primary-hover)", fontFamily: "var(--font-display)" }}>
                {money(entry.quote.totalCents)}
              </strong>
              {entry.quote.totalCents === 0 && (entry.session.package_balance_minutes ?? 0) > 0 && (
                <div style={{ fontSize: "12px", color: "#1A3F35", fontWeight: 600 }}>
                  🎟️ Coberto pelo saldo do pacote ({entry.session.package_balance_minutes} min disponíveis)
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            <Button variant="ghost" size="lg" onClick={clear} style={{ borderRadius: "9999px" }}>
              Cancelar<span className="saida-kbd"> (Esc)</span>
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={openCheckout}
              style={{ borderRadius: "9999px", flex: 1 }}
              title={entry.quote.totalCents === 0 ? "Liberar saída sem cobrança" : "Cobrar e liberar a criança"}
            >
              {entry.quote.totalCents === 0 ? "Liberar saída (R$ 0,00)" : "Cobrar e liberar"}<span className="saida-kbd"> (Enter)</span>
            </Button>
          </div>
        </div>
      )}

      {resolved && !entry && sessionsStatus === "loading" && (
        <div className="saida-result">
          <AsyncState kind="loading" title="Carregando dados da criança…" />
        </div>
      )}
        {!resolved && (
          <div className="saida-placeholder" aria-hidden="true">
            Aguardando leitura. Bipe a pulseira ou digite o código ao lado: a criança e o valor aparecem aqui.
          </div>
        )}
      </div>

      {checkoutOpen && entry && (
        <CheckoutModal
          entries={[entry]}
          onClose={() => {
            setCheckoutOpen(false);
            setClosingSnapshot(null);
          }}
          onDone={() => {
            setCheckoutOpen(false);
            setClosingSnapshot(null);
            setLastReleased(entry.session.child_name_snapshot);
            toast.success(`${entry.session.child_name_snapshot} liberado(a).`);
            setResolved(null);
            setManualCode("");
          }}
        />
      )}
    </div>
  );
}
