import { useCallback, useEffect, useState } from "react";
import { Button, Card, Input, Select, Tabs, HelpText, Modal, Tag } from "@facaamigos/ui";
import { generateEscPosReceipt } from "@facaamigos/domain";
import { Api, isWifiClinicCoupon } from "../api/client.js";
import type {
  Asset,
  Coupon,
  Employee,
  LoyaltyRule,
  Package,
  Plan,
  Product,
  ProductFiscal,
  FiscalTerminalStatus,
  UnitFiscal,
} from "../api/client.js";
import { useAppState } from "../state/AppState.js";
import { useToast } from "../state/ToastContext.js";
import { useAuth } from "../auth/AuthContext.js";
import { RequireCapability } from "../auth/RequireCapability.js";
import { ROLE_LABEL, ROLE_DESCRIPTION, type Capability } from "../auth/capabilities.js";
import { EmployeeAuthGate } from "../components/EmployeeAuthGate.js";
import type { TerminalEmployee } from "../lib/supabase/terminalAuth.js";
import { WristbandLabelPreview } from "../components/WristbandLabelPreview.js";
import { WristbandPrintModal } from "../components/WristbandPrintModal.js";
import { isPushSupported, subscribeToPush, getExistingPushSubscription, pushSubscriptionToKeys, OWNER_PUSH_STORAGE_KEY } from "../lib/push.js";
import { WristbandQRCode, generateWristbandQRCodeDataUrl } from "../components/WristbandQRCode.js";
import { buildAcessoRapidoPosterHtml, printContract } from "../contract/contractTemplate.js";
import { money } from "../format.js";
import { AutoUpdateCard } from "../components/AutoUpdateCard.js";
import { SideTabs, type SideTabGroup } from "../components/SideTabs.js";
import { DESKTOP_POINTER_QUERY, useMediaQuery } from "../hooks/useMediaQuery.js";
import { getPublicAppUrl } from "../lib/appUrl.js";
import { Emoji3D, renderEmoji } from "../components/Emoji3D.js";

type Tab =
  | "PLANOS"
  | "PACOTES"
  | "PRODUTOS"
  | "CUPONS"
  | "FIDELIDADE"
  | "FROTA"
  | "UNIDADE"
  | "FISCAL"
  | "TERMOS"
  | "IMPRESSORAS"
  | "NOTIFICACOES";

/**
 * Capacidade exigida por aba. Assim como em auth/screens.ts, o
 * `Record<Tab, Capability>` faz o build quebrar se uma aba nova nascer sem
 * declarar o que exige — o modo de falha natural seria ela nascer aberta.
 *
 * Todas exigem no mínimo `config.write` (Owner); as de baixo têm capacidade
 * própria porque o dano de errar nelas é de outra natureza: dado fiscal e o
 * texto que o responsável aceita.
 *
 * Cadastro de colaborador (antes "COLABORADORES" aqui) mudou de lugar: vive
 * só no módulo Gerencial agora, porque um colaborador não pertence a uma
 * unidade só — é lá que se escolhe em qual(is) ele atua.
 */
const TAB_CAPABILITY: Record<Tab, Capability> = {
  PLANOS: "config.write",
  PACOTES: "config.write",
  PRODUTOS: "config.write",
  CUPONS: "config.write",
  FIDELIDADE: "config.write",
  FROTA: "config.write",
  IMPRESSORAS: "config.write",
  UNIDADE: "config.unit.write",
  FISCAL: "config.fiscal.write",
  TERMOS: "config.terms.write",
  NOTIFICACOES: "notificacoes.owner_push",
};

/**
 * Agrupamento do menu lateral (desktop). O `Record<Tab, …>` quebra o build se
 * uma aba nova nascer sem grupo, em vez de sumir do menu em silêncio.
 */
const TAB_GROUP: Record<Tab, string> = {
  PLANOS: "Catálogo e vendas",
  PACOTES: "Catálogo e vendas",
  PRODUTOS: "Catálogo e vendas",
  CUPONS: "Catálogo e vendas",
  FIDELIDADE: "Catálogo e vendas",
  FROTA: "Catálogo e vendas",
  UNIDADE: "Operação",
  IMPRESSORAS: "Operação",
  NOTIFICACOES: "Operação",
  FISCAL: "Fiscal e legal",
  TERMOS: "Fiscal e legal",
};
const GROUP_ORDER = ["Catálogo e vendas", "Operação", "Fiscal e legal"];

export function ConfiguracoesScreen() {
  const { unit } = useAppState();
  const { can } = useAuth();
  const isQuiosque = unit?.kind === "QUIOSQUE";
  const [tab, setTab] = useState<Tab>("PLANOS");
  const desktop = useMediaQuery(DESKTOP_POINTER_QUERY);

  if (!unit) return null;

  const allTabs: { value: Tab; label: string }[] = [
    { value: "PLANOS", label: "Planos de Preços" },
    { value: "PACOTES", label: "Pacotes" },
    { value: "PRODUTOS", label: "Produtos" },
    { value: "CUPONS", label: "Cupons" },
    { value: "FIDELIDADE", label: "Fidelidade" },
    ...(isQuiosque ? ([{ value: "FROTA" as const, label: "Frota" }]) : []),
    { value: "UNIDADE", label: "Unidade" },
    { value: "FISCAL", label: "Dados Fiscais" },
    { value: "TERMOS", label: "Termos de Uso" },
    { value: "IMPRESSORAS", label: "Impressoras" },
    { value: "NOTIFICACOES", label: "Notificações" },
  ];
  const tabs = allTabs.filter((t) => can(TAB_CAPABILITY[t.value]));

  const TAB_HELP: Record<Tab, string> = {
    PLANOS: "Cadastre os planos de permanência que aparecem na tela de Entrada — nome, preço, duração e o que cobrar se passar do tempo.",
    PACOTES:
      "Pacotes de horas oferecidos como upgrade ao cliente VIP no check-in. Quem escolhe qual oferecer é o sistema: o pacote de valor imediatamente acima do que a família já gastou no mês, e só se ele baixar o custo por hora dela.",
    PRODUTOS: "Cadastre os itens vendidos avulsos no PDV (loja/lanchonete) e o estoque disponível de cada um.",
    CUPONS: "Crie códigos de desconto ou parceria que o operador pode aplicar na tela de Entrada.",
    FIDELIDADE: "Defina recompensas automáticas para clientes recorrentes — ex.: a cada 10 visitas registradas pelo CPF do responsável, a 10ª entrada de 30 minutos é 100% gratuita (Playground e Circuito).",
    FROTA: "Cadastre os carrinhos do Circuito (nome, cor, emoji e foto) e marque quando um estiver em manutenção.",
    UNIDADE: "Dados da unidade: nome, fuso, virada do dia operacional e o que aparece no cabeçalho do cupom.",
    FISCAL: "Dados do emitente para NFC-e (produtos) e o cadastro de NFS-e (serviço). Confira com seu contador antes de ligar a emissão.",
    TERMOS: "Texto que o responsável aceita no check-in. Alterações ficam registradas na trilha de auditoria.",
    IMPRESSORAS: "Escolha a unidade deste computador e as impressoras instaladas nele.",
    NOTIFICACOES: "Ative para receber no seu celular/computador os relatórios automáticos de abertura, acompanhamento (17h e 20h) e fechamento de caixa desta unidade.",
  };

  const groups: SideTabGroup<Tab>[] = GROUP_ORDER.map((label) => ({
    label,
    tabs: tabs.filter((t) => TAB_GROUP[t.value] === label),
  })).filter((g) => g.tabs.length > 0);

  // Mesmo painel nos dois layouts: só muda o menu (lateral no desktop com
  // mouse, barra de abas no resto).
  const panel = (
    <>
      {/* Cada painel é guardado individualmente, e não só a tela inteira: as
          abas têm capacidades diferentes entre si, e o estado `tab` sobrevive
          a uma troca de colaborador no terminal. */}
      <div role="tabpanel">
        <RequireCapability capability={TAB_CAPABILITY[tab]}>
          {tab === "PLANOS" && <PlanosTab unitId={unit.id} activity={isQuiosque ? "CARRINHO" : "PLAYGROUND"} />}
          {tab === "PACOTES" && <PacotesTab unitId={unit.id} activity={isQuiosque ? "CARRINHO" : "PLAYGROUND"} />}
          {tab === "PRODUTOS" && <ProdutosTab unitId={unit.id} />}
          {tab === "CUPONS" && <CuponsTab unitId={unit.id} />}
          {tab === "FIDELIDADE" && <FidelidadeTab unitId={unit.id} isQuiosque={isQuiosque} />}
          {tab === "FROTA" && isQuiosque && <FrotaTab unitId={unit.id} />}
          {tab === "UNIDADE" && <UnidadeTab unitId={unit.id} />}
          {tab === "FISCAL" && <FiscalTab unitId={unit.id} />}
          {tab === "TERMOS" && <TermosTab unitId={unit.id} />}
          {tab === "IMPRESSORAS" && <ImpressorasTab unitId={unit.id} />}
          {tab === "NOTIFICACOES" && <NotificacoesTab />}
        </RequireCapability>
      </div>
    </>
  );

  return (
    <div style={{ padding: "24px", maxWidth: desktop ? "1280px" : "900px", margin: "0 auto" }}>
      <h1 style={{ fontFamily: "var(--font-display)" }}>Configurações</h1>
      <HelpText>Ajustes da operação — o que é cadastrado aqui aparece depois nas outras telas do sistema.</HelpText>
      {desktop ? (
        <div className="config-body">
          <SideTabs value={tab} onChange={setTab} groups={groups} label="Seções de configurações" />
          <div className="config-content">
            <HelpText style={{ margin: "0 0 12px" }}>{TAB_HELP[tab]}</HelpText>
            {panel}
          </div>
        </div>
      ) : (
        <>
          <Tabs value={tab} onChange={setTab} tabs={tabs} />
          <HelpText style={{ margin: "12px 0" }}>{TAB_HELP[tab]}</HelpText>
          {panel}
        </>
      )}
    </div>
  );
}

/**
 * Ativa/desativa Web Push neste dispositivo para as rotinas automáticas
 * de relatório do Owner (abertura, acompanhamento 17h/20h, fechamento —
 * ver 20260818000001_fa_kiosk_owner_reports.sql). Reaproveita a mesma
 * função subscribeToPush() já usada no painel do responsável
 * (AcompanharScreen); aqui o endpoint é vinculado ao colaborador logado
 * em vez de a uma sessão de criança.
 */
