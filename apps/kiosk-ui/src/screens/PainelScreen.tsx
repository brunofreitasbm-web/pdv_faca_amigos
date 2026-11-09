import { startVisiblePolling } from "../lib/visiblePolling.js";
import { Suspense, useEffect, useState } from "react";
import { Card, Button, Select, StatusBadge, Badge, Tag, AsyncState, Modal, PrinterIcon, ShoppingCartIcon, PlusIcon, SignOutIcon, XIcon, HelpText, RevealPin, AutismRibbonIcon, ClockIcon, ArrowClockwiseIcon } from "@facaamigos/ui";
import { Api, businessDateFor } from "../api/client.js";
import type { ActiveSessionEntry, Plan, Package, Asset, BonusRule, VipFlag } from "../api/client.js";
import { bonificacaoHoje, dentroDoPiloto, diaSemanaISO } from "../bonificacao.js";
import type { BonusProgramConfig } from "../lib/apuracaoBonificacao.js";
import { useActiveSessions } from "../api/useTick.js";
import { usePendingRenewals, resolveRenewal, applyRenewal } from "../api/renewalRequests.js";
import { useAppState } from "../state/AppState.js";
import { useToast } from "../state/ToastContext.js";
import { useConfirm } from "../state/ConfirmContext.js";
import { IfCan } from "../auth/RequireCapability.js";
import { CheckoutModal } from "../components/CheckoutModal.js";
import { SaidaManualModal } from "../components/SaidaManualModal.js";
import { WristbandPrintModal } from "../components/WristbandPrintModal.js";
import type { WristbandData } from "../components/WristbandPrintModal.js";
import { SessionTimelineModal } from "../components/SessionTimelineModal.js";
import { EditRegistrationModal } from "../components/EditRegistrationModal.js";
import { getFriendlyWristbandCode } from "@facaamigos/domain";
import { formatAge, formatElapsed, money } from "../format.js";
import type { PreCheckinPrefill } from "./EntradaScreen.js";
import { EntradaScreen, SaidaScreen, PdvScreen } from "../lazyScreens.js";
import type { PrepaidCreditQueueItem } from "../api/client.js";
import { formatPlanoHoras } from "../contract/contractTemplate.js";
import { WristbandQRCode } from "../components/WristbandQRCode.js";
import { Emoji3D, renderEmoji } from "../components/Emoji3D.js";
import { MetaDoDia } from "../components/MetaDoDia.js";

const PAUSE_REASONS: Array<{ value: string; label: string }> = [
  { value: "BANHEIRO", label: "Foi ao banheiro" },
  { value: "SAIU_DO_ESPACO", label: "Saiu do espaço" },
  { value: "OUTRO", label: "Outro motivo" },
];

// Sessão pausada e esquecida vira o mesmo problema que o painel existe
// para evitar (criança some do controle de tempo) — por isso o card
// pisca depois desse limite, igual ao alerta de excedente.
const PAUSE_ALERT_MS = 10 * 60_000;

/**
 * Painel do parque (seção 1.3/6 do plano): contagem ascendente,
 * cor por fase, seleção de mais de 1 card para famílias com mais de
 * uma criança, medidor de capacidade e alertas de expiração.
 */
