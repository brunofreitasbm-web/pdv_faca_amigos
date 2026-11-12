import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Button, Checkbox, Input, Select, DateInput, Tag, Badge, HelpText, Modal, StatusBadge, AutismRibbonIcon } from "@facaamigos/ui";
import { Api, isCouponInSchedule } from "../api/client.js";
import type { Asset, ChildMatch, ChildPackageBalance, Coupon, ForeignPackageBalance, Package, Plan, Product, PrepaidCreditQueueItem, UpsellOffer, WifiCouponLookup } from "../api/client.js";
import { UpsellOfferCard } from "../components/UpsellOfferCard.js";
import { OlharUpsellCard } from "../components/OlharUpsellCard.js";
import { GeminiSalesCard } from "../components/GeminiSalesCard.js";
import { PrepaidPaymentModal } from "../components/PrepaidPaymentModal.js";
import { IfCan } from "../auth/RequireCapability.js";
import { generateCheckinSuggestions, type CheckinOffer } from "../lib/geminiAgent.js";
import { PhotoCapture } from "../components/PhotoCapture.js";
import { ContractModal } from "../components/ContractModal.js";
import { WristbandQRCode } from "../components/WristbandQRCode.js";
import { formatPlanoHoras } from "../contract/contractTemplate.js";
import { useAppState } from "../state/AppState.js";
import { useToast } from "../state/ToastContext.js";
import { useAcompanhar } from "../api/useAcompanhar.js";
import { getPublicAppUrl } from "../lib/appUrl.js";
import {
  normalizePhoneE164,
  formatPhoneBr,
  isValidPhoneBr,
  phoneDigitsBr,
  normalizeCpf,
  isValidCpf,
  formatCpf,
  planDurationMinutes,
  formatAccessCode,
  SESSION_REPORT_MIN_MINUTES,
} from "@facaamigos/domain";
import { money, formatElapsed, formatAge } from "../format.js";
import { Emoji3D, renderEmoji } from "../components/Emoji3D.js";

// Lista padrão e assertiva — o operador marca em vez de descrever do zero
// na hora do balcão, com a família esperando. Os cinco primeiros itens são
// os originais do fluxo (não renomear: o texto é gravado por visita e
// prefila o cadastro seguinte da mesma criança); os demais foram
// adicionados para cobrir os quadros sensoriais mais comuns fora desses.
export const SENSORY_TAG_OPTIONS = [
  "Sensível a Ruído Alto",
  "Usa Abafador",
  "Acompanhante / Mediador 1:1",
  "Preferência pelo Cantinho da Calma",
  "Alergia Alimentar / Cuidados Especializados",
  "Aversão a Texturas / Toque",
  "Sensibilidade à Luz ou Estímulos Visuais",
  "Dificuldade com Mudança de Rotina",
  "Comunicação Não-verbal / Uso de Figuras (CAA)",
  "Evita Contato Físico Inesperado",
  "Necessidade de Pausas Sensoriais Frequentes",
] as const;

/**
 * Entrada — check-in de balcão.
 *
 * A tela é organizada em torno de um número: quantas ações o operador
 * precisa fazer com a família esperando na frente dele. O caminho mais
 * comum do parque é uma criança que já veio antes, e para ela o fluxo
 * inteiro cabe em três toques:
 *
 *   1. digitar as primeiras letras do nome e tocar na criança encontrada
 *      (traz responsável, telefone, CPF, nascimento e os cuidados
 *      inclusivos da última visita);
 *   2. tocar no plano;
 *   3. tocar em "Confirmar entrada".
 *
 * O formulário completo de cadastro só aparece quando a criança realmente
 * não existe — não fica ocupando a tela nos outros 90% dos atendimentos.
 *
 * O plano continua exigindo um toque explícito de propósito. Ele é o único
 * campo que define quanto a família vai pagar, e um plano pré-selecionado
 * "para agilizar" é exatamente como se cobra o valor errado de alguém.
 *
 * Impressão: as duas vias (pulseira da criança + recibo de guarda dos pais)
 * são enfileiradas pelo próprio fa_checkin, na mesma transação do banco.
 * Esta tela não dispara impressão nenhuma — se o check-in gravou, as duas
 * saíram; se falhou, nenhuma saiu pela metade.
 */
function getPlanDiscountedCents(
  valueCents: number,
  code: string,
  couponsList: Coupon[],
  planId?: string | null,
): { finalCents: number; originalCents: number; discountText: string | null } {
  if (!code) return { finalCents: valueCents, originalCents: valueCents, discountText: null };

  const couponObj = couponsList.find((c) => c.code.toLowerCase() === code.toLowerCase());
  if (couponObj?.allowedPlanId && couponObj.allowedPlanId !== planId) {
    return { finalCents: valueCents, originalCents: valueCents, discountText: null };
  }
  let discountPct: number | null = null;
  let discountCents: number | null = null;

  if (couponObj) {
    if (couponObj.kind === "DESCONTO_PCT") discountPct = couponObj.value;
    else if (couponObj.kind === "DESCONTO_VALOR") discountCents = couponObj.value;
  }

  if (discountPct === null && discountCents === null) {
    if (code.includes("50%")) discountPct = 50;
    else if (code.includes("40%")) discountPct = 40;
  }

  let finalCents = valueCents;
  let discountText: string | null = null;

  if (discountPct !== null && discountPct > 0) {
    const cut = Math.round((valueCents * discountPct) / 100);
    finalCents = Math.max(0, valueCents - cut);
    discountText = `-${discountPct}%`;
  } else if (discountCents !== null && discountCents > 0) {
    finalCents = Math.max(0, valueCents - discountCents);
    discountText = `-${money(discountCents)}`;
  }

  return { finalCents, originalCents: valueCents, discountText };
}

export type PreCheckinPrefill = Awaited<ReturnType<typeof Api.preCheckinList>>[number];