function NotificacoesTab() {
  const toast = useToast();
  const [supported] = useState(isPushSupported());
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!supported) return;

    const locallyEnabled = localStorage.getItem(OWNER_PUSH_STORAGE_KEY) === "true";

    try {
      const existing = await getExistingPushSubscription();
      let keys = existing ? pushSubscriptionToKeys(existing) : null;

      // Se ativado localmente e permissão concedida, mas a inscrição push expirou ou perdeu do SW, tenta renovar
      if (!keys && locallyEnabled && "Notification" in window && Notification.permission === "granted") {
        try {
          const newSub = await subscribeToPush();
          keys = newSub ? pushSubscriptionToKeys(newSub) : null;
        } catch {
          // ignora erro de auto-renovação silenciosa em segundo plano
        }
      }

      if (!keys) {
        setSubscribed(false);
        return;
      }

      const isSubscribedOnServer = await Api.ownerPushIsSubscribed(keys.endpoint).catch(() => false);

      if (isSubscribedOnServer) {
        setSubscribed(true);
        localStorage.setItem(OWNER_PUSH_STORAGE_KEY, "true");
      } else if (locallyEnabled) {
        // Se ativado localmente mas perdeu no servidor (ex: troca de sessão), re-cadastra
        await Api.ownerPushSubscribe(keys.endpoint, keys.p256dh, keys.auth).catch(() => {});
        setSubscribed(true);
        localStorage.setItem(OWNER_PUSH_STORAGE_KEY, "true");
      } else {
        setSubscribed(false);
      }
    } catch {
      setSubscribed(locallyEnabled);
    }
  }
  useEffect(() => {
    refresh();
  }, [supported]);

  async function ativar() {
    setBusy(true);
    try {
      const sub = await subscribeToPush();
      const keys = sub ? pushSubscriptionToKeys(sub) : null;
      if (!keys) {
        toast.error("Não foi possível ativar notificações neste dispositivo/navegador.");
        return;
      }
      await Api.ownerPushSubscribe(keys.endpoint, keys.p256dh, keys.auth);
      localStorage.setItem(OWNER_PUSH_STORAGE_KEY, "true");
      toast.success("Notificações ativadas neste dispositivo.");
      setSubscribed(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível ativar notificações.");
    } finally {
      setBusy(false);
    }
  }

  async function desativar() {
    setBusy(true);
    try {
      const existing = await getExistingPushSubscription();
      const keys = existing ? pushSubscriptionToKeys(existing) : null;
      if (keys) await Api.ownerPushUnsubscribe(keys.endpoint);
      localStorage.removeItem(OWNER_PUSH_STORAGE_KEY);
      toast.success("Notificações desativadas neste dispositivo.");
      setSubscribed(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível desativar notificações.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
      <h2>Relatórios automáticos por notificação</h2>
      <HelpText>
        Com isto ativado, este dispositivo (exclusivo para perfil Owner) recebe automaticamente: <strong>Abertura de unidade</strong> (ao abrir o caixa),{" "}
        <strong>Visão Geral Diária às 17h e 20h</strong> (meta, faturamento do dia, total de sessões/locações e ticket médio) e{" "}
        <strong>Fechamento</strong> (faturamento total, meta do dia, quantidade de sessões/locações, fundo de caixa e valor em envelope).
      </HelpText>
      {!supported ? (
        <Tag color="var(--color-orange, #FF7A00)">
          Este navegador/dispositivo não suporta notificações push (no Electron local, ou fora do modo instalado no iOS,
          isso é esperado).
        </Tag>
      ) : subscribed === null ? (
        <Tag color="var(--color-neutral-500, #888888)">Verificando estado das notificações...</Tag>
      ) : subscribed ? (
        <>
          <Tag color="var(--color-teal, #2ECFB5)">Ativado neste dispositivo</Tag>
          <Button variant="secondary" disabled={busy} onClick={desativar}>
            Desativar neste dispositivo
          </Button>
        </>
      ) : (
        <Button variant="primary" disabled={busy} onClick={ativar}>
          Ativar neste dispositivo
        </Button>
      )}
    </Card>
  );
}



// Nome de cada hex da paleta — os seletores de cor (plano e carrinho)
// eram 6 botões redondos sem nenhum nome: nem aria-label, nem title, só
// a cor de fundo. Sem isso um leitor de tela anuncia "botão", 6 vezes
// seguidas, sem dizer qual é qual.
const COLOR_NAMES: Record<string, string> = {
  "#2ECFB5": "Teal",
  "#F0196B": "Rosa",
  "#FFE234": "Amarelo",
  "#FF7A00": "Laranja",
  "#A020EE": "Roxo",
  "#1A3F35": "Verde-escuro",
};

const PLAN_COLOR_OPTIONS = ["#2ECFB5", "#F0196B", "#FFE234", "#FF7A00", "#A020EE", "#1A3F35"];

function PlanosTab({ unitId, activity }: { unitId: string; activity: "PLAYGROUND" | "CARRINHO" }) {
  const toast = useToast();
  const { employee } = useAppState();
  const isOwner = employee?.role === "ADMIN";
  
  const [plans, setPlans] = useState<Plan[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  
  const [name, setName] = useState("");
  const [valueReais, setValueReais] = useState("0");
  const [durationValue, setDurationValue] = useState("15");
  const [durationUnit, setDurationUnit] = useState<"MINUTO" | "HORA">("MINUTO");
  const [overageReais, setOverageReais] = useState("1");
  const [color, setColor] = useState(PLAN_COLOR_OPTIONS[0]!);
  const [busy, setBusy] = useState(false);

  function load() {
    Api.plans(unitId, activity, false).then(setPlans);
  }
  useEffect(load, [unitId, activity]);

  function startEdit(p: Plan) {
    setEditingId(p.id);
    setName(p.name);
    setValueReais((p.valueCents / 100).toFixed(2));
    setDurationValue(String(p.durationValue));
    setDurationUnit(p.durationUnit);
    setOverageReais((p.overageCentsPerMinute / 100).toFixed(2));
    setColor(p.color);
  }

  function cancelEdit() {
    setEditingId(null);
    setName("");
    setValueReais("0");
    setDurationValue("15");
    setDurationUnit("MINUTO");
    setOverageReais("1");
    setColor(PLAN_COLOR_OPTIONS[0]!);
  }

  async function save() {
    setBusy(true);
    try {
      const payload = {
        name,
        valueCents: Math.round(Number(valueReais) * 100),
        durationValue: Number(durationValue),
        durationUnit,
        overageCentsPerMinute: Math.round(Number(overageReais) * 100),
        color,
      };

      if (editingId) {
        await Api.updatePlan(editingId, payload);
        toast.success("Plano atualizado.");
      } else {
        await Api.createPlan({ unitId, activity, ...payload });
        toast.success("Plano criado.");
      }
      cancelEdit();
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar o plano.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleActive(p: Plan) {
    if (!window.confirm(`Deseja realmente ${p.active ? "inativar/excluir" : "reativar"} o plano "${p.name}"?`)) return;
    setBusy(true);
    try {
      await Api.setPlanActive(p.id, !p.active);
      toast.success(p.active ? "Plano removido com sucesso." : "Plano reativado.");
      load();
    } catch (err) {
      toast.error("Erro ao alterar o plano.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Card style={{ padding: "16px", marginBottom: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: "0 0 4px" }}>
            {editingId ? "Editar plano" : "Novo plano"}
          </h2>
          {editingId && (
            <Button variant="secondary" onClick={cancelEdit} disabled={busy}>
              Cancelar Edição
            </Button>
          )}
        </div>
        <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="Valor (R$)" type="number" value={valueReais} onChange={(e) => setValueReais(e.target.value)} />
        <div style={{ display: "flex", gap: "8px" }}>
          <Input label="Duração" type="number" value={durationValue} onChange={(e) => setDurationValue(e.target.value)} />
          <Select label="Unidade" value={durationUnit} onChange={(e) => setDurationUnit(e.target.value as "MINUTO" | "HORA")}>
            <option value="MINUTO">minuto(s)</option>
            <option value="HORA">hora(s)</option>
          </Select>
        </div>
        <Input
          label="Excedente por minuto (R$)"
          type="number"
          value={overageReais}
          onChange={(e) => setOverageReais(e.target.value)}
          title="Valor cobrado por minuto quando a criança fica no espaço além da duração do plano"
        />
        <div>
          <label>Cor no Painel</label>
          <div style={{ display: "flex", gap: "4px" }}>
            {PLAN_COLOR_OPTIONS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Cor ${COLOR_NAMES[c] ?? c}`}
                aria-pressed={color === c}
                title={COLOR_NAMES[c] ?? c}
                style={{ width: "28px", height: "28px", borderRadius: "50%", background: c, border: color === c ? "3px solid var(--color-dark)" : "1px solid var(--border-subtle)" }}
              />
            ))}
          </div>
        </div>
        <Button variant="primary" disabled={busy || !name} onClick={save}>
          {editingId ? "Salvar plano" : "Criar plano"}
        </Button>
      </Card>

      {plans.map((p) => (
        <Card key={p.id} style={{ padding: "12px", marginBottom: "8px", display: "flex", justifyContent: "space-between", alignItems: "center", opacity: p.active ? 1 : 0.5 }}>
          <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ width: "14px", height: "14px", borderRadius: "50%", background: p.color, display: "inline-block" }} />
            {p.name} — {p.durationValue} {p.durationUnit.toLowerCase()}
            {p.birthdayCourtesy && <Tag color="var(--color-teal)">Cortesia de aniversário</Tag>}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span>
              {money(p.valueCents)} + {money(p.overageCentsPerMinute)}/min excedente
            </span>
            <Button variant="secondary" onClick={() => startEdit(p)} disabled={busy}>
              Editar
            </Button>
            {p.birthdayCourtesy ? null : p.active ? (
              <Button variant="secondary" style={isOwner ? { color: "#d32f2f", borderColor: "#d32f2f" } : undefined} onClick={() => handleToggleActive(p)} disabled={busy}>
                {isOwner ? "Excluir" : "Inativar"}
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => handleToggleActive(p)} disabled={busy}>
                Reativar
              </Button>
            )}
          </span>
        </Card>
      ))}
    </div>
  );
}

/**
 * Pacotes de horas + calibragem do motor de cross-selling.
 *
 * As duas coisas moram na mesma aba porque são a mesma decisão: um
 * pacote só existe para ser oferecido, e o limiar de quem recebe a
 * oferta é o outro lado da mesma moeda. Separá-los faria o Owner
 * cadastrar preços numa tela e descobrir noutra por que ninguém está
 * vendo a oferta.
 */
function PacotesTab({ unitId, activity }: { unitId: string; activity: "PLAYGROUND" | "CARRINHO" }) {
  const toast = useToast();
  const { employee } = useAppState();
  const isOwner = employee?.role === "ADMIN";

  const [packages, setPackages] = useState<Package[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [priceReais, setPriceReais] = useState("0");
  const [includedHours, setIncludedHours] = useState("10");
  const [validityDays, setValidityDays] = useState("30");
  const [benefitText, setBenefitText] = useState("");
  const [color, setColor] = useState("#FF7A00");
  const [overageReais, setOverageReais] = useState("0");
  const [busy, setBusy] = useState(false);

  const [vipVisits, setVipVisits] = useState("4");
  const [windowDays, setWindowDays] = useState("30");
  const [cooldownDays, setCooldownDays] = useState("15");
  const [savingRules, setSavingRules] = useState(false);

  function load() {
    Api.packages(unitId, activity, false).then(setPackages).catch(() => {});
  }
  useEffect(load, [unitId]);

  useEffect(() => {
    Api.unitSetting(unitId, "upsell_vip_visits").then((r) => setVipVisits(r.value ?? "4")).catch(() => {});
    Api.unitSetting(unitId, "upsell_vip_window_days").then((r) => setWindowDays(r.value ?? "30")).catch(() => {});
    Api.unitSetting(unitId, "upsell_cooldown_days").then((r) => setCooldownDays(r.value ?? "15")).catch(() => {});
  }, [unitId]);

  const priceCents = Math.round(Number(priceReais) * 100);
  const includedMinutes = Math.round(Number(includedHours) * 60);
  // Prévia do custo/hora enquanto o Owner digita: é o número que decide se
  // o pacote chega a ser oferecido (o motor só propõe pacote que BAIXA o
  // custo/hora do cliente). Sem a prévia, um pacote caro demais é
  // cadastrado, some da tela e ninguém entende o porquê.
  const hourlyCents = includedMinutes > 0 ? Math.round((priceCents * 60) / includedMinutes) : 0;

  function startEdit(p: Package) {
    setEditingId(p.id);
    setName(p.name);
    setPriceReais((p.priceCents / 100).toFixed(2));
    setIncludedHours(String(p.includedMinutes / 60));
    setValidityDays(String(p.validityDays));
    setBenefitText(p.benefitText);
    setColor(p.color);
    setOverageReais((p.overageCentsPerMinute / 100).toFixed(2));
  }

  function cancelEdit() {
    setEditingId(null);
    setName("");
    setPriceReais("0");
    setIncludedHours("10");
    setValidityDays("30");
    setBenefitText("");
    setColor("#FF7A00");
    setOverageReais("0");
  }

  async function save() {
    setBusy(true);
    try {
      const payload = {
        name,
        priceCents,
        includedMinutes,
        validityDays: Math.max(1, Math.round(Number(validityDays))),
        benefitText: benefitText.trim(),
        color,
        overageCentsPerMinute: Math.round(Number(overageReais) * 100),
      };

      if (editingId) {
        await Api.updatePackage(editingId, payload);
        toast.success("Pacote atualizado.");
      } else {
        await Api.createPackage({ unitId, activity, ...payload });
        toast.success("Pacote criado.");
      }
      cancelEdit();
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar o pacote.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleActive(pkg: Package) {
    if (!window.confirm(`Deseja realmente ${pkg.active ? "inativar/excluir" : "reativar"} o pacote "${pkg.name}"?`)) return;
    try {
      await Api.setPackageActive(pkg.id, !pkg.active);
      toast.success(pkg.active ? "Pacote removido com sucesso." : "Pacote reativado.");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível alterar o pacote.");
    }
  }

  async function saveRules() {
    setSavingRules(true);
    try {
      await Promise.all([
        Api.setUnitSetting(unitId, "upsell_vip_visits", String(Math.max(1, Math.round(Number(vipVisits))))),
        Api.setUnitSetting(unitId, "upsell_vip_window_days", String(Math.max(1, Math.round(Number(windowDays))))),
        Api.setUnitSetting(unitId, "upsell_cooldown_days", String(Math.max(0, Math.round(Number(cooldownDays))))),
      ]);
      toast.success("Regras do motor VIP salvas.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar as regras.");
    } finally {
      setSavingRules(false);
    }
  }

  const canCreate = Boolean(name.trim()) && Boolean(benefitText.trim()) && priceCents > 0 && includedMinutes > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>{editingId ? "Editar pacote" : "Novo pacote"}</h2>
          {editingId && (
            <Button variant="secondary" onClick={cancelEdit} disabled={busy}>
              Cancelar Edição
            </Button>
          )}
        </div>
        <HelpText>
          O valor cheio é a âncora: o cliente paga só a diferença entre ele e o que já gastou no mês. O benefício é lido
          em voz alta pelo operador, então escreva a frase exata — ex.: “2 horas extras e um lanche”.
        </HelpText>
        <Input label="Nome do pacote" placeholder="Ex.: Pacote Amigo 10h" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          label="Valor de tabela (R$)"
          type="number"
          value={priceReais}
          onChange={(e) => setPriceReais(e.target.value)}
          title="Preço cheio do pacote — é contra ele que o gasto do mês do cliente é comparado"
        />
        <Input
          label="Horas incluídas"
          type="number"
          step="0.5"
          value={includedHours}
          onChange={(e) => setIncludedHours(e.target.value)}
          title="Total de horas de brincadeira que o pacote dá"
        />
        <Input
          label="Validade (dias)"
          type="number"
          value={validityDays}
          onChange={(e) => setValidityDays(e.target.value)}
          title="Por quantos dias o saldo de horas continua valendo depois da compra"
        />
        <Input
          label="Excedente por minuto (R$)"
          type="number"
          value={overageReais}
          onChange={(e) => setOverageReais(e.target.value)}
          title="Valor cobrado por minuto além do incluído, quando o pacote é usado direto na Entrada"
        />
        <Input
          label="Benefício (frase do script de venda)"
          placeholder="Ex.: 2 horas extras e um lanche por visita"
          value={benefitText}
          onChange={(e) => setBenefitText(e.target.value)}
        />
        <div>
          <label>Cor do pacote</label>
          <div style={{ display: "flex", gap: "4px" }}>
            {PLAN_COLOR_OPTIONS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Cor ${COLOR_NAMES[c] ?? c}`}
                aria-pressed={color === c}
                title={COLOR_NAMES[c] ?? c}
                style={{ width: "28px", height: "28px", borderRadius: "50%", background: c, border: color === c ? "3px solid var(--color-dark)" : "1px solid var(--border-subtle)" }}
              />
            ))}
          </div>
        </div>
        {includedMinutes > 0 && priceCents > 0 && (
          <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            Custo por hora deste pacote: <strong>{money(hourlyCents)}</strong> — ele só será oferecido a quem hoje paga
            mais do que isso por hora.
          </div>
        )}
        <Button variant="primary" disabled={busy || !canCreate} onClick={save}>
          {editingId ? "Salvar pacote" : "Criar pacote"}
        </Button>
      </Card>

      {packages.map((p) => {
        const hourly = Math.round((p.priceCents * 60) / p.includedMinutes);
        return (
          <Card
            key={p.id}
            style={{ padding: "12px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", opacity: p.active ? 1 : 0.5 }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
              <span style={{ width: "14px", height: "14px", borderRadius: "50%", background: p.color, display: "inline-block", flexShrink: 0 }} />
              <span>
                <strong>{p.name}</strong>
                <br />
                <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  {(p.includedMinutes / 60).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} h · {p.validityDays} dias ·{" "}
                  {p.benefitText}
                </span>
              </span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
              <span style={{ textAlign: "right" }}>
                <strong>{money(p.priceCents)}</strong>
                <br />
                <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{money(hourly)}/h</span>
              </span>
              <Button variant="secondary" onClick={() => startEdit(p)} disabled={busy}>
                Editar
              </Button>
              {p.active ? (
                <Button variant="secondary" style={isOwner ? { color: "#d32f2f", borderColor: "#d32f2f" } : undefined} onClick={() => handleToggleActive(p)} disabled={busy}>
                  {isOwner ? "Excluir" : "Inativar"}
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => handleToggleActive(p)} disabled={busy}>
                  Reativar
                </Button>
              )}
            </span>
          </Card>
        );
      })}

      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
        <h2>Regras do motor VIP</h2>
        <HelpText>
          Quem recebe a oferta e por quanto tempo ela para de aparecer depois de uma recusa. O padrão é 4 visitas em 30
          dias e 15 dias de espera.
        </HelpText>
        <Input
          label="Visitas para virar VIP"
          type="number"
          value={vipVisits}
          onChange={(e) => setVipVisits(e.target.value)}
          title="Número de check-ins dentro da janela que faz a criança receber o selo VIP e a oferta"
        />
        <Input
          label="Janela de contagem (dias)"
          type="number"
          value={windowDays}
          onChange={(e) => setWindowDays(e.target.value)}
          title="Período móvel em que as visitas são contadas — 30 dias significa 'nos últimos 30 dias', não 'neste mês'"
        />
        <Input
          label="Espera após recusa (dias)"
          type="number"
          value={cooldownDays}
          onChange={(e) => setCooldownDays(e.target.value)}
          title="Quantos dias a oferta fica bloqueada para o responsável que recusou"
        />
        <Button variant="primary" disabled={savingRules} onClick={saveRules}>
          Salvar regras
        </Button>
      </Card>

      <QuickUpsellCard unitId={unitId} />
    </div>
  );
}

/**
 * Cross-sell rápido de item único (ex.: "Água") — diferente do motor de
 * pacotes acima: sem script nem ancoragem, é só "oferecer X por R$Y" ao
 * escolher um plano longo o bastante na Entrada. O produto ofertado é
 * qualquer um já cadastrado em Produtos; sem produto escolhido aqui, o
 * gatilho simplesmente não aparece no balcão.
 */
function QuickUpsellCard({ unitId }: { unitId: string }) {
  const toast = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [triggerMinutes, setTriggerMinutes] = useState("60");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Api.products(unitId).then(setProducts).catch(() => {});
    Api.unitSetting(unitId, "upsell_quick_product_id").then((r) => setProductId(r.value ?? "")).catch(() => {});
    Api.unitSetting(unitId, "upsell_quick_trigger_minutes").then((r) => setTriggerMinutes(r.value ?? "60")).catch(() => {});
  }, [unitId]);

  async function save() {
    setSaving(true);
    try {
      await Promise.all([
        Api.setUnitSetting(unitId, "upsell_quick_product_id", productId),
        Api.setUnitSetting(unitId, "upsell_quick_trigger_minutes", String(Math.max(1, Math.round(Number(triggerMinutes))))),
      ]);
      toast.success("Cross-sell rápido salvo.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <h2>Cross-sell rápido</h2>
      <HelpText>
        Ao escolher um plano com pelo menos os minutos configurados abaixo, a Entrada oferece este produto para
        adicionar direto na comanda da criança — cobrado junto no fechamento.
      </HelpText>
      <Select label="Produto oferecido" value={productId} onChange={(e) => setProductId(e.target.value)}>
        <option value="">Nenhum (gatilho desligado)</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} — {money(p.price_cents)}
          </option>
        ))}
      </Select>
      <Input
        label="A partir de quantos minutos de plano"
        type="number"
        value={triggerMinutes}
        onChange={(e) => setTriggerMinutes(e.target.value)}
        title="Planos com duração igual ou maior a este valor mostram o gatilho de oferta"
      />
      <Button variant="primary" disabled={saving} onClick={save}>
        Salvar
      </Button>
    </Card>
  );
}

