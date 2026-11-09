import { startVisiblePolling } from "../lib/visiblePolling.js";
import { useEffect, useState } from "react";
import { Button, Card, Input, HelpText, Modal, Tag } from "@facaamigos/ui";
import { formatCpf, isValidCpf } from "@facaamigos/domain";
import { Api } from "../api/client.js";
import type { CashMovement, CloseShiftResult, RevenueByMethod, Shift, ShiftSale, FiscalDoc, BonusRule } from "../api/client.js";
import { useAppState } from "../state/AppState.js";
import { useConfirm } from "../state/ConfirmContext.js";
import { IfCan } from "../auth/RequireCapability.js";
import { money } from "../format.js";
import { OFFLINE_FLUSH_EVENT, OfflineQueuedError } from "../lib/supabase/offlineQueue.js";
import type { OfflineFlushDetail } from "../lib/supabase/offlineQueue.js";
import { NfceModal } from "../components/NfceModal.js";
import { PhotoCapture } from "../components/PhotoCapture.js";
import { PassagemTurnoForm } from "../components/PassagemTurnoForm.js";
import { PassagemTurnoGate } from "../components/PassagemTurnoGate.js";
import { normalizeHandover, validateHandover } from "../lib/passagemTurno.js";
import type { HandoverDraft } from "../lib/passagemTurno.js";
import { extensionForMime } from "../lib/imageCompression.js";
import { Emoji3D, renderEmoji } from "../components/Emoji3D.js";

const METHODS = ["DINHEIRO", "PIX", "CREDITO", "DEBITO"] as const;

type CloseResult = CloseShiftResult;