export function EntradaScreen({
  onSuccess,
  prefill,
  onPrefillConsumed,
  prepaidPrefill,
  onPrepaidPrefillConsumed,
}: {
  onSuccess?: () => void;
  /** Pré-cadastro feito pelo responsável no QR de Acesso Rápido (ver PainelScreen) — preenche o formulário para o operador só conferir e confirmar. */
  prefill?: PreCheckinPrefill | null;
  /** Avisa quem abriu a tela (PainelScreen) que o prefill já foi consumido, para fechar o card da lista de pendentes. */
  onPrefillConsumed?: () => void;
  /** Criança escolhida na fila "Saldos aguardando início" do Painel (ver PainelScreen) — reusa pickMatch() e já seleciona o saldo pré-pago. */
  prepaidPrefill?: PrepaidCreditQueueItem | null;
  /** Avisa quem abriu a tela que o prefill já foi consumido, para fechar o card da fila. */
  onPrepaidPrefillConsumed?: () => void;
} = {}) {
  const { unit, employee } = useAppState();
  const toast = useToast();
  const activity = unit?.kind === "QUIOSQUE" ? "CARRINHO" : "PLAYGROUND";

  const [plans, setPlans] = useState<Plan[]>([]);
  const [packages, setPackages] = useState<Package[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [preCheckinId, setPreCheckinId] = useState<string | null>(null);
  const [preCheckinChildIndex, setPreCheckinChildIndex] = useState<number | null>(null);

  // Busca única: nome da criança, nome do responsável, CPF ou telefone.
  // Antes eram quatro campos separados disputando a mesma consulta.
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ChildMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [matchedChild, setMatchedChild] = useState<ChildMatch | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);

  const [cpf, setCpf] = useState("");
  const [childName, setChildName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [guardianName, setGuardianName] = useState("");
  const [phone, setPhone] = useState("");
  // Aceite de contato por WhatsApp (avisos + pesquisa de NPS). Começa desmarcado: só vale se o responsável autorizar.
  const [whatsappConsent, setWhatsappConsent] = useState(true);
  // Aceite de MARKETING (ofertas/novidades) — pergunta separada, só oferecida
  // se o responsável já aceitou o contato geral acima.
  const [marketingConsent, setMarketingConsent] = useState(true);
  const [favoriteAssetId, setFavoriteAssetId] = useState<string | null>(null);

  const [isNeurodivergent, setIsNeurodivergent] = useState(false);
  const [selectedSensoryTags, setSelectedSensoryTags] = useState<string[]>([]);
  const [customNotes, setCustomNotes] = useState("");
  const [childPhoto, setChildPhoto] = useState<Blob | null>(null);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  // Só o cupom escolhido à mão (parceria, Wi-Fi, sugestão da IA). null = vale o
  // desconto padrão do Playground, derivado em `couponCode` mais abaixo.
  const [manualCoupon, setManualCoupon] = useState<string | null>(null);
  const setCouponCode = (code: string) => setManualCoupon(code || null);
  const [showExtras, setShowExtras] = useState(false);
  // Conferência do cupom do portal Wi-Fi (ESPERA-XXXX): o servidor responde de quem é e se ainda vale.
  const [wifiCode, setWifiCode] = useState("");
  const [wifiLookup, setWifiLookup] = useState<WifiCouponLookup | null>(null);
  const [wifiChecking, setWifiChecking] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    sessionId: string;
    accessCode: string;
    exitPin: string;
    childName: string;
    guardianId: string;
    /** Plano vendido acima de 2h — habilita o botão de imprimir o contrato. */
    contractPlan: { name: string; valueCents: number; minutes: number } | null;
  } | null>(null);
  const [contractOpen, setContractOpen] = useState(false);
  const [acompanharOpen, setAcompanharOpen] = useState(false);

  // Modo pré-pago: o operador decide na Entrada se a contagem começa
  // agora (padrão, ~90% dos casos) ou se o pai paga e vai embora com a
  // criança, deixando o tempo como saldo para uma visita futura. Marcado
  // por padrão de propósito — o caso raro exige um toque a mais, nunca
  // o contrário.
  const [startNow, setStartNow] = useState(true);
  const [hasOpenShift, setHasOpenShift] = useState<boolean | null>(null);
  const [prepaidModalOpen, setPrepaidModalOpen] = useState(false);
  const [donePrepaid, setDonePrepaid] = useState<{ childName: string; sourceName: string; minutesTotal: number } | null>(null);

  // Endereço público (Vercel) para o QR de acompanhamento — em localhost/Electron,
  // utiliza o fallback automático de produção.
  const publicAppOrigin = getPublicAppUrl();
  const acompanharUrl =
    done && publicAppOrigin ? `${publicAppOrigin.replace(/\/$/, "")}/?acompanhar=${done.accessCode}` : null;

  // Mesmo hook do painel do responsável (AcompanharScreen): busca a sessão
  // pela mesma RPC anônima e recalcula o cronômetro a 1Hz localmente. Ao
  // reusar o hook em vez de duplicar a lógica, o tempo mostrado aqui no
  // balcão nunca diverge do que aparece no celular de quem escaneou o QR.
  const { timing: acompanharTiming } = useAcompanhar(acompanharOpen && done ? done.accessCode : null);

  // Saldo do banco de horas da criança identificada (planos >2h de visitas
  // anteriores, em qualquer unidade). null = sem saldo ou não consultado.
  const [hourBank, setHourBank] = useState<{ remainingMinutes: number; nextExpiryMs: number } | null>(null);

  // Saldo pré-pago da criança identificada (comprado numa visita anterior
  // com "Iniciar contagem agora" desmarcado). null = sem saldo ou não
  // consultado. creditId aponta para o crédito mais antigo (FIFO) — é o
  // que fa_checkin referencia para fixar tarifa/piso da sessão.
  const [childCredit, setChildCredit] = useState<{ remainingMinutes: number; creditId: string } | null>(null);
  // Pacotes com saldo dos responsáveis da criança (ex.: Porto Seguro). O
  // fechamento abate daqui o tempo da visita e, na sessão em saldo pré-pago,
  // o que o saldo da criança não cobrir.
  const [childPackages, setChildPackages] = useState<ChildPackageBalance[]>([]);
  // Só o pacote da PRÓPRIA criança entra sozinho. Pacote de irmão é opção
  // separada, com confirmação explícita do balcão (ver SIBLING_PACKAGE_BALANCE).
  const ownChildPackages = childPackages.filter((p) => p.is_own !== false);
  const siblingPackages = childPackages.filter((p) => p.is_own === false);
  const childPackageMinutes = ownChildPackages.reduce((sum, p) => sum + p.remaining_minutes, 0);
  const siblingPackageMinutes = siblingPackages.reduce((sum, p) => sum + p.remaining_minutes, 0);
  // Saldo de pacote da família gravado em outro responsável: o check-in
  // cobraria avulso, então o operador é avisado antes de confirmar.
  const [foreignPackages, setForeignPackages] = useState<ForeignPackageBalance[]>([]);

  // Oferta de upgrade da criança identificada. `null` cobre os dois casos
  // em que não há card: ainda não consultado e não elegível — a tela trata
  // os dois igual, então não vale um estado a mais para distingui-los.
  const [offer, setOffer] = useState<UpsellOffer | null>(null);

  // Cross-sell rápido (produto único, ex.: "Água") — parametrizável em
  // Configurações. Diferente da oferta de upgrade acima: não tem script
  // nem ancoragem, é só "oferecer X por R$Y" quando o plano escolhido é
  // longo o bastante para fazer sentido (padrão: 60 min).
  const [quickProduct, setQuickProduct] = useState<Product | null>(null);
  const [quickTriggerMinutes, setQuickTriggerMinutes] = useState(60);
  const [quickUpsellAccepted, setQuickUpsellAccepted] = useState(false);
  const [crossSellModalOpen, setCrossSellModalOpen] = useState(false);
  // Oferta "1 hora + Olhar FaçaAmigos": dispensada neste atendimento.
  const [olharOfferDismissed, setOlharOfferDismissed] = useState(false);

  // Aluguel avulso de pelúcia no Playground: plano PLAYGROUND com assetKind.
  // Fica fora do grid normal (tem card próprio) e não recebe cupom,
  // cross-sell nem venda pré-paga. Ver migrations 20260919120*.
  const peluciaPlan = activity === "PLAYGROUND" ? plans.find((p) => p.assetKind) : undefined;
  const regularPlans = activity === "PLAYGROUND" ? plans.filter((p) => !p.assetKind) : plans;
  const isPelucia = Boolean(peluciaPlan && planId === peluciaPlan.id);

  // Cortesia de aniversário: o plano é inativo (fora de `plans`) e vem de
  // Api.birthdayCourtesyOffer só para a criança identificada que tem cortesia
  // válida hoje. Não recebe cupom (o desconto de 40% atingiria o minuto
  // adicional), nem venda pré-paga, nem upsell de 1 h.
  const [birthdayOffer, setBirthdayOffer] = useState<{ courtesyId: string; validUntil: string; plan: Plan } | null>(null);
  const birthdayPlanIdRef = useRef<string | null>(null);
  const isBirthdayCourtesy = Boolean(birthdayOffer && planId === birthdayOffer.plan.id);
  const peluciaAssets = assets.filter((a) => a.kind === "PELUCIA");

  // Desconto padrão do Playground. O "valor cheio" da tabela é só vitrine de
  // marketing: o valor real cobrado é o com 40% (ou 50% se a criança é
  // inclusiva). Por isso o desconto é derivado do estado atual, nunca um
  // estado próprio — antes ele sumia ao zerar a família (o efeito que o
  // aplicava só reexecutava quando uma dependência mudava) e o card
  // mostrava o valor cheio.
  const autoCouponCode = useMemo(() => {
    if (activity !== "PLAYGROUND" || isPelucia || isBirthdayCourtesy) return "";
    const pick = (tokens: string[], fallback: string) =>
      coupons.find(
        (c) =>
          c.active !== false &&
          tokens.some((t) => c.code.toLowerCase().includes(t) || c.description?.toLowerCase().includes(t)),
      )?.code ?? fallback;
    return isNeurodivergent
      ? pick(["50%", "inclusivo", "meia"], "50% MEIA")
      : pick(["40%", "promocional"], "40% PROMOCIONAL");
  }, [activity, isNeurodivergent, coupons, isPelucia, isBirthdayCourtesy]);
  const hasManualCoupon = Boolean(manualCoupon) && !isPelucia && !isBirthdayCourtesy;
  const couponCode = hasManualCoupon ? manualCoupon! : autoCouponCode;

  const [lastGuardianId, setLastGuardianId] = useState<string | null>(null);
  const [siblingMatches, setSiblingMatches] = useState<ChildMatch[]>([]);
  const [siblingCheckinCount, setSiblingCheckinCount] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const [geminiOffers, setGeminiOffers] = useState<CheckinOffer[]>([]);
  const [loadingGemini, setLoadingGemini] = useState(false);

  // Configuração do cross-sell rápido: qual produto oferecer e a partir de
  // quantos minutos de plano. Se não houver id configurado, tenta localizar "Água".
  useEffect(() => {
    if (!unit) return;
    Api.unitSetting(unit.id, "upsell_quick_trigger_minutes")
      .then((r) => setQuickTriggerMinutes(r.value ? Number(r.value) : 60))
      .catch(() => {});
    Api.unitSetting(unit.id, "upsell_quick_product_id")
      .then((r) => {
        return Api.products(unit.id).then((products) => {
          if (r.value) {
            const found = products.find((p) => p.id === r.value);
            if (found) return setQuickProduct(found);
          }
          const agua = products.find((p) => p.name.toLowerCase().includes("água") || p.name.toLowerCase().includes("agua"));
          if (agua) return setQuickProduct(agua);
          const fallback = products[0];
          if (fallback) return setQuickProduct(fallback);
          setQuickProduct(null);
        });
      })
      .catch(() => setQuickProduct(null));
  }, [unit]);

  useEffect(() => {
    if (!unit) return;
    setPlanId(null);
    Api.plans(unit.id, activity).then(setPlans);
    Api.packages(unit.id, activity).then(setPackages);
    Api.products(unit.id).then(setProducts);
    Api.coupons(unit.id).then(setCoupons);
    // No Playground a lista de ativos é só a pelúcia do aluguel avulso.
    Api.assets(unit.id).then(setAssets);
    // Só a venda pré-paga exige turno aberto (o dinheiro precisa cair
    // num turno) — o check-in normal nunca exigiu isso.
    Api.currentShift(unit.id).then((shift) => setHasOpenShift(!!shift)).catch(() => setHasOpenShift(null));
  }, [unit, activity]);

  // Card "Cortesia de aniversário (30min)": aparece sozinho para a criança
  // identificada que tem a cortesia. A operadora só confirma a entrada.
  const unitId = unit?.id;
  useEffect(() => {
    let active = true;
    const clear = () => {
      const stale = birthdayPlanIdRef.current;
      birthdayPlanIdRef.current = null;
      setBirthdayOffer(null);
      if (stale) setPlanId((cur) => (cur === stale ? null : cur));
    };
    if (!unitId || activity !== "PLAYGROUND" || !matchedChild?.id) {
      clear();
      return;
    }
    Api.birthdayCourtesyOffer(matchedChild.id, unitId)
      .then((offer) => {
        if (!active) return;
        if (!offer) return clear();
        birthdayPlanIdRef.current = offer.plan.id;
        setBirthdayOffer(offer);
      })
      .catch(() => {
        if (active) clear();
      });
    return () => {
      active = false;
    };
  }, [matchedChild?.id, unitId, activity]);

  // Pré-cadastro do QR de Acesso Rápido: preenche o formulário exatamente
  // como se o operador tivesse digitado tudo — ele só confere identidade
  // e toca em "Confirmar entrada". `submit()` manda o `preCheckinId`
  // junto no fa_checkin, que marca a origem como CONVERTIDO na mesma
  // transação (ver client.ts `checkin`).
  useEffect(() => {
    if (!prefill) return;
    setPreCheckinId(prefill.id);
    setPreCheckinChildIndex(prefill.childIndex);
    setMatchedChild(null);
    setMatches([]);
    setShowNewForm(true);
    setChildName(prefill.childName);
    setBirthDate(prefill.birthDate);
    setGuardianName(prefill.guardianName);
    setCpf(prefill.cpf ? formatCpf(prefill.cpf) : "");
    setPhone(formatPhoneBr(prefill.phoneE164));
    setPlanId(prefill.packageId ? `${PACKAGE_PREFIX}${prefill.packageId}` : prefill.planId);
    setIsNeurodivergent(prefill.inclusiveEligible || (prefill.sensoryTags?.length ?? 0) > 0);
    setSelectedSensoryTags(prefill.sensoryTags ?? []);
    setCustomNotes(prefill.notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.id]);

  // Busca única com debounce. Só dígitos quando o operador digitou um número:
  // a coluna de telefone é E.164 ("+5591982501215") e o texto mascarado
  // "(91) 98250-…" nunca casaria no ilike.
  useEffect(() => {
    const trimmed = query.trim();
    if (matchedChild || trimmed.length < 2) {
      setMatches([]);
      return;
    }
    const digits = trimmed.replace(/\D/g, "");
    const term = digits.length >= 3 && digits.length >= trimmed.length - 4 ? digits : trimmed;
    setSearching(true);
    const handle = setTimeout(() => {
      Api.searchChildren(term, unit?.id)
        .then(setMatches)
        .catch(() => setMatches([]))
        .finally(() => setSearching(false));
    }, 220);
    return () => clearTimeout(handle);
  }, [query, matchedChild, unit?.id]);

  function pickMatch(match: ChildMatch) {
    setMatchedChild(match);
    setShowNewForm(false);
    setChildName(match.full_name);
    setBirthDate(match.birth_date);
    setPhone(match.phone_e164 ? formatPhoneBr(match.phone_e164) : "");
    setGuardianName(match.guardian_name ?? "");
    setCpf(match.cpf ? formatCpf(match.cpf) : "");
    if (match.inclusive_eligible) {
      setIsNeurodivergent(true);
    }
    setMatches([]);
    setFavoriteAssetId(null);
    setOffer(null);
    setHourBank(null);
    setChildCredit(null);
    setChildPackages([]);
    setForeignPackages([]);

    if (unit?.id) {
      Api.childPackages(unit.id, match.id)
        .then((pkgs) => {
          setChildPackages(pkgs);
          if (pkgs.some((p) => p.is_own !== false && p.remaining_minutes > 0)) {
            setPlanId(PACKAGE_BALANCE);
          }
        })
        .catch(() => setChildPackages([]));
      Api.foreignPackageBalances(unit.id, match.id, match.cpf ? normalizeCpf(match.cpf) : null, match.phone_e164)
        .then(setForeignPackages)
        .catch(() => setForeignPackages([]));
    }

    const activeTerm = (match.cpf ? normalizeCpf(match.cpf) : "") || (match.phone_e164 ? phoneDigitsBr(match.phone_e164) : "");
    if (activeTerm && activeTerm.length >= 3) {
      Api.searchChildren(activeTerm, unit?.id)
        .then((siblings) => setSiblingMatches(siblings.filter((s) => s.id !== match.id)))
        .catch(() => setSiblingMatches([]));
    }

    // Saldo do banco de horas (planos >2h de visitas anteriores, em
    // qualquer unidade): consultado aqui para a opção "Usar banco de
    // horas" já aparecer junto dos planos, antes de vender um novo.
    Api.hourBankBalances([match.id])
      .then((map) => {
        const b = map.get(match.id);
        setHourBank(b && b.remaining_minutes > 0 ? { remainingMinutes: b.remaining_minutes, nextExpiryMs: b.next_expiry_ms } : null);
      })
      .catch(() => setHourBank(null));

    // Saldo pré-pago (comprado numa visita anterior, sem iniciar a
    // sessão): mesma lógica do banco de horas — aparece como card antes
    // de vender plano novo.
    Api.childCreditBalances([match.id])
      .then((map) => {
        const b = map.get(match.id);
        setChildCredit(b && b.remaining_minutes > 0 ? { remainingMinutes: b.remaining_minutes, creditId: b.credit_id } : null);
      })
      .catch(() => setChildCredit(null));

    // Oferta de upgrade. Consultada aqui, e não no `submit`, porque o
    // script precisa chegar ao operador ANTES de a conversa virar "qual
    // plano?" — depois de escolhido o plano, propor outra coisa é desfazer
    // uma decisão já tomada na frente do cliente.
    if (unit) {
      Api.upsellOffer(unit.id, match.id, null, employee?.id)
        .then((result) => setOffer(result.eligible ? result : null))
        .catch(() => setOffer(null));
    }

    // Cuidados da última visita vêm marcados: quem tem necessidade sensorial
    // continua tendo na visita seguinte.
    Api.lastCareForChild(match.id)
      .then((care) => {
        setSelectedSensoryTags(care.sensoryTags);
        setCustomNotes(care.notes);
        if (care.sensoryTags.length > 0 || care.notes) setIsNeurodivergent(true);
      })
      .catch(() => {});

    if (activity === "CARRINHO") {
      Api.lastAssetForChild(match.id)
        .then((r) => {
          setFavoriteAssetId(r.assetId);
          if (r.assetId && assets.find((a) => a.id === r.assetId)?.status === "DISPONIVEL") {
            setAssetId(r.assetId);
          }
        })
        .catch(() => {});
    }
  }

  function startNewChild() {
    setShowNewForm(true);
    setMatchedChild(null);
    setMatches([]);
    setOffer(null);
    if (query.trim() && !/\d/.test(query)) setChildName(query.trim());
  }

  function addSiblingChild() {
    setQuery("");
    setChildName("");
    setBirthDate("");
    setIsNeurodivergent(false);
    setSelectedSensoryTags([]);
    setCustomNotes("");
    setChildPhoto(null);
    setShowNewForm(true);
    setMatchedChild(null);
    setMatches([]);
    setOffer(null);
    setPreCheckinId(null);
  }

  function toggleSensoryTag(tag: string) {
    setSelectedSensoryTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  function resetForNextChild(keepGuardian: boolean) {
    if (!keepGuardian) {
      setWhatsappConsent(true);
      setMarketingConsent(true);
    }
    setQuery("");
    setMatches([]);
    setMatchedChild(null);
    setShowNewForm(false);
    setOffer(null);
    setHourBank(null);
    setChildCredit(null);
    setForeignPackages([]);
    setChildName("");
    setBirthDate("");
    setIsNeurodivergent(false);
    setSelectedSensoryTags([]);
    setCustomNotes("");
    setChildPhoto(null);
    setPlanId(null);
    setShowExtras(false);
    setFavoriteAssetId(null);
    setQuickUpsellAccepted(false);
    setOlharOfferDismissed(false);
    setPreCheckinId(null);
    setStartNow(true);
    if (!keepGuardian) {
      setCpf("");
      setGuardianName("");
      setPhone("");
      setLastGuardianId(null);
      setSiblingMatches([]);
      setSiblingCheckinCount(0);
      setManualCoupon(null);
    } else {
      const activeTerm = normalizeCpf(cpf) || phone.replace(/\D/g, "");
      if (activeTerm && activeTerm.length >= 3) {
        Api.searchChildren(activeTerm, unit?.id)
          .then((list) => setSiblingMatches(list))
          .catch(() => setSiblingMatches([]));
      }
    }
    searchRef.current?.focus();
  }

  const identified = Boolean(matchedChild) || showNewForm;
  // Sentinela do "plano" Banco de Horas: reusa o fluxo de seleção/validação
  // dos planos sem virar um plano de verdade.
  const HOUR_BANK = "HOUR_BANK";
  const usingHourBank = planId === HOUR_BANK;
  // Sentinela do saldo pré-pago — mesmo truque, para consumir o crédito
  // comprado numa visita anterior sem virar um plano de verdade.
  const CHILD_CREDIT = "CHILD_CREDIT";
  const usingChildCredit = planId === CHILD_CREDIT;
  // Sentinela de uso de saldo de pacote existente (Porto Seguro etc.)
  const PACKAGE_BALANCE = "PACKAGE_BALANCE";
  // Saldo de pacote de OUTRA criança (irmão): nunca é selecionado sozinho.
  const SIBLING_PACKAGE_BALANCE = "PACKAGE_BALANCE_SIBLING";
  const usingSiblingPackage = planId === SIBLING_PACKAGE_BALANCE;
  const usingPackageBalance = planId === PACKAGE_BALANCE || usingSiblingPackage;
  // Com saldo de pacote válido não se vende plano avulso no Playground: o
  // saldo é consumido primeiro (o servidor também recusa, ver fa_checkin).
  const saldoPacoteObrigatorio = Boolean(matchedChild) && childPackageMinutes > 0 && activity === "PLAYGROUND";

  // "▶ Iniciar" da fila do Painel: reusa o MESMO pickMatch() da busca
  // manual — um único caminho de criação de sessão em vez de duplicar a
  // lógica de fa_checkin numa segunda função (ver comentário da
  // migration fa_prepaid_queue_enrichment). Só falta selecionar o saldo
  // pré-pago, que pickMatch por si só não faz.
  useEffect(() => {
    if (!prepaidPrefill) return;
    pickMatch({
      id: prepaidPrefill.child_id,
      full_name: prepaidPrefill.child_name,
      birth_date: prepaidPrefill.child_birth_date,
      phone_e164: prepaidPrefill.guardian_phone,
      guardian_name: prepaidPrefill.guardian_name,
      cpf: prepaidPrefill.guardian_cpf,
      inclusive_eligible: prepaidPrefill.child_inclusive_eligible,
      is_vip: false,
      visits_in_window: 0,
    });
    setPlanId(CHILD_CREDIT);
    onPrepaidPrefillConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepaidPrefill?.credit_id]);

  // Pacotes aparecem no mesmo grid dos planos, sem distinção: cada um vira
  // um Plan sintético (id prefixado) — o resto da tela (preço, "cabe até o
  // fechamento", contrato >2h, cross-sell) já sabe lidar com um Plan
  // sintético, mesmo truque já usado para o Banco de Horas.
  const PACKAGE_PREFIX = "PKG:";
  const packagePlans: Plan[] = packages.map((pkg) => ({
    id: `${PACKAGE_PREFIX}${pkg.id}`,
    activity: pkg.activity,
    name: pkg.name,
    valueCents: pkg.priceCents,
    durationValue: pkg.includedMinutes,
    durationUnit: "MINUTO",
    overageCentsPerMinute: pkg.overageCentsPerMinute,
    color: pkg.color,
  }));
  const usingPackage = planId?.startsWith(PACKAGE_PREFIX) ?? false;
  const selectedPackageId = usingPackage ? planId!.slice(PACKAGE_PREFIX.length) : null;
  const selectedPlan =
    plans.find((p) => p.id === planId) ??
    packagePlans.find((p) => p.id === planId) ??
    (isBirthdayCourtesy ? birthdayOffer?.plan : undefined) ??
    (usingPackageBalance
      ? {
          id: usingSiblingPackage ? SIBLING_PACKAGE_BALANCE : PACKAGE_BALANCE,
          activity: "PLAYGROUND" as const,
          name: (usingSiblingPackage ? siblingPackages : ownChildPackages)[0]?.package_name
            ? `${(usingSiblingPackage ? siblingPackages : ownChildPackages)[0]!.package_name} (Saldo)`
            : "Porto Seguro (Saldo)",
          valueCents: 0,
          durationValue: usingSiblingPackage ? siblingPackageMinutes : childPackageMinutes,
          durationUnit: "MINUTO" as const,
          overageCentsPerMinute: 0,
          color: "#1A3F35",
        }
      : undefined);
  const threshold = 120;

  // Cupons restritos a um plano (ex.: "N ESTRELAS", só no plano de 30min)
  // só aparecem quando esse plano está selecionado — evita o operador
  // escolher um cupom que o servidor vai recusar no check-in.
  const eligibleCoupons = useMemo(
    () =>
      coupons.filter(
        (c) =>
          (!c.allowedPlanId || c.allowedPlanId === planId) &&
          isCouponInSchedule(c) &&
          !(c.expiresAtMs && c.expiresAtMs < Date.now()),
      ),
    [coupons, planId],
  );

  // Oferta "1 hora + Olhar FaçaAmigos": plano curto no Playground -> sugere o de 1 h.
  // Só sem cupom restrito a plano (trocar derrubaria o desconto e o script
  // mentiria) e só quando a 1 h realmente sai mais barata que ficar a hora
  // toda no plano atual com o minuto adicional.
  const olharOffer = useMemo(() => {
    if (olharOfferDismissed || activity !== "PLAYGROUND") return null;
    if (!selectedPlan || isPelucia || isBirthdayCourtesy || usingPackage || usingHourBank || usingChildCredit || usingPackageBalance) return null;
    const currentMinutes = planDurationMinutes(selectedPlan);
    if (currentMinutes >= SESSION_REPORT_MIN_MINUTES) return null;
    const target = regularPlans.find((p) => planDurationMinutes(p) === SESSION_REPORT_MIN_MINUTES);
    if (!target) return null;
    const coupon = couponCode ? coupons.find((c) => c.code.toLowerCase() === couponCode.toLowerCase()) : undefined;
    if (coupon?.allowedPlanId) return null;
    const extraMinutes = SESSION_REPORT_MIN_MINUTES - currentMinutes;
    const stayGross = selectedPlan.valueCents + extraMinutes * selectedPlan.overageCentsPerMinute;
    const stayCents = getPlanDiscountedCents(stayGross, couponCode, coupons, selectedPlan.id).finalCents;
    const targetCents = getPlanDiscountedCents(target.valueCents, couponCode, coupons, target.id).finalCents;
    if (targetCents >= stayCents) return null;
    return { target, extraMinutes, stayCents, targetCents };
  }, [olharOfferDismissed, activity, selectedPlan, isPelucia, isBirthdayCourtesy, usingPackage, usingHourBank, usingChildCredit, regularPlans, couponCode, coupons]);

  useEffect(() => {
    if (!unit) return;
    const currentName = childName.trim();
    if (!currentName && !selectedPlan) {
      setGeminiOffers([]);
      return;
    }

    let active = true;
    const timer = setTimeout(() => {
      setLoadingGemini(true);
      generateCheckinSuggestions({
        childName: currentName,
        responsibleName: guardianName,
        selectedPlanName: selectedPlan?.name,
        selectedPlanMinutes: selectedPlan ? planDurationMinutes(selectedPlan) : 30,
        selectedPlanPriceCents: selectedPlan?.valueCents,
        unitName: unit.name,
        availablePlans: plans.map((p) => ({
          id: p.id,
          name: p.name,
          valueCents: p.valueCents,
          minutes: planDurationMinutes(p),
        })),
        availableProducts: products.map((p) => ({
          id: p.id,
          name: p.name,
          priceCents: p.price_cents,
        })),
        availableCoupons: eligibleCoupons.map((c) => ({
          code: c.code,
          discountText: c.kind === "DESCONTO_PCT" ? `${c.value}% OFF` : `R$ ${(c.value / 100).toFixed(2)} OFF`,
        })),
      })
        .then((offers) => {
          if (active) setGeminiOffers(offers);
        })
        .finally(() => {
          if (active) setLoadingGemini(false);
        });
    }, 400);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [matchedChild?.id, childName, selectedPlan?.id, guardianName, unit?.id, plans, products, eligibleCoupons]);

  function handleApplyGeminiOffer(offer: CheckinOffer) {
    if (offer.actionType === "UPGRADE_PLAN") {
      const higherPlan = plans.find(
        (p) =>
          (offer.targetName && p.name.toLowerCase().includes(offer.targetName.toLowerCase())) ||
          planDurationMinutes(p) > (selectedPlan ? planDurationMinutes(selectedPlan) : 30),
      );
      if (higherPlan) {
        setPlanId(higherPlan.id);
        toast.success(`Plano alterado para ${higherPlan.name}!`);
      }
    } else if (offer.actionType === "APPLY_COUPON") {
      if (offer.targetName) {
        setCouponCode(offer.targetName);
        toast.success(`Cupom "${offer.targetName}" aplicado!`);
      }
    } else if (offer.actionType === "ADD_PRODUCT") {
      setShowExtras(true);
      toast.success(`Item "${offer.targetName || offer.title}" recomendado no balcão!`);
    }
  }

  async function checkWifiCoupon() {
    const code = wifiCode.trim().toUpperCase();
    if (!unit || !code) return;
    setWifiChecking(true);
    try {
      setWifiLookup(await Api.wifiCouponLookup(unit.id, code));
    } catch (err) {
      setWifiLookup(null);
      toast.error(err instanceof Error ? err.message : "Não foi possível conferir o cupom.");
    } finally {
      setWifiChecking(false);
    }
  }

  function applyWifiCoupon() {
    const found = wifiLookup?.status === "OK" ? wifiLookup.coupon : null;
    if (!found) return;
    // Entra na lista local só para o preço mostrar o desconto; o servidor continua sendo quem decide no check-in.
    setCoupons((prev) => [...prev.filter((c) => c.code !== found.code), found]);
    setCouponCode(found.code);
    setWifiCode("");
    setWifiLookup(null);
    toast.success(`Cupom ${found.code} aplicado.`);
  }

  useEffect(() => {
    if (manualCoupon && !eligibleCoupons.some((c) => c.code === manualCoupon)) setManualCoupon(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  const readiness = useMemo(() => {
    if (!identified) return "Identifique a criança para continuar";
    if (!childName.trim()) return "Informe o nome da criança";
    if (!birthDate) return "Informe a data de nascimento";
    if (!guardianName.trim()) return "Informe o nome do responsável";
    if (!cpf.trim()) return "Informe o CPF do responsável";
    if (!isValidCpf(cpf)) return "CPF do responsável inválido";
    if (!phone.trim()) return "Informe o WhatsApp do responsável";
    if (!isValidPhoneBr(phone)) return "WhatsApp do responsável inválido";
    if (!planId) return "Escolha o plano de permanência";
    if (activity === "CARRINHO" && !assetId) return "Escolha o carrinho";
    if (isPelucia && !assetId) return "Escolha a pelúcia";

    if (!startNow) {
      // Decisão do dono (2026-09-10): caixa aberto é obrigatório (o
      // dinheiro tem que cair num turno — o servidor também recusa isto
      // com SEM_TURNO_ABERTO, esta é só a mensagem amigável antes de
      // preencher tudo); saldo pré-pago só vale para Playground, nunca
      // CARRINHO (o carrinho não pode ser reservado para o futuro);
      // cupom de desconto vale normalmente, mesmo para saldo consumido
      // só daqui a semanas — por isso não há guarda de cupom aqui.
      if (hasOpenShift === false) return "Abra o caixa para vender saldo pré-pago";
      if (activity === "CARRINHO") return "Saldo pré-pago só vale para planos e pacotes do Playground";
    }

    return null;
  }, [identified, childName, birthDate, guardianName, cpf, phone, planId, activity, assetId, startNow, hasOpenShift, isPelucia]);

  async function submit() {
    if (!unit || !employee || readiness) return;
    if (!startNow) {
      setPrepaidModalOpen(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await Api.checkin({
        unitId: unit.id,
        activity,
        assetId: assetId ?? undefined,
        // Saldo de pacote é um modo próprio (sem plano): o servidor liga a
        // sessão ao responsável que tem o saldo e nunca cobra plano avulso.
        planId: usingHourBank || usingPackage || usingChildCredit || usingPackageBalance ? null : planId!,
        useGuardianPackage: usingPackageBalance,
        allowSiblingPackage: usingSiblingPackage,
        useHourBank: usingHourBank,
        packageId: usingPackage ? selectedPackageId : undefined,
        childCreditId: usingChildCredit ? childCredit?.creditId : undefined,
        employeeId: employee.id,
        child: { id: matchedChild?.id, fullName: childName.trim(), birthDate, inclusiveEligible: isNeurodivergent },
        guardian: {
          id: lastGuardianId ?? undefined,
          fullName: guardianName.trim(),
          cpf: normalizeCpf(cpf),
          phoneE164: normalizePhoneE164(phone),
        },
        couponCode: usingHourBank || usingChildCredit || usingPackageBalance || isPelucia || isBirthdayCourtesy ? undefined : couponCode || undefined,
        notes: customNotes.trim() || undefined,
        sensoryTags: selectedSensoryTags,
        preCheckinId: preCheckinId ?? undefined,
        preCheckinChildIndex: preCheckinId ? (preCheckinChildIndex ?? undefined) : undefined,
      });

      if (preCheckinId) {
        setPreCheckinId(null);
        setPreCheckinChildIndex(null);
        onPrefillConsumed?.();
      }

      setDonePrepaid(null);
      setDone({
        sessionId: res.sessionId,
        accessCode: res.accessCode,
        exitPin: res.exitPin,
        childName: isNeurodivergent && !childName.includes("🧩") ? `${childName.trim()} 🧩` : childName.trim(),
        guardianId: res.guardianId,
        // Plano acima de 2h vendido agora: habilita o botão do contrato de
        // prestação de serviços (banco de horas garantido em contrato).
        contractPlan:
          selectedPlan && planDurationMinutes(selectedPlan) > threshold
            ? { name: selectedPlan.name, valueCents: selectedPlan.valueCents, minutes: planDurationMinutes(selectedPlan) }
            : null,
      });
      setLastGuardianId(res.guardianId);
      // Assim que a entrada é confirmada, o QR já sobe na tela — o operador
      // vira o kiosk para o responsável sem precisar tocar em mais nada.
      setAcompanharOpen(true);
      onSuccess?.();

      if (quickUpsellAccepted && quickProduct) {
        // Fora do try do check-in de propósito, mesma lógica da foto: a
        // entrada já foi gravada, e o item extra é um adicional na comanda,
        // não algo que pode reverter um check-in já concluído.
        Api.addSessionExtra(res.sessionId, quickProduct.id, employee.id).catch(() =>
          toast.error(`Entrada registrada, mas não foi possível adicionar "${quickProduct.name}" à comanda. Adicione manualmente no fechamento.`),
        );
      }

      if (whatsappConsent) {
        // Fora do try do check-in de propósito, mesma lógica da foto: o aceite
        // é gravado depois da entrada. Se falhar, o caminho seguro é não
        // enviar nada (sem registro, sem NPS) — nunca derrubar o check-in.
        Api.setWhatsappConsent(res.guardianId, true, employee.id).catch(() =>
          toast.error("Entrada registrada, mas o aceite de WhatsApp não foi salvo. Peça de novo na próxima visita."),
        );
      }
      if (marketingConsent) {
        // Só faz sentido junto do aceite geral (checkbox acima só aparece
        // marcável quando whatsappConsent está ligado) — mesma lógica de
        // não derrubar o check-in se a gravação falhar.
        Api.setMarketingConsent(res.guardianId, true, employee.id).catch(() =>
          toast.error("Entrada registrada, mas o aceite de ofertas não foi salvo. Peça de novo na próxima visita."),
        );
      }

      if (childPhoto) {
        // Fora do try do check-in de propósito: a entrada já foi gravada, e a
        // foto é só um extra de identificação — uma falha de upload não pode
        // virar "erro ao fazer check-in" na tela.
        Api.uploadChildPhoto(res.childId, childPhoto).catch(() =>
          toast.error("Entrada registrada, mas a foto não pôde ser salva. Você pode tentar de novo na próxima visita."),
        );
      }

      const rentedAsset = isPelucia;
      resetForNextChild(true);

      if (activity === "CARRINHO" || rentedAsset) {
        // Fora do try do check-in de propósito: a entrada já foi gravada, e
        // uma falha só em recarregar a lista de carrinhos não pode virar
        // "erro ao fazer check-in" na tela.
        try {
          const freshAssets = await Api.assets(unit.id);
          setAssets(freshAssets);
          setAssetId(null);
        } catch {
          toast.error("Entrada registrada, mas não foi possível atualizar a lista de carrinhos — atualize a tela antes da próxima.");
        }
      } else {
        setAssetId(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao registrar a entrada";
      if (msg.includes("CORTESIA_ANIVERSARIO_")) {
        // "CODIGO: texto para a operadora" — mostra só o texto.
        setError(msg.includes(": ") ? msg.slice(msg.indexOf(": ") + 2) : msg);
      } else if (msg.includes("CRIANCA_JA_EM_SESSAO")) {
        setError(isPelucia
          ? "Esta criança já está numa sessão ativa. Finalize a brincadeira antes de alugar a pelúcia."
          : "Esta criança já tem uma sessão ativa (brincadeira ou pelúcia alugada). Finalize-a antes de uma nova entrada.");
      } else if (msg.includes("SALDO_PACOTE_USAR_PRIMEIRO")) {
        setError("Esta criança tem saldo de pacote (Porto Seguro). Use o saldo antes de vender plano avulso: escolha \"Usar saldo do pacote\".");
      } else if (msg.includes("SALDO_PACOTE_SEM_SALDO")) {
        setError("O saldo de pacote acabou ou venceu. Atualize a tela e escolha outro plano.");
      } else if (msg.includes("ASSET_INDISPONIVEL")) {
        setError(isPelucia ? "Esta pelúcia acabou de ser alugada. Atualize a tela." : msg);
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handlePrepaidSold(result: { minutesTotal: number }) {
    setPrepaidModalOpen(false);
    setDonePrepaid({
      childName: childName.trim(),
      sourceName: selectedPlan?.name ?? "Saldo",
      minutesTotal: result.minutesTotal,
    });
    setDone(null);
    onSuccess?.();
    resetForNextChild(true);
  }

  async function reprint() {
    if (!done || !employee) return;
    try {
      await Api.reimprimirEntrada(done.sessionId, employee.id);
      toast.success("Pulseira e recibo reenviados para a impressora.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível reimprimir.");
    }
  }

  if (!unit) return null;

  const phoneDigits = phoneDigitsBr(phone);
  const phoneLooksComplete =
    phoneDigits.length === 11 || (phoneDigits.length === 10 && !phoneDigits.slice(2).startsWith("9"));
  const phoneInvalid = phoneLooksComplete && !isValidPhoneBr(phone);

  return (
    <div className="entrada-shell" style={{ maxWidth: "720px", margin: "0 auto", padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        {/* Título só para leitores de tela: a aba ativa "Entrada" já diz onde a pessoa está. */}
        <h1 className="sr-only">Entrada</h1>
        <HelpText>
          Busque a criança pelo nome, CPF ou telefone; toque no plano; confirme. A pulseira e o recibo de guarda saem
          juntos, automaticamente.
        </HelpText>
      </div>

      {/* Confirmação da entrada anterior — fica visível enquanto o operador
          já começa a próxima criança, porque é onde está o código que ele
          pode precisar ditar se a impressora falhar. */}
      {done && (
        <div
          role="status"
          style={{
            border: "2px solid var(--color-teal)",
            background: "rgba(29, 155, 132, 0.08)",
            borderRadius: "16px",
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            gap: "14px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: "200px" }}>
            <strong style={{ display: "block", color: "var(--color-teal-text)" }}>
              ✓ {done.childName} está no parque
            </strong>
            <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              Pulseira e recibo de guarda enviados para impressão. Código:{" "}
              <strong style={{ fontFamily: "var(--font-display)", letterSpacing: "1px" }}>
                {formatAccessCode(done.accessCode)}
              </strong>
              {" · "}PIN de saída:{" "}
              <strong style={{ fontFamily: "var(--font-display)", letterSpacing: "3px" }}>{done.exitPin}</strong>
            </span>
          </div>
          {done.contractPlan && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setContractOpen(true)}
              title="Preencher os dados do Responsável Contratante e imprimir o contrato em A4 (2 vias)"
              style={{ borderColor: "var(--color-teal)", color: "var(--color-teal-text)" }}
            >
              <Emoji3D e="📄" /> Imprimir contrato do plano
            </Button>
          )}
          {lastGuardianId && (
            <Button
              variant="secondary"
              size="sm"
              onClick={addSiblingChild}
              title={`Registrar a entrada de mais uma criança de ${guardianName}`}
            >
              ＋ Mais uma criança deste responsável
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAcompanharOpen(true)}
            title="Mostrar um QR na tela para o responsável acompanhar o tempo pelo próprio celular"
          >
            <Emoji3D e="📱" /> QR de acompanhamento
          </Button>
          <Button variant="ghost" size="sm" onClick={reprint} title="Reenviar as duas vias para a impressora">
            <Emoji3D e="🖨️" /> Reimprimir
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDone(null)} aria-label="Dispensar aviso">
            ✕
          </Button>
        </div>
      )}

      {/* Confirmação da venda pré-paga — sem pulseira, sem código de acesso,
          sem PIN de saída: nada disso existe porque nenhuma sessão foi
          criada. Só o comprovante do pagamento. */}
      {donePrepaid && (
        <div
          role="status"
          style={{
            border: "2px solid #FF7A00",
            background: "rgba(255, 122, 0, 0.08)",
            borderRadius: "16px",
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            gap: "14px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: "200px" }}>
            <strong style={{ display: "block", color: "#B75C00" }}>
              ✓ Saldo de {donePrepaid.sourceName} registrado para {donePrepaid.childName}
            </strong>
            <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              Comprovante enviado para impressão. Sem pulseira e sem código — quando{" "}
              {donePrepaid.childName.split(" ")[0]} voltar, inicie a contagem pelo Painel.
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setDonePrepaid(null)} aria-label="Dispensar aviso">
            ✕
          </Button>
        </div>
      )}

      {/* Oferta de upgrade — acima de tudo, inclusive do nome da criança.
          É o único elemento laranja do fluxo de Entrada, e some assim que
          o operador registra o aceite ou a recusa. */}
      {offer && <UpsellOfferCard offer={offer} onResolved={() => setOffer(null)} />}

      {/* Sugestões do Agente IA Comercial Gemini */}
      <GeminiSalesCard
        type="CHECKIN"
        offers={geminiOffers}
        loading={loadingGemini}
        onApplyOffer={handleApplyGeminiOffer}
      />

      {/* ---------------------------------------------------------------- */}
      {/* 1. Quem é a criança                                              */}
      {/* ---------------------------------------------------------------- */}
      <div className="entrada-cols">
      <div className="entrada-col">
      <section style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>1. Quem é a criança</h2>

        {matchedChild ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "var(--surface-sunken)",
                padding: "14px 18px",
                borderRadius: "14px",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div style={{ flex: 1, minWidth: "200px" }}>
                <strong style={{ fontSize: "17px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  {childName}{isNeurodivergent && !childName.includes("🧩") ? renderEmoji(" 🧩") : ""}
                  {isNeurodivergent && (
                    <Badge
                      variant="teal"
                      title="Criança com Autismo / Neurodivergente — Atendimento Inclusivo"
                      style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
                    >
                      <AutismRibbonIcon width={13} height={16} style={{ flexShrink: 0 }} />
                      <span>Neurodivergente</span>
                    </Badge>
                  )}
                  {matchedChild?.is_vip && (
                    <Badge variant="vip" title={`${matchedChild.visits_in_window} visitas nos últimos 30 dias`}>
                      ★ VIP
                    </Badge>
                  )}
                </strong>
                <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                  {guardianName}
                  {phone ? ` · ${phone}` : ""}
                  {cpf ? ` · ${cpf}` : " · ⚠️ Sem CPF registrado"}
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => resetForNextChild(false)} title="Buscar outra criança">
                Trocar
              </Button>
            </div>

            {!isValidCpf(cpf) && (
              <div
                style={{
                  padding: "12px 16px",
                  background: "#FEF3C7",
                  color: "#92400E",
                  borderRadius: "12px",
                  border: "1px solid #F59E0B",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <strong style={{ fontSize: "13px" }}>⚠️ CPF do Responsável Obrigatório (NFS-e):</strong>
                <span style={{ fontSize: "12px" }}>
                  O cadastro de <strong>{guardianName || "Responsável"}</strong> está sem CPF. Informe o CPF abaixo para continuar com o check-in:
                </span>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <Input
                    placeholder="000.000.000-00 (Obrigatório)"
                    inputMode="numeric"
                    value={cpf}
                    onChange={(e) => setCpf(formatCpf(e.target.value))}
                    style={{ maxWidth: "260px" }}
                  />
                  {cpf.length === 14 && !isValidCpf(cpf) && <Tag color="var(--color-error)">CPF inválido</Tag>}
                </div>
              </div>
            )}

            {!isValidPhoneBr(phone) && (
              <div
                style={{
                  padding: "12px 16px",
                  background: "#FEF3C7",
                  color: "#92400E",
                  borderRadius: "12px",
                  border: "1px solid #F59E0B",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <strong style={{ fontSize: "13px" }}>⚠️ WhatsApp do Responsável Obrigatório:</strong>
                <span style={{ fontSize: "12px" }}>
                  O cadastro de <strong>{guardianName || "Responsável"}</strong> está sem WhatsApp válido. Informe o WhatsApp abaixo para continuar com o check-in:
                </span>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <Input
                    placeholder="(91) 98250-1215 (Obrigatório)"
                    inputMode="numeric"
                    maxLength={15}
                    value={phone}
                    onChange={(e) => setPhone(formatPhoneBr(e.target.value))}
                    style={{ maxWidth: "260px" }}
                  />
                  {phone.length > 0 && !isValidPhoneBr(phone) && (
                    <Tag color="var(--color-error)">WhatsApp inválido — DDD + número, com o 9 do celular</Tag>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ position: "relative" }}>
            <Input
              ref={searchRef}
              label="Buscar por nome, CPF ou telefone"
              placeholder="Ex.: Helena, 000.000.000-00, 91982501215"
              value={query}
              autoFocus
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
            />
            {(matches.length > 0 || (query.trim().length >= 2 && !searching)) && !showNewForm && (
              <div
                className="match-suggestions"
                style={{
                  position: "absolute",
                  zIndex: 10,
                  background: "var(--surface-card)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "12px",
                  width: "100%",
                  boxShadow: "var(--shadow-md)",
                  overflow: "hidden",
                }}
              >
                {matches.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => pickMatch(m)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "12px 14px",
                      cursor: "pointer",
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px solid var(--border-subtle)",
                      font: "inherit",
                    }}
                  >
                    <strong style={{ fontSize: "15px", display: "inline-flex", alignItems: "center", gap: "8px" }}>
                      {m.full_name}
                      {m.is_vip && (
                        <Badge variant="vip" title={`${m.visits_in_window} visitas nos últimos 30 dias`}>
                          ★ VIP
                        </Badge>
                      )}
                    </strong>
                    <br />
                    <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {m.guardian_name ?? "sem responsável"}
                      {m.cpf ? ` · ${formatCpf(m.cpf)}` : ""}
                      {m.phone_e164 ? ` · ${formatPhoneBr(m.phone_e164)}` : ""}
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={startNewChild}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "12px 14px",
                    cursor: "pointer",
                    background: "var(--surface-sunken)",
                    border: "none",
                    font: "inherit",
                    fontWeight: "bold",
                    color: "var(--color-primary-hover)",
                  }}
                >
                  ＋ Não está na lista — cadastrar criança nova
                </button>
              </div>
            )}
          </div>
        )}

        {!matchedChild && !showNewForm && query.trim().length < 2 && (
          <Button variant="ghost" size="sm" onClick={startNewChild} style={{ alignSelf: "flex-start" }}>
            ＋ Primeira vez aqui — cadastrar
          </Button>
        )}

        {showNewForm && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px", border: "1px solid var(--border-subtle)", borderRadius: "14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: "14px" }}>
                Cadastro novo
                {lastGuardianId && guardianName ? ` — responsável ${guardianName} já preenchido` : ""}
              </strong>
              <Button variant="ghost" size="sm" onClick={() => resetForNextChild(Boolean(lastGuardianId))}>
                Voltar para a busca
              </Button>
            </div>
            <Input label="Nome da criança" placeholder="Nome completo" value={childName} onChange={(e) => setChildName(e.target.value)} />
            <DateInput label="Data de nascimento" value={birthDate} onChange={setBirthDate} />
            <Input label="Nome do responsável" placeholder="Pai, mãe ou acompanhante" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} />
            <Input label="CPF do responsável *" placeholder="000.000.000-00 (Obrigatório)" inputMode="numeric" value={cpf} onChange={(e) => setCpf(formatCpf(e.target.value))} />
            {cpf.length === 14 && !isValidCpf(cpf) && <Tag color="var(--color-error)">CPF inválido</Tag>}
            <Input
              label="WhatsApp do responsável *"
              placeholder="(91) 98250-1215 (Obrigatório)"
              inputMode="numeric"
              maxLength={15}
              value={phone}
              onChange={(e) => setPhone(formatPhoneBr(e.target.value))}
            />
            {phoneInvalid && <Tag color="var(--color-error)">WhatsApp inválido — DDD + número, com o 9 do celular</Tag>}
          </div>
        )}

        {(lastGuardianId || (cpf && isValidCpf(cpf))) && !matchedChild && !showNewForm && (
          <Card
            style={{
              padding: "16px",
              borderRadius: "16px",
              border: "2px solid var(--color-teal)",
              background: "rgba(46, 207, 181, 0.08)",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
              <div>
                <Tag color="var(--color-teal)" style={{ fontWeight: "bold", marginBottom: "4px" }}>
                  <Emoji3D e="👤" /> Responsável Ativo (Dados Mantidos)
                </Tag>
                <div style={{ fontSize: "16px", fontWeight: "bold", color: "var(--text-main)" }}>
                  {guardianName || "Responsável"}
                </div>
                <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                  {cpf ? `CPF: ${cpf}` : ""} {phone ? `· WhatsApp: ${phone}` : ""}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => resetForNextChild(false)}
                title="Limpar dados do responsável e buscar outro cliente"
              >
                <Emoji3D e="🔄" /> Trocar responsável
              </Button>
            </div>

            {siblingMatches.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "13px", fontWeight: "bold", color: "var(--color-teal-text)" }}>
                  <Emoji3D e="👶" /> Crianças já cadastradas para este responsável ({siblingMatches.length}):
                </span>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  {siblingMatches.map((sibling) => (
                    <Button
                      key={sibling.id}
                      variant="secondary"
                      size="sm"
                      onClick={() => pickMatch(sibling)}
                      style={{ borderColor: "var(--color-teal)", background: "#fff", color: "var(--text-main)" }}
                      title={`Fazer check-in para ${sibling.full_name}`}
                    >
                      <Emoji3D e="🧒" /> {sibling.full_name} ({formatAge(sibling.birth_date)})
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
              <Button
                variant="primary"
                size="sm"
                onClick={addSiblingChild}
                title={`Cadastrar mais uma criança de ${guardianName}, mantendo CPF e WhatsApp`}
              >
                ＋ Cadastrar nova criança de {guardianName.split(" ")[0]}
              </Button>
              {siblingCheckinCount >= 1 && (
                <Tag color="var(--color-gold)" style={{ fontWeight: "bold" }}>
                  <Emoji3D e="🎉" /> {siblingCheckinCount + 1}ª Criança deste responsável (Combo Irmãos)
                </Tag>
              )}
            </div>
          </Card>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 2. Plano                                                         */}
      {/* ---------------------------------------------------------------- */}
      </div>
      <div className="entrada-col">
      <section>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: "0 0 8px 0" }}>2. Plano de permanência</h2>
        {matchedChild && foreignPackages.length > 0 && (
          <div
            role="alert"
            style={{
              margin: "0 0 10px 0",
              padding: "10px 14px",
              borderRadius: "12px",
              border: "2px solid var(--color-warning, #F5A623)",
              background: "rgba(245, 166, 35, 0.12)",
              fontSize: "13px",
            }}
          >
            <strong>⚠ Saldo de pacote em outro responsável.</strong>{" "}
            {foreignPackages
              .map((p) => `${p.package_name}: ${formatPlanoHoras(p.remaining_minutes)} em nome de ${p.guardian_name}`)
              .join(" · ")}
            . Se esta família usa esse saldo, a criança será cobrada como avulsa — corrija o responsável no cadastro antes de confirmar.
          </div>
        )}
        {/* Saldo de pacote (ex.: Porto Seguro) da família, visto ANTES de abrir a
            sessão. Informativo: o tempo da visita sai do saldo no fechamento,
            qualquer que seja o plano escolhido abaixo. Um pacote por linha,
            na ordem em que são abatidos. */}
        {matchedChild && childPackages.length > 0 && (
          <div
            style={{
              margin: "0 0 10px 0",
              padding: "10px 14px",
              borderRadius: "12px",
              border: "2px solid var(--color-primary, #FF7A00)",
              background: "rgba(255, 122, 0, 0.08)",
              fontSize: "13px",
            }}
          >
            <strong>
              <Emoji3D e="🎟️" /> Saldo de pacote: {formatPlanoHoras(childPackageMinutes)} disponíveis
              {siblingPackageMinutes > 0 ? ` (+ ${formatPlanoHoras(siblingPackageMinutes)} de irmão)` : ""}
            </strong>
            <ul style={{ margin: "6px 0 0 0", paddingLeft: "18px" }}>
              {childPackages.map((p) => (
                <li key={p.package_id}>
                  {p.package_name}{p.is_own === false ? ` (de ${p.owner_child_name ?? "outra criança"})` : ""}: {formatPlanoHoras(p.remaining_minutes)} de {formatPlanoHoras(p.included_minutes)} · vence{" "}
                  {new Date(p.expires_at_ms).toLocaleDateString("pt-BR")}
                </li>
              ))}
            </ul>
            <div style={{ marginTop: "4px", color: "var(--text-muted)" }}>
              O tempo da visita sai do saldo no fechamento (exceto aluguel de pelúcia e cortesia de aniversário).
            </div>
          </div>
        )}
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {/* Saldo de pacote (ex.: Porto Seguro): opção prioritária quando a família já tem saldo */}
          {matchedChild && childPackageMinutes > 0 && activity === "PLAYGROUND" && (
            <Card
              onClick={() => setPlanId(PACKAGE_BALANCE)}
              title="Usar o saldo de pacote já contratado (Porto Seguro) da família"
              style={{
                cursor: "pointer",
                padding: "14px 18px",
                minWidth: "180px",
                borderRadius: "16px",
                border: usingPackageBalance ? "2px solid #1A3F35" : "2px dashed #1A3F35",
                background: usingPackageBalance ? "rgba(26, 63, 53, 0.12)" : "var(--surface-card)",
              }}
            >
              <strong style={{ fontSize: "16px", display: "block", color: "#1A3F35" }}>
                <Emoji3D e="🎟️" /> Usar saldo do pacote
              </strong>
              <div style={{ fontSize: "18px", color: "#1A3F35", fontWeight: "bold", marginTop: "2px" }}>
                {formatPlanoHoras(childPackageMinutes)} disponíveis
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                {childPackages[0]?.package_name || "Porto Seguro"} · sem custo de entrada
              </div>
            </Card>
          )}
          {/* Pacote de IRMÃO: opção separada e nunca pré-selecionada. O balcão confirma com o responsável. */}
          {matchedChild && childPackageMinutes === 0 && siblingPackageMinutes > 0 && activity === "PLAYGROUND" && (
            <Card
              onClick={() => setPlanId(SIBLING_PACKAGE_BALANCE)}
              title="Este saldo foi comprado para outra criança. Só use se o responsável autorizar."
              style={{
                cursor: "pointer",
                padding: "14px 18px",
                minWidth: "180px",
                borderRadius: "16px",
                border: usingSiblingPackage ? "2px solid #B45309" : "2px dashed #B45309",
                background: usingSiblingPackage ? "rgba(180, 83, 9, 0.12)" : "var(--surface-card)",
              }}
            >
              <strong style={{ fontSize: "16px", display: "block", color: "#B45309" }}>
                <Emoji3D e="⚠️" /> Usar pacote de {siblingPackages[0]?.owner_child_name ?? "outra criança"}
              </strong>
              <div style={{ fontSize: "18px", color: "#B45309", fontWeight: "bold", marginTop: "2px" }}>
                {formatPlanoHoras(siblingPackageMinutes)} disponíveis
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                Pacote de outra criança · confirme com o responsável
              </div>
            </Card>
          )}
          {/* Banco de horas antes dos planos pagos, de propósito: a regra é
              usar o saldo que a família já pagou ANTES de vender plano novo. */}
          {matchedChild && hourBank && (
            <Card
              onClick={() => setPlanId(HOUR_BANK)}
              title="Usar o saldo de horas já pago em visitas anteriores (vale em qualquer unidade)"
              style={{
                cursor: "pointer",
                padding: "14px 18px",
                minWidth: "180px",
                borderRadius: "16px",
                border: usingHourBank ? "2px solid var(--color-teal)" : "2px dashed var(--color-teal)",
                background: usingHourBank ? "rgba(46, 207, 181, 0.10)" : "var(--surface-card)",
              }}
            >
              <strong style={{ fontSize: "16px", display: "block", color: "var(--color-teal-text)" }}>
                <Emoji3D e="🕐" /> Usar banco de horas
              </strong>
              <div style={{ fontSize: "18px", color: "var(--color-teal-text)", fontWeight: "bold", marginTop: "2px" }}>
                {formatPlanoHoras(hourBank.remainingMinutes)} disponíveis
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                vence {new Date(hourBank.nextExpiryMs).toLocaleDateString("pt-BR")} · sem custo de entrada
              </div>
            </Card>
          )}
          {/* Saldo pré-pago: dinheiro já recebido numa visita anterior em
              que "Iniciar contagem agora" ficou desmarcado. Mesmo padrão
              visual do banco de horas, cor roxa para não confundir com ele
              (o roxo já é a cor da sessão pré-paga no Painel/client.ts). */}
          {matchedChild && childCredit && activity === "PLAYGROUND" && (
            <Card
              onClick={() => setPlanId(CHILD_CREDIT)}
              title="Usar o saldo pago numa visita anterior, em que a criança não iniciou a contagem na hora"
              style={{
                cursor: "pointer",
                padding: "14px 18px",
                minWidth: "180px",
                borderRadius: "16px",
                border: usingChildCredit ? "2px solid #7C4DFF" : "2px dashed #7C4DFF",
                background: usingChildCredit ? "rgba(124, 77, 255, 0.10)" : "var(--surface-card)",
              }}
            >
              <strong style={{ fontSize: "16px", display: "block", color: "#5B32C4" }}>
                <Emoji3D e="💳" /> Usar saldo pré-pago
              </strong>
              <div style={{ fontSize: "18px", color: "#5B32C4", fontWeight: "bold", marginTop: "2px" }}>
                {formatPlanoHoras(childCredit.remainingMinutes + childPackageMinutes)} disponíveis
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                {childPackageMinutes > 0
                  ? `${formatPlanoHoras(childCredit.remainingMinutes)} da criança + ${formatPlanoHoras(childPackageMinutes)} do pacote · o pacote é usado quando o saldo da criança acabar`
                  : "sem vencimento · sem custo de entrada"}
              </div>
            </Card>
          )}
          {/* Cortesia de aniversário: só aparece para a criança que a tem,
              válida hoje. Plano de R$ 0,00; o minuto adicional (depois dos
              30 min) é cobrado normalmente no fechamento. */}
          {birthdayOffer && activity === "PLAYGROUND" && (
            <Card
              onClick={() => {
                setPlanId(birthdayOffer.plan.id);
                setStartNow(true);
              }}
              title="Cortesia de aniversário: 30 minutos grátis para a criança aniversariante"
              style={{
                cursor: "pointer",
                padding: "14px 18px",
                minWidth: "200px",
                borderRadius: "16px",
                border: isBirthdayCourtesy ? "2px solid var(--color-warning, #F5A623)" : "2px dashed var(--color-warning, #F5A623)",
                background: isBirthdayCourtesy ? "rgba(245, 166, 35, 0.12)" : "var(--surface-card)",
              }}
            >
              <strong style={{ fontSize: "16px", display: "block" }}><Emoji3D e="🎂" /> {birthdayOffer.plan.name}</strong>
              <div style={{ fontSize: "18px", fontWeight: "bold", marginTop: "2px", color: "var(--color-primary-hover)" }}>Grátis</div>
              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                vale até {new Date(`${birthdayOffer.validUntil}T12:00:00`).toLocaleDateString("pt-BR")} · depois dos 30 min,{" "}
                {money(birthdayOffer.plan.overageCentsPerMinute)}/min
              </div>
            </Card>
          )}
          {/* Pacotes entram no mesmo grid dos planos, sem seção ou marca
              visual separada — cada um já chegou aqui como um Plan
              sintético (packagePlans). */}
          {[...(saldoPacoteObrigatorio ? [] : regularPlans), ...packagePlans].map((plan) => {
            const discountInfo = getPlanDiscountedCents(plan.valueCents, couponCode, coupons, plan.id);
            return (
              <Card
                key={plan.id}
                onClick={() => {
                  setPlanId(plan.id);
                }}
                style={{
                  cursor: "pointer",
                  padding: "14px 18px",
                  minWidth: "150px",
                  borderRadius: "16px",
                  border: planId === plan.id ? "2px solid var(--color-primary)" : "1px solid var(--border-subtle)",
                  background: planId === plan.id ? "rgba(240, 25, 107, 0.06)" : "var(--surface-card)",
                }}
              >
                <strong style={{ fontSize: "16px", display: "block" }}>{plan.name}</strong>
                <div style={{ marginTop: "4px" }}>
                  {discountInfo.discountText && hasManualCoupon ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                      <span style={{ fontSize: "12px", color: "var(--text-muted)", textDecoration: "line-through" }}>
                        {money(discountInfo.originalCents)}
                      </span>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ fontSize: "18px", color: "var(--color-primary-hover)", fontWeight: "bold" }}>
                          {money(discountInfo.finalCents)}
                        </span>
                        <Badge variant="pink" style={{ background: "rgba(240, 25, 107, 0.12)", color: "var(--color-primary-hover)", fontSize: "11px" }}>
                          {discountInfo.discountText}
                        </Badge>
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: "18px", color: "var(--color-primary-hover)", fontWeight: "bold" }}>
                      {money(discountInfo.finalCents)}
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
          {/* Aluguel avulso de pelúcia: um card por pelúcia, com a foto,
              no mesmo formato do seletor de carrinhos do Circuito. Fica por
              último e tracejado, porque é esporádico e não deve competir
              com o plano de brincadeira. Tocar escolhe o plano e a pelúcia
              de uma vez. */}
          {peluciaPlan &&
            peluciaAssets
              .filter((a) => a.status === "DISPONIVEL" || a.status === "EM_USO")
              .map((asset) => {
                const livre = asset.status === "DISPONIVEL";
                const selecionada = isPelucia && assetId === asset.id;
                return (
                  <Card
                    key={asset.id}
                    onClick={() => {
                      if (!livre) return;
                      setPlanId(peluciaPlan.id);
                      setAssetId(asset.id);
                      setCouponCode("");
                      setStartNow(true);
                    }}
                    title={livre ? "Aluguel avulso de pelúcia, cronometrado, com devolução" : "Pelúcia alugada agora"}
                    style={{
                      cursor: livre ? "pointer" : "not-allowed",
                      opacity: livre ? 1 : 0.4,
                      padding: "14px 18px",
                      borderRadius: "16px",
                      border: selecionada ? "2px solid #A855F7" : "2px dashed #A855F7",
                      background: selecionada ? "rgba(168, 85, 247, 0.10)" : "var(--surface-card)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                      {asset.photo_url ? (
                        <img
                          src={asset.photo_url}
                          alt={asset.name}
                          style={{
                            width: "96px",
                            height: "96px",
                            objectFit: "cover",
                            borderRadius: "14px",
                            border: "1px solid var(--border-subtle)",
                            flexShrink: 0,
                          }}
                        />
                      ) : (
                        <span aria-hidden style={{ fontSize: "60px", display: "inline-flex", alignItems: "center", justifyContent: "center", width: "96px", height: "96px" }}>
                          {renderEmoji(asset.emoji || "🧸")}
                        </span>
                      )}
                      <div>
                        <strong style={{ fontSize: "15px", display: "block", color: "#7E22CE" }}>{asset.name}</strong>
                        <div style={{ fontSize: "18px", color: "#7E22CE", fontWeight: "bold", marginTop: "2px" }}>
                          {money(peluciaPlan.valueCents)} · {planDurationMinutes(peluciaPlan)} min
                        </div>
                        <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                          {livre
                            ? `Aluguel avulso · excedente ${money(peluciaPlan.overageCentsPerMinute)}/min`
                            : "Alugada agora"}
                        </div>
                      </div>
                    </div>
                  </Card>
                );
              })}
        </div>

        {/* Cross-sell rápido: só aparece com plano longo o bastante e
            produto configurado. Um toque liga/desliga — o item só entra
            na comanda de fato depois do check-in confirmado. */}
        {selectedPlan && !isPelucia && quickProduct && planDurationMinutes(selectedPlan) >= quickTriggerMinutes && (
          <div
            style={{
              marginTop: "10px",
              display: "flex",
              alignItems: "center",
              gap: "12px",
              padding: "12px 14px",
              borderRadius: "14px",
              border: quickUpsellAccepted ? "2px solid var(--color-primary)" : "1px dashed var(--border-subtle)",
              background: quickUpsellAccepted ? "rgba(240, 25, 107, 0.06)" : "transparent",
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: "20px" }}>{renderEmoji(quickProduct.emoji ?? "🛒")}</span>
            <span style={{ flex: 1, minWidth: "180px", fontSize: "14px" }}>
              Oferecer <strong>{quickProduct.name}</strong> por {money(quickProduct.price_cents)}?
            </span>
            <Button
              type="button"
              variant={quickUpsellAccepted ? "primary" : "secondary"}
              size="sm"
              onClick={() => setQuickUpsellAccepted((v) => !v)}
            >
              {quickUpsellAccepted ? "✓ Vai na comanda" : "Adicionar"}
            </Button>
          </div>
        )}

        {/* Lembrete de venda: 30 min -> 1 hora + Olhar FaçaAmigos (só a
            partir de 1 h gera o Olhar). Trocar não abre o modal da água:
            duas ofertas seguidas cansam o cliente. */}
        {olharOffer && selectedPlan && (
          <OlharUpsellCard
            currentName={selectedPlan.name}
            targetName={olharOffer.target.name}
            extraMinutes={olharOffer.extraMinutes}
            stayCents={olharOffer.stayCents}
            targetCents={olharOffer.targetCents}
            onSwitch={() => setPlanId(olharOffer.target.id)}
            onDismiss={() => setOlharOfferDismissed(true)}
          />
        )}

        {/* Pré-pago: o pai paga e vai embora, o tempo fica como saldo da
            criança. Marcado ("Iniciar contagem agora") é o padrão — só
            aparece quando já há um plano escolhido, não é o banco de
            horas (não dá pra pré-pagar um saldo que a criança já tem) e
            é Playground (CARRINHO não pode ser reservado para o futuro). */}
        {selectedPlan && !usingHourBank && !usingChildCredit && !isPelucia && !isBirthdayCourtesy && activity === "PLAYGROUND" && (
          <IfCan capability="venda.prepago">
            <div
              style={{
                marginTop: "10px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                padding: "12px 14px",
                borderRadius: "14px",
                border: "1px dashed var(--color-teal)",
              }}
            >
              <Checkbox checked={startNow} onChange={setStartNow} label="Iniciar contagem agora" />
              {!startNow && (
                <HelpText>
                  O tempo fica guardado como saldo da criança. Nada é impresso como pulseira; você cobra agora
                  e inicia depois pelo Painel, quando ela voltar.
                </HelpText>
              )}
            </div>
          </IfCan>
        )}
      </section>

      {activity === "CARRINHO" && (
        <section>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: "0 0 8px 0" }}>
            {isPelucia ? "3. Pelúcia" : "3. Carrinho"}
          </h2>
          {favoriteAssetId === assetId && assetId && (
            <Tag color="var(--color-teal)" style={{ marginBottom: "8px" }}>
              Carrinho de sempre já reservado
            </Tag>
          )}
          {(() => {
            const visibleAssets = (isPelucia ? peluciaAssets : assets).filter((a) => a.name !== "Fusca Amarelo" && a.name !== "Jipe Rosa" && (a.status as string) !== "DESATIVADO" && (a.status as string) !== "EXCLUIDO" && (a.status as string) !== "INATIVO");
            return (
              <>
                {visibleAssets.length > 0 && visibleAssets.every((a) => a.status !== "DISPONIVEL") && (
                  <div
                    role="alert"
                    style={{
                      fontSize: "13px",
                      color: "var(--color-error-text)",
                      background: "rgba(232,48,48,0.08)",
                      border: "1px solid var(--color-error)",
                      borderRadius: "10px",
                      padding: "8px 12px",
                      marginBottom: "10px",
                    }}
                  >
                    {isPelucia
                      ? "⚠️ Nenhuma pelúcia disponível agora: todas estão alugadas ou em manutenção."
                      : `⚠️ Lotação máxima atingida: todos os ${visibleAssets.length} carrinhos cadastrados estão em uso ou em manutenção.`}
                  </div>
                )}
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  {visibleAssets.map((asset) => (
              <Card
                key={asset.id}
                onClick={() => asset.status === "DISPONIVEL" && setAssetId(asset.id)}
                style={{
                  cursor: asset.status === "DISPONIVEL" ? "pointer" : "not-allowed",
                  opacity: asset.status === "DISPONIVEL" ? 1 : 0.4,
                  padding: "14px 18px",
                  borderRadius: "16px",
                  border: assetId === asset.id ? "2px solid var(--color-primary)" : "1px solid var(--border-subtle)",
                  background: assetId === asset.id ? "rgba(240, 25, 107, 0.06)" : "var(--surface-card)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                  {asset.photo_url ? (
                    <img
                      src={asset.photo_url}
                      alt={asset.name}
                      style={{
                        width: "96px",
                        height: "96px",
                        objectFit: "cover",
                        borderRadius: "14px",
                        border: "1px solid var(--border-subtle)",
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <span style={{ fontSize: "60px", display: "inline-flex", alignItems: "center", justifyContent: "center", width: "96px", height: "96px" }}>{renderEmoji(asset.emoji)}</span>
                  )}
                  <span style={{ fontWeight: "var(--weight-bold)" as unknown as number, fontSize: "15px" }}>{asset.name}</span>
                </div>
              </Card>
            ))}
          </div>
        </>
      );
    })()}
        </section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Neurodivergência — o checkbox é o gatilho; a área expande inline  */}
      {/* (grid-template-rows 0fr→1fr), nunca em modal, para não tirar o    */}
      {/* operador do formulário nem esconder o resto do fluxo.            */}
      {/* ---------------------------------------------------------------- */}
      <section style={{ border: "1px solid var(--border-subtle)", borderRadius: "14px", padding: "12px 14px" }}>
        <Checkbox
          label="Criança neurodivergente"
          helpText="Marque para registrar cuidados sensoriais e, se quiser, uma foto para identificação."
          checked={isNeurodivergent}
          onChange={(checked) => {
            setIsNeurodivergent(checked);
            if (!checked) {
              setSelectedSensoryTags([]);
              setCustomNotes("");
              setChildPhoto(null);
            }
          }}
        />

        <div
          style={{
            display: "grid",
            gridTemplateRows: isNeurodivergent ? "1fr" : "0fr",
            transition: "grid-template-rows 240ms ease",
          }}
        >
          <div style={{ overflow: "hidden", minHeight: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px", paddingTop: "12px", borderTop: "1px solid var(--border-subtle)" }}>
              <strong style={{ fontSize: "15px" }}><Emoji3D e="🧩" /> Cuidados Inclusivos &amp; Tags Sensoriais</strong>
              <HelpText>
                Estas informações são impressas na pulseira e no recibo — é assim que o monitor no salão fica sabendo.
              </HelpText>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {SENSORY_TAG_OPTIONS.map((tag) => {
                  const isSelected = selectedSensoryTags.includes(tag);
                  return (
                    <Button
                      key={tag}
                      type="button"
                      variant={isSelected ? "teal" : "ghost"}
                      size="sm"
                      onClick={() => toggleSensoryTag(tag)}
                      style={{ borderRadius: "9999px" }}
                    >
                      {isSelected ? "✓ " : "+ "}
                      {tag}
                    </Button>
                  );
                })}
              </div>
              <Input
                label="Outras observações (opcional)"
                placeholder="Ex: alergia a corantes, brinquedo favorito..."
                value={customNotes}
                onChange={(e) => setCustomNotes(e.target.value)}
              />
              <PhotoCapture onChange={setChildPhoto} />
            </div>
          </div>
        </div>
      </section>

      {/* Cupom fica atrás de um toque ou visualizado automaticamente */}
      {!isPelucia && !isBirthdayCourtesy && (
      <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {hasManualCoupon && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Tag color="var(--color-teal)" style={{ fontSize: "13px", padding: "6px 12px" }}>
              <Emoji3D e="🎟️" /> Cupom de desconto ativo: <strong>{couponCode}</strong>
            </Tag>
          </div>
        )}
        {!showExtras ? (
          <Button variant="ghost" size="sm" onClick={() => setShowExtras(true)} style={{ alignSelf: "flex-start" }}>
            {hasManualCoupon ? "Alterar cupom de desconto" : "＋ Aplicar cupom de parceria"}
          </Button>
        ) : (
          <>
            <Select label="Cupom de parceria (substitui o desconto padrão)" value={manualCoupon ?? ""} onChange={(e) => setCouponCode(e.target.value)}>
              <option value="">Desconto padrão</option>
              {eligibleCoupons.map((c) => (
                <option key={c.id} value={c.code}>
                  {c.code}
                  {c.description ? ` — ${c.description}` : ""}
                </option>
              ))}
            </Select>

            {/* Cupom do portal Wi-Fi da clínica: um por família, então não entra na lista acima. */}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontWeight: 700, fontSize: "13px" }}>Cupom do Wi-Fi da clínica (ESPERA-XXXX)</label>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <Input
                  placeholder="ESPERA-AB12"
                  value={wifiCode}
                  autoCapitalize="characters"
                  onChange={(e) => {
                    setWifiCode(e.target.value.toUpperCase());
                    setWifiLookup(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void checkWifiCoupon();
                    }
                  }}
                  style={{ maxWidth: "220px" }}
                />
                <Button variant="ghost" size="sm" onClick={() => void checkWifiCoupon()} disabled={!wifiCode.trim() || wifiChecking}>
                  {wifiChecking ? "Conferindo…" : "Conferir"}
                </Button>
              </div>
              {wifiLookup && <WifiCouponResult lookup={wifiLookup} onApply={applyWifiCoupon} />}
            </div>
          </>
        )}
      </section>
      )}
      </div>
      </div>

      {error && <p style={{ color: "var(--color-error-text)", margin: 0, fontWeight: "bold" }}>{error}</p>}

      {/* Barra de confirmação: sempre visível no fim do fluxo, com o total
          que a família vai ver e o motivo exato do bloqueio, se houver. */}
      <div
        style={{
          position: "sticky",
          bottom: 0,
          background: "var(--surface-card)",
          borderTop: "1px solid var(--border-subtle)",
          padding: "12px 0",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        {readiness && <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>{readiness}</span>}
        {startNow && (
          <details style={{ fontSize: "14px" }}>
            <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--text-muted)" }}>
              Autorizações de contato (WhatsApp)
            </summary>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
              <Checkbox
                checked={whatsappConsent}
                onChange={(v) => {
                  setWhatsappConsent(v);
                  if (!v) setMarketingConsent(false); // sem aceite geral, não faz sentido oferecer o de ofertas
                }}
                label="O responsável autoriza contato por WhatsApp (avisos da visita e pesquisa de satisfação)"
                helpText="Já vem marcado — pergunte ao responsável e desmarque se ele não quiser. Pode pedir para parar a qualquer momento respondendo PARAR."
              />
              {whatsappConsent && (
                <Checkbox
                  checked={marketingConsent}
                  onChange={setMarketingConsent}
                  label="Também aceita receber ofertas e novidades (pacotes, promoções) de vez em quando"
                  helpText="Pergunta separada da anterior — desmarque se o responsável quiser receber só os avisos, sem ofertas."
                />
              )}
            </div>
          </details>
        )}
        <Button
          variant="primary"
          size="lg"
          loading={submitting}
          disabled={submitting || Boolean(readiness)}
          onClick={submit}
          data-save-button
          style={{ borderRadius: "9999px", padding: "16px" }}
          title={
            startNow
              ? "Registrar a entrada e imprimir a pulseira e o recibo de guarda"
              : "Cobrar o saldo pré-pago sem iniciar a sessão — a criança volta outro dia para usar"
          }
        >
          {startNow ? "Confirmar entrada" : "Cobrar saldo pré-pago"}
          {usingHourBank
            ? " — Banco de horas (R$ 0,00)"
            : selectedPlan
              ? ` — ${money(
                  getPlanDiscountedCents(selectedPlan.valueCents, couponCode, coupons, selectedPlan.id).finalCents +
                    (quickUpsellAccepted && quickProduct ? quickProduct.price_cents : 0),
                )}`
              : ""}
        </Button>
      </div>

      {/* Contrato dos planos acima de 2h: dados do Responsável Contratante
          + impressão A4 com timbre da unidade, em 2 vias. */}
      {contractOpen && done?.contractPlan && (
        <ContractModal
          guardianId={done.guardianId}
          childName={done.childName}
          plan={done.contractPlan}
          onClose={() => setContractOpen(false)}
        />
      )}

      {/* Cobrança do saldo pré-pago — "Iniciar contagem agora" desmarcado.
          Não cria sessão nenhuma; só existe depois que o operador confirma
          o pagamento aqui. */}
      {prepaidModalOpen && unit && employee && selectedPlan && (
        <PrepaidPaymentModal
          unitId={unit.id}
          employeeId={employee.id}
          activity={activity}
          planId={usingPackage ? null : planId}
          packageId={usingPackage ? selectedPackageId : null}
          priceCents={getPlanDiscountedCents(selectedPlan.valueCents, couponCode, coupons, selectedPlan.id).finalCents}
          sourceName={selectedPlan.name}
          child={{ id: matchedChild?.id, fullName: childName.trim(), birthDate, inclusiveEligible: isNeurodivergent }}
          guardian={{
            id: lastGuardianId ?? undefined,
            fullName: guardianName.trim(),
            cpf: normalizeCpf(cpf),
            phoneE164: normalizePhoneE164(phone),
          }}
          couponCode={couponCode || undefined}
          onClose={() => setPrepaidModalOpen(false)}
          onSold={handlePrepaidSold}
        />
      )}

      {/* QR de acompanhamento: mostrado na tela, não impresso — evita
          mexer no QR já impresso na pulseira/recibo (aquele é lido pelo
          scanner do operador na saída via fa_kiosk_normalize_access_code,
          que quebraria se virasse uma URL). Este é só para o responsável
          apontar a câmera do próprio celular, oferecido pela operadora. */}
      {acompanharOpen && done && acompanharUrl && (
        <Modal title={renderEmoji("📱 Apresentar ao Responsável")} onClose={() => setAcompanharOpen(false)}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", padding: "8px 0" }}>
            <p
              style={{
                margin: 0,
                textAlign: "center",
                fontSize: "15px",
                fontWeight: 600,
                color: "var(--color-teal-text)",
              }}
            >
              Vire a tela e apresente este QR Code ao responsável de {done.childName.split(" ")[0]}
            </p>
            <p style={{ margin: 0, textAlign: "center", fontSize: "13px", color: "var(--text-muted)" }}>
              Basta apontar a câmera do celular para o QR abaixo — o painel de acompanhamento abre na hora, sem
              precisar de cadastro.
            </p>
            {/* Mesmo cronômetro que o responsável vê no celular assim que
                escaneia o QR — roda aqui no balcão em paralelo, pela
                mesma sessão, para o operador confirmar de relance que o
                tempo já está contando antes de liberar a criança. */}
            {acompanharTiming && (
              <StatusBadge
                phase={acompanharTiming.phase}
                detail={formatElapsed(acompanharTiming.elapsedMs)}
                size="lg"
                style={{ width: "100%", alignItems: "center", textAlign: "center" }}
              />
            )}
            <WristbandQRCode value={acompanharUrl} size={220} />
          </div>
        </Modal>
      )}

      {/* Modal de Cross-Selling Automático para pacotes >= 1h */}
      {crossSellModalOpen && (
        <Modal onClose={() => setCrossSellModalOpen(false)} title={renderEmoji("🥤 Oportunidade de Venda (Cross-Selling)")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "4px" }}>
            <p style={{ margin: 0, fontSize: "14px", color: "var(--text-muted)" }}>
              O cliente selecionou um pacote de{" "}
              <strong>
                {selectedPlan
                  ? planDurationMinutes(selectedPlan) >= 60 && planDurationMinutes(selectedPlan) % 60 === 0
                    ? `${planDurationMinutes(selectedPlan) / 60}h`
                    : `${planDurationMinutes(selectedPlan)} min`
                  : "1h"}
              </strong>
              . Ofereça o produto adicional utilizando o script abaixo:
            </p>

            {/* Script destacado para o operador ler */}
            <div
              style={{
                border: "2px solid var(--color-orange, #ff7a00)",
                background: "rgba(255, 122, 0, 0.08)",
                borderRadius: "14px",
                padding: "16px 18px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: "bold",
                  color: "var(--color-orange-text, #d96300)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                Script de Abordagem
              </div>
              <blockquote
                style={{
                  margin: 0,
                  fontSize: "18px",
                  lineHeight: 1.5,
                  fontWeight: "600",
                  color: "var(--text-primary)",
                  borderLeft: "4px solid var(--color-orange, #ff7a00)",
                  paddingLeft: "12px",
                }}
              >
                “Por mais {money(quickProduct ? quickProduct.price_cents : 500)}, você quer adicionar uma água para ele?{" "}
                {selectedPlan
                  ? planDurationMinutes(selectedPlan) >= 60 && planDurationMinutes(selectedPlan) % 60 === 0
                    ? `${planDurationMinutes(selectedPlan) / 60} ${planDurationMinutes(selectedPlan) === 60 ? "hora" : "horas"}`
                    : `${planDurationMinutes(selectedPlan)} minutos`
                  : "1 hora"}{" "}
                vai dar bem sede!”
              </blockquote>
            </div>

            {/* Botões de Ação */}
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "8px" }}>
              <Button
                type="button"
                variant="primary"
                size="lg"
                onClick={() => {
                  setQuickUpsellAccepted(true);
                  setCrossSellModalOpen(false);
                  toast.success(`${quickProduct?.name ?? "Água"} adicionada ao pedido!`);
                }}
                style={{
                  flex: 1,
                  minWidth: "220px",
                  borderRadius: "9999px",
                  background: "var(--color-orange, #ff7a00)",
                  borderColor: "var(--color-orange, #ff7a00)",
                }}
              >
                ✓ Sim, adicionar água (+ {money(quickProduct ? quickProduct.price_cents : 500)})
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={() => {
                  setQuickUpsellAccepted(false);
                  setCrossSellModalOpen(false);
                }}
                style={{ flex: 1, minWidth: "180px", borderRadius: "9999px" }}
              >
                ✕ Não, apenas o pacote
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const WIFI_STATUS_TEXT: Record<Exclude<WifiCouponLookup["status"], "OK">, string> = {
  USADO: "Este cupom já foi usado.",
  USADO_OUTRA_UNIDADE: "Este cupom já foi usado na outra unidade (um benefício por cupom).",
  VENCIDO: "Este cupom está vencido.",
  DESATIVADO: "Este cupom foi desativado.",
  NAO_ENCONTRADO: "Cupom não encontrado nesta unidade. Confira o código.",
};

/** Resultado da conferência do cupom do Wi-Fi: de quem é, o que vale, até quando, e o botão de aplicar. */
function WifiCouponResult({ lookup, onApply }: { lookup: WifiCouponLookup; onApply: () => void }) {
  if (lookup.status !== "OK" || !lookup.coupon) {
    const text = WIFI_STATUS_TEXT[lookup.status === "OK" ? "NAO_ENCONTRADO" : lookup.status];
    return (
      <p style={{ margin: 0, fontWeight: 700, color: "var(--color-error-text)" }}>
        ✖ {text}
        {lookup.guardianName ? ` (cupom de ${lookup.guardianName})` : ""}
      </p>
    );
  }
  const c = lookup.coupon;
  const benefit = c.kind === "MINUTOS_EXTRA" ? `+${c.value} min grátis` : c.kind === "DESCONTO_PCT" ? `${c.value}% de desconto` : "desconto";
  const until = c.expiresAtMs ? ` · vale até ${new Date(c.expiresAtMs).toLocaleDateString("pt-BR")}` : "";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
      <span style={{ fontWeight: 700 }}>
        ✔ Cupom de {lookup.guardianName ?? "cliente"} · {benefit}
        {until}
      </span>
      <Button size="sm" onClick={onApply}>
        Aplicar
      </Button>
    </div>
  );
}