function ProdutosTab({ unitId }: { unitId: string }) {
  const toast = useToast();
  const { employee } = useAppState();
  const isOwner = employee?.role === "ADMIN";

  const [products, setProducts] = useState<Product[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [priceReais, setPriceReais] = useState("0");
  const [stock, setStock] = useState("0");
  const [emoji, setEmoji] = useState("🛍️");
  const [busy, setBusy] = useState(false);

  function load() {
    Api.products(unitId, false).then(setProducts);
  }
  useEffect(load, [unitId]);

  function startEdit(p: Product) {
    setEditingId(p.id);
    setName(p.name);
    setPriceReais((p.price_cents / 100).toFixed(2));
    setStock(String(p.stock));
    setEmoji(p.emoji ?? "🛍️");
  }

  function cancelEdit() {
    setEditingId(null);
    setName("");
    setPriceReais("0");
    setStock("0");
    setEmoji("🛍️");
  }

  async function save() {
    setBusy(true);
    try {
      const payload = {
        name,
        emoji,
        priceCents: Math.round(Number(priceReais) * 100),
        stock: Number(stock),
      };
      
      if (editingId) {
        await Api.updateProduct(editingId, payload);
        toast.success("Produto atualizado.");
      } else {
        await Api.createProduct({ unitId, ...payload });
        toast.success("Produto criado.");
      }
      cancelEdit();
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar o produto.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleActive(p: Product) {
    if (!window.confirm(`Deseja realmente ${p.active ? "inativar/excluir" : "reativar"} o produto "${p.name}"?`)) return;
    try {
      await Api.setProductActive(p.id, !p.active);
      toast.success(p.active ? "Produto removido com sucesso." : "Produto reativado.");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível alterar o produto.");
    }
  }

  return (
    <div>
      <Card style={{ padding: "16px", marginBottom: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: "0 0 4px" }}>
            {editingId ? "Editar produto" : "Novo produto"}
          </h2>
          {editingId && (
            <Button variant="secondary" onClick={cancelEdit} disabled={busy}>
              Cancelar Edição
            </Button>
          )}
        </div>
        <Input label="Emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} />
        <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="Preço (R$)" type="number" value={priceReais} onChange={(e) => setPriceReais(e.target.value)} />
        <Input label="Estoque" type="number" value={stock} onChange={(e) => setStock(e.target.value)} />
        <Button variant="primary" disabled={busy || !name} onClick={save}>
          {editingId ? "Salvar produto" : "Criar produto"}
        </Button>
      </Card>
      {products.map((p) => (
        <Card key={p.id} style={{ padding: "12px", marginBottom: "8px", display: "flex", justifyContent: "space-between", alignItems: "center", opacity: p.active ? 1 : 0.5 }}>
          <span>
            {renderEmoji(p.emoji)} {p.name}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span>
              {money(p.price_cents)} — {p.stock} un.
            </span>
            <Button variant="secondary" onClick={() => startEdit(p)} disabled={busy}>
              Editar
            </Button>
            {p.active ? (
              <Button variant="secondary" style={isOwner ? { color: "#d32f2f", borderColor: "#d32f2f" } : undefined} onClick={() => handleToggleActive(p)} disabled={busy}>
                {isOwner ? "Excluir" : "Inativar"}
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => handleToggleActive(p)} disabled={busy}>
                Reativar
              </Button>
            )}
          </span>
        </Card>
      ))}
    </div>
  );
}

function CuponsTab({ unitId }: { unitId: string }) {
  const toast = useToast();
  const { employee } = useAppState();
  const isOwner = employee?.role === "ADMIN";

  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [kind, setKind] = useState<Coupon["kind"]>("MINUTOS_EXTRA");
  const [value, setValue] = useState("10");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    Api.coupons(unitId).then((list) => setCoupons(list.filter((c) => !isWifiClinicCoupon(c.code))));
  }
  useEffect(load, [unitId]);

  function startEdit(c: Coupon) {
    setEditingId(c.id);
    setCode(c.code);
    setKind(c.kind);
    setValue(String(c.value));
    setDescription(c.description ?? "");
  }

  function cancelEdit() {
    setEditingId(null);
    setCode("");
    setKind("MINUTOS_EXTRA");
    setValue("10");
    setDescription("");
  }

  async function save() {
    setBusy(true);
    try {
      const payload = {
        code,
        kind,
        value: Number(value),
        description: description || undefined,
      };

      if (editingId) {
        await Api.updateCoupon(editingId, payload);
        toast.success("Cupom atualizado.");
      } else {
        await Api.createCoupon({ unitId, ...payload });
        toast.success("Cupom criado.");
      }
      cancelEdit();
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar o cupom.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleActive(c: Coupon) {
    if (!window.confirm(`Deseja realmente ${c.active ? "inativar/excluir" : "reativar"} o cupom "${c.code}"?`)) return;
    try {
      await Api.setCouponActive(c.id, !c.active);
      toast.success(c.active ? "Cupom removido com sucesso." : "Cupom reativado.");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível alterar o cupom.");
    }
  }

  return (
    <div>
      <Card style={{ padding: "16px", marginBottom: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: "0 0 4px" }}>
            {editingId ? "Editar cupom" : "Novo cupom"}
          </h2>
          {editingId && (
            <Button variant="secondary" onClick={cancelEdit} disabled={busy}>
              Cancelar Edição
            </Button>
          )}
        </div>
        <Input label="Código" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <Select label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as Coupon["kind"])}>
          <option value="MINUTOS_EXTRA">Minutos extras</option>
          <option value="DESCONTO_PCT">Desconto %</option>
          <option value="DESCONTO_VALOR">Desconto em R$</option>
        </Select>
        <Input label="Valor" type="number" value={value} onChange={(e) => setValue(e.target.value)} />
        <Input label="Descrição" value={description} onChange={(e) => setDescription(e.target.value)} />
        <Button variant="primary" disabled={busy || !code} onClick={save}>
          {editingId ? "Salvar cupom" : "Criar cupom"}
        </Button>
      </Card>
      {coupons.map((c) => (
        <Card key={c.id} style={{ padding: "12px", marginBottom: "8px", display: "flex", justifyContent: "space-between", alignItems: "center", opacity: c.active ? 1 : 0.5 }}>
          <span>
            <strong>{c.code}</strong> — {c.kind} ({c.value}) — usado {c.used_count}× {c.description ? `— ${c.description}` : ""}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <Button variant="secondary" onClick={() => startEdit(c)} disabled={busy}>
              Editar
            </Button>
            {c.active ? (
              <Button variant="secondary" style={isOwner ? { color: "#d32f2f", borderColor: "#d32f2f" } : undefined} onClick={() => handleToggleActive(c)} disabled={busy}>
                {isOwner ? "Excluir" : "Inativar"}
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => handleToggleActive(c)} disabled={busy}>
                Reativar
              </Button>
            )}
          </span>
        </Card>
      ))}
    </div>
  );
}