export function CaixaScreen() {
  const { unit, employee } = useAppState();
  const confirm = useConfirm();
  const [shift, setShift] = useState<Shift | null | undefined>(undefined);
  const [openingCash, setOpeningCash] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [movements, setMovements] = useState<CashMovement[]>([]);
  const [revenue, setRevenue] = useState<RevenueByMethod[]>([]);
  const [sales, setSales] = useState<ShiftSale[]>([]);
  const [movementKind, setMovementKind] = useState<"SANGRIA" | "SUPRIMENTO">("SANGRIA");
  const [movementAmount, setMovementAmount] = useState("0");
  const [movementReason, setMovementReason] = useState("");
  const [selectedSaleForNfce, setSelectedSaleForNfce] = useState<{
    doc: FiscalDoc | null;
    sale: ShiftSale;
  } | null>(null);

  const [nfseDocsMap, setNfseDocsMap] = useState<Record<string, FiscalDoc | null>>({});
  const [nfseLoadingMap, setNfseLoadingMap] = useState<Record<string, boolean>>({});
  const [whatsappPhoneModal, setWhatsappPhoneModal] = useState<{ sale: ShiftSale; doc: FiscalDoc } | null>(null);
  const [customWhatsappPhone, setCustomWhatsappPhone] = useState("");
  // Modal de motivo de bloqueio/rejeição — serve para NFS-e e NFC-e; o
  // doc.doc_type decide o que aparece (edição de CPF só faz sentido na NFS-e).
  const [fiscalErrorModal, setFiscalErrorModal] = useState<{ sale: ShiftSale; doc: FiscalDoc } | null>(null);
  const [cpfInputModal, setCpfInputModal] = useState("");
  const [cpfUpdating, setCpfUpdating] = useState(false);

  // NFC-e das vendas do PDV — a emissão é automática (worker do balcão);
  // aqui só acompanhamos o status e liberamos o "Tentar Novamente".
  const [nfceDocsMap, setNfceDocsMap] = useState<Record<string, FiscalDoc | null>>({});
  const [nfceRetryingMap, setNfceRetryingMap] = useState<Record<string, boolean>>({});
  const [bonusRules, setBonusRules] = useState<BonusRule[]>([]);

  // Passagem de turno escrita no fechamento (obrigatória — ver
  // migration 20260920100000 e lib/passagemTurno.ts).
  const [handover, setHandover] = useState<HandoverDraft>({ noChanges: false, conteudo: "" });
  const [handoverTouched, setHandoverTouched] = useState(false);
  // Ciência já dada nesta sessão de tela. O portão consulta o servidor
  // a cada montagem, então isto só evita remontá-lo à toa depois do ack.
  const [handoverLido, setHandoverLido] = useState(false);

  useEffect(() => {
    if (unit?.id) {
      Api.bonusRules(unit.id).then(setBonusRules).catch(() => {});
    }
  }, [unit?.id]);

  async function loadNfceDocsForSales(salesList: ShiftSale[]) {
    const orderIds = salesList.filter((s) => s.kind === "PDV").map((s) => s.orderId);
    if (orderIds.length === 0) return;
    // Uma consulta em lote em vez de uma por venda (ver Api.fiscalDocsByOrders).
    const docs = await Api.fiscalDocsByOrders(orderIds, "NFCE").catch(() => ({}) as Record<string, FiscalDoc>);
    setNfceDocsMap((prev) => ({ ...prev, ...docs }));
  }

  async function handleRetryNfce(sale: ShiftSale, doc: FiscalDoc) {
    setNfceRetryingMap((prev) => ({ ...prev, [sale.orderId]: true }));
    try {
      await Api.retryNfce(doc.id);
      setNfceDocsMap((prev) => ({
        ...prev,
        [sale.orderId]: { ...doc, status: "PENDENTE", last_error: null, reject_code: null, reject_message: null },
      }));
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts += 1;
        const fresh = await Api.fiscalDocByOrder(sale.orderId).catch(() => null);
        if (fresh) {
          setNfceDocsMap((prev) => ({ ...prev, [sale.orderId]: fresh }));
          if (fresh.status === "AUTORIZADO" || ["BLOQUEADO", "REJEITADO", "DENEGADO", "CANCELADO"].includes(fresh.status)) {
            clearInterval(interval);
            setNfceRetryingMap((prev) => ({ ...prev, [sale.orderId]: false }));
          }
        }
        if (attempts >= 10) {
          clearInterval(interval);
          setNfceRetryingMap((prev) => ({ ...prev, [sale.orderId]: false }));
        }
      }, 2000);
    } catch (err) {
      alert(err instanceof Error && err.message ? err.message : "Não foi possível reenviar a NFC-e. Tente novamente.");
      setNfceRetryingMap((prev) => ({ ...prev, [sale.orderId]: false }));
    }
  }

  async function loadNfseDocsForSales(salesList: ShiftSale[]) {
    const orderIds = salesList.filter((s) => s.kind === "SESSAO").map((s) => s.orderId);
    if (orderIds.length === 0) return;
    const docs = await Api.fiscalDocsByOrders(orderIds, "NFSE").catch(() => ({}) as Record<string, FiscalDoc>);
    setNfseDocsMap((prev) => ({ ...prev, ...docs }));
  }

  async function handleEmitNfse(sale: ShiftSale) {
    setNfseLoadingMap((prev) => ({ ...prev, [sale.orderId]: true }));
    try {
      await Api.requestNfse(sale.orderId);
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts += 1;
        const doc = await Api.nfseDocByOrder(sale.orderId).catch(() => null);
        if (doc) {
          setNfseDocsMap((prev) => ({ ...prev, [sale.orderId]: doc }));
          if (doc.status === "AUTORIZADO" || ["BLOQUEADO", "REJEITADO", "DENEGADO", "CANCELADO"].includes(doc.status)) {
            clearInterval(interval);
            setNfseLoadingMap((prev) => ({ ...prev, [sale.orderId]: false }));
          }
        }
        if (attempts >= 10) {
          clearInterval(interval);
          setNfseLoadingMap((prev) => ({ ...prev, [sale.orderId]: false }));
        }
      }, 2000);
    } catch {
      alert("Não foi possível solicitar a emissão da NFS-e. Tente novamente.");
      setNfseLoadingMap((prev) => ({ ...prev, [sale.orderId]: false }));
    }
  }

  async function handleSendNfseWhatsapp(sale: ShiftSale, doc: FiscalDoc, overridePhone?: string) {
    const phone = overridePhone ?? sale.guardianPhone;
    if (!phone || !phone.trim()) {
      setWhatsappPhoneModal({ sale, doc });
      setCustomWhatsappPhone("");
      return;
    }

    const digits = phone.replace(/\D/g, "");
    const fullPhone = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;

    const respStr = sale.guardianName ? `Olá, ${sale.guardianName}! ` : "Olá! ";
    const valStr = money(doc.total_cents ?? sale.amountCents);
    const numStr = doc.nfse_numero ?? doc.numero ?? "—";
    const serieStr = doc.serie ?? "1";

    const messageLines = [
      `${respStr}Segue a sua Nota Fiscal de Serviços Eletrônica (NFS-e) emitida pelo FaçaAmigos:`,
      ``,
      `📄 NFS-e nº ${numStr} / Série ${serieStr}`,
      `Valor: ${valStr}`,
      doc.access_key ? `Chave: ${doc.access_key}` : null,
      ``,
      `Agradecemos a sua visita e ficamos à disposição! 🎈`,
    ].filter((l): l is string => l !== null);

    const text = encodeURIComponent(messageLines.join("\n"));
    window.open(`https://wa.me/${fullPhone}?text=${text}`, "_blank");

    try {
      await Api.markNfseSent(doc.id);
      setNfseDocsMap((prev) => ({
        ...prev,
        [sale.orderId]: { ...doc, guardian_whatsapp_sent_at_ms: Date.now() },
      }));
    } catch {
      // ignore
    }

    if (whatsappPhoneModal) {
      setWhatsappPhoneModal(null);
    }
  }

  async function openNfceForSale(sale: ShiftSale) {
    try {
      const doc = await Api.fiscalDocByOrder(sale.orderId).catch(() => null);
      setSelectedSaleForNfce({ doc, sale });
    } catch {
      setSelectedSaleForNfce({ doc: null, sale });
    }
  }

  const [closing, setClosing] = useState(false);
  const [declared, setDeclared] = useState<Record<string, string>>({ DINHEIRO: "0", PIX: "0", CREDITO: "0", DEBITO: "0" });
  const [closeJustifications, setCloseJustifications] = useState<Record<string, string>>({});
  const [closeResult, setCloseResult] = useState<CloseResult | null>(null);
  // Conferência física da gaveta no fechamento (regra de 2026-09-02, ver
  // migration 20260902000001): Dinheiro_Total_Gaveta contado e
  // Fundo_Caixa_Proximo_Dia. O valor do envelope é derivado (contado − fundo)
  // e nunca digitado. Strings em reais, como `declared`.
  const [countedCash, setCountedCash] = useState("");
  const [nextDayFloat, setNextDayFloat] = useState("");
  // Depois que o envelope derivado desses dois campos foi registrado, eles
  // travam: mudar o contado/fundo depois deixaria o envelope registrado com
  // um valor diferente do calculado (e o servidor recusaria o fechamento).
  const [closingEnvelopeLocked, setClosingEnvelopeLocked] = useState(false);
  const [shiftOpenSuccessModal, setShiftOpenSuccessModal] = useState<{
    openingCashCents: number;
    expectedOpeningCashCents: number | null;
    openingDivergenceCents: number | null;
    openedAtMs: number;
    employeeName: string;
    unitName: string;
  } | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  // Enquanto isso está preenchido, o fechamento foi enviado mas ficou na fila
  // offline (sem rede no momento) — ainda NÃO aconteceu de fato. O
  // OFFLINE_FLUSH_EVENT abaixo resolve isso quando a fila reenviar sozinha.
  const [pendingCloseKey, setPendingCloseKey] = useState<string | null>(null);

  // Mesma lógica do fechamento (pendingCloseKey) aplicada a sangria/suprimento:
  // sem isso, uma queda breve de rede fazia o operador ver "Erro" numa
  // movimentação que na verdade já tinha sido salva na fila offline — e ao
  // tentar de novo (idempotencyKey novo a cada chamada) o valor entrava
  // duplicado quando a fila reenviava sozinha. Ver fa_record_cash_movement.
  const [pendingMovementKey, setPendingMovementKey] = useState<string | null>(null);

  // Rascunho do fechamento em sessionStorage (por turno). Se a tela remontar
  // no meio do fechamento (troca de aba, recarga, queda de sessão), sem isto
  // o valor contado/fundo voltavam a vazio: o envelope calculado virava R$ 0,00
  // (e contava como "registrado"), mesmo já tendo sido gravado no servidor, e
  // a passagem de turno digitada se perdia.
  const closingDraftKey = shift ? `fa:closing-draft:${shift.id}` : null;
  const [closingDraftLoadedFor, setClosingDraftLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!closingDraftKey || closingDraftLoadedFor === closingDraftKey) return;
    try {
      const raw = sessionStorage.getItem(closingDraftKey);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d === "object") {
          if (typeof d.countedCash === "string") setCountedCash(d.countedCash);
          if (typeof d.nextDayFloat === "string") setNextDayFloat(d.nextDayFloat);
          if (d.declared && typeof d.declared === "object") setDeclared(d.declared);
          if (d.closeJustifications && typeof d.closeJustifications === "object") setCloseJustifications(d.closeJustifications);
          if (d.handover && typeof d.handover === "object") {
            setHandover({ noChanges: !!d.handover.noChanges, conteudo: String(d.handover.conteudo ?? "") });
          }
          if (d.envelopeLocked) setClosingEnvelopeLocked(true);
          if (d.closing) setClosing(true);
        }
      }
    } catch {
      // sessionStorage indisponível/corrompido: segue sem rascunho.
    }
    setClosingDraftLoadedFor(closingDraftKey);
  }, [closingDraftKey, closingDraftLoadedFor]);

  useEffect(() => {
    if (!closingDraftKey || closingDraftLoadedFor !== closingDraftKey) return;
    try {
      if (closing && !closeResult) {
        sessionStorage.setItem(
          closingDraftKey,
          JSON.stringify({
            closing: true,
            countedCash,
            nextDayFloat,
            declared,
            closeJustifications,
            handover,
            envelopeLocked: closingEnvelopeLocked,
          }),
        );
      } else {
        sessionStorage.removeItem(closingDraftKey);
      }
    } catch {
      // idem
    }
  }, [closingDraftKey, closingDraftLoadedFor, closing, closeResult, countedCash, nextDayFloat, declared, closeJustifications, handover, closingEnvelopeLocked]);

  // Estados do Modal "Registrar Envelope"
  const [envelopeModalOpen, setEnvelopeModalOpen] = useState(false);
  const [envelopeNum, setEnvelopeNum] = useState("");
  const [envelopeNumLoading, setEnvelopeNumLoading] = useState(false);
  const [envelopeVal, setEnvelopeVal] = useState("0");
  const [envelopeFundoCaixa, setEnvelopeFundoCaixa] = useState("0");
  const [envelopePhoto, setEnvelopePhoto] = useState<File | null>(null);
  const [envelopeBusy, setEnvelopeBusy] = useState(false);
  // true quando o modal foi aberto pela tela de fechamento com valor e fundo
  // já calculados — nesse caso os dois campos ficam somente leitura.
  const [envelopeFromClosing, setEnvelopeFromClosing] = useState(false);

  // Número do envelope é gerado pelo servidor (sequência global, não por
  // unidade) assim que o modal abre — o operador não digita mais.
  // `preset` vem da tela de fechamento: valor do envelope (contado − fundo do
  // próximo dia) e o fundo que fica na gaveta, ambos calculados lá.
  async function openEnvelopeModal(preset?: { envelopeCents: number; fundoCents: number }) {
    setEnvelopeModalOpen(true);
    setEnvelopeFromClosing(!!preset);
    setEnvelopeVal(preset ? (preset.envelopeCents / 100).toFixed(2) : "0");
    setEnvelopeFundoCaixa(preset ? (preset.fundoCents / 100).toFixed(2) : "0");
    setEnvelopeNum("");
    setEnvelopeNumLoading(true);
    try {
      const num = await Api.nextEnvelopeNumber();
      setEnvelopeNum(num);
    } catch (err) {
      console.warn("[openEnvelopeModal]", err);
      alert("Não foi possível gerar o número do envelope. Tente novamente.");
      setEnvelopeModalOpen(false);
    } finally {
      setEnvelopeNumLoading(false);
    }
  }

  async function handleSaveEnvelope() {
    if (!unit || !employee || !shift) return;
    const amountCents = Math.round(Number(envelopeVal) * 100);
    if (amountCents <= 0) {
      alert("Informe um valor válido maior que zero para o envelope.");
      return;
    }
    if (!envelopePhoto) {
      alert("Anexe a foto do envelope antes de confirmar.");
      return;
    }
    const fundoCaixaCents = Math.round(Number(envelopeFundoCaixa) * 100);
    if (!Number.isFinite(fundoCaixaCents) || fundoCaixaCents < 0) {
      alert("Informe um valor válido para o fundo de caixa.");
      return;
    }
    setEnvelopeBusy(true);
    try {
      const photoUrl = await Api.uploadEnvelopePhoto(unit.id, envelopePhoto);
      await Api.cashMovement(shift.id, {
        employeeId: employee.id,
        kind: "SANGRIA",
        amountCents,
        envelopeNumber: envelopeNum,
        photoUrl,
        fundoCaixaCents,
      });

      alert(`Envelope #${envelopeNum} registrado com sucesso!`);
      if (envelopeFromClosing) setClosingEnvelopeLocked(true);
      setEnvelopeModalOpen(false);
      setEnvelopeFromClosing(false);
      setEnvelopeNum("");
      setEnvelopeVal("0");
      setEnvelopeFundoCaixa("0");
      setEnvelopePhoto(null);
      await refresh();
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        // A movimentação FOI salva (fila offline) e será reenviada sozinha —
        // fechar o modal e limpar o formulário evita que o operador registre
        // o mesmo envelope de novo (o que criaria uma sangria duplicada,
        // já que cada chamada usa uma idempotencyKey nova).
        alert(`Sem conexão: envelope #${envelopeNum} foi salvo e será enviado automaticamente quando a rede voltar. Não registre este envelope novamente.`);
        setPendingMovementKey(err.idempotencyKey);
        if (envelopeFromClosing) setClosingEnvelopeLocked(true);
        setEnvelopeModalOpen(false);
        setEnvelopeFromClosing(false);
        setEnvelopeNum("");
        setEnvelopeVal("0");
        setEnvelopeFundoCaixa("0");
        setEnvelopePhoto(null);
      } else {
        console.warn("[handleSaveEnvelope]", err);
        const msg = err instanceof Error && err.message ? err.message : "Erro ao registrar o envelope.";
        alert(msg);
      }
    } finally {
      setEnvelopeBusy(false);
    }
  }

  async function refresh() {

    if (!unit) return;
    try {
      const current = await Api.currentShift(unit.id);
      setShift(current);
      if (current) {
        setMovements(await Api.cashMovements(current.id));
        setRevenue(await Api.revenueByMethod(current.id));
        const fetchedSales = await Api.shiftSales(current.id);
        setSales(fetchedSales);
        loadNfseDocsForSales(fetchedSales);
        loadNfceDocsForSales(fetchedSales);
      }
      setRefreshError(false);
    } catch {
      // Repolla a cada 5s (setInterval abaixo) sem try/catch aqui virava
      // uma rejeição não tratada a cada falha, e a tela ficava com dado
      // velho sem nenhum sinal disso. Mantém o último bom na tela — só
      // acende o aviso; não troca o turno/movimentos por um vazio.
      setRefreshError(true);
    }
  }

  // Intervalo de 5 s -> 15 s e parado com a janela escondida: cada ciclo são
  // ~7 consultas em série. Ações feitas NESTA tela já chamam refresh() direto
  // (abertura, sangria, fechamento...); o intervalo só serve para enxergar
  // vendas feitas em outro terminal da unidade, que passam a aparecer em até 15 s.
  useEffect(() => {
    return startVisiblePolling(() => void refresh(), 15_000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit]);

  useEffect(() => {
    if (!pendingCloseKey) return;
    function onFlush(event: Event) {
      const detail = (event as CustomEvent<OfflineFlushDetail>).detail;
      if (detail.idempotencyKey !== pendingCloseKey) return;
      setPendingCloseKey(null);
      if (detail.success) {
        setCloseResult(detail.data as CloseResult);
      } else {
        // A fila desistiu (erro de regra de negócio no reenvio, ex.: turno já
        // fechado por outra via) — o fechamento não vai acontecer sozinho.
        setError("Não foi possível concluir o fechamento enviado anteriormente. Tente fechar o turno novamente.");
      }
      refresh();
    }
    window.addEventListener(OFFLINE_FLUSH_EVENT, onFlush);
    return () => window.removeEventListener(OFFLINE_FLUSH_EVENT, onFlush);
  }, [pendingCloseKey]);

  useEffect(() => {
    if (!pendingMovementKey) return;
    function onFlush(event: Event) {
      const detail = (event as CustomEvent<OfflineFlushDetail>).detail;
      if (detail.idempotencyKey !== pendingMovementKey) return;
      setPendingMovementKey(null);
      if (!detail.success) {
        // Erro de regra de negócio no reenvio (ex.: turno fechado nesse meio
        // tempo) — a movimentação NÃO aconteceu; precisa ser refeita manualmente.
        setError("Uma movimentação enviada sem conexão não pôde ser concluída. Confira o Fluxo de Dinheiro e registre novamente se necessário.");
      }
      refresh();
    }
    window.addEventListener(OFFLINE_FLUSH_EVENT, onFlush);
    return () => window.removeEventListener(OFFLINE_FLUSH_EVENT, onFlush);
  }, [pendingMovementKey]);

  async function openShift() {
    if (!unit || !employee) return;
    setBusy(true);
    setError(null);
    try {
      const openingCashCents = Math.round(Number(openingCash) * 100);
      if (!Number.isFinite(openingCashCents) || openingCashCents < 0) {
        setError("Informe um valor válido para o fundo de caixa contado.");
        return;
      }
      const opened = await Api.openShift({ unitId: unit.id, employeeId: employee.id, openingCashCents });
      await refresh();
      setShiftOpenSuccessModal({
        openingCashCents,
        expectedOpeningCashCents: opened?.expectedOpeningCashCents ?? null,
        openingDivergenceCents: opened?.openingDivergenceCents ?? null,
        openedAtMs: Date.now(),
        employeeName: employee.full_name,
        unitName: unit.name,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao abrir turno";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function addMovement() {
    if (!shift || !employee) return;
    setBusy(true);
    setError(null);
    try {
      await Api.cashMovement(shift.id, {
        employeeId: employee.id,
        kind: movementKind,
        amountCents: Math.round(Number(movementAmount) * 100),
        reason: movementReason || undefined,
      });
      setMovementAmount("0");
      setMovementReason("");
      await refresh();
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        // Idem ao envelope: já foi salva na fila, limpa o formulário para
        // não convidar um reenvio duplicado quando ela sincronizar sozinha.
        setPendingMovementKey(err.idempotencyKey);
        setMovementAmount("0");
        setMovementReason("");
      } else {
        const msg = err instanceof Error ? err.message : "Erro ao registrar movimentação";
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmClose() {
    if (!shift || !employee) return;
    setBusy(true);
    setError(null);
    try {
      const declaredCents: Record<string, number> = {};
      for (const [method, value] of Object.entries(declared)) declaredCents[method] = Math.round(Number(value) * 100);
      const justificationsToSend: Record<string, string> = {};
      for (const method of METHODS) {
        const divergenceCents = (declaredCents[method] ?? 0) - expectedHint(method, revenue);
        const text = (closeJustifications[method] ?? "").trim();
        if (divergenceCents !== 0 && text) justificationsToSend[method] = text;
      }
      const cm = closingMath();
      const gavetaText = (closeJustifications.GAVETA ?? "").trim();
      if (cm.cashBreakCents !== 0 && gavetaText) justificationsToSend.GAVETA = gavetaText;
      const result = await Api.closeShift(shift.id, {
        employeeId: employee.id,
        declared: declaredCents,
        justifications: justificationsToSend,
        countedCashCents: cm.countedCents,
        nextDayFloatCents: cm.nextDayFloatCents,
        handover: normalizeHandover(handover),
      });
      setCloseResult(result);
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        // Não é um erro de fato: a chamada foi guardada e será reenviada
        // sozinha (ver OFFLINE_FLUSH_EVENT acima). O fechamento AINDA NÃO
        // aconteceu — por isso não mostra o resumo nem sai desta tela.
        setPendingCloseKey(err.idempotencyKey);
      } else {
        const msg = err instanceof Error ? err.message : "Erro ao fechar turno";
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Conta da gaveta na tela de fechamento. Espelha fa_close_shift:
   *   esperado agora = fundo inicial + vendas em dinheiro + suprimentos/ajustes
   *                    − sangrias (avulsas e envelopes já registrados)
   *   envelope       = contado − fundo do próximo dia (calculado, não digitado)
   *   quebra/sobra   = contado − (esperado agora + envelope já registrado)
   * O envelope registrado entra de volta no esperado porque a contagem foi
   * feita ANTES de separá-lo.
   */
  function closingMath() {
    const dm = drawerMath(revenue, movements);
    const countedCents = Math.round(Number(countedCash) * 100);
    const nextDayFloatCents = Math.round(Number(nextDayFloat) * 100);
    const countedValid = countedCash.trim() !== "" && Number.isFinite(countedCents) && countedCents >= 0;
    const floatValid =
      nextDayFloat.trim() !== "" && Number.isFinite(nextDayFloatCents) && nextDayFloatCents >= 0 && (!countedValid || nextDayFloatCents <= countedCents);
    const envelopeCents = countedValid && floatValid ? countedCents - nextDayFloatCents : 0;
    const envelopeRegistered =
      envelopeCents === 0 || movements.some((m) => m.kind === "SANGRIA" && !!m.envelope_number && m.amount_cents === envelopeCents);
    const drawerExpectedCents = dm.drawerNowCents + (envelopeCents > 0 && envelopeRegistered ? envelopeCents : 0);
    const cashBreakCents = countedValid ? countedCents - drawerExpectedCents : 0;
    return { ...dm, countedCents, nextDayFloatCents, countedValid, floatValid, envelopeCents, envelopeRegistered, drawerExpectedCents, cashBreakCents };
  }

  async function handleConfirmClose() {
    // Valida a passagem ANTES do diálogo de confirmação: não faz sentido
    // perguntar "tem certeza?" sobre um fechamento que o banco vai recusar.
    const passagem = validateHandover(handover);
    if (!passagem.ok) {
      setHandoverTouched(true);
      setError("Preencha a Passagem de Turno antes de fechar o caixa.");
      return;
    }
    const ok = await confirm({
      title: "Fechar turno de caixa?",
      message: "Essa ação é irreversível e vai encerrar o turno atual. Confira os valores declarados antes de continuar.",
      confirmLabel: "Fechar turno",
      cancelLabel: "Revisar valores",
      variant: "danger",
    });
    if (ok) await confirmClose();
  }

  const renderEnvelopeModal = () => {
    if (!envelopeModalOpen) return null;
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          display: "flex",
          alignItems: "safe center",
          justifyContent: "center",
          overflowY: "auto",
          padding: "24px",
          zIndex: 9999,
        }}
      >
        <Card
          style={{
            width: "90%",
            maxWidth: "450px",
            maxHeight: "calc(100dvh - 48px)",
            overflowY: "auto",
            padding: "24px",
            borderRadius: "16px",
            background: "var(--surface-card)",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: "20px" }}><Emoji3D e="✉️" /> Registrar Envelope (Sangria)</h2>
          <HelpText style={{ marginBottom: "16px" }}>
            {envelopeFromClosing
              ? "Valor do envelope e fundo de caixa vêm da conferência do fechamento (contado − fundo do próximo dia). Confira o dinheiro separado, fotografe o envelope e confirme."
              : "Registre a retirada de valores em espécie com o número do envelope correspondente."}
          </HelpText>

          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <Input
              label="Número do Envelope"
              value={envelopeNumLoading ? "Gerando..." : `#${envelopeNum}`}
              disabled
              readOnly
            />
            <Input
              label="Valor do Envelope (R$)"
              type="number"
              value={envelopeVal}
              onChange={(e) => setEnvelopeVal(e.target.value)}
              disabled={envelopeFromClosing}
              readOnly={envelopeFromClosing}
            />
            <Input
              label={envelopeFromClosing ? "Fundo de Caixa para o próximo dia (R$)" : "Fundo de Caixa (R$)"}
              placeholder="Valor que fica na gaveta após a sangria"
              type="number"
              value={envelopeFundoCaixa}
              onChange={(e) => setEnvelopeFundoCaixa(e.target.value)}
              disabled={envelopeFromClosing}
              readOnly={envelopeFromClosing}
            />
            <PhotoCapture
              label="Foto do Envelope (obrigatória)"
              buttonLabel="📷 Tirar foto do envelope"
              previewAlt="Foto capturada do envelope"
              showEnvelopeGrid={true}
              onChange={(blob) =>
                setEnvelopePhoto(blob ? new File([blob], `envelope-${Date.now()}.${extensionForMime(blob.type)}`, { type: blob.type }) : null)
              }
            />

            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "16px" }}>
              <Button
                variant="secondary"
                disabled={envelopeBusy}
                onClick={() => {
                  setEnvelopeModalOpen(false);
                  setEnvelopeFromClosing(false);
                }}
              >
                Cancelar
              </Button>
              <Button
                variant="primary"
                loading={envelopeBusy}
                disabled={
                  envelopeBusy ||
                  envelopeNumLoading ||
                  !!pendingMovementKey ||
                  !envelopeNum ||
                  Number(envelopeVal) <= 0 ||
                  !envelopePhoto ||
                  Number.isNaN(Number(envelopeFundoCaixa)) ||
                  Number(envelopeFundoCaixa) < 0
                }
                onClick={handleSaveEnvelope}
              >
                {pendingMovementKey ? "Aguardando conexão..." : renderEmoji("💾 Confirmar Registro")}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  };

  if (!unit || shift === undefined) return null;

  // closeResult precisa ser checado ANTES de `shift === null`: o poll de 5s
  // (useEffect acima) já busca de novo o turno assim que o fechamento é
  // confirmado, e como o turno acabou de fechar `currentShift` volta null.
  // Se o "Abrir turno" fosse checado primeiro, a tela de conferência
  // (esperado x declarado x divergência) seria substituída por "Abrir
  // turno" antes do operador conseguir ler — inclusive com divergência.
  if (closeResult) {
    return (
      <div style={{ maxWidth: "540px", margin: "40px auto", padding: "0 16px" }}>
        <Card style={{ padding: "24px", borderRadius: "18px", boxShadow: "0 10px 30px rgba(0,0,0,0.1)" }}>
          <div style={{ textAlign: "center", marginBottom: "20px" }}>
            <div
              style={{
                width: "60px",
                height: "60px",
                margin: "0 auto 12px",
                borderRadius: "50%",
                background: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "28px",
                color: "#fff",
                boxShadow: "0 8px 18px rgba(59, 130, 246, 0.3)",
              }}
            >
              <Emoji3D e="🏁" />
            </div>
            <h1 style={{ fontFamily: "var(--font-display)", fontSize: "22px", margin: "0 0 6px 0", color: "var(--text-primary)" }}>
              Turno Fechado com Sucesso!
            </h1>
            <p style={{ margin: 0, fontSize: "14px", color: "var(--text-secondary)" }}>
              Resumo de conferência de caixa · {new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>

          <HelpText style={{ marginBottom: "16px" }}>
            "Declarado" é o total vendido que você informou. "✓ Zero divergência" confirma que bateu com as vendas registradas
            no sistema.
          </HelpText>

          <div style={{ overflowX: "auto", marginBottom: "20px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--border-subtle)" }}>
                  <th style={{ textAlign: "left", padding: "8px" }}>Método</th>
                  <th style={{ textAlign: "right", padding: "8px" }}>Declarado</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Situação</th>
                  <th style={{ textAlign: "left", padding: "8px" }}>Justificativa</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(closeResult.divergence).map((method) => {
                  const isShortage = (closeResult.divergence[method] ?? 0) < 0;
                  return (
                    <tr key={method} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                      <td style={{ padding: "8px", fontWeight: "600" }}>{method}</td>
                      <td style={{ textAlign: "right", padding: "8px", fontVariantNumeric: "tabular-nums" }}>{money(closeResult.declared[method] ?? 0)}</td>
                      <td
                        style={{
                          padding: "8px",
                          fontWeight: "bold",
                          color: isShortage ? "var(--color-error-text)" : "var(--color-teal-text)",
                        }}
                      >
                        {isShortage ? "⚠ Divergência" : "✓ Zero divergência"}
                      </td>
                      <td style={{ fontSize: "13px", padding: "8px" }}>{isShortage ? closeResult.justifications[method] ?? "—" : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {closeResult.countedCashCents !== null && (
            <div style={{ background: "var(--surface-sunken)", borderRadius: "12px", padding: "12px 14px", marginBottom: "20px", display: "flex", flexDirection: "column", gap: "6px" }}>
              <strong style={{ fontSize: "14px" }}><Emoji3D e="💵" /> Conferência da gaveta</strong>
              <SummaryRow label="Dinheiro contado na gaveta" value={money(closeResult.countedCashCents)} />
              <SummaryRow label="Esperado pelo sistema" value={money(closeResult.drawerExpectedCents ?? 0)} />
              <SummaryRow
                label="Quebra / sobra"
                value={fmtBreak(closeResult.cashBreakCents ?? 0, "quebra")}
                tone={(closeResult.cashBreakCents ?? 0) < 0 ? "warn" : "ok"}
              />
              <SummaryRow label="Fundo de caixa para o próximo dia" value={money(closeResult.nextDayFloatCents ?? 0)} strong />
              <SummaryRow label="Valor no envelope" value={money(closeResult.envelopeCents ?? 0)} strong />
              <HelpText style={{ marginTop: "4px" }}>
                Na próxima abertura o operador deve contar exatamente o fundo acima — qualquer diferença é avisada ao proprietário.
              </HelpText>
            </div>
          )}

          <Button
            variant="primary"
            size="lg"
            onClick={() => { setCloseResult(null); setClosing(false); setCloseJustifications({}); setCountedCash(""); setNextDayFloat(""); setClosingEnvelopeLocked(false); refresh(); }}
            style={{ width: "100%", borderRadius: "10px" }}
          >
            ✓ Entendido, Concluir Fechamento
          </Button>
        </Card>
      </div>
    );
  }

  if (shift === null) {
    return (
      <div style={{ maxWidth: "420px", margin: "60px auto", display: "flex", flexDirection: "column", gap: "16px" }}>
        <h1 style={{ fontFamily: "var(--font-display)" }}>Abrir turno</h1>
        <HelpText>
          É preciso abrir o turno de caixa antes de vender no PDV ou fechar atendimentos. <strong>Conte</strong> o dinheiro
          em espécie que está na gaveta agora e informe o valor. O sistema confere com o fundo de caixa declarado no último
          fechamento desta loja — qualquer diferença fica registrada e o proprietário é avisado.
        </HelpText>
        <Input label="Fundo de Caixa contado na abertura (R$)" type="number" value={openingCash} onChange={(e) => setOpeningCash(e.target.value)} />
        {error && <p style={{ color: "var(--color-error-text)" }}>{error}</p>}
        <Button variant="primary" size="lg" loading={busy} disabled={busy} onClick={openShift}>
          Abrir turno
        </Button>
      </div>
    );
  }

  if (closing) {
    const cm = closingMath();
    const methodsOk = METHODS.every((method) => {
      const divergenceCents = Math.round(Number(declared[method]) * 100) - expectedHint(method, revenue);
      const isShortage = divergenceCents < 0;
      return !isShortage || (closeJustifications[method] ?? "").trim().length >= 3;
    });
    const gavetaJustificationOk = cm.cashBreakCents >= 0 || (closeJustifications.GAVETA ?? "").trim().length >= 3;
    const canConfirmClose = methodsOk && cm.countedValid && cm.floatValid && cm.envelopeRegistered && gavetaJustificationOk;
    const otherMovementsCents = cm.suprimentosCents + cm.ajustesCents - cm.sangriasAvulsasCents - cm.envelopesCents;
    return (
      <div style={{ maxWidth: "420px", margin: "40px auto", display: "flex", flexDirection: "column", gap: "12px" }}>
        {renderEnvelopeModal()}
        <h1 style={{ fontFamily: "var(--font-display)" }}>Fechar turno</h1>
        <HelpText>
          Digite o total <strong>vendido neste turno</strong> em cada forma de pagamento, conferindo o dinheiro
          e os comprovantes. Em DINHEIRO, informe só o que foi vendido: o fundo de caixa fica na gaveta e é
          conferido na abertura do próximo turno. Se houver divergência com o esperado pelo sistema, será pedida
          uma justificativa (sem mostrar o valor esperado).
        </HelpText>
        <p>Digite o total vendido por método:</p>
        <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Método</th>
              <th style={{ textAlign: "right" }}>Declarado</th>
              <th style={{ textAlign: "left" }}>Situação</th>
              <th style={{ textAlign: "left" }}>Justificativa</th>
            </tr>
          </thead>
          <tbody>
            {METHODS.map((method) => {
              const expectedCents = expectedHint(method, revenue);
              const declaredCents = Math.round(Number(declared[method]) * 100);
              const divergenceCents = declaredCents - expectedCents;
              const isShortage = divergenceCents < 0;
              return (
                <tr key={method}>
                  <td>{method}</td>
                  <td style={{ textAlign: "right" }}>
                    <Input
                      type="number"
                      value={declared[method]}
                      onChange={(e) => setDeclared((prev) => ({ ...prev, [method]: e.target.value }))}
                    />
                  </td>
                  <td
                    style={{
                      fontWeight: isShortage ? "bold" : "normal",
                      color: isShortage ? "var(--color-error-text)" : "var(--color-teal-text)",
                    }}
                  >
                    {isShortage ? "⚠ Divergência — justifique abaixo" : "✓ Zero divergência"}
                  </td>
                  <td>
                    {isShortage && (
                      <Input
                        placeholder="Por que houve diferença? (mín. 3 caracteres)"
                        value={closeJustifications[method] ?? ""}
                        onChange={(e) => setCloseJustifications((prev) => ({ ...prev, [method]: e.target.value }))}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
          <h2 style={{ margin: 0, fontSize: "18px" }}><Emoji3D e="💵" /> Conferência do dinheiro na gaveta</h2>
          <HelpText>
            Conte <strong>todo</strong> o dinheiro em espécie da gaveta (fundo + vendas) antes de separar o envelope. Depois
            informe quanto fica na gaveta para amanhã: o valor do envelope é calculado (contado − fundo) e precisa ser
            registrado com foto antes de confirmar.
          </HelpText>
          <SummaryRow label="Fundo de caixa inicial (abertura)" value={money(cm.openingCents)} />
          <SummaryRow label="Faturamento em dinheiro" value={money(cm.cashSalesCents)} />
          {otherMovementsCents !== 0 && (
            <SummaryRow label="Suprimentos / ajustes − sangrias já registradas" value={money(otherMovementsCents)} />
          )}
          <SummaryRow label="Esperado na gaveta agora" value={money(cm.drawerNowCents)} strong />
          <Input
            label="Dinheiro total contado na gaveta (R$)"
            type="number"
            value={countedCash}
            onChange={(e) => setCountedCash(e.target.value)}
            disabled={closingEnvelopeLocked}
            readOnly={closingEnvelopeLocked}
            error={countedCash.trim() !== "" && !cm.countedValid ? "Informe um valor válido (maior ou igual a zero)." : undefined}
          />
          <Input
            label="Fundo de caixa para o próximo dia (R$)"
            type="number"
            value={nextDayFloat}
            onChange={(e) => setNextDayFloat(e.target.value)}
            disabled={closingEnvelopeLocked}
            readOnly={closingEnvelopeLocked}
            error={
              nextDayFloat.trim() !== "" && !cm.floatValid
                ? "O fundo para o próximo dia não pode ser negativo nem maior que o dinheiro contado."
                : undefined
            }
          />
          {closingEnvelopeLocked && (
            <HelpText><Emoji3D e="🔒" /> Valores travados: o envelope já foi registrado com base neles.</HelpText>
          )}
          <SummaryRow label="Valor para o envelope (contado − fundo)" value={money(cm.envelopeCents)} strong />
          {cm.countedValid && (
            <p
              style={{
                margin: 0,
                fontWeight: "bold",
                color: cm.cashBreakCents < 0 ? "var(--color-error-text)" : "var(--color-teal-text)",
              }}
            >
              {cm.cashBreakCents < 0
                ? `⚠ ${fmtBreak(cm.cashBreakCents, "quebra")} em relação ao esperado — justifique abaixo`
                : "✓ Contagem bate com o esperado pelo sistema (sem divergência)"}
            </p>
          )}
          {cm.countedValid && cm.cashBreakCents < 0 && (
            <Input
              placeholder="Por que houve falta na contagem? (mín. 3 caracteres)"
              value={closeJustifications.GAVETA ?? ""}
              onChange={(e) => setCloseJustifications((prev) => ({ ...prev, GAVETA: e.target.value }))}
            />
          )}
          {cm.envelopeCents > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <p style={{ margin: 0, fontWeight: "bold", color: cm.envelopeRegistered ? "var(--color-teal-text)" : "var(--color-amber)" }}>
                {cm.envelopeRegistered
                  ? `✓ Envelope de ${money(cm.envelopeCents)} registrado neste turno`
                  : pendingMovementKey
                    ? renderEmoji("⏳ Envelope salvo sem conexão — aguardando a rede para confirmar")
                    : `⚠ Registre o envelope de ${money(cm.envelopeCents)} (com foto) antes de confirmar o fechamento`}
              </p>
              {!cm.envelopeRegistered && !pendingMovementKey && (
                <IfCan capability="caixa.open_close">
                  <Button
                    variant="secondary"
                    onClick={() => void openEnvelopeModal({ envelopeCents: cm.envelopeCents, fundoCents: cm.nextDayFloatCents })}
                    disabled={busy || !!pendingCloseKey}
                  >
                    <Emoji3D e="✉️" /> Registrar Envelope de {money(cm.envelopeCents)}
                  </Button>
                </IfCan>
              )}
            </div>
          )}
        </Card>
        <PassagemTurnoForm
          value={handover}
          onChange={(next) => setHandover(next)}
          disabled={busy || !!pendingCloseKey}
          showError={handoverTouched}
        />
        {error && <p style={{ color: "var(--color-error-text)" }}>{error}</p>}
        {pendingCloseKey && (
          <p style={{ color: "var(--color-amber)" }}>
            <Emoji3D e="⏳" /> Sem conexão no momento da confirmação — o fechamento foi salvo e será concluído automaticamente assim
            que a rede voltar. Não feche o turno de novo nem saia desta tela.
          </p>
        )}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <Button variant="ghost" onClick={() => setClosing(false)} disabled={busy || !!pendingCloseKey}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={handleConfirmClose} loading={busy} disabled={busy || !!pendingCloseKey || !canConfirmClose || !validateHandover(handover).ok}>
            {pendingCloseKey ? "Aguardando conexão..." : "Confirmar fechamento"}
          </Button>
        </div>
      </div>
    );
  }


  return (
    <div className="desk-wide" style={{ maxWidth: "900px", margin: "0 auto", padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
      {renderEnvelopeModal()}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
        <div>
          {/* Título só para leitores de tela: a aba ativa "Caixa" já diz onde a pessoa está. */}
          <h1 className="sr-only">Caixa</h1>
          <HelpText>
            Acompanhe o faturamento e as vendas deste turno, registre retiradas/reforços de dinheiro e feche o turno no
            final do dia.
          </HelpText>
        </div>
        <IfCan capability="caixa.open_close">
          <Button variant="secondary" onClick={() => void openEnvelopeModal()}>
            <Emoji3D e="✉️" /> Registrar Envelope
          </Button>
        </IfCan>
      </div>


      {refreshError && (
        <div
          role="alert"
          style={{ fontSize: "13px", color: "var(--color-error-text)", background: "rgba(232,48,48,0.08)", border: "1px solid var(--color-error)", borderRadius: "10px", padding: "8px 12px" }}
        >
          ⚠️ Não foi possível atualizar o caixa agora — os valores abaixo podem estar desatualizados.
        </div>
      )}

      {shift.opening_divergence_cents !== null && shift.opening_divergence_cents < 0 && (
        <div
          role="alert"
          style={{ fontSize: "13px", color: "var(--color-error-text)", background: "rgba(232,48,48,0.08)", border: "1px solid var(--color-error)", borderRadius: "10px", padding: "8px 12px" }}
        >
          ⚠️ Abertura com divergência no fundo de caixa: contado {money(shift.opening_cash_cents)} vs previsto pelo último
          fechamento {money(shift.expected_opening_cash_cents ?? 0)} ({fmtBreak(shift.opening_divergence_cents, "falta")}). O
          proprietário foi avisado.
        </div>
      )}

      <Card style={{ padding: "16px" }}>
        <h2>Faturamento do turno</h2>
        {revenue.length === 0 && <p>Nenhuma venda ainda.</p>}
        {revenue.map((r) => (
          <div key={r.method} style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{r.method}</span>
            <span>{money(r.total_cents)}</span>
          </div>
        ))}
      </Card>

      <Card style={{ padding: "16px" }}>
        <h2>Vendas do turno</h2>
        <HelpText style={{ marginBottom: "8px" }}>Cada linha é uma venda paga neste turno (entrada ou produto do PDV).</HelpText>
        {sales.length === 0 && <p>Nenhuma venda registrada ainda.</p>}
        {sales.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-subtle)" }}>
                  <th style={{ padding: "6px 8px" }}>Código</th>
                  <th style={{ padding: "6px 8px" }}>Hora</th>
                  <th style={{ padding: "6px 8px" }}>Criança / Responsável</th>
                  <th style={{ padding: "6px 8px" }}>Pagamento</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>Desconto</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>Valor</th>
                  <th style={{ padding: "6px 8px", textAlign: "center" }}>Doc. Fiscal</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.orderId} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                    <td style={{ padding: "6px 8px", fontFamily: "monospace", whiteSpace: "nowrap" }}>{s.orderCode ?? s.orderId.slice(0, 8).toUpperCase()}</td>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{new Date(s.createdAtMs).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</td>
                    <td style={{ padding: "6px 8px" }}>
                      {s.kind === "SESSAO" ? (
                        <>
                          <strong>{s.childNames}</strong>
                          {s.guardianName && <span style={{ display: "block", fontSize: "12px", color: "var(--text-muted)" }}>Resp: {s.guardianName}</span>}
                        </>
                      ) : (
                        <span title={s.productsSummary ?? undefined}><Emoji3D e="🛒" /> {s.productsSummary}</span>
                      )}
                    </td>
                    <td style={{ padding: "6px 8px" }}>{s.method}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>{s.discountCents > 0 ? `−${money(s.discountCents)}` : "—"}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: "bold" }}>{money(s.amountCents)}</td>
                    <td style={{ padding: "6px 8px", textAlign: "center" }}>
                      {s.kind === "PDV" && (() => {
                        const doc = nfceDocsMap[s.orderId];
                        const isRetrying = !!nfceRetryingMap[s.orderId];

                        if (!doc) {
                          return <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>— (sem NFC-e)</span>;
                        }

                        if (isRetrying || ["PENDENTE", "ASSINADO", "TRANSMITIDO"].includes(doc.status)) {
                          return (
                            <span style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: "500" }}>
                              <Emoji3D e="⏳" /> Emitindo…
                            </span>
                          );
                        }

                        if (doc.status === "AUTORIZADO") {
                          return (
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
                              <span style={{ fontSize: "11px", color: "var(--success-color, #10b981)", fontWeight: "bold" }}>
                                ✅ NFC-e nº {doc.numero ?? "—"}
                              </span>
                              <Button variant="ghost" size="sm" onClick={() => openNfceForSale(s)} title="Ver / Imprimir Cupom Fiscal NFC-e">
                                <Emoji3D e="📄" /> Ver cupom
                              </Button>
                            </div>
                          );
                        }

                        if (doc.status === "BLOQUEADO" || doc.status === "REJEITADO") {
                          return (
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
                              <span style={{ fontSize: "11px", color: "var(--error-color, #ef4444)", fontWeight: "bold" }}>
                                ❌ {doc.status}
                              </span>
                              <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", justifyContent: "center" }}>
                                <IfCan capability="nfce.retry">
                                  <Button variant="ghost" size="sm" onClick={() => handleRetryNfce(s, doc)} title="Reenviar a NFC-e para a SEFAZ-PA">
                                    <Emoji3D e="🔄" /> Tentar Novamente
                                  </Button>
                                </IfCan>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setFiscalErrorModal({ sale: s, doc })}
                                  title="Ver o motivo detalhado do erro"
                                >
                                  Ver motivo
                                </Button>
                              </div>
                            </div>
                          );
                        }

                        // DENEGADO, CANCELADO, CONTINGENCIA_OFFLINE etc.: só informa e deixa abrir o cupom.
                        return (
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
                            <span style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: "bold" }}>{doc.status}</span>
                            <Button variant="ghost" size="sm" onClick={() => openNfceForSale(s)} title="Ver detalhes da NFC-e">
                              <Emoji3D e="📄" /> Ver cupom
                            </Button>
                          </div>
                        );
                      })()}
                      {s.kind === "SESSAO" && (() => {
                        const doc = nfseDocsMap[s.orderId];
                        const isLoading = !!nfseLoadingMap[s.orderId] || (doc && ["PENDENTE", "ASSINADO", "TRANSMITIDO"].includes(doc.status));

                        if (isLoading) {
                          return (
                            <span style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: "500" }}>
                              <Emoji3D e="⏳" /> Emitindo...
                            </span>
                          );
                        }

                        if (doc?.status === "AUTORIZADO") {
                          const wasSent = !!doc.guardian_whatsapp_sent_at_ms;
                          return (
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
                              <span style={{ fontSize: "11px", color: "var(--success-color, #10b981)", fontWeight: "bold" }}>
                                ✅ NFS-e nº {doc.nfse_numero ?? doc.numero ?? "—"}
                              </span>
                              <Button
                                variant={wasSent ? "ghost" : "primary"}
                                size="sm"
                                onClick={() => handleSendNfseWhatsapp(s, doc)}
                                title="Enviar NFS-e por WhatsApp ao responsável"
                              >
                                <Emoji3D e="📱" /> {wasSent ? "Reenviar Whats" : "Enviar Whats"}
                              </Button>
                            </div>
                          );
                        }

                        if (doc && ["BLOQUEADO", "REJEITADO", "DENEGADO", "CANCELADO"].includes(doc.status)) {
                          return (
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
                              <button
                                type="button"
                                onClick={() => {
                                  setFiscalErrorModal({ sale: s, doc });
                                  setCpfInputModal(s.guardianCpf ? formatCpf(s.guardianCpf) : "");
                                }}
                                style={{
                                  background: "transparent",
                                  border: "none",
                                  cursor: "pointer",
                                  padding: 0,
                                  fontSize: "11px",
                                  color: "var(--error-color, #ef4444)",
                                  fontWeight: "bold",
                                  textDecoration: "underline",
                                }}
                                title="Clique para ver o motivo detalhado do erro"
                              >
                                ❌ {doc.status} (Motivo)
                              </button>
                              <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", justifyContent: "center" }}>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => setSelectedSaleForNfce({ sale: s, doc })}
                                  title="Ver Comprovante Auxiliar de Venda, gerar PDF ou enviar por WhatsApp"
                                >
                                  <Emoji3D e="📄" /> Comprovante
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleEmitNfse(s)}
                                  title="Tentar emitir novamente"
                                >
                                  <Emoji3D e="🔄" /> Reenviar
                                </Button>
                              </div>
                            </div>
                          );
                        }

                        return (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleEmitNfse(s)}
                            title="Emitir Nota Fiscal de Serviço (NFS-e) sob demanda"
                          >
                            <Emoji3D e="🧾" /> Emitir NFS-e
                          </Button>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selectedSaleForNfce && (
        <NfceModal
          doc={selectedSaleForNfce.doc}
          unitName={unit?.name ?? "FaçaAmigos"}
          orderCode={selectedSaleForNfce.sale.orderCode ?? undefined}
          items={[{ description: selectedSaleForNfce.sale.productsSummary ?? "Produtos PDV", quantity: 1, amountCents: selectedSaleForNfce.sale.amountCents }]}
          payments={[{ method: selectedSaleForNfce.sale.method, amountCents: selectedSaleForNfce.sale.amountCents }]}
          onClose={() => setSelectedSaleForNfce(null)}
        />
      )}

      {whatsappPhoneModal && (
        <Modal title="Enviar NFS-e por WhatsApp" onClose={() => setWhatsappPhoneModal(null)}>
          <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <p style={{ margin: 0, fontSize: "14px" }}>
              Informe o número de WhatsApp do responsável (<strong>{whatsappPhoneModal.sale.guardianName ?? "Responsável"}</strong>) para enviar o comprovante:
            </p>
            <Input
              label="Telefone / WhatsApp"
              placeholder="(11) 99999-9999"
              value={customWhatsappPhone}
              onChange={(e) => setCustomWhatsappPhone(e.target.value)}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}>
              <Button variant="ghost" onClick={() => setWhatsappPhoneModal(null)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                disabled={!customWhatsappPhone.trim()}
                onClick={() => handleSendNfseWhatsapp(whatsappPhoneModal.sale, whatsappPhoneModal.doc, customWhatsappPhone)}
              >
                <Emoji3D e="📱" /> Abrir WhatsApp
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {fiscalErrorModal && (() => {
        const isNfse = fiscalErrorModal.doc.doc_type === "NFSE";
        const docLabel = isNfse ? "NFS-e" : "NFC-e";
        return (
        <Modal
          title={`❌ Detalhes da Falha na ${docLabel} ${fiscalErrorModal.sale.orderCode ? `(#${fiscalErrorModal.sale.orderCode})` : ""}`}
          onClose={() => setFiscalErrorModal(null)}
          maxWidth="520px"
        >
          <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ background: "#FEE2E2", color: "#991B1B", padding: "12px 14px", borderRadius: "10px", fontSize: "13px" }}>
              <strong>Motivo do bloqueio / rejeição{fiscalErrorModal.doc.reject_code ? ` (código ${fiscalErrorModal.doc.reject_code})` : ""}:</strong>
              <p style={{ margin: "4px 0 0 0", fontWeight: 500, lineHeight: "1.4" }}>
                {fiscalErrorModal.doc.last_error ?? fiscalErrorModal.doc.reject_message ?? "Documento fiscal bloqueado sem motivo especificado."}
              </p>
            </div>

            {!isNfse && (
              <HelpText>
                Corrija a causa (NCM/CFOP do produto, CSC ou certificado em Gerencial &gt; Dados Fiscais) e use
                "Tentar Novamente" — a venda já está registrada; só o cupom fiscal é reenviado.
              </HelpText>
            )}

            {isNfse && (
              <div style={{ background: "var(--surface-sunken)", padding: "12px 14px", borderRadius: "10px", fontSize: "13px" }}>
                <div><strong>Responsável:</strong> {fiscalErrorModal.sale.guardianName ?? "Não especificado"}</div>
                <div><strong>CPF Atual no Cadastro:</strong> {fiscalErrorModal.sale.guardianCpf ? formatCpf(fiscalErrorModal.sale.guardianCpf) : "⚠️ Sem CPF cadastrado"}</div>
              </div>
            )}

            {isNfse && fiscalErrorModal.sale.guardianId && (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", background: "var(--surface-card)", border: "1px solid var(--border-subtle)", padding: "14px", borderRadius: "12px" }}>
                <strong style={{ fontSize: "13px" }}><Emoji3D e="✏️" /> Cadastrar/Atualizar CPF do Responsável:</strong>
                <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  Digite o CPF correto abaixo para atualizar o cadastro e tentar a emissão novamente:
                </span>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <Input
                    placeholder="000.000.000-00"
                    inputMode="numeric"
                    value={cpfInputModal}
                    onChange={(e) => setCpfInputModal(formatCpf(e.target.value))}
                    style={{ flex: 1, minWidth: "180px" }}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    loading={cpfUpdating}
                    disabled={cpfUpdating || !isValidCpf(cpfInputModal)}
                    onClick={async () => {
                      if (!fiscalErrorModal.sale.guardianId) return;
                      setCpfUpdating(true);
                      try {
                        await Api.updateGuardianCpf(fiscalErrorModal.sale.guardianId, cpfInputModal);
                        const updatedSale = { ...fiscalErrorModal.sale, guardianCpf: cpfInputModal };
                        setFiscalErrorModal(null);
                        await handleEmitNfse(updatedSale);
                      } catch (err) {
                        const msg = err instanceof Error ? err.message : "Erro ao atualizar CPF";
                        alert(msg);
                      } finally {
                        setCpfUpdating(false);
                      }
                    }}
                  >
                    <Emoji3D e="💾" /> Salvar CPF e Reemitir
                  </Button>
                </div>
                {cpfInputModal.length === 14 && !isValidCpf(cpfInputModal) && (
                  <Tag color="var(--color-error)">CPF inválido</Tag>
                )}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "8px" }}>
              <Button variant="ghost" onClick={() => setFiscalErrorModal(null)}>
                Fechar
              </Button>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    const { sale, doc } = fiscalErrorModal;
                    setFiscalErrorModal(null);
                    setSelectedSaleForNfce({ sale, doc });
                  }}
                  title="Abrir Comprovante Auxiliar de Venda para gerar PDF ou enviar por WhatsApp"
                >
                  <Emoji3D e="📄" /> Ver Comprovante / PDF / WhatsApp
                </Button>
                {isNfse ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const sale = fiscalErrorModal.sale;
                      setFiscalErrorModal(null);
                      handleEmitNfse(sale);
                    }}
                  >
                    <Emoji3D e="🔄" /> Tentar Emissão Novamente
                  </Button>
                ) : (
                  <IfCan capability="nfce.retry">
                    <Button
                      variant="primary"
                      onClick={() => {
                        const { sale, doc } = fiscalErrorModal;
                        setFiscalErrorModal(null);
                        handleRetryNfce(sale, doc);
                      }}
                    >
                      <Emoji3D e="🔄" /> Tentar Novamente
                    </Button>
                  </IfCan>
                )}
              </div>
            </div>
          </div>
        </Modal>
        );
      })()}

      {/* Sangria/suprimento tira e põe dinheiro na gaveta fora de uma venda —
          é a operação em que a diferença entre Operador e Líder tem
          consequência financeira. Esconder aqui é só cortesia: quem barra de
          verdade é o trigger fa_kiosk_guard_cash_movement (migration
          20260807000006), que recusa a inserção no banco. */}
      <IfCan capability="caixa.sangria">
      <Card style={{ padding: "16px" }}>
        <h2>Sangria / Suprimento</h2>
        <HelpText style={{ marginBottom: "8px" }}>
          Use esta seção sempre que dinheiro sair ou entrar na gaveta fora de uma venda — por exemplo, retirar para
          levar ao banco (Sangria) ou colocar troco extra (Suprimento).
        </HelpText>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
          <Button
            variant={movementKind === "SANGRIA" ? "primary" : "secondary"}
            size="sm"
            title="Retirar dinheiro da gaveta — ex.: levar ao banco, sobra de troco"
            onClick={() => setMovementKind("SANGRIA")}
          >
            Sangria (retirar dinheiro)
          </Button>
          <Button
            variant={movementKind === "SUPRIMENTO" ? "primary" : "secondary"}
            size="sm"
            title="Colocar dinheiro extra na gaveta — ex.: reforço de troco"
            onClick={() => setMovementKind("SUPRIMENTO")}
          >
            Suprimento (colocar dinheiro)
          </Button>
        </div>
        <Input label="Valor (R$)" type="number" value={movementAmount} onChange={(e) => setMovementAmount(e.target.value)} />
        <Input label="Motivo / N° Envelope" placeholder="Ex: Sangria depósito banco, envelope #104..." value={movementReason} onChange={(e) => setMovementReason(e.target.value)} />
        <Button variant="secondary" loading={busy} disabled={busy || !!pendingMovementKey} onClick={addMovement} style={{ marginTop: "8px" }}>
          {pendingMovementKey ? "Aguardando conexão..." : "Registrar Lançamento"}
        </Button>

        <ul style={{ marginTop: "12px", paddingLeft: "20px" }}>
          {movements.map((m, i) => (
            <li key={i}>
              <strong>{m.kind}</strong>: {money(m.amount_cents)} {m.reason ? `— ${m.reason}` : ""}
            </li>
          ))}
        </ul>
      </Card>
      </IfCan>



      {error && <p style={{ color: "var(--color-error-text)" }}>{error}</p>}

      <Button
        variant="primary"
        size="lg"
        title="Encerrar o turno atual — conte o dinheiro da gaveta antes de tocar aqui"
        onClick={() => {
          // Pré-preenche com o calculado (fundo inicial + vendas em dinheiro ±
          // movimentações) e com o mesmo fundo de hoje; o operador corrige pela
          // contagem física. Não sobrescreve se já vinha digitando.
          // Se o envelope do fechamento já foi gravado (ex.: a tela recarregou
          // no meio), recupera contado/fundo dele em vez de recalcular — senão
          // o envelope aparece como R$ 0,00 e o registrado fica invisível.
          const lastEnvelope = [...movements]
            .reverse()
            .find((m) => m.kind === "SANGRIA" && !!m.envelope_number && m.fundo_caixa_cents != null);
          if (countedCash.trim() === "" && nextDayFloat.trim() === "" && lastEnvelope) {
            const fundo = lastEnvelope.fundo_caixa_cents ?? 0;
            setCountedCash(((lastEnvelope.amount_cents + fundo) / 100).toFixed(2));
            setNextDayFloat((fundo / 100).toFixed(2));
            setClosingEnvelopeLocked(true);
          } else {
            if (countedCash.trim() === "") setCountedCash((drawerMath(revenue, movements).drawerNowCents / 100).toFixed(2));
            if (nextDayFloat.trim() === "") setNextDayFloat((shift.opening_cash_cents / 100).toFixed(2));
          }
          setClosing(true);
        }}
      >
        Fechar turno
      </Button>

      {shiftOpenSuccessModal && (
        <Modal onClose={() => setShiftOpenSuccessModal(null)} ariaLabel="Confirmação de Abertura de Turno" maxWidth="460px">
          <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "14px", padding: "10px 4px" }}>
            <div
              style={{
                width: "64px",
                height: "64px",
                borderRadius: "50%",
                background: "linear-gradient(135deg, #10b981, #059669)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "32px",
                color: "#fff",
                boxShadow: "0 8px 20px rgba(16, 185, 129, 0.35)",
              }}
            >
              <Emoji3D e="🟢" />
            </div>

            <h2 style={{ margin: 0, fontSize: "22px", fontFamily: "var(--font-display)", color: "#10b981" }}>
              Turno Aberto com Sucesso!
            </h2>

            <div style={{ background: "var(--surface-sunken)", width: "100%", padding: "16px", borderRadius: "14px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "14px", color: "var(--text-muted)" }}>
                Unidade: <strong>{shiftOpenSuccessModal.unitName}</strong>
              </div>
              <div style={{ fontSize: "15px", fontWeight: "bold" }}>
                Operador: {shiftOpenSuccessModal.employeeName}
              </div>
              <div style={{ fontSize: "18px", color: "var(--color-teal-text)", fontWeight: "bold", background: "rgba(16, 185, 129, 0.12)", padding: "8px", borderRadius: "8px" }}>
                Fundo de Caixa contado: {money(shiftOpenSuccessModal.openingCashCents)}
              </div>
              {shiftOpenSuccessModal.expectedOpeningCashCents === null ? (
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  Sem fundo declarado no fechamento anterior — nada para conferir.
                </div>
              ) : (
                <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                  Fundo previsto pelo último fechamento: <strong>{money(shiftOpenSuccessModal.expectedOpeningCashCents)}</strong>
                </div>
              )}
              {shiftOpenSuccessModal.openingDivergenceCents !== null && shiftOpenSuccessModal.openingDivergenceCents < 0 ? (
                <div
                  role="alert"
                  style={{ fontSize: "14px", fontWeight: "bold", color: "var(--color-error-text)", background: "rgba(232,48,48,0.08)", padding: "8px", borderRadius: "8px" }}
                >
                  ⚠ {fmtBreak(shiftOpenSuccessModal.openingDivergenceCents, "falta")} em relação ao fundo declarado no último
                  fechamento. O proprietário foi avisado.
                </div>
              ) : shiftOpenSuccessModal.expectedOpeningCashCents !== null ? (
                <div style={{ fontSize: "13px", color: "var(--color-teal-text)", fontWeight: "bold" }}>✓ Fundo conferido sem divergência</div>
              ) : null}
              <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                Horário de Abertura: {new Date(shiftOpenSuccessModal.openedAtMs).toLocaleString("pt-BR")}
              </div>
            </div>

            <div style={{ fontSize: "14px", color: "var(--text-secondary)", fontWeight: "500", fontStyle: "italic" }}>
              <Emoji3D e="🚀" /> Desejamos um ótimo dia e excelentes vendas para toda a equipe!
            </div>

            <Button
              variant="primary"
              size="lg"
              onClick={() => setShiftOpenSuccessModal(null)}
              style={{ width: "100%", marginTop: "6px", borderRadius: "10px", background: "linear-gradient(135deg, #10b981, #059669)" }}
            >
              Iniciar Operações
            </Button>
          </div>
        </Modal>
      )}

      {/* Primeira tela do dia: quem abriu o caixa é obrigado a ler a passagem
          do turno anterior antes de operar. Montado depois do modal de
          sucesso da abertura para não competir com ele, e recalculado no
          servidor a cada montagem (recarregar a página o traz de volta). */}
      {shift &&
        shift.status === "ABERTO" &&
        employee &&
        shift.opened_by_employee_id === employee.id &&
        !shiftOpenSuccessModal &&
        !handoverLido && (
          <PassagemTurnoGate
            unitId={shift.unit_id}
            employeeId={employee.id}
            shiftId={shift.id}
            onDone={() => setHandoverLido(true)}
          />
        )}
    </div>
  );
}

/**
 * Só um hint na tela de fechamento — o valor que realmente vale é o
 * `expected` recalculado pelo servidor na resposta de /close (a
 * mesma regra de negócio, para não haver dois lugares que podem
 * divergir).
 *
 * Regra (owner, 2026-09-01): no fechamento o operador declara o que
 * VENDEU no turno por forma de pagamento. O fundo de caixa fica na
 * gaveta e é conferido na abertura do próximo turno, então
 * TROCO_INICIAL, SUPRIMENTO, SANGRIA e AJUSTE não entram no esperado —
 * nem para DINHEIRO. (Ver migration 20260901100000.)
 */
function expectedHint(method: string, revenue: RevenueByMethod[]): number {
  return revenue.find((r) => r.method === method)?.total_cents ?? 0;
}

/**
 * Conta da gaveta (espelho de fa_close_shift / fa_units_cash_status): fundo
 * inicial (TROCO_INICIAL) + vendas em dinheiro + suprimentos/ajustes −
 * sangrias, separando os envelopes (SANGRIA com número) das sangrias avulsas.
 * `drawerNowCents` é o que deveria estar fisicamente na gaveta neste momento.
 */
function drawerMath(revenue: RevenueByMethod[], movements: CashMovement[]) {
  const cashSalesCents = expectedHint("DINHEIRO", revenue);
  let openingCents = 0;
  let suprimentosCents = 0;
  let ajustesCents = 0;
  let sangriasAvulsasCents = 0;
  let envelopesCents = 0;
  for (const m of movements) {
    switch (m.kind) {
      case "TROCO_INICIAL":
        openingCents += m.amount_cents;
        break;
      case "SUPRIMENTO":
        suprimentosCents += m.amount_cents;
        break;
      case "AJUSTE":
        ajustesCents += m.amount_cents;
        break;
      case "SANGRIA":
        if (m.envelope_number) envelopesCents += m.amount_cents;
        else sangriasAvulsasCents += m.amount_cents;
        break;
    }
  }
  const drawerNowCents = openingCents + cashSalesCents + suprimentosCents + ajustesCents - sangriasAvulsasCents - envelopesCents;
  return { openingCents, cashSalesCents, suprimentosCents, ajustesCents, sangriasAvulsasCents, envelopesCents, drawerNowCents };
}

/** "Sobra de R$ X" / "Quebra de R$ X" (ou "Falta", na abertura) / "sem diferença". */
function fmtBreak(cents: number, negativeWord: "quebra" | "falta"): string {
  if (cents === 0) return "sem diferença";
  if (cents > 0) return `Sobra de ${money(cents)}`;
  return `${negativeWord === "quebra" ? "Quebra" : "Falta"} de ${money(Math.abs(cents))}`;
}

function SummaryRow({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: "ok" | "warn" }) {
  const color = tone === "ok" ? "var(--color-teal-text)" : tone === "warn" ? "var(--color-error-text)" : undefined;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "14px", fontWeight: strong ? "bold" : "normal", color }}>
      <span>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