export function PainelScreen() {
  const { unit, employee } = useAppState();
  const toast = useToast();
  const confirm = useConfirm();
  const { entries, status: sessionsStatus, errorMessage: sessionsError, refetch: refetchActiveSessions } = useActiveSessions(unit?.id ?? null);
  const pendingRenewals = usePendingRenewals(entries.map((e) => e.session.id));
  const [renewalBusy, setRenewalBusy] = useState<Set<string>>(new Set());

  // handleRenewalOutcome moved down
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionBusy, setActionBusy] = useState<Set<string>>(new Set());
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  // Congela o cartão de quem está sendo fechado no instante do clique em
  // "Fechar sessões" — o CheckoutModal já trava o VALOR cobrado nesse
  // mesmo instante (ver client.ts: closedAtMs), mas o card por baixo do
  // modal seguia recalculando a cada segundo via useActiveSessions, dando
  // a impressão (falsa, mas visível) de que o tempo/excedente continuava
  // subindo enquanto o operador escolhia a forma de pagamento.
  const [closingSnapshot, setClosingSnapshot] = useState<Map<string, ActiveSessionEntry>>(new Map());
  const [printData, setPrintData] = useState<WristbandData | null>(null);
  const [timelineFor, setTimelineFor] = useState<ActiveSessionEntry | null>(null);
  const [editRegistrationFor, setEditRegistrationFor] = useState<ActiveSessionEntry | null>(null);
  const [planOptions, setPlanOptions] = useState<Plan[]>([]);
  const [packageOptions, setPackageOptions] = useState<Package[]>([]);
  const [changingPlanFor, setChangingPlanFor] = useState<string | null>(null);
  const [pendingPlanId, setPendingPlanId] = useState<string>("");
  const [pausingFor, setPausingFor] = useState<string | null>(null);
  const [pendingPauseReason, setPendingPauseReason] = useState<string>("");
  const [todayRevenueCents, setTodayRevenueCents] = useState(0);
  // Aluguel de pelúcia entra no caixa, mas não na meta de faturamento da bonificação.
  const [todayRentalCents, setTodayRentalCents] = useState(0);
  const [ticketMedioCents, setTicketMedioCents] = useState(0);
  const [ticketMinCents, setTicketMinCents] = useState(0);
  const [ticketTargetCents, setTicketTargetCents] = useState(0);
  const [todayOrdersCount, setTodayOrdersCount] = useState(0);
  const [bonusRules, setBonusRules] = useState<BonusRule[]>([]);
  const [bonusProgram, setBonusProgram] = useState<BonusProgramConfig | null>(null);
  const [entradaOpen, setEntradaOpen] = useState(false);
  const [preCheckinPrefill, setPreCheckinPrefill] = useState<PreCheckinPrefill | null>(null);
  const [pendingPreCheckins, setPendingPreCheckins] = useState<PreCheckinPrefill[]>([]);
  const [preCheckinBusy, setPreCheckinBusy] = useState<Set<string>>(new Set());
  const [prepaidCreditQueue, setPrepaidCreditQueue] = useState<PrepaidCreditQueueItem[]>([]);
  const [prepaidPrefill, setPrepaidPrefill] = useState<PrepaidCreditQueueItem | null>(null);
  const [saidaOpen, setSaidaOpen] = useState(false);
  const [pdvOpen, setPdvOpen] = useState(false);
  const [qrModalSession, setQrModalSession] = useState<{ code: string; childName: string; guardianName?: string } | null>(null);
  // Contingência: recibo perdido E etiqueta ilegível. Passa pela conferência
  // do documento antes de cair no mesmo fechamento financeiro de sempre.
  const [manualExitFor, setManualExitFor] = useState<ActiveSessionEntry | null>(null);
  const [vipChildIds, setVipChildIds] = useState<Set<string>>(new Set());
  const [vipFlagsMap, setVipFlagsMap] = useState<Map<string, VipFlag>>(new Map());
  const [assets, setAssets] = useState<Asset[]>([]);
  // Retrátil: começa fechada mostrando só a descrição (quantos saldos e
  // resumo), porque essa fila pode ficar aberta o turno inteiro e comia
  // espaço fixo da tela mesmo sem nenhuma ação pendente do operador.
  const [prepaidQueueOpen, setPrepaidQueueOpen] = useState(false);
  const [tipDismissed, setTipDismissed] = useState(() => localStorage.getItem("facaamigos_panel_tip_dismissed") === "true");
  // Menu "⋯ Mais" do card (Editar/Sessão/Pulseira/Trocar Plano) — só um aberto por vez.
  const [moreMenuFor, setMoreMenuFor] = useState<string | null>(null);

  useEffect(() => {
    if (!moreMenuFor) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.("[data-more-menu]")) setMoreMenuFor(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreMenuFor(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreMenuFor]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
      if (e.key === "e" || e.key === "E" || e.key === "F2") {
        e.preventDefault();
        setPreCheckinPrefill(null);
        setEntradaOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!unit) return;
    Api.assets(unit.id).then(setAssets).catch(() => setAssets([]));
  }, [unit, entries.length]);

  useEffect(() => {
    if (!unit) return;
    const activity = unit.kind === "QUIOSQUE" ? "CARRINHO" : "PLAYGROUND";
    Api.plans(unit.id, activity).then(setPlanOptions);
    Api.packages(unit.id, activity).then(setPackageOptions);
  }, [unit]);

  // Pacotes entram na mesma listbox de "Mudar Plano" que os Planos, sem
  // distinção — cada um vira um Plan sintético com id prefixado, mesmo
  // truque já usado em EntradaScreen/AcessoRapidoScreen para a Entrada.
  // Api.changeSessionPlan reconhece o prefixo e troca a sessão para o
  // pacote em vez do plano.
  const PACKAGE_PREFIX = "PKG:";
  const changePlanOptions: Plan[] = [
    // Plano de pelúcia do Playground não entra na troca (o servidor recusa com TROCA_PLANO_PELUCIA).
    ...planOptions.filter((p) => p.activity === "CARRINHO" || !p.assetKind),
    ...packageOptions.map((pkg) => ({
      id: `${PACKAGE_PREFIX}${pkg.id}`,
      activity: pkg.activity,
      name: pkg.name,
      valueCents: pkg.priceCents,
      durationValue: pkg.includedMinutes,
      durationUnit: "MINUTO" as const,
      overageCentsPerMinute: pkg.overageCentsPerMinute,
      color: pkg.color,
    })),
  ];

  // Pré-cadastros enviados pelo QR de Acesso Rápido (?acesso-rapido=,
  // AcessoRapidoScreen), aguardando o balcão confirmar. Poll simples —
  // igual a usePendingRenewals — não é um dado que precisa de Realtime
  // para ficar "ao vivo", só reaparecer em alguns segundos já basta.
  function refetchPendingPreCheckins() {
    if (!unit) return;
    Api.preCheckinList(unit.id)
      .then(setPendingPreCheckins)
      .catch(() => {});
  }
  useEffect(() => {
    if (!unit) return;
    // Mesmo ritmo de antes (8 s), mas parado com a janela escondida.
    return startVisiblePolling(refetchPendingPreCheckins, 8000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit?.id]);

  function openPreCheckin(item: PreCheckinPrefill) {
    setPreCheckinPrefill(item);
    setEntradaOpen(true);
  }

  // Saldos pré-pagos aguardando início (venda feita sem "Iniciar contagem
  // agora"). Mesmo poll simples do pré-cadastro acima — não é dado que
  // precisa de Realtime, só reaparecer em alguns segundos já basta, e
  // crédito não vive em fa_kiosk_sessions, então o canal Realtime do
  // Painel (useActiveSessions) nunca o veria de qualquer forma.
  function refetchPrepaidCreditQueue() {
    if (!unit) return;
    Api.prepaidCreditQueue(unit.id)
      .then(setPrepaidCreditQueue)
      .catch(() => {});
  }
  useEffect(() => {
    if (!unit) return;
    return startVisiblePolling(refetchPrepaidCreditQueue, 10000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit?.id]);

  function openPrepaidCredit(item: PrepaidCreditQueueItem) {
    setPrepaidPrefill(item);
    setEntradaOpen(true);
  }

  async function cancelPreCheckin(item: PreCheckinPrefill) {
    const key = `${item.id}:${item.childIndex}`;
    setPreCheckinBusy((prev) => new Set(prev).add(key));
    try {
      await Api.preCheckinCancel(item.id, employee?.id);
      // Cancela o pré-cadastro inteiro (todas as crianças ainda pendentes
      // dele) — quem já ganhou pulseira não é afetado, só já não aparece
      // mais nesta lista de pendentes.
      setPendingPreCheckins((prev) => prev.filter((p) => p.id !== item.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível descartar o pré-cadastro.");
    } finally {
      setPreCheckinBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  // Selo VIP dos cards. Uma chamada para a lista inteira, refeita só quando
  // o conjunto de crianças no salão muda — o `useActiveSessions` recalcula
  // a contagem regressiva a cada segundo, e pendurar isto no mesmo tick
  // seria uma consulta por segundo para um dado que muda uma vez por visita.
  const childIdsKey = entries
    .map((e) => e.session.child_id)
    .sort()
    .join(",");
  useEffect(() => {
    if (!unit || childIdsKey === "") {
      setVipChildIds(new Set());
      setVipFlagsMap(new Map());
      return;
    }
    let cancelled = false;
    Api.vipFlags(unit.id, childIdsKey.split(","))
      .then((flags) => {
        if (cancelled) return;
        setVipFlagsMap(flags);
        setVipChildIds(new Set([...flags.values()].filter((f) => f.is_vip).map((f) => f.child_id)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [unit?.id, childIdsKey]);

  // Faturamento muda bem mais devagar que a ocupação — repolla num intervalo
  // mais espaçado, e só enquanto a janela está visível. Só as 3 RPCs de
  // faturamento ficam no ciclo; a configuração abaixo quase nunca muda.
  useEffect(() => {
    if (!unit) return;
    let cancelled = false;
    async function poll() {
      try {
        const [revenueRes, ticketMedioRes, rentalRes] = await Promise.allSettled([
          Api.todayRevenue(unit!.id, unit!.business_day_cutoff_hour),
          Api.todayTicketMedio(unit!.id, unit!.business_day_cutoff_hour),
          Api.todayRentalCents(unit!.id, unit!.business_day_cutoff_hour),
        ]);
        if (cancelled) return;
        if (revenueRes.status === "fulfilled") {
          setTodayRevenueCents(revenueRes.value.totalCents);
        }
        if (rentalRes.status === "fulfilled") {
          setTodayRentalCents(rentalRes.value.totalCents);
        }
        if (ticketMedioRes.status === "fulfilled") {
          setTicketMedioCents(ticketMedioRes.value.avgCents);
          setTodayOrdersCount(ticketMedioRes.value.ordersCount);
        }
      } catch {
        // Meta é um extra informativo
      }
    }
    const stop = startVisiblePolling(() => void poll(), 15_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [unit]);

  // Metas e regras de bonificação mudam algumas vezes por mês, mas estavam no
  // mesmo ciclo de 15 s do faturamento (7 de 10 requisições do ciclo, incluindo
  // cinco tabelas em bonusProgramsByUnit). Agora: uma vez ao abrir a tela (que
  // desmonta ao ir para Configurações, então alteração lá é lida na volta) e
  // revalidação a cada 10 min.
  useEffect(() => {
    if (!unit) return;
    let cancelled = false;
    async function loadConfig() {
      const [ticketGoalRes, bonusRulesRes, bonusProgramsRes] = await Promise.allSettled([
        Api.ticketGoal(unit!.id),
        Api.bonusRules(unit!.id),
        Api.bonusProgramsByUnit([unit!.id]),
      ]);
      if (cancelled) return;
      if (ticketGoalRes.status === "fulfilled") {
        setTicketMinCents(ticketGoalRes.value?.minTicketCents ?? 0);
        setTicketTargetCents(ticketGoalRes.value?.targetTicketCents ?? 0);
      }
      if (bonusRulesRes.status === "fulfilled") {
        setBonusRules(bonusRulesRes.value || []);
      }
      if (bonusProgramsRes.status === "fulfilled") {
        setBonusProgram(bonusProgramsRes.value[unit!.id] ?? null);
      }
    }
    const stop = startVisiblePolling(() => void loadConfig(), 10 * 60_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [unit]);

  async function notifyGuardian(entry: ActiveSessionEntry, channel: "WHATSAPP" | "SMS", customMessage?: string) {
    const sessionId = entry.session.id;
    const guardianName = entry.session.guardian_name_snapshot || "Responsável";
    const message =
      customMessage ??
      `Olá ${guardianName}! ${entry.session.child_name_snapshot} está no plano ${entry.plan.name} — valor atual: ${money(entry.quote.totalCents)}.`;
    setActionBusy((prev) => new Set(prev).add(sessionId));
    try {
      if (channel === "WHATSAPP") {
        const digits = (entry.session.guardian_phone_snapshot || "").replace(/\D/g, "");
        if (digits) window.open(`https://wa.me/${digits}?text=${encodeURIComponent(message)}`, "_blank");
      }
      await Api.notifySession(sessionId, { channel, message });
      if (channel === "SMS") {
        toast.success("SMS simulado — nenhum provedor configurado ainda. Registrado no histórico da sessão.");
      } else {
        toast.success("Responsável notificado.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível registrar a notificação.");
    } finally {
      setActionBusy((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }

  async function callGuardianBack(entry: ActiveSessionEntry) {
    const guardianName = entry.session.guardian_name_snapshot || "Responsável";
    const ok = await confirm({
      title: "Chamar responsável com urgência?",
      message: `Isso envia uma mensagem urgente pelo WhatsApp para o responsável de ${entry.session.child_name_snapshot} pedindo para comparecer agora.`,
      confirmLabel: "Enviar chamado",
      cancelLabel: "Cancelar",
      variant: "danger",
    });
    if (!ok) return;
    await notifyGuardian(
      entry,
      "WHATSAPP",
      `URGENTE: ${guardianName}, por favor compareça ao parque — ${entry.session.child_name_snapshot} precisa de você (banheiro / quer ir embora).`,
    );
  }

  async function handleRenewalOutcome(sessionId: string, outcome: "APLICADA" | "DISPENSADA") {
    setRenewalBusy((prev) => new Set(prev).add(sessionId));
    try {
      if (outcome === "DISPENSADA") {
        await resolveRenewal(sessionId, outcome, employee?.id ?? null);
        return;
      }
      // OK troca o plano sozinho (+N min). Sem plano equivalente único, cai no
      // seletor com o melhor palpite já escolhido; o pedido só é marcado como
      // aplicado quando a troca for confirmada (confirmChangePlan).
      const result = await applyRenewal(sessionId, employee?.id ?? null);
      if (result.status === "OK") {
        toast.success(`Tempo renovado: plano trocado para "${result.planName}" (+${result.minutes} min).`);
        return;
      }
      if (result.status === "SESSAO_NAO_ATIVA") {
        toast.error("A sessão está pausada ou encerrada. Retome a sessão e dê OK de novo.");
        return;
      }
      const entry = entries.find((e) => e.session.id === sessionId);
      const current = planOptions.find((p) => p.id === entry?.plan.id);
      const asMinutes = (p: Plan) => (p.durationUnit === "HORA" ? p.durationValue * 60 : p.durationValue);
      const asked = pendingRenewals.get(sessionId)?.minutes ?? 0;
      const target = current && asked > 0 ? asMinutes(current) + asked : null;
      const matches = target == null ? [] : changePlanOptions.filter((p) => !p.id.startsWith(PACKAGE_PREFIX) && asMinutes(p) === target);
      setPendingPlanId(matches.length === 1 ? matches[0]!.id : "");
      setChangingPlanFor(sessionId);
      toast.error("Não achei um plano único com esse tempo. Escolha o novo plano e confirme para somar o tempo.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu para atualizar o pedido de renovação.");
    } finally {
      setRenewalBusy((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }

  async function confirmChangePlan(sessionId: string) {
    if (!pendingPlanId) return;
    setActionBusy((prev) => new Set(prev).add(sessionId));
    try {
      await Api.changeSessionPlan(sessionId, pendingPlanId);
      setChangingPlanFor(null);
      setPendingPlanId("");
      toast.success("Plano atualizado.");
      // Pedido de renovação em aberto + plano trocado à mão = pedido atendido.
      if (pendingRenewals.has(sessionId)) {
        await resolveRenewal(sessionId, "APLICADA", employee?.id ?? null).catch(() => undefined);
      }
      // fa_kiosk_sessions muda -> Realtime dispara refetch em useActiveSessions automaticamente.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível trocar o plano.");
    } finally {
      setActionBusy((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }

  async function confirmPauseSession(sessionId: string) {
    if (!pendingPauseReason) return;
    setActionBusy((prev) => new Set(prev).add(sessionId));
    try {
      await Api.pauseSession(sessionId, pendingPauseReason);
      setPausingFor(null);
      setPendingPauseReason("");
      toast.success("Tempo pausado.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível pausar o tempo.");
    } finally {
      setActionBusy((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }

  async function resumeSession(sessionId: string) {
    setActionBusy((prev) => new Set(prev).add(sessionId));
    try {
      await Api.resumeSession(sessionId);
      toast.success("Tempo retomado.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível retomar o tempo.");
    } finally {
      setActionBusy((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }

  function guardianKeyOf(entry: ActiveSessionEntry): string {
    return entry.session.guardian_id ?? entry.session.guardian_name_snapshot ?? entry.session.id;
  }

  function toggle(sessionId: string) {
    const entry = entries.find((e) => e.session.id === sessionId);
    if (!entry) return;
    const guardianKey = guardianKeyOf(entry);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
        return next;
      }
      // Só permite empilhar mais de 1 card se todos forem do mesmo
      // responsável (famílias com mais de uma criança) — misturar
      // responsáveis diferentes num único fechamento não faz sentido.
      if (next.size > 0) {
        const firstSelected = entries.find((e) => next.has(e.session.id));
        const sameGuardian = firstSelected ? guardianKeyOf(firstSelected) === guardianKey : true;
        if (!sameGuardian) {
          toast.error("Só dá para selecionar mais de uma sessão do mesmo responsável.");
          return new Set([sessionId]);
        }
      }
      next.add(sessionId);
      return next;
    });
  }

  if (!unit) return null;

  const maxCapacity = unit.kind === "LOJA" ? 22 : (assets.length > 0 ? assets.length : 12);
  // Pelúcia alugada no Playground não ocupa vaga na brincadeira.
  const currentOccupancy = entries.filter((e) => !e.session.rental_kind).length;
  const occupancyPercent = Math.min(100, Math.round((currentOccupancy / maxCapacity) * 100));

  // capacityColor pinta a barra (preenchimento — a cor de marca serve,
  // só precisa de 3:1); capacityTextColor é o mesmo rótulo, mas como
  // TEXTO ao lado, que precisa de 4.5:1. --color-success (2.17:1) e
  // --color-amber (2.80:1) puros como texto falhavam os dois.
  let capacityColor = "var(--color-success)";
  let capacityTextColor = "var(--color-success-text)";
  let capacityLabel = "Capacidade Tranquila";
  if (occupancyPercent >= 90) {
    capacityColor = "var(--color-error)";
    capacityTextColor = "var(--color-error-text)";
    capacityLabel = "Capacidade Máxima / Lotação";
  } else if (occupancyPercent >= 75) {
    capacityColor = "var(--color-amber)";
    capacityTextColor = "var(--color-amber-text)";
    capacityLabel = "Alta Ocupação";
  }

  const selectedEntries = entries.filter((e) => selected.has(e.session.id));

  const unitTipo = unit?.kind === "QUIOSQUE" ? "CIRCUITO" : "PLAYGROUND";
  const businessDate = unit ? businessDateFor(Date.now(), unit.business_day_cutoff_hour) : "";
  const atualBonificacao = unitTipo === "CIRCUITO" ? todayOrdersCount : Math.max(0, todayRevenueCents - todayRentalCents);
  const dow = businessDate ? diaSemanaISO(businessDate) : 1;
  const currentGoal = bonusProgram?.goals.find((g) => g.weekday === dow) ?? null;
  const currentBonus =
    unit && businessDate
      ? bonificacaoHoje(unitTipo, businessDate, atualBonificacao, currentGoal, bonusProgram?.locacaoExtraBonusCents ?? 0)
      : null;

  return (
    // height:100% + minHeight:0: o Painel ocupa exatamente o espaço do
    // <main> do shell (ver App.tsx) e nunca mais que isso — só a lista de
    // sessões (abaixo) rola internamente quando não cabe tudo. Cabeçalho,
    // meta do dia e os botões flutuantes ficam sempre visíveis, sem rolar
    // a página inteira, no computador, tablet ou celular.
    <div className="painel-shell" style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", padding: "clamp(10px, 1.5vw, 16px)", gap: "10px" }}>
      {/* Cabeçalho só com o que é estado do espaço (subtítulo + ocupação).
          O botão "Novo Check-in" que ficava aqui saiu: era a 3ª porta para
          a mesma ação — o botão redondo "+" (64px, canto inferior) e o
          atalho E/F2 já cobrem, e o estado vazio mantém o seu. */}
      <div style={{ flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px 16px" }}>
        <h1 className="sr-only">Painel</h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "13px", fontWeight: 500 }}>
          {unit.kind === "QUIOSQUE"
            ? "Acompanhamento em tempo real dos carrinhos no circuito"
            : "Acompanhamento em tempo real das crianças no playground"}
        </p>
        <div style={{ minWidth: "220px", flex: "0 1 280px" }} className="capacity-container">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "2px 8px", fontSize: "12px", fontWeight: "bold" }}>
            <span>Ocupação: {currentOccupancy} / {maxCapacity} {unit.kind === "QUIOSQUE" ? "carrinhos" : "crianças"}</span>
            <span style={{ color: capacityTextColor, fontSize: "11px" }}>{occupancyPercent}% ({capacityLabel})</span>
          </div>
          <div className="capacity-bar-track" role="progressbar" aria-valuenow={occupancyPercent} aria-valuemin={0} aria-valuemax={100}>
            <div className="capacity-bar-fill" style={{ width: `${occupancyPercent}%`, backgroundColor: capacityColor }} />
          </div>
        </div>
      </div>

      <MetaDoDia
        tipo={unitTipo}
        bonus={businessDate && dentroDoPiloto(businessDate) ? currentBonus : null}
        ticketMedioCents={ticketMedioCents}
        ticketMinCents={ticketMinCents}
        ticketTargetCents={ticketTargetCents}
        bonusRules={bonusRules}
        copilot={{
          todayRevenueCents: todayRevenueCents - todayRentalCents,
          targetRevenueCents: currentBonus?.meta || ticketTargetCents || 100000,
          superRevenueCents: currentBonus?.super || (ticketTargetCents > 0 ? Math.round(ticketTargetCents * 1.3) : 150000),
          ordersCount: todayOrdersCount,
          ticketMedioCents,
          unitName: unit.name,
          unitKind: unit.kind,
          bonusLevel: currentBonus?.nivel || "abaixo",
          bonusEstimatedCents: currentBonus?.bonusCents || 0,
        }}
      />

      {!tipDismissed && entries.length > 0 && (
        <div style={{ position: "relative", flexShrink: 0 }} role="status">
          <HelpText style={{ marginTop: 0, paddingRight: "30px" }}>
            Toque num cartão para selecioná-lo (fica com borda rosa) e depois em "Fechar sessões" para cobrar. O
            rótulo colorido (verde/amarelo/vermelho) mostra o tempo restante do plano — vermelho já ultrapassou.
          </HelpText>
          <button
            type="button"
            onClick={() => {
              localStorage.setItem("facaamigos_panel_tip_dismissed", "true");
              setTipDismissed(true);
            }}
            title="Não mostrar mais esta dica"
            style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "16px" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Se já havia sessões na tela e a última reconsulta falhou (ex: uma
          troca de Realtime disparou refetch e a rede caiu), mantém o
          último dado bom visível — mas avisa, em vez de deixar a tela
          parar de atualizar em silêncio sem nenhum sinal disso. */}
      {sessionsStatus === "error" && entries.length > 0 && (
        <div
          role="alert"
          style={{ flexShrink: 0, fontSize: "13px", color: "var(--color-error-text)", background: "rgba(232,48,48,0.08)", border: "1px solid var(--color-error)", borderRadius: "10px", padding: "8px 12px" }}
        >
          ⚠️ Não foi possível atualizar o painel — os dados abaixo podem estar desatualizados.
        </div>
      )}

      {/* Pré-cadastros do QR de Acesso Rápido: o responsável já preencheu
          tudo pelo próprio celular na entrada da unidade — o operador só
          confere e toca em "Confirmar entrada" (abre EntradaScreen já
          preenchida). Fica antes da grade normal, de propósito: é fila de
          espera, não uma sessão em andamento. */}
      {pendingPreCheckins.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            padding: "10px 12px",
            borderRadius: "14px",
            border: "1px dashed var(--color-teal)",
            background: "rgba(29, 155, 132, 0.06)",
          }}
        >
          <strong style={{ fontSize: "13px", color: "var(--color-teal-text)" }}>
            <Emoji3D e="🕓" /> {pendingPreCheckins.length} pré-cadastro{pendingPreCheckins.length > 1 ? "s" : ""} aguardando pelo QR de
            Acesso Rápido
          </strong>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {pendingPreCheckins.map((item) => (
              <div
                key={`${item.id}:${item.childIndex}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 10px",
                  borderRadius: "12px",
                  border: "1px solid var(--border-subtle)",
                  background: "var(--surface-card)",
                }}
              >
                <span
                  title="PIN que o responsável fala no balcão — confira antes de confirmar"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "18px",
                    letterSpacing: "0.06em",
                    color: "var(--color-primary-hover)",
                    background: "rgba(240, 25, 107, 0.08)",
                    borderRadius: "10px",
                    padding: "4px 8px",
                  }}
                >
                  {item.pin}
                </span>
                <div>
                  <strong style={{ fontSize: "13px", display: "block" }}>
                    {item.childName}{(item.inclusiveEligible || (item.sensoryTags?.length ?? 0) > 0 || item.notes?.toLowerCase().includes("neuro")) && !item.childName.includes("🧩") ? renderEmoji(" 🧩") : ""}
                    {item.totalChildren > 1 && (
                      <span style={{ fontWeight: 400, color: "var(--text-muted)" }}> ({item.childIndex + 1}/{item.totalChildren})</span>
                    )}
                  </strong>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                    {item.guardianName} · {item.planName}
                  </span>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={preCheckinBusy.has(`${item.id}:${item.childIndex}`)}
                  onClick={() => openPreCheckin(item)}
                  title="Abrir Entrada já preenchida com os dados enviados pelo responsável"
                >
                  Confirmar
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={preCheckinBusy.has(`${item.id}:${item.childIndex}`)}
                  onClick={() => cancelPreCheckin(item)}
                  title={item.totalChildren > 1 ? "Descartar todo o pré-cadastro (todas as crianças ainda pendentes desta família)" : "Descartar este pré-cadastro (duplicado, desistência)"}
                  aria-label="Descartar pré-cadastro"
                >
                  <XIcon />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Saldos pré-pagos: o pai pagou e foi embora numa visita anterior
          ("Iniciar contagem agora" desmarcado na Entrada) e a criança
          voltou agora. Mesmo layout do bloco de pré-cadastro acima, mas
          roxo — cor do saldo pré-pago em toda a UI (client.ts, card da
          Entrada) — para não confundir as duas filas. "▶ Iniciar" abre a
          Entrada pré-preenchida (openPrepaidCredit); não cria a sessão
          direto daqui, de propósito. */}
      {prepaidCreditQueue.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: prepaidQueueOpen ? "8px" : 0,
            padding: "10px 12px",
            borderRadius: "14px",
            border: "1px dashed #7C4DFF",
            background: "rgba(124, 77, 255, 0.06)",
          }}
        >
          <button
            type="button"
            onClick={() => setPrepaidQueueOpen((v) => !v)}
            aria-expanded={prepaidQueueOpen}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              width: "100%",
              textAlign: "left",
            }}
          >
            <strong style={{ fontSize: "13px", color: "#5B32C4" }}>
              <Emoji3D e="💳" /> {prepaidCreditQueue.length} saldo{prepaidCreditQueue.length > 1 ? "s" : ""} pré-pago
              {prepaidCreditQueue.length > 1 ? "s" : ""} aguardando início
            </strong>
            <span style={{ fontSize: "12px", color: "#5B32C4", flexShrink: 0 }}>
              {prepaidQueueOpen ? "▲ recolher" : "▼ ver"}
            </span>
          </button>
          {prepaidQueueOpen && (
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {prepaidCreditQueue.map((item) => (
              <div
                key={item.credit_id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 10px",
                  borderRadius: "12px",
                  border: "1px solid var(--border-subtle)",
                  background: "var(--surface-card)",
                }}
              >
                <div>
                  <strong style={{ fontSize: "13px", display: "block" }}>
                    {item.child_name}
                    {item.child_inclusive_eligible && !item.child_name.includes("🧩") ? renderEmoji(" 🧩") : ""}
                  </strong>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                    {item.guardian_name} · {formatPlanoHoras(item.remaining_minutes)} · {item.source_name_snapshot}
                  </span>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={item.has_active_session}
                  onClick={() => openPrepaidCredit(item)}
                  title={
                    item.has_active_session
                      ? "Esta criança já está no parque por outra entrada"
                      : "Abrir Entrada já preenchida para iniciar a contagem deste saldo"
                  }
                >
                  {item.has_active_session ? "Já está no parque" : renderEmoji("▶ Iniciar")}
                </Button>
              </div>
            ))}
          </div>
          )}
        </div>
      )}

      {/* Única área com rolagem própria da tela — contida, nunca a página toda.
          No celular (.painel-scroll no app.css) isso é desligado: a
          prioridade lá é ver o quadro inteiro, então quem rola é a página. */}
      <div className="painel-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
        {entries.length === 0 && sessionsStatus === "loading" && (
          <AsyncState kind="loading" title="Carregando sessões ativas…" style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", boxSizing: "border-box" }} />
        )}
        {/* Antes ficava dentro do .painel-grid como só mais um item — a grade
            não estica um item sozinho pra ocupar a linha inteira, então o
            "quadro" (a área de maior destaque da tela) sobrava vazio em
            volta de uma caixinha pequena centrada no topo. Agora ocupa a
            altura toda do .painel-scroll de propósito. */}
        {entries.length === 0 && sessionsStatus === "ready" && (
          <div style={{ height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px", gap: "16px", textAlign: "center", color: "var(--text-muted)", background: "var(--surface-card)", borderRadius: "16px", border: "1px dashed var(--border-subtle)" }}>
            <div style={{ fontSize: "40px" }}><Emoji3D e="📭" /></div>
            <div style={{ fontSize: "16px", fontWeight: 500 }}>Nenhuma criança em atividade no momento.</div>
            <Button variant="primary" onClick={() => {
              setPreCheckinPrefill(null);
              setEntradaOpen(true);
            }}>
              Registrar Nova Entrada (E)
            </Button>
          </div>
        )}
        {entries.length === 0 && sessionsStatus === "error" && (
          <AsyncState
            kind="error"
            title="Não foi possível carregar as sessões ativas."
            detail={sessionsError ?? undefined}
            style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", boxSizing: "border-box" }}
          />
        )}
        {entries.length > 0 && (
        <div className="painel-grid">
        {entries.map((entry) => {
          const { session, quote, plan, asset } = closingSnapshot.get(entry.session.id) ?? entry;
          const isSelected = selected.has(session.id);
          // "Estourou" só depois de passar do tempo do plano — os últimos minutos
          // (fase VERMELHO, antes do teto) são só aviso, não excedente.
          const isExceeded = quote.timing.elapsedMs > quote.timing.durationMs;
          const displayPhase = isExceeded ? "EXCEDENTE" : quote.timing.phase;
          const isPaused = quote.timing.isPaused;
          const isPausedTooLong = isPaused && quote.timing.pausedForMs >= PAUSE_ALERT_MS;
          const overageLine = quote.lines.find((l) => l.label.startsWith("Excedente"));
          // access_code é o código curto novo; wristband_code cobre as
          // pulseiras impressas antes da migração 20260807000007, que ainda
          // circulam no pulso de quem entrou naquele dia.
          const wristbandCode = session.access_code || session.wristband_code || session.id.slice(0, 6).toUpperCase();
          const careSummary = [...(session.sensory_tags ?? []), session.notes].filter(Boolean).join(" · ");
          const isNeurodivergent = Boolean(
            session.child_inclusive_eligible ||
            (session.sensory_tags?.length ?? 0) > 0 ||
            session.notes?.toLowerCase().includes("neuro") ||
            session.notes?.toLowerCase().includes("autis") ||
            session.notes?.toLowerCase().includes("tea") ||
            session.child_name_snapshot.includes("🧩")
          );

          return (
            <Card
              key={session.id}
              onClick={() => !isPaused && toggle(session.id)}
              // "Selecionada para cobrança" antes só existia como borda
              // rosa + fundo 4% rosa — nenhum texto/ícone de apoio, e é
              // o estado que decide quem paga. aria-pressed marca o
              // alternador pra leitor de tela; o selo "✓ Selecionada"
              // abaixo é o reforço visual que não depende só de cor.
              aria-pressed={!isPaused ? isSelected : undefined}
              // painel-card cuida de padding/gap/raio de forma fluida (app.css);
              // aqui ficam só os estilos que dependem do estado da sessão.
              // Sem animação: a marca proíbe loop infinito em UI (ver
              // print.css), então a urgência é só borda mais grossa +
              // selo de texto sempre visível (abaixo), nunca movimento.
              // EXCEÇÃO: Pedido de tempo do responsável (renewal-attention) ganha movimento
              // temporário para chamar a atenção do operador até que seja resolvido.
              className={`painel-card ${pendingRenewals.has(session.id) ? "renewal-attention" : ""}`}
              // O respiro do card acompanha a largura do próprio card (cqi),
              // não a da janela — ver .painel-card em app.css. Vai em
              // bodyStyle porque é lá que os filhos ficam; `flex:1` é o que
              // permite ao rodapé de valor grudar embaixo com marginTop:auto.
              bodyStyle={{
                position: "relative",
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: "clamp(4px, 1.5cqi, 8px)",
                padding: "clamp(8px, 3cqi, 12px)",
              }}
              style={{
                cursor: isPaused ? "default" : "pointer",
                // Menu "⋯ Mais" abre para cima a partir do rodapé — não pode ser cortado pelo card.
                overflow: "visible",
                display: "flex",
                flexDirection: "column",
                borderRadius: "16px",
                border: isPausedTooLong
                  ? "3px solid var(--color-amber)"
                  : isPaused
                  ? "2px dashed var(--color-amber)"
                  : isSelected
                  ? "2px solid var(--color-primary)"
                  : isExceeded
                  ? "3px solid var(--color-error)"
                  : "1px solid var(--border-subtle)",
                borderLeft: `6px solid ${plan?.color ?? "var(--border-subtle)"}`,
                background: isPaused ? "rgba(201, 144, 32, 0.06)" : isSelected ? "rgba(240, 25, 107, 0.04)" : "var(--surface-card)",
                opacity: isPaused ? 0.85 : 1,
              }}
            >
              {/* Ordem do card segue a leitura do operador: QUEM (nome,
                  sempre no mesmo lugar) → QUANTO (tempo e valor lado a
                  lado — é o par que decide a cobrança) → ALERTAS → AÇÕES
                  no rodapé. Antes os selos vinham antes do nome (o nome
                  "andava" de card para card) e o valor ficava no rodapé,
                  separado do tempo por dois grupos de botões. */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                <div style={{ display: "flex", gap: "10px", alignItems: "flex-start", minWidth: 0, flex: 1 }}>
                  {asset && (
                    asset.photo_url ? (
                      <img
                        src={asset.photo_url}
                        alt={asset.name}
                        title={`${session.rental_kind ? "Pelúcia" : "Carrinho"}: ${asset.name}`}
                        className="painel-card-thumb-img"
                        style={{ objectFit: "cover", borderRadius: "12px", border: "1px solid var(--border-subtle)", flexShrink: 0 }}
                      />
                    ) : (
                      <span title={`${session.rental_kind ? "Pelúcia" : "Carrinho"}: ${asset.name}`} className="painel-card-thumb-emoji">
                        {asset.emoji}
                      </span>
                    )
                  )}
                  <div style={{ minWidth: 0 }}>
                    <strong className="painel-card-name" style={{ display: "block" }}>
                      {session.child_name_snapshot.replace(/\s*🧩/g, "")}
                      {session.child_birth_date && (
                        <span style={{ fontSize: "12px", fontWeight: "normal", color: "var(--text-muted)" }}> · {formatAge(session.child_birth_date)}</span>
                      )}
                    </strong>
                    {/* Um único sinal de neurodivergência (o selo com texto).
                        Antes eram três ao mesmo tempo — selo + 🧩 no nome +
                        fita no fundo do card — e o que se repete em todo
                        card deixa de chamar atenção. A pulseira impressa
                        continua com 🧩 (ver "Imprimir pulseira" abaixo). */}
                    <div style={{ display: "flex", alignItems: "center", gap: "4px 6px", flexWrap: "wrap", margin: "4px 0 2px" }}>
                      {isNeurodivergent && (
                        <Badge
                          variant="teal"
                          title="Criança com Autismo / Neurodivergente — Atendimento Inclusivo"
                          style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "2px 7px" }}
                        >
                          <AutismRibbonIcon width={13} height={16} style={{ flexShrink: 0 }} />
                          <span>Neurodivergente</span>
                        </Badge>
                      )}
                      {(() => {
                        const vipFlag = vipFlagsMap.get(session.child_id);
                        const windowVisits = vipFlag?.visits_in_window;
                        // Selo mostra o contador absoluto; a janela de 30 dias fica no tooltip.
                        const visits = vipFlag?.total_visits ?? windowVisits;
                        if (vipChildIds.has(session.child_id)) {
                          return (
                            <Badge variant="vip" title={`Cliente VIP — ${visits ?? 4} visitas no total, ${windowVisits ?? 4} nos últimos 30 dias`}>
                              ★ VIP ({visits ?? 4} visitas)
                            </Badge>
                          );
                        }
                        if (visits !== undefined && visits > 0) {
                          return (
                            <span
                              style={{ fontSize: "11px", color: "var(--text-muted)" }}
                              title={`${visits} visita(s) no total, ${windowVisits ?? 0} nos últimos 30 dias`}
                            >
                              {visits} {visits === 1 ? "visita" : "visitas"}
                            </span>
                          );
                        }
                        return null;
                      })()}
                      {plan && (
                        <Tag color={plan.color} title="Plano de permanência escolhido para esta criança">{plan.name}</Tag>
                      )}
                      {session.rental_kind && (
                        <Badge variant="solid_orange" title="Aluguel avulso de pelúcia — cobrar e recolher a pelúcia na saída">
                          <Emoji3D e="🧸" /> Pelúcia · devolver
                        </Badge>
                      )}
                    </div>
                    {session.guardian_name_snapshot && (
                      <span style={{ fontSize: "12px", color: "var(--text-muted)", display: "block" }}>Responsável: {session.guardian_name_snapshot}</span>
                    )}
                    <span style={{ fontSize: "12px", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", margin: "2px 0" }}>
                      <span>Pulseira: <strong>#{getFriendlyWristbandCode(wristbandCode)}</strong></span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setQrModalSession({
                            code: wristbandCode,
                            childName: session.child_name_snapshot,
                            guardianName: session.guardian_name_snapshot || "",
                          });
                        }}
                        style={{
                          background: "rgba(240,25,107,0.08)",
                          border: "1px solid rgba(240,25,107,0.25)",
                          borderRadius: "var(--radius-full)",
                          padding: "2px 8px",
                          fontSize: "11px",
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                          color: "var(--color-primary-hover)",
                          fontWeight: "var(--weight-bold)" as unknown as number,
                        }}
                        title="Clique para visualizar o QR Code da pulseira em tamanho grande"
                      >
                        <span><Emoji3D e="📱" /> QR Code</span>
                      </button>
                    </span>
                    {session.exit_pin && (
                      <span style={{ fontSize: "12px", color: "var(--text-muted)", display: "block", margin: "2px 0" }}>
                        <RevealPin pin={session.exit_pin} label="PIN de saída" />
                      </span>
                    )}
                    {asset && (
                      <span style={{ fontSize: "12px", color: "var(--text-muted)", display: "block" }}>
                        {session.rental_kind ? "Pelúcia" : "Carrinho"}: {asset.name}
                      </span>
                    )}
                  </div>
                </div>
                {isSelected && !isPaused && (
                  <Badge variant="solid_pink" title="Esta sessão entra no próximo fechamento" style={{ flexShrink: 0 }}>
                    ✓ Selecionada
                  </Badge>
                )}
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <StatusBadge
                  phase={displayPhase}
                  detail={formatElapsed(quote.timing.elapsedMs)}
                  size="lg"
                  title={isPaused ? "Tempo congelado enquanto a sessão está pausada" : "Tempo de permanência desde a entrada — base para a cobrança"}
                  style={isPaused ? { opacity: 0.6 } : undefined}
                />
                <span style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>Valor atual</span>
                  <strong className="painel-card-total" style={{ color: "var(--color-primary-hover)" }}>{money(quote.totalCents)}</strong>
                </span>
              </div>

              {isPaused && (
                <Badge
                  variant={isPausedTooLong ? "solid_pink" : "solid_amber"}
                  title="Relógio parado — retome quando a criança voltar"
                >
                  <Emoji3D e="⏸" /> Pausada há {formatElapsed(quote.timing.pausedForMs)}
                  {isPausedTooLong ? " — retome agora" : ""}
                </Badge>
              )}

              {isExceeded && !isPaused && (
                <Badge variant="solid_pink" title="Tempo do plano já foi ultrapassado — minutos e valor extra somados em tempo real">
                  <Emoji3D e="🔴" /> +{quote.timing.overMinutes} min excedente{overageLine ? ` (+${money(overageLine.cents)})` : ""}
                </Badge>
              )}

              {/* Pedido de renovação feito pelo responsável no painel público
                  (?acompanhar=) — só aparece enquanto ninguém do balcão
                  aplicar ou dispensar. "Dar OK" troca o plano na hora
                  (fa_kiosk_apply_renewal); sem plano equivalente único abre o
                  seletor abaixo e o pedido é baixado ao confirmar a troca. */}
              {pendingRenewals.has(session.id) && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    flexWrap: "wrap",
                    padding: "8px 10px",
                    borderRadius: "12px",
                    border: "1px solid rgba(240,25,107,0.25)",
                    background: "rgba(240,25,107,0.06)",
                  }}
                >
                  <Badge variant="solid_pink" title="O responsável pediu mais tempo pelo painel de acompanhamento no celular">
                    <Emoji3D e="📱" /> Pediu +{pendingRenewals.get(session.id)!.minutes} min
                    {pendingRenewals.get(session.id)!.cents != null ? ` — ${money(pendingRenewals.get(session.id)!.cents!)}` : ""}
                  </Badge>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={renewalBusy.has(session.id)}
                    onClick={() => handleRenewalOutcome(session.id, "APLICADA")}
                  >
                    Dar OK (Ciente)
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={renewalBusy.has(session.id)}
                    onClick={() => handleRenewalOutcome(session.id, "DISPENSADA")}
                  >
                    Dispensar
                  </Button>
                </div>
              )}

              {/* Saldo de pacote: o fechamento vai abater estes minutos, então
                  o valor estimado acima não é o que será cobrado. Dizer isso
                  aqui evita o operador contestar o próprio sistema no caixa. */}
              {!session.rental_kind && (session.package_balance_minutes ?? 0) > 0 && (
                <Badge variant="solid_orange" title="Este responsável tem pacote pré-pago — o tempo sai do saldo no fechamento">
                  <Emoji3D e="🎟️" /> Pacote: {session.package_balance_minutes} min de saldo
                </Badge>
              )}

              {careSummary && (
                <div style={{ fontSize: "12px", background: "rgba(201, 144, 32, 0.1)", padding: "6px 10px", borderRadius: "8px", color: "var(--color-dark)" }}>
                  <Emoji3D e="💡" /> {careSummary}
                </div>
              )}

              {pausingFor === session.id && (
                <div style={{ display: "flex", gap: "6px" }} onClick={(e) => e.stopPropagation()}>
                  <Select
                    value={pendingPauseReason}
                    title="Selecione o motivo da pausa"
                    onChange={(e) => setPendingPauseReason(e.target.value)}
                    style={{ height: "40px", fontSize: "14px" }}
                  >
                    <option value="" disabled>
                      Motivo da pausa...
                    </option>
                    {PAUSE_REASONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={actionBusy.has(session.id)}
                    disabled={!pendingPauseReason || actionBusy.has(session.id)}
                    title="Confirmar a pausa desta sessão"
                    onClick={() => confirmPauseSession(session.id)}
                  >
                    Confirmar
                  </Button>
                </div>
              )}

              {changingPlanFor === session.id && (
                <div style={{ display: "flex", gap: "6px" }} onClick={(e) => e.stopPropagation()}>
                  <Select
                    value={pendingPlanId}
                    title="Selecione o novo plano para esta sessão"
                    onChange={(e) => setPendingPlanId(e.target.value)}
                    style={{ height: "40px", fontSize: "14px" }}
                  >
                    <option value="" disabled>
                      Escolher novo plano...
                    </option>
                    {changePlanOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {money(p.valueCents)}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={actionBusy.has(session.id)}
                    disabled={!pendingPlanId || actionBusy.has(session.id)}
                    title="Confirmar a troca de plano desta sessão"
                    onClick={() => confirmChangePlan(session.id)}
                  >
                    Confirmar
                  </Button>
                </div>
              )}

              {/* Rodapé de ações. À vista só o que é urgente ou contingência
                  sob pressão (Chamado, Pausar/Retomar, Saída manual — esta
                  usada justamente quando algo já deu errado, com a família
                  na frente). Consulta e correção (Editar, Sessão, Pulseira,
                  Trocar Plano) vão para "⋯ Mais": eram 7 botões por card,
                  multiplicados por cada criança na tela. */}
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center", marginTop: "auto", paddingTop: "8px", borderTop: "1px dashed var(--border-subtle)" }}>
                <Button
                  variant="primary"
                  size="sm"
                  loading={actionBusy.has(session.id)}
                  disabled={actionBusy.has(session.id)}
                  title="Chamado de retorno urgente — o responsável precisa vir buscar/atender a criança agora (banheiro, quer ir embora)"
                  onClick={(e) => {
                    e.stopPropagation();
                    callGuardianBack(entry);
                  }}
                >
                  <Emoji3D e="🚻" /> Chamado de Retorno
                </Button>
                {isPaused ? (
                  <Button
                    variant="teal"
                    size="sm"
                    loading={actionBusy.has(session.id)}
                    disabled={actionBusy.has(session.id)}
                    title="Retomar a contagem do tempo desta sessão"
                    onClick={(e) => {
                      e.stopPropagation();
                      resumeSession(session.id);
                    }}
                  >
                    <Emoji3D e="▶" /> Retomar
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={actionBusy.has(session.id)}
                    title="Pausar a contagem do tempo — banheiro, saiu do espaço, etc."
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingPauseReason("");
                      setPausingFor(pausingFor === session.id ? null : session.id);
                    }}
                  >
                    <Emoji3D e="⏸" /> Pausar
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isPaused || actionBusy.has(session.id)}
                  title={
                    isPaused
                      ? "Retome a contagem antes de liberar a criança"
                      : "Recibo perdido ou etiqueta danificada: liberar conferindo o documento do responsável"
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    setManualExitFor(entry);
                  }}
                >
                  <Emoji3D e="🪪" /> Saída manual
                </Button>
                <div data-more-menu style={{ position: "relative", marginLeft: "auto" }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-haspopup="menu"
                    aria-expanded={moreMenuFor === session.id}
                    aria-label="Mais ações desta sessão"
                    title="Editar cadastro, ver sessão, imprimir pulseira, trocar plano"
                    onClick={() => setMoreMenuFor(moreMenuFor === session.id ? null : session.id)}
                  >
                    ⋯ Mais
                  </Button>
                  {moreMenuFor === session.id && (
                    <div role="menu" className="more-menu">
                      <IfCan capability="clientes.write">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMoreMenuFor(null);
                            setEditRegistrationFor(entry);
                          }}
                        >
                          <Emoji3D e="✏️" /> Editar cadastro
                        </button>
                      </IfCan>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMoreMenuFor(null);
                          setTimelineFor(entry);
                        }}
                      >
                        <ClockIcon /> Linha do tempo da sessão
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMoreMenuFor(null);
                          setPrintData({
                            wristbandCode,
                            childName: isNeurodivergent && !session.child_name_snapshot.includes("🧩")
                              ? `${session.child_name_snapshot} 🧩`
                              : session.child_name_snapshot,
                            guardianName: session.guardian_name_snapshot || "Responsável",
                            phone: session.guardian_phone_snapshot || "",
                            entryTime: new Date(session.checkin_at_ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
                            notes: careSummary || undefined,
                          });
                        }}
                      >
                        <PrinterIcon /> Imprimir pulseira
                      </button>
                      <IfCan capability="sessao.change_plan">
                        {!session.rental_kind && (
                          <button
                            type="button"
                            role="menuitem"
                            disabled={actionBusy.has(session.id)}
                            onClick={() => {
                              setMoreMenuFor(null);
                              setPendingPlanId("");
                              setChangingPlanFor(session.id);
                            }}
                          >
                            <ArrowClockwiseIcon /> Trocar plano
                          </button>
                        )}
                      </IfCan>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
        </div>
        )}
      </div>

      {selected.size > 0 && (
        <div style={{ position: "fixed", bottom: "calc(24px + var(--install-banner-height, 0px))", left: "50%", transform: "translateX(-50%)", zIndex: 100 }}>
          <Button
            variant="primary"
            size="lg"
            onClick={() => {
              setClosingSnapshot(new Map(selectedEntries.map((e) => [e.session.id, e])));
              setCheckoutOpen(true);
            }}
            style={{ boxShadow: "var(--shadow-lg)" }}
          >
            Fechar {selected.size} {selected.size === 1 ? "sessão" : "sessões"}
          </Button>
        </div>
      )}

      {checkoutOpen && (
        <CheckoutModal
          entries={selectedEntries}
          onClose={() => {
            setCheckoutOpen(false);
            setClosingSnapshot(new Map());
          }}
          onDone={() => {
            setCheckoutOpen(false);
            setSelected(new Set());
            // Só solta o snapshot congelado depois que `entries` já refletir
            // o fechamento no servidor — sem isso, se o Realtime ainda não
            // tiver entregue o UPDATE de status, o card volta a renderizar a
            // partir do `entries` desatualizado (ainda ATIVA) e o
            // cronômetro/excedente parecem "continuar contando" mesmo com a
            // sessão já paga e fechada no banco.
            refetchActiveSessions().finally(() => setClosingSnapshot(new Map()));
          }}
        />
      )}

      {manualExitFor && (
        <SaidaManualModal
          entry={manualExitFor}
          onClose={() => setManualExitFor(null)}
          onAuthorized={() => {
            // Conferência registrada — a cobrança segue pelo mesmo caminho
            // do fechamento normal, para não existir uma segunda forma de
            // fechar venda no sistema.
            setSelected(new Set([manualExitFor.session.id]));
            setClosingSnapshot(new Map([[manualExitFor.session.id, manualExitFor]]));
            setManualExitFor(null);
            setCheckoutOpen(true);
            toast.success("Conferência registrada. Finalize o pagamento.");
          }}
        />
      )}

      {printData && (
        <WristbandPrintModal
          data={printData}
          onClose={() => setPrintData(null)}
        />
      )}

      {timelineFor && <SessionTimelineModal entry={timelineFor} onClose={() => setTimelineFor(null)} />}

      {editRegistrationFor && (
        <EditRegistrationModal
          open={Boolean(editRegistrationFor)}
          onClose={() => setEditRegistrationFor(null)}
          onSaved={() => {
            refetchActiveSessions();
          }}
          initialData={{
            guardianId: editRegistrationFor.session.guardian_id,
            childId: editRegistrationFor.session.child_id,
            sessionId: editRegistrationFor.session.id,
            guardianName: editRegistrationFor.session.guardian_name_snapshot,
            guardianPhone: editRegistrationFor.session.guardian_phone_snapshot,
            childName: editRegistrationFor.session.child_name_snapshot,
          }}
        />
      )}



      {/* Botões flutuantes: Painel é a tela principal — Entrada e PDV abrem por cima, sem sair dele */}
      <div style={{ position: "fixed", bottom: "calc(24px + var(--install-banner-height, 0px))", right: "24px", zIndex: 90, display: "flex", flexDirection: "column", gap: "14px", alignItems: "flex-end" }}>
        <Button
          variant="teal"
          size="lg"
          onClick={() => setPdvOpen(true)}
          title="Abrir PDV flutuante e fechar vendas sem sair do Painel"
          aria-label="Abrir PDV"
          style={{ borderRadius: "9999px", width: "64px", height: "64px", fontSize: "26px", boxShadow: "var(--shadow-lg)", padding: 0 }}
        >
          <ShoppingCartIcon />
        </Button>
        <Button
          variant="primary"
          size="lg"
          onClick={() => {
            setPreCheckinPrefill(null);
            setEntradaOpen(true);
          }}
          title="Fazer nova entrada sem sair do Painel"
          aria-label="Fazer nova entrada"
          style={{ borderRadius: "9999px", width: "64px", height: "64px", fontSize: "26px", boxShadow: "var(--shadow-lg)", padding: 0 }}
        >
          <PlusIcon />
        </Button>
      </div>

      {entradaOpen && (
        <Modal
          onClose={() => {
            setEntradaOpen(false);
            setPreCheckinPrefill(null);
            setPrepaidPrefill(null);
          }}
          ariaLabel="Entrada"
          maxWidth="820px"
          padding="0"
          zIndex={150}
        >
          <Suspense fallback={null}>
          <EntradaScreen
            onSuccess={() => { refetchActiveSessions(); refetchPrepaidCreditQueue(); }}
            prefill={preCheckinPrefill}
            onPrefillConsumed={() => {
              setPreCheckinPrefill(null);
              refetchPendingPreCheckins();
            }}
            prepaidPrefill={prepaidPrefill}
            onPrepaidPrefillConsumed={() => setPrepaidPrefill(null)}
          />
          </Suspense>
        </Modal>
      )}

      {pdvOpen && (
        <Modal onClose={() => setPdvOpen(false)} ariaLabel="PDV" maxWidth="1100px" padding="0" zIndex={150}>
          <Suspense fallback={null}>
            <PdvScreen />
          </Suspense>
        </Modal>
      )}

      {saidaOpen && (
        <Modal onClose={() => setSaidaOpen(false)} ariaLabel="Saída" maxWidth="600px" padding="0" zIndex={150}>
          <Suspense fallback={null}>
            <SaidaScreen entriesOverride={entries} />
          </Suspense>
        </Modal>
      )}

      {qrModalSession && (
        <Modal
          title={`Pulseira de ${qrModalSession.childName}`}
          onClose={() => setQrModalSession(null)}
          maxWidth="380px"
          zIndex={160}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px", padding: "12px 0", textAlign: "center" }}>
            <WristbandQRCode value={qrModalSession.code} size={220} />
            <div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: "22px", letterSpacing: "1px", background: "var(--surface-sunken)", color: "var(--text-primary)", padding: "8px 20px", borderRadius: "var(--radius-full)", border: "1px solid var(--border-subtle)", display: "inline-block" }}>
                #{getFriendlyWristbandCode(qrModalSession.code)}
              </div>
              {qrModalSession.guardianName && (
                <div style={{ marginTop: "8px", fontSize: "13px", color: "var(--text-muted)" }}>
                  Responsável: {qrModalSession.guardianName}
                </div>
              )}
            </div>
            <Button variant="secondary" onClick={() => setQrModalSession(null)}>
              Fechar
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