function FidelidadeTab({ unitId, isQuiosque }: { unitId: string; isQuiosque: boolean }) {
  const toast = useToast();
  const [rules, setRules] = useState<LoyaltyRule[]>([]);
  const [triggerVisits, setTriggerVisits] = useState("10");
  const [rewardKind, setRewardKind] = useState<LoyaltyRule["rewardKind"]>("ENTRADA_GRATIS");
  const [rewardValue, setRewardValue] = useState("1");
  const [busy, setBusy] = useState(false);

  function load() {
    Api.loyaltyRules(unitId).then(setRules);
  }
  useEffect(load, [unitId]);

  async function create() {
    setBusy(true);
    try {
      await Api.createLoyaltyRule({
        unitId,
        activity: isQuiosque ? "CARRINHO" : "PLAYGROUND",
        triggerVisits: Number(triggerVisits),
        rewardKind,
        rewardValue: Number(rewardValue),
      });
      load();
      toast.success("Regra de fidelidade criada.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível criar a regra de fidelidade.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Card style={{ padding: "16px", marginBottom: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: "0 0 4px" }}>Nova regra</h2>
        <Input label="A cada X visitas" type="number" value={triggerVisits} onChange={(e) => setTriggerVisits(e.target.value)} />
        <Select label="Recompensa" value={rewardKind} onChange={(e) => setRewardKind(e.target.value as LoyaltyRule["rewardKind"])}>
          <option value="ENTRADA_GRATIS">Entrada grátis</option>
          <option value="DESCONTO_PCT">Desconto %</option>
          <option value="MINUTOS_EXTRA">Minutos extras</option>
        </Select>
        <Input label="Valor" type="number" value={rewardValue} onChange={(e) => setRewardValue(e.target.value)} />
        <Button variant="primary" disabled={busy} onClick={create}>
          Criar regra
        </Button>
      </Card>
      {rules.map((r) => (
        <Card key={r.id} style={{ padding: "12px", marginBottom: "8px" }}>
          A cada {r.triggerVisits} visitas ({r.activity}) → {r.rewardKind} ({r.rewardValue})
        </Card>
      ))}
    </div>
  );
}

const CART_EMOJI_OPTIONS = ["🚙", "🚗", "🏎️", "🏍️", "🏁", "🚜", "🛺", "🚕"];
const CART_COLOR_OPTIONS = ["#F0196B", "#2ECFB5", "#FFE234", "#1A3F35", "#FF7A00", "#A020EE"];

const CART_PHOTO_ACCEPT = "image/jpeg,image/png";

function FrotaTab({ unitId }: { unitId: string }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState(CART_EMOJI_OPTIONS[0]!);
  const [color, setColor] = useState(CART_COLOR_OPTIONS[0]!);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoBusyFor, setPhotoBusyFor] = useState<string | null>(null);

  function load() {
    Api.assets(unitId).then(setAssets);
  }
  useEffect(load, [unitId]);

  function pickPhoto(file: File | null) {
    setError(null);
    if (!file) {
      setPhotoFile(null);
      setPhotoPreview(null);
      return;
    }
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setError("A foto precisa ser um arquivo JPG ou PNG.");
      return;
    }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const photoUrl = photoFile ? await Api.uploadAssetPhoto(unitId, photoFile) : null;
      await Api.createAsset({ unitId, name, emoji, color, maintenanceThresholdHours: 200, photoUrl });
      setName("");
      pickPhoto(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível criar o carrinho.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: Asset["status"]) {
    await Api.setAssetStatus(id, status);
    load();
  }

  async function replacePhoto(asset: Asset, file: File | null) {
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setError("A foto precisa ser um arquivo JPG ou PNG.");
      return;
    }
    setPhotoBusyFor(asset.id);
    setError(null);
    try {
      const photoUrl = await Api.uploadAssetPhoto(unitId, file);
      await Api.setAssetPhoto(asset.id, photoUrl);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível trocar a foto.");
    } finally {
      setPhotoBusyFor(null);
    }
  }

  return (
    <div>
      <Card style={{ padding: "16px", marginBottom: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: "0 0 4px" }}>Novo carrinho</h2>
        <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} />
        <div>
          <label>Emoji</label>
          <div style={{ display: "flex", gap: "4px" }}>
            {CART_EMOJI_OPTIONS.map((em) => (
              <Button
                key={em}
                variant={emoji === em ? "primary" : "ghost"}
                size="sm"
                onClick={() => setEmoji(em)}
                aria-pressed={emoji === em}
                aria-label={`Usar ${em} para este carrinho`}
              >
                {renderEmoji(em)}
              </Button>
            ))}
          </div>
        </div>
        <div>
          <label>Cor</label>
          <div style={{ display: "flex", gap: "4px" }}>
            {CART_COLOR_OPTIONS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Cor ${COLOR_NAMES[c] ?? c}`}
                aria-pressed={color === c}
                title={COLOR_NAMES[c] ?? c}
                style={{ width: "28px", height: "28px", borderRadius: "50%", background: c, border: color === c ? "3px solid var(--color-dark)" : "1px solid var(--border-subtle)" }}
              />
            ))}
          </div>
        </div>
        <div>
          <label>Foto do carrinho (opcional — JPG ou PNG)</label>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "4px" }}>
            {photoPreview && (
              <img src={photoPreview} alt="Pré-visualização" style={{ width: "56px", height: "56px", objectFit: "cover", borderRadius: "12px", border: "1px solid var(--border-subtle)" }} />
            )}
            <input type="file" accept={CART_PHOTO_ACCEPT} onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)} />
          </div>
        </div>
        {error && <p style={{ color: "var(--color-error-text)", margin: 0 }}>{error}</p>}
        <Button variant="primary" loading={busy} disabled={busy || !name} onClick={create}>
          Criar carrinho
        </Button>
      </Card>

      {assets.map((a) => (
        <Card key={a.id} style={{ padding: "12px", marginBottom: "8px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            {a.photo_url ? (
              <img src={a.photo_url} alt={a.name} style={{ width: "40px", height: "40px", objectFit: "cover", borderRadius: "10px", border: "1px solid var(--border-subtle)" }} />
            ) : (
              <span style={{ fontSize: "24px" }}>{renderEmoji(a.emoji)}</span>
            )}
            <span>
              {a.name} — {a.status} — {Math.round(a.odometer_minutes / 60)}h de uso
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "var(--text-secondary)", cursor: "pointer" }} title="Trocar a foto deste carrinho">
              {photoBusyFor === a.id ? "Enviando…" : renderEmoji("🖼️ Trocar foto")}
              {/* .sr-only em vez de display:none: display:none tira o
                  input da ordem de tabulação — o upload de foto virava
                  mouse-only. .sr-only esconde visualmente mas mantém
                  focável, então Tab + Enter ainda abre o seletor de
                  arquivo do sistema. */}
              <input
                type="file"
                accept={CART_PHOTO_ACCEPT}
                className="sr-only"
                disabled={photoBusyFor === a.id}
                onChange={(e) => replacePhoto(a, e.target.files?.[0] ?? null)}
              />
            </label>
            <Button variant="ghost" size="sm" onClick={() => setStatus(a.id, "DISPONIVEL")}>
              disponível
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setStatus(a.id, "MANUTENCAO")}>
              manutenção
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

const CONTRACT_TYPE_LABEL: Record<NonNullable<Employee["contract_type"]>, string> = {
  CLT: "CLT",
  ESTAGIO: "Estágio",
  AUTONOMO: "Autônomo",
  PJ: "PJ (Prestador de Serviço)",
};

/**
 * Nome exato da impressora tal como aparece no Windows (Painel de
 * Controle > Dispositivos e Impressoras) — não é uma lista buscada do
 * sistema operacional (o navegador não expõe isso a uma página web), é o
 * que o print bridge local (apps/kiosk) recebe para mandar o trabalho de
 * impressão direto pra fila do driver certo via Electron, sem diálogo.
 */
// Dados fictícios só para a visualização rápida abaixo — não representam
// nenhuma sessão ou venda real, existem só para o operador conferir o
// layout que vai sair na impressora antes de precisar de um check-in de
// verdade.
const SAMPLE_WRISTBAND = {
  wristbandCode: "A1B2C3",
  childName: "Nome da Criança",
  guardianName: "Nome do Responsável",
  phone: "(11) 99999-9999",
  planName: "Plano 2 horas",
  notes: undefined as string | undefined,
};

const SAMPLE_RECEIPT = generateEscPosReceipt({
  title: "Comprovante de Check-in",
  unitName: "Unidade Exemplo",
  employeeName: "Atendente Exemplo",
  code: "PED-000123",
  items: [
    { description: "Plano 2 horas", quantity: 1, amountCents: 6000 },
    { description: "Meia de antiderrapante", quantity: 1, amountCents: 1500 },
  ],
  totalCents: 7500,
  payments: [{ method: "Cartão de Crédito", amountCents: 7500 }],
});

function ImpressorasTab({ unitId }: { unitId: string }) {
  const toast = useToast();
  const { units } = useAppState();
  const [wristbandPrinter, setWristbandPrinter] = useState("");
  const [receiptPrinter, setReceiptPrinter] = useState("");
  const [saving, setSaving] = useState<"WRISTBAND" | "RECEIPT" | null>(null);
  const [testingReceipt, setTestingReceipt] = useState(false);
  const [testingCheckinReceipt, setTestingCheckinReceipt] = useState(false);
  const [testingWristband, setTestingWristband] = useState(false);
  const [showWristbandTestModal, setShowWristbandTestModal] = useState(false);
  // Nomes instalados no Windows deste terminal (via preload do Electron —
  // undefined enquanto não sabemos, [] se a API não existe neste ambiente
  // (ex.: tablet comum da LAN) ou o Windows não retornou nenhuma). O print
  // bridge usa o nome escolhido aqui literalmente em OpenPrinterA/
  // webContents.print: digitar de cabeça já foi o motivo da impressão
  // falhar sem nada na fila — por isso a escolha é sempre por lista, nunca
  // texto livre.
  const [installedPrinters, setInstalledPrinters] = useState<string[] | undefined>(undefined);
  const [loadingPrinters, setLoadingPrinters] = useState(false);
  // Unidade amarrada a ESTE computador — diferente da unidade selecionada
  // na sessão. É o que decide quais jobs de impressão este terminal pega:
  // sem amarração ele não imprime nada (antes imprimia os de TODAS as
  // unidades, e a impressão de uma unidade saía também na outra).
  const [terminalUnitId, setTerminalUnitId] = useState<string | null>(null);
  const [terminalUnitAvailable, setTerminalUnitAvailable] = useState(false);
  const [terminalUnitDraft, setTerminalUnitDraft] = useState("");
  const [savingTerminalUnit, setSavingTerminalUnit] = useState(false);
  const [loadingTerminalInfo, setLoadingTerminalInfo] = useState(false);
  const [allUnits, setAllUnits] = useState<{ id: string; name: string }[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  useEffect(() => {
    Api.unitSetting(unitId, "printer_wristband").then((r) => setWristbandPrinter(r.value ?? ""));
    Api.unitSetting(unitId, "printer_receipt").then((r) => setReceiptPrinter(r.value ?? ""));
    fetch("/api/system/terminal-unit")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.unitId) setTerminalUnitId(data.unitId);
      })
      .catch(() => {});
  }, [unitId]);

  const refreshTerminalInfo = useCallback(() => {
    setLoadingTerminalInfo(true);
    Promise.all([
      Api.terminalUnit().catch(() => ({ available: false, unitId: null })),
      Api.deviceId().catch(() => null),
    ])
      .then(([info, devId]) => {
        setTerminalUnitAvailable(info.available);
        if (info.available) {
          setTerminalUnitId(info.unitId);
          setTerminalUnitDraft((prev) => prev || info.unitId || "");
        }
        if (devId) setDeviceId(devId);
      })
      .finally(() => {
        setLoadingTerminalInfo(false);
      });
  }, []);

  useEffect(() => {
    refreshTerminalInfo();
    Api.units()
      .then((list) => setAllUnits(list.map((u) => ({ id: u.id, name: u.name }))))
      .catch(() => setAllUnits([]));

    const retryDelaysMs = [1000, 3000, 7000];
    const timers = retryDelaysMs.map((delay) => setTimeout(refreshTerminalInfo, delay));
    return () => timers.forEach(clearTimeout);
  }, [refreshTerminalInfo]);

  async function saveTerminalUnit(targetUnitId?: string) {
    const unitToSave = targetUnitId || terminalUnitDraft;
    if (!unitToSave) return;
    setSavingTerminalUnit(true);
    try {
      const saved = await Api.setTerminalUnit(unitToSave);
      setTerminalUnitId(saved);
      setTerminalUnitDraft(saved);
      toast.success("Computador vinculado à unidade. A impressão já passa a sair só aqui.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível vincular este computador à unidade.");
    } finally {
      setSavingTerminalUnit(false);
    }
  }

  interface PrintBridgeStatus {
    started: boolean;
    bound: boolean;
    hasServiceRoleKey: boolean;
    reason?: string;
    lastError?: string | null;
    lastJobPrintedAtMs?: number | null;
  }
  const [bridgeStatus, setBridgeStatus] = useState<PrintBridgeStatus | null>(null);
  const [terminalKeyInput, setTerminalKeyInput] = useState("");

  function refreshPrinters() {
    const list = window.facaamigos?.listPrinters;
    if (!list) {
      setInstalledPrinters([]);
      return;
    }
    setLoadingPrinters(true);
    list()
      .then((printers) => setInstalledPrinters(printers.map((p) => p.name)))
      .catch((err) => {
        console.warn("Não foi possível listar impressoras instaladas:", err);
        setInstalledPrinters([]);
      })
      .finally(() => setLoadingPrinters(false));
  }

  useEffect(() => {
    refreshPrinters();
    fetch("/api/system/print-bridge-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setBridgeStatus(data))
      .catch(() => setBridgeStatus(null));

    const retryDelaysMs = [2000, 5000, 10000];
    const timers = retryDelaysMs.map((delay) =>
      setTimeout(() => {
        setInstalledPrinters((current) => {
          if (current && current.length === 0) refreshPrinters();
          return current;
        });
      }, delay),
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  const printerApiAvailable = typeof window.facaamigos?.listPrinters === "function";

  async function save(kind: "WRISTBAND" | "RECEIPT") {
    setSaving(kind);
    try {
      const key = kind === "WRISTBAND" ? "printer_wristband" : "printer_receipt";
      await Api.setUnitSetting(unitId, key, kind === "WRISTBAND" ? wristbandPrinter : receiptPrinter);
      toast.success("Impressora salva com sucesso.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar a impressora.");
    } finally {
      setSaving(null);
    }
  }

  async function testReceiptPrint() {
    setTestingReceipt(true);
    try {
      await Api.queuePrintJob(unitId, "RECEIPT", {
        title: "Teste de Impressão",
        unitName: "Unidade FaçaAmigos",
        employeeName: "Operador Kiosk",
        code: "TESTE-T271U",
        items: [
          { description: "Cupom de Teste Apptech T271U", quantity: 1, amountCents: 0 },
          { description: "Verificação de Enquadramento", quantity: 1, amountCents: 0 },
        ],
        totalCents: 0,
        payments: [{ method: "Teste do Sistema", amountCents: 0 }],
        customerInfo: { childName: "Criança Teste", guardianName: "Responsável Teste" },
        footerNote: "Teste de enquadramento 80mm OK!",
      });
      toast.success("Cupom de teste enviado para a fila de impressão!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível enviar cupom de teste.");
    } finally {
      setTestingReceipt(false);
    }
  }

  /**
   * "TESTE" + 7 dígitos fixos: não é um código de acesso real (nenhuma
   * sessão por trás dele), só precisa ter a cara de um — formatAccessCode
   * só formata em grupos de 4, não confere dígito verificador nenhum.
   */
  async function testCheckinReceiptPrint() {
    setTestingCheckinReceipt(true);
    try {
      await Api.queuePrintJob(unitId, "RECEIPT", {
        title: "Check-in (Teste)",
        unitName: "Unidade FaçaAmigos",
        employeeName: "Operador Kiosk",
        dateTime: new Date().toLocaleString("pt-BR"),
        accessCode: "TESTE1234567",
        exitPin: "1234",
        qrValue: "TESTE1234567",
        entryTime: "14:00",
        expectedExitTime: "15:00",
        planName: "Plano 60 min (Teste)",
        activity: "PLAYGROUND",
        items: [{ description: "Plano 60 min", quantity: 1, amountCents: 6000 }],
        totalCents: 6000,
        customerInfo: {
          childName: "Criança Teste",
          childBirthDate: "01/01/2018",
          guardianName: "Responsável Teste",
          guardianCpf: "000.000.000-00",
          phone: "(91) 99999-9999",
        },
      });
      toast.success("Cupom de check-in de teste enviado para a fila!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível enviar cupom de teste.");
    } finally {
      setTestingCheckinReceipt(false);
    }
  }

  async function testWristbandPrint() {
    setTestingWristband(true);
    try {
      await Api.queuePrintJob(unitId, "WRISTBAND", {
        wristbandCode: "TESTE1234567",
        childName: "Criança Teste",
        guardianName: "Responsável Teste",
        phone: "(91) 99999-9999",
        planName: "Plano 60 min (Teste)",
        entryTime: "14:00",
      });
      toast.success("Pulseira de teste enviada para a fila!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível enviar pulseira de teste.");
    } finally {
      setTestingWristband(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {bridgeStatus && !bridgeStatus.hasServiceRoleKey && (
        <HelpText icon={renderEmoji("🛑")} style={{ background: "#fff0f0", borderColor: "#f5c6cb", color: "#721c24", fontWeight: "bold" }}>
          Erro de Autenticação do Print Bridge: A chave de serviço (FACAAMIGOS_SUPABASE_SECRET_KEY) não está configurada no arquivo .env deste computador. Sem ela, o banco rejeita a reserva de cupons e a impressão não sai.
          {typeof window.facaamigos?.saveTerminalKey === "function" && (
            <form
              style={{ display: "flex", gap: "8px", marginTop: "10px", fontWeight: "normal" }}
              onSubmit={async (e) => {
                e.preventDefault();
                const res = await window.facaamigos!.saveTerminalKey(terminalKeyInput);
                if (res.ok) toast.success("Chave salva. O sistema vai reiniciar.");
                else toast.error(res.error ?? "Não foi possível salvar a chave.");
              }}
            >
              <input
                type="password"
                autoComplete="off"
                placeholder="Cole aqui a chave secreta (sb_secret_...)"
                value={terminalKeyInput}
                onChange={(e) => setTerminalKeyInput(e.target.value)}
                style={{ flex: 1, padding: "6px 8px" }}
              />
              <button type="submit" disabled={!terminalKeyInput.trim()}>
                Salvar e reiniciar
              </button>
            </form>
          )}
        </HelpText>
      )}
      {bridgeStatus && bridgeStatus.hasServiceRoleKey && bridgeStatus.started && (
        <HelpText icon={renderEmoji("🟢")} style={{ background: "#f0fff4", borderColor: "#c3e6cb", color: "#155724", fontWeight: "600" }}>
          Ponte de Impressão Ativa e Autenticada (Print Bridge OK — escutando a fila de impressão neste terminal).
        </HelpText>
      )}
      {bridgeStatus && bridgeStatus.reason && bridgeStatus.hasServiceRoleKey && !bridgeStatus.started && (
        <HelpText icon="⚠️" style={{ color: "var(--warning, #856404)" }}>
          Aviso da Ponte de Impressão: {bridgeStatus.reason}
        </HelpText>
      )}

      <p style={{ color: "var(--text-muted)", fontSize: "13px", margin: 0 }}>
        Escolha a impressora pela lista das que estão instaladas neste terminal — o print bridge local usa exatamente esse nome para imprimir direto, sem abrir diálogo nenhum na tela.
      </p>
      {!printerApiAvailable && (
        <HelpText icon="⚠️" style={{ color: "var(--danger, #d9534f)" }}>
          Este ecrã não tem acesso à lista de impressoras do Windows — abra Configurações dentro do aplicativo desktop FaçaAmigos (não num tablet/navegador) para escolher a impressora instalada.
        </HelpText>
      )}
      {printerApiAvailable && installedPrinters && installedPrinters.length === 0 && (
        <HelpText icon="⚠️" style={{ color: "var(--danger, #d9534f)" }}>
          Nenhuma impressora instalada foi encontrada neste terminal. Instale a impressora no Windows (Painel de Controle &gt; Dispositivos e Impressoras) e clique em "Buscar novamente".
        </HelpText>
      )}

      {/* ESTE TERMINAL — a que unidade este computador pertence */}
      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "16px", margin: 0 }}>
            <Emoji3D e="🖥️" /> Este terminal — Travar Impressão Local
          </h2>
          {terminalUnitId ? (
            <span
              style={{
                background: "rgba(40, 167, 69, 0.15)",
                color: "#28a745",
                padding: "4px 10px",
                borderRadius: "12px",
                fontSize: "12px",
                fontWeight: "bold",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <Emoji3D e="🔒" /> Impressão Travada Neste Terminal
            </span>
          ) : (
            <span
              style={{
                background: "rgba(220, 53, 69, 0.15)",
                color: "#dc3545",
                padding: "4px 10px",
                borderRadius: "12px",
                fontSize: "12px",
                fontWeight: "bold",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              ⚠️ Terminal Não Vinculado
            </span>
          )}
        </div>

        <p style={{ color: "var(--text-muted)", fontSize: "13px", margin: 0 }}>
          Defina a qual unidade <strong>este computador físico</strong> pertence. Ele aceitará e imprimirá pulseiras e cupons{" "}
          <strong>apenas desta unidade</strong>, travando a fila de impressão nesta máquina e impedindo que impressões saiam na outra unidade.
        </p>

        {!terminalUnitAvailable && !printerApiAvailable && (
          <HelpText icon={renderEmoji("ℹ️")} style={{ color: "var(--text-muted)" }}>
            Este terminal está em execução via navegador web/dispositivo móvel. A trava de impressora local é gerenciada diretamente no aplicativo desktop FaçaAmigos instalado no computador de caixa.
          </HelpText>
        )}

        {terminalUnitAvailable && (
          <>
            {!terminalUnitId && (
              <HelpText icon="⚠️" style={{ color: "var(--danger, #d9534f)" }}>
                Este computador ainda não está travado em nenhuma unidade — selecione a unidade abaixo e clique em vincular.
              </HelpText>
            )}

            {terminalUnitId && terminalUnitId !== unitId && (
              <HelpText icon="⚠️" style={{ color: "var(--warning, #b8860b)" }}>
                Atenção: Você está operando a sessão em <strong>{allUnits.find((u) => u.id === unitId)?.name ?? "outra unidade"}</strong>, mas este computador físico está travado na unidade <strong>{allUnits.find((u) => u.id === terminalUnitId)?.name ?? terminalUnitId}</strong>. As impressões desta sessão sairão no computador daquela unidade.
              </HelpText>
            )}

            <div style={{ display: "flex", gap: "8px", alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: "240px" }}>
                <Select value={terminalUnitDraft} onChange={(e) => setTerminalUnitDraft(e.target.value)}>
                  <option value="">Selecione a unidade para travar este computador</option>
                  {allUnits.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                variant="primary"
                size="sm"
                loading={savingTerminalUnit}
                disabled={!terminalUnitDraft || terminalUnitDraft === terminalUnitId}
                onClick={() => saveTerminalUnit()}
              >
                <Emoji3D e="🔒" /> Vincular e Travar Impressão
              </Button>

              {unitId && unitId !== terminalUnitId && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={savingTerminalUnit}
                  onClick={() => {
                    setTerminalUnitDraft(unitId);
                    saveTerminalUnit(unitId);
                  }}
                >
                  <Emoji3D e="📍" /> Travar na Unidade Atual ({allUnits.find((u) => u.id === unitId)?.name ?? "Sessão"})
                </Button>
              )}
            </div>

            {deviceId && (
              <HelpText>
                Identificação desta máquina: <code style={{ fontFamily: "monospace", fontWeight: "bold" }}>{deviceId.slice(0, 8)}</code> — verifique se cada computador de caixa exibe um código diferente.
              </HelpText>
            )}
          </>
        )}

        {!terminalUnitAvailable && printerApiAvailable && (
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "4px" }}>
            <HelpText icon={renderEmoji("⏳")}>Conectando ao serviço de terminal local...</HelpText>
            <Button variant="ghost" size="sm" loading={loadingTerminalInfo} onClick={refreshTerminalInfo}>
              <Emoji3D e="🔄" /> Tentar Novamente
            </Button>
          </div>
        )}
      </Card>

      {/* IMPRESSORA DE CUPONS NÃO FISCAIS */}
      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "16px", margin: "0 0 4px" }}>Impressora de Cupons Não Fiscais (80mm)</h2>
        <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <Select value={receiptPrinter} onChange={(e) => setReceiptPrinter(e.target.value)} disabled={!installedPrinters || installedPrinters.length === 0}>
              <option value="">{loadingPrinters ? "Buscando impressoras…" : "Selecione uma impressora instalada"}</option>
              {installedPrinters?.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="ghost" size="sm" loading={loadingPrinters} onClick={refreshPrinters}>
            <Emoji3D e="🔄" /> Buscar novamente
          </Button>
        </div>

        <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
          <Button variant="primary" size="sm" loading={saving === "RECEIPT"} onClick={() => save("RECEIPT")}>
            Salvar Impressora
          </Button>
          <Button variant="secondary" size="sm" loading={testingReceipt} onClick={testReceiptPrint}>
            <Emoji3D e="🖨️" /> Enviar Cupom de Teste
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={testingCheckinReceipt}
            onClick={testCheckinReceiptPrint}
            title="Cupom de teste com accessCode fake — o único jeito de ver o QR de acompanhamento sem fazer um check-in de verdade"
          >
            <Emoji3D e="📱" /> Cupom de Teste — Check-in
          </Button>
        </div>
      </Card>

      {/* VISUALIZAÇÃO RÁPIDA */}
      <div>
        <h2 style={{ margin: "0 0 4px 0", fontSize: "16px" }}>Visualização rápida de impressão</h2>
        <p style={{ color: "var(--text-muted)", fontSize: "13px", margin: "0 0 12px 0" }}>
          Layout em tempo real — mostra o enquadramento exato de 42 colunas como sairá na impressora térmica de 80mm.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

          <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <h3 style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>Cupom não fiscal (80mm - 42 Colunas)</h3>
            <pre
              style={{
                background: "#ffffff",
                color: "#141414",
                padding: "12px",
                borderRadius: "12px",
                border: "2px dashed var(--border-subtle)",
                fontFamily: '"Consolas", "Courier New", monospace',
                fontSize: "11px",
                lineHeight: "1.25",
                fontWeight: 600,
                whiteSpace: "pre",
                maxHeight: "340px",
                overflowX: "auto",
                overflowY: "auto",
                margin: 0,
              }}
            >
              {SAMPLE_RECEIPT.text}
            </pre>
          </Card>
        </div>
      </div>

      {/* VERSÃO E ATUALIZAÇÃO DO SISTEMA */}
      <SystemVersionCard />
    </div>
  );
}

function SystemVersionCard() {
  const toast = useToast();
  // Sem valor hardcoded: um número fixo aqui fica defasado a cada release e
  // faz o operador achar que o terminal "não atualizou" mesmo atualizado.
  const [version, setVersion] = useState<string>("");
  const [updateState, setUpdateState] = useState<{ status: string; version?: string; progress?: number; error?: string }>({ status: "idle" });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (window.facaamigos?.getAppVersion) {
      window.facaamigos.getAppVersion().then(setVersion);
    } else {
      // Tablets/PWA não têm o bridge do Electron — busca a versão real do
      // terminal no servidor local em vez de exibir um número inventado.
      fetch("/api/system/info")
        .then((res) => res.json())
        .then((data: { update?: { status: string; version?: string; progress?: number; error?: string } }) => {
          if (data?.update?.version) setVersion(data.update.version);
          if (data?.update) setUpdateState(data.update);
        })
        .catch(() => {});
    }
    if (window.facaamigos?.getUpdateStatus) {
      window.facaamigos.getUpdateStatus().then((s: unknown) => {
        if (s && typeof s === "object") setUpdateState(s as { status: string; version?: string; progress?: number; error?: string });
      });
    }
    if (window.facaamigos?.onUpdateStatusChange) {
      return window.facaamigos.onUpdateStatusChange((s: unknown) => {
        if (s && typeof s === "object") setUpdateState(s as { status: string; version?: string; progress?: number; error?: string });
      });
    }
  }, []);

  async function handleCheck() {
    setChecking(true);
    try {
      if (window.facaamigos?.checkForUpdates) {
        const status = (await window.facaamigos.checkForUpdates()) as { status: string; version?: string; progress?: number; error?: string } | undefined;
        if (status) setUpdateState(status);
        toast.success("Verificação de atualização iniciada.");
      } else {
        const res = await fetch("/api/system/update/check", { method: "POST" });
        const data = await res.json();
        if (data.update) setUpdateState(data.update);
        toast.success("Verificação iniciada.");
      }
    } catch {
      toast.error("Não foi possível verificar atualizações.");
    } finally {
      setChecking(false);
    }
  }

  async function handleApply() {
    try {
      if (window.facaamigos?.applyUpdate) {
        await window.facaamigos.applyUpdate();
      } else {
        await fetch("/api/system/update/apply", { method: "POST" });
      }
    } catch {
      toast.error("Não foi possível reiniciar para atualizar.");
    }
  }

  return (
    <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: "16px", margin: "0 0 4px" }}>Versão do Sistema & Atualização</h2>
      <div style={{ fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
        <span>Versão atual:</span>
        <Tag color="var(--color-teal, #2ECFB5)">{version ? `v${version}` : "—"}</Tag>
      </div>
      <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
        {updateState.status === "checking" && renderEmoji("🔎 Verificando se há novas atualizações...")}
        {updateState.status === "available" && renderEmoji(`⏳ Baixando versão ${updateState.version ?? ""} (${updateState.progress ?? 0}%)...`)}
        {updateState.status === "downloaded" && renderEmoji(`🚀 Nova versão ${updateState.version ?? ""} pronta para ser instalada!`)}
        {updateState.status === "error" && `⚠️ Status de atualização: ${updateState.error ?? "Erro ao verificar"}`}
        {updateState.status === "idle" && "✅ O aplicativo está na versão mais recente."}
      </div>
      <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
        <Button variant="secondary" size="sm" loading={checking} onClick={handleCheck}>
          <Emoji3D e="🔄" /> Verificar Atualizações
        </Button>
        {updateState.status === "downloaded" && (
          <Button variant="primary" size="sm" onClick={handleApply}>
            <Emoji3D e="🚀" /> Atualizar e Reiniciar Agora
          </Button>
        )}
      </div>
    </Card>
  );
}


// ---------------------------------------------------------------------------
// Unidade
// ---------------------------------------------------------------------------
// Migrada de apps/backoffice/src/app/(app)/unidades/page.tsx. A escrita não é
// mais um UPDATE direto na tabela: passa por fa_config_update_unit, que confere
// config.unit.write no servidor e audita a alteração.
function UnidadeTab({ unitId }: { unitId: string }) {
  const toast = useToast();
  const { units, refreshUnits } = useAppState();
  const unit = units.find((u) => u.id === unitId);

  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("America/Belem");
  const [cutoffHour, setCutoffHour] = useState("4");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [geofenceRadiusM, setGeofenceRadiusM] = useState("");
  const [openingHourMonSat, setOpeningHourMonSat] = useState("");
  const [closingHourMonSat, setClosingHourMonSat] = useState("");
  const [openingHourSun, setOpeningHourSun] = useState("");
  const [closingHourSun, setClosingHourSun] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!unit) return;
    setName(unit.name);
    setTimezone(unit.timezone ?? "America/Belem");
    setCutoffHour(String(unit.business_day_cutoff_hour ?? 4));
    setAddress(unit.address ?? "");
    setPhone(unit.phone ?? "");
    setLatitude(unit.latitude != null ? String(unit.latitude) : "");
    setLongitude(unit.longitude != null ? String(unit.longitude) : "");
    setGeofenceRadiusM(unit.geofence_radius_m != null ? String(unit.geofence_radius_m) : "");
    setOpeningHourMonSat(unit.opening_hour_mon_sat ?? "10:00");
    setClosingHourMonSat(unit.closing_hour_mon_sat ?? "22:00");
    setOpeningHourSun(unit.opening_hour_sun ?? "12:00");
    setClosingHourSun(unit.closing_hour_sun ?? "21:00");
  }, [unit]);

  async function save() {
    setSaving(true);
    try {
      await Api.updateUnit(unitId, {
        name,
        timezone,
        businessDayCutoffHour: Number(cutoffHour),
        address: address || null,
        phone: phone || null,
        latitude: latitude.trim() ? Number(latitude) : null,
        longitude: longitude.trim() ? Number(longitude) : null,
        geofenceRadiusM: geofenceRadiusM.trim() ? Number(geofenceRadiusM) : null,
        openingHourMonSat: openingHourMonSat.trim() || null,
        closingHourMonSat: closingHourMonSat.trim() || null,
        openingHourSun: openingHourSun.trim() || null,
        closingHourSun: closingHourSun.trim() || null,
      });
      await refreshUnits();
      toast.success("Dados da unidade salvos com sucesso.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar a unidade.");
    } finally {
      setSaving(false);
    }
  }

  function usarLocalizacaoAtual() {
    if (!("geolocation" in navigator)) {
      toast.error("Este dispositivo não tem geolocalização disponível.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatitude(String(pos.coords.latitude));
        setLongitude(String(pos.coords.longitude));
      },
      () => toast.error("Não foi possível obter a localização atual."),
      { enableHighAccuracy: true },
    );
  }

  const publicAppOrigin = getPublicAppUrl();
  const acessoRapidoUrl = `${publicAppOrigin.replace(/\/$/, "")}/?acesso-rapido=${unitId}`;
  const [printingPoster, setPrintingPoster] = useState(false);

  async function printPoster() {
    if (!acessoRapidoUrl || !unit) return;
    setPrintingPoster(true);
    try {
      const qrDataUrl = await generateWristbandQRCodeDataUrl(acessoRapidoUrl, 480);
      printContract(buildAcessoRapidoPosterHtml({ unitName: unit.name, qrDataUrl, url: acessoRapidoUrl }));
    } finally {
      setPrintingPoster(false);
    }
  }

  if (!unit) return <HelpText>Unidade não encontrada.</HelpText>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>Identificação</h2>
        <Input label="Nome da unidade" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          label="Tipo"
          value={unit.kind === "QUIOSQUE" ? "Quiosque (Circuito)" : "Loja (Playground)"}
          disabled
          title="O tipo define quais telas e planos a unidade usa; mudá-lo depois invalidaria as sessões e planos já cadastrados, por isso não é editável."
        />
        <Select label="Fuso horário" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          <option value="America/Belem">America/Belem (Pará)</option>
          <option value="America/Sao_Paulo">America/Sao_Paulo</option>
          <option value="America/Manaus">America/Manaus</option>
          <option value="America/Fortaleza">America/Fortaleza</option>
        </Select>
        <Input
          label="Hora da virada do dia operacional"
          type="number"
          value={cutoffHour}
          onChange={(e) => setCutoffHour(e.target.value)}
        />
        <HelpText>
          Uma venda feita às 2h da manhã ainda conta no movimento do dia anterior até esta hora. Com 4, o dia
          operacional vai das 4h de um dia às 3h59 do seguinte — é o que faz o fechamento de caixa da madrugada bater.
        </HelpText>
      </Card>

      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>Cabeçalho do cupom</h2>
        <HelpText>O que sai impresso no topo do comprovante entregue ao responsável.</HelpText>
        <Input label="Endereço" value={address} onChange={(e) => setAddress(e.target.value)} />
        <Input label="Telefone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <HelpText>
          O CNPJ do cupom vem da aba Dados Fiscais — é o mesmo do emitente da nota, e ter dois campos para digitá-lo
          é o caminho mais curto para eles divergirem.
        </HelpText>
      </Card>

      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>Localização (Controle de Frequência)</h2>
        <HelpText>
          Opcional. Preenchendo os 3 campos abaixo, o quiosque passa a exigir que quem bate o ponto esteja dentro
          deste raio — deixe em branco para não validar GPS nesta unidade.
        </HelpText>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <Input label="Latitude" value={latitude} onChange={(e) => setLatitude(e.target.value)} style={{ flex: 1, minWidth: "140px" }} />
          <Input label="Longitude" value={longitude} onChange={(e) => setLongitude(e.target.value)} style={{ flex: 1, minWidth: "140px" }} />
          <Input
            label="Raio (metros)"
            type="number"
            value={geofenceRadiusM}
            onChange={(e) => setGeofenceRadiusM(e.target.value)}
            style={{ flex: 1, minWidth: "120px" }}
          />
        </div>
        <Button variant="secondary" onClick={usarLocalizacaoAtual} style={{ alignSelf: "flex-start" }}>
          <Emoji3D e="📍" /> Usar localização atual deste dispositivo
        </Button>
      </Card>

      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>Horário de Funcionamento</h2>
        <HelpText>
          Configure os horários de abertura e fechamento do shopping onde a unidade se localiza. O alerta automático de término e as opções de renovação dependem deste horário.
        </HelpText>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <Input label="Abertura (Seg-Sáb)" type="time" value={openingHourMonSat} onChange={(e) => setOpeningHourMonSat(e.target.value)} style={{ flex: 1, minWidth: "140px" }} />
          <Input label="Fechamento (Seg-Sáb)" type="time" value={closingHourMonSat} onChange={(e) => setClosingHourMonSat(e.target.value)} style={{ flex: 1, minWidth: "140px" }} />
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <Input label="Abertura (Domingo)" type="time" value={openingHourSun} onChange={(e) => setOpeningHourSun(e.target.value)} style={{ flex: 1, minWidth: "140px" }} />
          <Input label="Fechamento (Domingo)" type="time" value={closingHourSun} onChange={(e) => setClosingHourSun(e.target.value)} style={{ flex: 1, minWidth: "140px" }} />
        </div>
      </Card>

      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>QR Code de Acesso Rápido</h2>
        <HelpText>
          Cartaz para fixar na entrada da unidade: o responsável escaneia, preenche os dados da criança e do
          responsável pelo próprio celular, escolhe o plano e aceita os Termos de Uso — os dados já chegam prontos
          para o educador só confirmar a entrada no Painel.
        </HelpText>
        <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
          <WristbandQRCode value={acessoRapidoUrl} size={120} />
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <HelpText style={{ margin: 0, wordBreak: "break-all" }}>{acessoRapidoUrl}</HelpText>
            <Button variant="secondary" loading={printingPoster} disabled={printingPoster} onClick={printPoster} style={{ alignSelf: "flex-start" }}>
              <Emoji3D e="🖨️" /> Imprimir cartaz (A4)
            </Button>
          </div>
        </div>
      </Card>

      <Button variant="primary" disabled={saving || !name} onClick={save}>
        Salvar unidade
      </Button>

      <AutoUpdateCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dados Fiscais
// ---------------------------------------------------------------------------
const CRT_OPTIONS = [
  { value: 1, label: "1 — Simples Nacional" },
  { value: 2, label: "2 — Simples Nacional, excesso de sublimite" },
  { value: 3, label: "3 — Regime Normal" },
];

const ORIGEM_OPTIONS = [
  { value: 0, label: "0 — Nacional" },
  { value: 1, label: "1 — Estrangeira, importação direta" },
  { value: 2, label: "2 — Estrangeira, adquirida no mercado interno" },
];

const HEARTBEAT_STALE_MS = 30 * 60 * 1000;

function FiscalTab({ unitId }: { unitId: string }) {
  const toast = useToast();
  const { refreshUnits } = useAppState();
  const [fiscal, setFiscal] = useState<UnitFiscal | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [products, setProducts] = useState<ProductFiscal[]>([]);
  const [status, setStatus] = useState<FiscalTerminalStatus[]>([]);
  const [saving, setSaving] = useState(false);
  const [certStatus, setCertStatus] = useState<{ subject_cn: string | null; expires_at_ms: number | null; uploaded_at_ms: number } | null>(null);
  const [certFile, setCertFile] = useState<File | null>(null);
  const [certPassword, setCertPassword] = useState("");
  const [certUploading, setCertUploading] = useState(false);
  // Token do CSC: nunca é lido de volta — só o status (existe / quando).
  const [cscStatus, setCscStatus] = useState<{ unit_id: string; updated_at_ms: number } | null>(null);
  const [cscToken, setCscToken] = useState("");
  const [cscSaving, setCscSaving] = useState(false);

  function loadCertStatus() {
    Api.fiscalCertificateStatus(unitId)
      .then(setCertStatus)
      .catch(() => setCertStatus(null));
  }

  function loadCscStatus() {
    Api.fiscalCscStatus(unitId)
      .then(setCscStatus)
      .catch(() => setCscStatus(null));
  }

  async function saveCsc() {
    const cscId = (form.nfceCscId ?? "").trim();
    if (!cscId || !cscToken) return;
    setCscSaving(true);
    try {
      await Api.uploadFiscalCsc(unitId, cscId, cscToken);
      toast.success("Token do CSC salvo e protegido com sucesso.");
      setCscToken("");
      loadCscStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar o token do CSC.");
    } finally {
      setCscSaving(false);
    }
  }

  async function uploadCertificate() {
    if (!certFile || !certPassword) return;
    setCertUploading(true);
    try {
      const buffer = await certFile.arrayBuffer();
      let binary = "";
      new Uint8Array(buffer).forEach((b) => (binary += String.fromCharCode(b)));
      const pfxBase64 = btoa(binary);
      await Api.uploadFiscalCertificate(unitId, pfxBase64, certPassword, certFile.name);
      toast.success("Certificado enviado e protegido com sucesso.");
      setCertFile(null);
      setCertPassword("");
      loadCertStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível enviar o certificado.");
    } finally {
      setCertUploading(false);
    }
  }

  function load() {
    Api.unitFiscal(unitId)
      .then((f) => {
        setFiscal(f);
        setForm({
          cnpj: f.cnpj ?? "",
          razaoSocial: f.razao_social ?? "",
          nomeFantasia: f.nome_fantasia ?? "",
          inscricaoEstadual: f.inscricao_estadual ?? "",
          inscricaoMunicipal: f.inscricao_municipal ?? "",
          cnaePrincipal: f.cnae_principal ?? "",
          crt: String(f.crt ?? 1),
          endLogradouro: f.end_logradouro ?? "",
          endNumero: f.end_numero ?? "",
          endComplemento: f.end_complemento ?? "",
          endBairro: f.end_bairro ?? "",
          endMunicipioIbge: f.end_municipio_ibge ?? "1501402",
          endMunicipioNome: f.end_municipio_nome ?? "BELEM",
          endUf: f.end_uf ?? "PA",
          endCep: f.end_cep ?? "",
          fone: f.fone ?? "",
          fiscalAmbiente: f.fiscal_ambiente ?? "HOMOLOGACAO",
          fiscalEnabled: String(f.fiscal_enabled ?? false),
          nfceSerie: String(f.nfce_serie ?? 1),
          nfceCscId: f.nfce_csc_id ?? "",
          nfceQrcodeUrlConsulta: f.nfce_qrcode_url_consulta ?? "",
          nfseItemListaServico: f.nfse_item_lista_servico ?? "",
          nfseCodigoTributacaoMunicipio: f.nfse_codigo_tributacao_municipio ?? "",
          nfseAliquotaIssBp: String(f.nfse_aliquota_iss_bp ?? 0),
          nfseIssRetido: String(f.nfse_iss_retido ?? false),
          nfseRegimeEspecial: String(f.nfse_regime_especial ?? 6),
          nfseSerieRps: f.nfse_serie_rps ?? "1",
          nfseAmbiente: f.nfse_ambiente ?? "HOMOLOGACAO",
          nfseEnabled: String(f.nfse_enabled ?? false),
        });
      })
      .catch(() => toast.error("Não foi possível carregar os dados fiscais."));
    Api.productsFiscal(unitId)
      .then(setProducts)
      .catch(() => setProducts([]));
    Api.fiscalTerminalStatus(unitId)
      .then(setStatus)
      .catch(() => setStatus([]));
    loadCscStatus();
  }
  useEffect(load, [unitId]);
  useEffect(loadCertStatus, [unitId]);

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      await Api.updateUnitFiscal(unitId, form);
      await refreshUnits();
      toast.success("Dados fiscais salvos.");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar os dados fiscais.");
    } finally {
      setSaving(false);
    }
  }

  if (!fiscal) return <HelpText>Carregando…</HelpText>;

  const nowMs = Date.now();
  const missingNcm = products.filter((p) => !p.ncm);

  const isCnpjOk = !!form.cnpj && form.cnpj.length >= 14;
  const isIeOk = !!form.inscricaoEstadual;
  const isCscOk = !!form.nfceCscId && !!cscStatus;
  const isFiscalEnabled = form.fiscalEnabled === "true";
  const isTerminalActive = status.some((s) => nowMs - s.last_heartbeat_ms <= HEARTBEAT_STALE_MS);
  const isAllReady = isCnpjOk && isIeOk && isCscOk && missingNcm.length === 0 && isTerminalActive && isFiscalEnabled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <Card style={{ padding: "16px", borderLeft: isAllReady ? "4px solid var(--color-success, #10B981)" : "4px solid var(--color-warning, #F59E0B)" }}>
        <h3 style={{ margin: "0 0 8px 0", fontSize: "16px", fontFamily: "var(--font-display)" }}>
          {isAllReady ? "✅ Emissão de NFC-e 100% Pronta e Ativa" : "⚠️ Checklist para Emissão Automática de Cupom Fiscal"}
        </h3>
        <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "13px", display: "flex", flexDirection: "column", gap: "4px" }}>
          <li>
            {isCnpjOk ? "✅" : "❌"} <strong>Emitente:</strong> CNPJ ({form.cnpj || "não informado"}) e Inscrição Estadual ({form.inscricaoEstadual || "não informada"}).
          </li>
          <li>
            {isCscOk ? "✅" : "⚠️"} <strong>CSC:</strong> {isCscOk ? `ID do CSC (${form.nfceCscId}) e token configurados` : "pendente (ID e token da SEFA-PA)"}.
          </li>
          <li>
            {missingNcm.length === 0 ? "✅" : "❌"} <strong>Produtos:</strong> {products.length - missingNcm.length}/{products.length} cadastrados com NCM correto.
          </li>
          <li>
            {isTerminalActive ? "✅" : "⚠️"} <strong>Emissor no Balcão:</strong> {isTerminalActive ? "Terminal ativo e comunicando" : "Aguardando heartbeat do emissor local no PC do balcão"}.
          </li>
          <li>
            {isFiscalEnabled ? "✅" : renderEmoji("ℹ️")} <strong>Chave NFC-e:</strong> {isFiscalEnabled ? "Ligada (emissão automática ativa nas vendas)" : "Desligada (chave geral)"}.
          </li>
        </ul>
        <HelpText style={{ marginTop: "8px" }}>
          Confira estes dados com seu contador antes de ligar a emissão em Produção. O token do CSC e a senha do certificado A1 ficam cifrados na nuvem; só o emissor do PC do balcão consegue lê-los.
        </HelpText>
      </Card>


      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>Emitente</h2>
        <Input label="CNPJ" value={form.cnpj ?? ""} onChange={(e) => set("cnpj", e.target.value)} />
        <Input label="Razão social" value={form.razaoSocial ?? ""} onChange={(e) => set("razaoSocial", e.target.value)} />
        <Input label="Nome fantasia" value={form.nomeFantasia ?? ""} onChange={(e) => set("nomeFantasia", e.target.value)} />
        <Input label="Inscrição estadual" value={form.inscricaoEstadual ?? ""} onChange={(e) => set("inscricaoEstadual", e.target.value)} />
        <Input label="Inscrição municipal" value={form.inscricaoMunicipal ?? ""} onChange={(e) => set("inscricaoMunicipal", e.target.value)} />
        <Input label="CNAE principal" value={form.cnaePrincipal ?? ""} onChange={(e) => set("cnaePrincipal", e.target.value)} />
        <Select label="Regime tributário (CRT)" value={form.crt ?? "1"} onChange={(e) => set("crt", e.target.value)}>
          {CRT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Card>

      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>Endereço do emitente</h2>
        <Input label="Logradouro" value={form.endLogradouro ?? ""} onChange={(e) => set("endLogradouro", e.target.value)} />
        <Input label="Número" value={form.endNumero ?? ""} onChange={(e) => set("endNumero", e.target.value)} />
        <Input label="Complemento" value={form.endComplemento ?? ""} onChange={(e) => set("endComplemento", e.target.value)} />
        <Input label="Bairro" value={form.endBairro ?? ""} onChange={(e) => set("endBairro", e.target.value)} />
        <Input label="Código IBGE do município" value={form.endMunicipioIbge ?? ""} onChange={(e) => set("endMunicipioIbge", e.target.value)} />
        <Input label="Nome do município (xMun)" value={form.endMunicipioNome ?? ""} onChange={(e) => set("endMunicipioNome", e.target.value)} />
        <Input label="UF" value={form.endUf ?? ""} onChange={(e) => set("endUf", e.target.value.toUpperCase().slice(0, 2))} />
        <Input label="CEP" value={form.endCep ?? ""} onChange={(e) => set("endCep", e.target.value)} />
        <Input label="Telefone" value={form.fone ?? ""} onChange={(e) => set("fone", e.target.value)} />
      </Card>

      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>NFC-e — venda de produtos</h2>
        <HelpText>
          Nota de mercadoria (modelo 65) autorizada na SEFAZ-PA (Pará). A inscrição estadual, o credenciamento e o CSC são emitidos diretamente no portal da SEFA-PA.
        </HelpText>

        <Select label="Ambiente" value={form.fiscalAmbiente ?? "HOMOLOGACAO"} onChange={(e) => set("fiscalAmbiente", e.target.value)}>
          <option value="HOMOLOGACAO">Homologação (teste, sem valor fiscal)</option>
          <option value="PRODUCAO">Produção (nota válida)</option>
        </Select>
        <Input label="Série" type="number" value={form.nfceSerie ?? "1"} onChange={(e) => set("nfceSerie", e.target.value)} />
        <Input label="ID do CSC (ex.: 000001)" value={form.nfceCscId ?? ""} onChange={(e) => set("nfceCscId", e.target.value)} />
        <Input
          label="Token do CSC (SEFA-PA)"
          type="password"
          autoComplete="off"
          value={cscToken}
          onChange={(e) => setCscToken(e.target.value)}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <Button
            variant="secondary"
            disabled={cscSaving || !(form.nfceCscId ?? "").trim() || !cscToken}
            loading={cscSaving}
            onClick={saveCsc}
          >
            Salvar CSC
          </Button>
          {cscStatus ? (
            <span style={{ fontSize: "13px" }}>
              ✅ Token do CSC configurado em {new Date(cscStatus.updated_at_ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
            </span>
          ) : (
            <span style={{ fontSize: "13px", color: "var(--color-warning, #B45309)" }}>
              ⚠️ Token do CSC ainda não configurado — sem ele a NFC-e não gera QR Code.
            </span>
          )}
        </div>
        <HelpText>
          O token é gravado cifrado na nuvem e nunca aparece de novo nesta tela. O "ID do CSC" acima é salvo junto com
          os demais dados fiscais (botão "Salvar dados fiscais"); o botão "Salvar CSC" envia o ID e o token juntos.
        </HelpText>
        <Input
          label="URL de consulta do QR Code (opcional — padrão SEFA-PA)"
          value={form.nfceQrcodeUrlConsulta ?? ""}
          onChange={(e) => set("nfceQrcodeUrlConsulta", e.target.value)}
        />
        <HelpText>Deixe em branco para usar as URLs oficiais da SEFA-PA (appnfc.sefa.pa.gov.br) por ambiente.</HelpText>
        <Select label="Emissão de NFC-e" value={form.fiscalEnabled ?? "false"} onChange={(e) => set("fiscalEnabled", e.target.value)}>
          <option value="false">Desligada</option>
          <option value="true">Ligada</option>
        </Select>
        <HelpText>
          Só ligue depois de uma semana inteira emitindo em homologação sem rejeição. Com a emissão ligada e um
          produto sem NCM, a venda continua acontecendo normalmente — o documento é que fica bloqueado para correção,
          nunca o caixa.
        </HelpText>
        {missingNcm.length > 0 && form.fiscalEnabled === "true" && (
          <p style={{ color: "var(--color-error-text)", margin: 0 }}>
            {missingNcm.length} produto(s) sem NCM: {missingNcm.map((p) => p.name).join(", ")}.
          </p>
        )}
      </Card>

      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>NFS-e — sessões de brincar</h2>
        <HelpText>
          Nota de serviço (ISS, Prefeitura de Belém, Sistema Nacional NFS-e/ADN). O Responsável pode pedir a nota
          pelo botão "Emitir Nota Fiscal Serviço" na tela de Saída, e o operador entrega pelo WhatsApp assim que
          fica pronta. A transmissão real exige certificado A1 configurado abaixo, o convênio de Belém ativo no
          Sistema Nacional e os campos preenchidos corretamente — sem isso, o documento fica em modo simulado
          (registra o pedido e reserva o número, mas sem valor fiscal). Ligar a chave abaixo é o que libera o botão
          para o Responsável pedir.
        </HelpText>
        <Input
          label="Código de tributação nacional (cTribNac, 6 dígitos)"
          placeholder="120501 — Parques de diversões, centros de lazer e congêneres"
          value={form.nfseItemListaServico ?? ""}
          onChange={(e) => set("nfseItemListaServico", e.target.value)}
        />
        <Input label="Código de tributação do município (opcional)" value={form.nfseCodigoTributacaoMunicipio ?? ""} onChange={(e) => set("nfseCodigoTributacaoMunicipio", e.target.value)} />
        <Input
          label="Alíquota de ISS (%)"
          type="number"
          step="0.01"
          value={((Number(form.nfseAliquotaIssBp ?? 0) || 0) / 100).toString()}
          onChange={(e) => set("nfseAliquotaIssBp", String(Math.round(Number(e.target.value) * 100)))}
        />
        <Select label="ISS retido na fonte" value={form.nfseIssRetido ?? "false"} onChange={(e) => set("nfseIssRetido", e.target.value)}>
          <option value="false">Não</option>
          <option value="true">Sim</option>
        </Select>
        <Input label="Regime especial de tributação" type="number" value={form.nfseRegimeEspecial ?? "6"} onChange={(e) => set("nfseRegimeEspecial", e.target.value)} />
        <Input label="Série do RPS" value={form.nfseSerieRps ?? "1"} onChange={(e) => set("nfseSerieRps", e.target.value)} />
        <Select label="Ambiente" value={form.nfseAmbiente ?? "HOMOLOGACAO"} onChange={(e) => set("nfseAmbiente", e.target.value)}>
          <option value="HOMOLOGACAO">Homologação</option>
          <option value="PRODUCAO">Produção</option>
        </Select>
        <Select label="Emissão de NFS-e" value={form.nfseEnabled ?? "false"} onChange={(e) => set("nfseEnabled", e.target.value)}>
          <option value="false">Desligada</option>
          <option value="true">Ligada</option>
        </Select>
      </Card>

      <Button variant="primary" disabled={saving} onClick={save}>
        Salvar dados fiscais
      </Button>

      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>Certificado digital A1 (NFS-e e NFC-e)</h2>
        <HelpText>
          Necessário para assinar e transmitir tanto a NFS-e (prefeitura) quanto a NFC-e (SEFAZ-PA). A senha nunca
          fica salva em texto puro: é cifrada na nuvem e só o emissor do PC do balcão consegue decifrá-la; o arquivo
          .pfx fica num espaço privado que o app nunca lê de volta.
        </HelpText>
        {certStatus ? (
          <p style={{ margin: 0, fontSize: "13px" }}>
            ✅ Certificado configurado em {new Date(certStatus.uploaded_at_ms).toLocaleDateString("pt-BR")}
            {certStatus.expires_at_ms ? ` — válido até ${new Date(certStatus.expires_at_ms).toLocaleDateString("pt-BR")}` : ""}.
          </p>
        ) : (
          <p style={{ margin: 0, fontSize: "13px", color: "var(--text-muted)" }}>Nenhum certificado configurado ainda.</p>
        )}
        <input
          type="file"
          accept=".pfx,.p12"
          onChange={(e) => setCertFile(e.target.files?.[0] ?? null)}
        />
        <Input
          label="Senha do certificado"
          type="password"
          value={certPassword}
          onChange={(e) => setCertPassword(e.target.value)}
        />
        <Button
          variant="secondary"
          disabled={!certFile || !certPassword || certUploading}
          loading={certUploading}
          onClick={uploadCertificate}
        >
          Enviar certificado
        </Button>
      </Card>

      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>Tributação por produto</h2>
        <HelpText>Sem NCM, CFOP e CSOSN preenchidos, a NFC-e do item é rejeitada pela SEFAZ.</HelpText>
        {products.length === 0 && <HelpText>Nenhum produto cadastrado nesta unidade.</HelpText>}
        {products.map((p) => (
          <ProdutoFiscalRow key={p.id} product={p} onSaved={load} />
        ))}
      </Card>

      <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>Emissor no PC do balcão</h2>
        {status.length === 0 && <HelpText>Nenhum terminal reportou ainda.</HelpText>}
        {status.map((s) => {
          const ageMs = nowMs - s.last_heartbeat_ms;
          const stale = ageMs > HEARTBEAT_STALE_MS;
          const certExpired = s.cert_not_after_ms != null && s.cert_not_after_ms < nowMs;
          return (
            <Card key={s.terminal_id} style={{ padding: "12px" }}>
              <strong>{s.terminal_id}</strong> · {s.environment ?? "—"}
              <div style={{ fontSize: "13px", color: stale ? "var(--color-error-text)" : "var(--text-secondary)" }}>
                {stale ? `Sem contato há ${Math.round(ageMs / 60000)} min` : "Ativo"}
                {certExpired && " · certificado vencido"}
                {!s.csc_configured && " · CSC não configurado"}
                {s.last_error && ` · último erro: ${s.last_error}`}
              </div>
            </Card>
          );
        })}
      </Card>
    </div>
  );
}

function ProdutoFiscalRow({ product, onSaved }: { product: ProductFiscal; onSaved: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ncm, setNcm] = useState(product.ncm ?? "");
  const [cest, setCest] = useState(product.cest ?? "");
  const [cfop, setCfop] = useState(product.cfop ?? "5102");
  const [csosn, setCsosn] = useState(product.csosn ?? "102");
  const [origem, setOrigem] = useState(String(product.origem ?? 0));
  const [unidadeComercial, setUnidadeComercial] = useState(product.unidade_comercial ?? "UN");
  const [gtin, setGtin] = useState(product.gtin ?? "SEM GTIN");
  const [pisCst, setPisCst] = useState(product.pis_cst ?? "49");
  const [cofinsCst, setCofinsCst] = useState(product.cofins_cst ?? "49");

  async function save() {
    setSaving(true);
    try {
      await Api.updateProductFiscal(product.id, {
        ncm,
        cest,
        cfop,
        csosn,
        origem: Number(origem),
        unidadeComercial,
        gtin,
        pisCst,
        cofinsCst,
      });
      toast.success(`Tributação de ${product.name} salva.`);
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card style={{ padding: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>
          <strong>{product.name}</strong>{" "}
          {product.ncm ? (
            <span style={{ color: "var(--text-muted)" }}>NCM {product.ncm}</span>
          ) : (
            <span style={{ color: "var(--color-error-text)" }}>sem NCM</span>
          )}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? "fechar" : "editar"}
        </Button>
      </div>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
          <Input label="NCM" value={ncm} onChange={(e) => setNcm(e.target.value)} />
          <Input label="CEST (se houver)" value={cest} onChange={(e) => setCest(e.target.value)} />
          <Input label="CFOP" value={cfop} onChange={(e) => setCfop(e.target.value)} />
          <Input label="CSOSN" value={csosn} onChange={(e) => setCsosn(e.target.value)} />
          <Select label="Origem" value={origem} onChange={(e) => setOrigem(e.target.value)}>
            {ORIGEM_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Input label="Unidade comercial" value={unidadeComercial} onChange={(e) => setUnidadeComercial(e.target.value)} />
          <Input label="GTIN / código de barras" value={gtin} onChange={(e) => setGtin(e.target.value)} />
          <Input label="CST PIS" value={pisCst} onChange={(e) => setPisCst(e.target.value)} />
          <Input label="CST COFINS" value={cofinsCst} onChange={(e) => setCofinsCst(e.target.value)} />
          <HelpText style={{ margin: 0 }}>
            04 = monofásico, revenda a alíquota zero (bebidas frias). 49 = outras operações — o padrão para itens que
            não são monofásicos. Confirme com o contador antes de mudar.
          </HelpText>
          <Button variant="primary" disabled={saving} onClick={save}>
            Salvar tributação
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Termos de Uso
// ---------------------------------------------------------------------------
// Aba própria, e não um campo dentro de Meta: é o texto que o responsável
// aceita no check-in, então alterá-lo tem efeito jurídico. Grava por
// fa_config_set_terms, que exige config.terms.write e guarda o texto INTEIRO na
// trilha de auditoria — a pergunta que importa depois é "o que exatamente foi
// aceito naquele dia", não "mudou alguma coisa".
function TermosTab({ unitId }: { unitId: string }) {
  const toast = useToast();
  const [terms, setTerms] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Api.unitSetting(unitId, "terms_of_use")
      .then((r) => setTerms(r.value ?? ""))
      .finally(() => setLoaded(true));
  }, [unitId]);

  async function save() {
    setSaving(true);
    try {
      await Api.setTerms(unitId, terms);
      toast.success("Termos de uso salvos.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar os termos de uso.");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <HelpText>Carregando…</HelpText>;

  return (
    <Card style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: "18px", margin: 0 }}>Termos de Uso</h2>
      <HelpText>
        Texto impresso no comprovante de entrada e apresentado ao responsável no check-in. Cada alteração fica
        registrada com autor, data e o texto completo.
      </HelpText>
      <textarea
        value={terms}
        onChange={(e) => setTerms(e.target.value)}
        rows={16}
        aria-label="Texto dos Termos de Uso"
        style={{
          width: "100%",
          padding: "10px",
          borderRadius: "12px",
          border: "1px solid var(--border-subtle)",
          fontFamily: "inherit",
          lineHeight: 1.5,
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>{terms.length} caracteres</span>
        <Button variant="primary" disabled={saving} onClick={save}>
          Salvar termos
        </Button>
      </div>
    </Card>
  );
}

