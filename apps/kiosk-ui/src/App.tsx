import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  Button,
  BrandLockup,
  BrandLoader,
  SignInIcon,
  GridIcon,
  ShoppingCartIcon,
  WalletIcon,
  ClockIcon,
  ChartBarIcon,
  GearIcon,
  ArrowClockwiseIcon,
  ListIcon,
  XIcon,
} from "@facaamigos/ui";
import { unitBrandFor } from "./branding/unitBrand.js";
import { useSwipeNavigation } from "./hooks/useSwipeNavigation.js";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.js";
import { usePrintFailureAlerts } from "./hooks/usePrintFailureAlerts.js";
import { useSessionReportFailureAlerts } from "./hooks/useSessionReportFailureAlerts.js";
import { useAppState } from "./state/AppState.js";
import { useConfirm } from "./state/ConfirmContext.js";
import { useAuth } from "./auth/AuthContext.js";
import { RequireCapability } from "./auth/RequireCapability.js";
import { SCREEN_CAPABILITY, type Screen } from "./auth/screens.js";
import { ROLE_LABEL } from "./auth/capabilities.js";
import {
  OnboardingInviteScreen,
  GeneralOnboardingScreen,
  GeneralPjOnboardingScreen,
  AcompanharScreen,
  AcessoRapidoScreen,
  EntradaScreen,
  SaidaScreen,
  RelatorioSessaoScreen,
  PdvScreen,
  CaixaScreen,
  MinhaBonificacaoScreen,
  RelatorioScreen,
  ConfiguracoesScreen,
  AniversariosScreen,
  GerencialApp,
  TapReturnScreen,
  prefetchHotScreens,
} from "./lazyScreens.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { SelectModuleScreen } from "./screens/SelectModuleScreen.js";
import { PainelScreen } from "./screens/PainelScreen.js";
import { PendingSessionReportsBadge } from "./components/session-report/PendingSessionReportsBadge.js";
import { parseTapReturn } from "./lib/infinitepayTap.js";
import { ConnectDeviceModal } from "./components/ConnectDeviceModal.js";
import { ConnectionStatusChip } from "./components/ConnectionStatusChip.js";
import { InstallPwaBanner } from "./components/InstallPwaBanner.js";
import { UpdatePwaBanner } from "./components/UpdatePwaBanner.js";
import { GlobalPdfReceiptModalListener } from "./components/PdfReceiptModal.js";
import { OwnerFloatingDashboard } from "./components/OwnerFloatingDashboard.js";
import { ChatFab } from "./components/ChatFab.js";
import { isElectronLocal } from "./pwa.js";
import { ensureOwnerPushSubscription } from "./lib/push.js";
import { Api } from "./api/client.js";
import type { Unit } from "./api/client.js";
import { MobileShell, mobileReturnLabel } from "./mobile/MobileShell.js";
import { MobileScreenFrame } from "./mobile/MobileScreenFrame.js";
import { MobileGerencial } from "./mobile/MobileGerencial.js";
import { MobileLogin } from "./mobile/MobileLogin.js";
import { useBackHandler } from "./hooks/useBackHandler.js";
import { useMobileShell } from "./mobile/useMobileShell.js";
import { Emoji3D } from "./components/Emoji3D.js";


const SCREENS: ReadonlyArray<{ value: Screen; label: string; help: string; icon: ReactNode }> = [
  { value: "ENTRADA", label: "Entrada", help: "Cadastrar a chegada de uma criança: escolher o plano, identificar responsável e imprimir a pulseira e o recibo de guarda", icon: <SignInIcon /> },
  // Saída não fica na barra superior de propósito: o único caminho de
  // liberação agora é o botão flutuante amarelo dentro do Painel (ver
  // PainelScreen.tsx) — evita duas entradas concorrentes para a mesma ação.
  { value: "PAINEL", label: "Painel", help: "Ver todas as crianças que estão no espaço agora, quanto tempo já ficaram e fechar o atendimento (cobrar) quando forem embora", icon: <GridIcon /> },
  { value: "RELATORIO_SESSAO", label: "Olhar FaçaAmigos", help: "Preencher o mapa de observação das crianças com plano de 1h ou mais, até 40 minutos depois da saída, e enviar o Olhar FaçaAmigos ao responsável por WhatsApp", icon: <span><Emoji3D e="📝" /></span> },
  { value: "PDV", label: "PDV", help: "Vender produtos avulsos (loja/lanchonete), sem estar ligado a uma entrada", icon: <ShoppingCartIcon /> },
  { value: "CAIXA", label: "Caixa", help: "Abrir e fechar o turno de caixa, conferir o dinheiro e registrar sangria/suprimento", icon: <WalletIcon /> },
  { value: "MINHA_BONIFICACAO", label: "Minha Bonificação", help: "Consultar só os seus números do programa de bonificação: ticket médio, progresso da meta e acumulado do mês. Somente consulta.", icon: <span><Emoji3D e="🎮" /></span> },
  { value: "RELATORIO", label: "Relatório", help: "Consultar vendas, visitas, planos, movimentação de caixa de períodos anteriores", icon: <ChartBarIcon /> },
  { value: "CONFIGURACOES", label: "Configurações", help: "Ajustar planos, produtos, cupons, colaboradores, unidade, dados fiscais e termos de uso", icon: <GearIcon /> },
];

const SCREEN_COMPONENTS: Record<Screen, ComponentType> = {
  ENTRADA: EntradaScreen,
  SAIDA: SaidaScreen,
  PAINEL: PainelScreen,
  RELATORIO_SESSAO: RelatorioSessaoScreen,
  PDV: PdvScreen,
  CAIXA: CaixaScreen,
  ANIVERSARIOS: AniversariosScreen,
  MINHA_BONIFICACAO: MinhaBonificacaoScreen,
  RELATORIO: RelatorioScreen,
  CONFIGURACOES: ConfiguracoesScreen,
};


export function App() {
  const { units, unit, setUnitId, gerencial, setGerencial, employee, logout, restoring } = useAppState();
  const { can, loading: loadingCapabilities } = useAuth();
  const confirm = useConfirm();
  const [screen, setScreen] = useState<Screen>("PAINEL");
  const [screenHistory, setScreenHistory] = useState<Screen[]>([]);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // Casca mobile: no celular o operador entra por ela, e `mobileEscape`
  // guarda a tela completa que ele pediu de dentro dela (Saída, Caixa…).
  // Enquanto for null, quem manda no celular é a casca.
  const mobile = useMobileShell();
  const [mobileEscape, setMobileEscape] = useState<Screen | null>(null);

  // Com o operador logado e o app interativo, baixa em segundo plano os chunks
  // das telas quentes (Entrada, Saída, PDV, Caixa) para o primeiro uso não esperar.
  useEffect(() => {
    if (employee) prefetchHotScreens();
  }, [employee]);

  // Se for colaborador com perfil Owner e tiver as notificações ativas no dispositivo (localStorage),
  // revalida a inscrição Web Push com o Supabase automaticamente ao carregar o aplicativo.
  useEffect(() => {
    if (employee && (employee.role === "ADMIN" || can("notificacoes.owner_push"))) {
      ensureOwnerPushSubscription(Api).catch(() => {});
    }
  }, [employee, can]);

  // Tela inicial padrão do Owner no celular: abre direto no modo Gerencial
  // (a home "as 3 operações numa tela") em vez de cair na grade de módulos.
  // Só na virada de login/restauração de sessão — depois disso o Owner é
  // livre para sair do Gerencial (setGerencial(false)) sem que este efeito
  // o traga de volta.
  const autoGerencialAppliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!employee) {
      autoGerencialAppliedFor.current = null;
      return;
    }
    // Espera as capabilities chegarem antes de decidir — checar can() com o
    // conjunto ainda vazio (loading) marcaria "já decidi" com um "não" falso
    // e o Owner nunca mais cairia no Gerencial automaticamente nesta sessão.
    if (loadingCapabilities) return;
    if (autoGerencialAppliedFor.current === employee.id) return;
    autoGerencialAppliedFor.current = employee.id;
    if (mobile.active && employee.role !== "OPERADOR" && can("config.write")) {
      setGerencial(true);
    }
  }, [employee, mobile.active, loadingCapabilities, can, setGerencial]);

  function navigateToScreen(newScreen: Screen) {
    if (newScreen === screen) return;
    setScreenHistory((prev) => [...prev, screen].slice(-20));
    setScreen(newScreen);
  }

  // Sair da casca mobile para uma tela completa é uma navegação normal do
  // app — só que decidida lá dentro.
  useEffect(() => {
    if (mobileEscape) setScreen(mobileEscape);
  }, [mobileEscape]);

  // Cada módulo/unidade selecionado sempre abre direto no Painel (tela principal do sistema).
  useEffect(() => {
    if (unit) {
      setScreen("PAINEL");
      setScreenHistory([]);
    }
  }, [unit?.id]);

  // Se o colaborador atual não pode ver a tela em que está — porque trocou de
  // conta no terminal, ou porque o Owner rebaixou o papel dele enquanto a
  // tela estava aberta — cai para a primeira tela permitida em vez de ficar
  // preso num "Área restrita" sem saída.
  useEffect(() => {
    if (loadingCapabilities || !employee) return;
    if (can(SCREEN_CAPABILITY[screen])) return;
    const firstAllowed = SCREENS.find((s) => can(SCREEN_CAPABILITY[s.value]));
    if (firstAllowed) setScreen(firstAllowed.value);
  }, [loadingCapabilities, employee, screen, can]);

  // Calculado antes dos retornos antecipados abaixo (tela de login, seleção
  // de módulo etc.) porque o gesto de arrastar já precisa dele — hooks não
  // podem vir depois de um `return` condicional.
  const visibleScreens = SCREENS.filter((s) => can(SCREEN_CAPABILITY[s.value]));

  const handleGoBack = useCallback(() => {
    if (showConnectModal) {
      setShowConnectModal(false);
      return;
    }
    if (navOpen) {
      setNavOpen(false);
      return;
    }
    setScreenHistory((prev) => {
      if (prev.length === 0) {
        const index = visibleScreens.findIndex((s) => s.value === screen);
        const prevScreen = visibleScreens[index - 1];
        if (prevScreen) {
          setScreen(prevScreen.value);
        }
        return prev;
      }
      const lastScreen = prev[prev.length - 1];
      if (lastScreen) {
        setScreen(lastScreen);
      }
      return prev.slice(0, -1);
    });
  }, [showConnectModal, navOpen, visibleScreens, screen]);

  // Voltar do navegador/celular (botão, gesto de borda) navega dentro do app
  // em vez de sair do site: fecha modal/menu, sai do Gerencial ou da tela
  // completa aberta pela casca mobile, desfaz o histórico de telas e, por
  // fim, cai no Painel.
  const baseBackDepth = !employee || (!unit && !gerencial)
    ? 0
    : gerencial
      ? 1
      : mobile.active && mobileEscape === null
        ? 0
        : (mobileEscape ? 1 : 0) + screenHistory.length + (!mobileEscape && screenHistory.length === 0 && screen !== "PAINEL" ? 1 : 0);
  const backDepth = baseBackDepth + (showConnectModal ? 1 : 0) + (navOpen ? 1 : 0);
  useBackHandler(backDepth, () => {
    if (showConnectModal) return setShowConnectModal(false);
    if (navOpen) return setNavOpen(false);
    if (gerencial) return setGerencial(false);
    if (mobileEscape) return setMobileEscape(null);
    if (screenHistory.length > 0) {
      const last = screenHistory[screenHistory.length - 1];
      setScreenHistory(screenHistory.slice(0, -1));
      if (last) setScreen(last);
      return;
    }
    setScreen("PAINEL");
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
      if (e.altKey && e.key >= "1" && e.key <= "9") {
        const index = parseInt(e.key, 10) - 1;
        const s = visibleScreens[index];
        if (s) {
          e.preventDefault();
          navigateToScreen(s.value);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visibleScreens, screen]);

  const handleSave = useCallback(() => {
    const submitButton = document.querySelector<HTMLButtonElement>(
      "main form button[type='submit'], main button[data-save-button], main .kiosk-save-btn"
    );
    if (submitButton && !submitButton.disabled) {
      submitButton.click();
    }
  }, []);

  useKeyboardShortcuts({
    onGoBack: handleGoBack,
    onEscape: () => {
      if (showConnectModal) setShowConnectModal(false);
      if (navOpen) setNavOpen(false);
    },
    onSave: handleSave,
    enabled: !!employee && !gerencial && !!unit,
  });

  usePrintFailureAlerts(unit?.id ?? null);
  useSessionReportFailureAlerts(unit?.id ?? null);

  const swipeHandlers = useSwipeNavigation(
    () => {
      // Arrastar para a esquerda: próximo módulo, como virar a página.
      const index = visibleScreens.findIndex((s) => s.value === screen);
      const next = index !== -1 ? visibleScreens[index + 1] : undefined;
      if (next) navigateToScreen(next.value);
    },
    () => {
      // Arrastar para a direita: voltar no histórico / módulo anterior.
      handleGoBack();
    },
  );

  function handleChangeModule() {
    setUnitId("");
    setGerencial(false);
  }

  async function handleLogout() {
    const ok = await confirm({
      title: "Sair?",
      message: "O terminal vai voltar para a tela de PIN. Nenhum atendimento em andamento é perdido.",
      confirmLabel: "Sair",
      cancelLabel: "Cancelar",
    });
    if (ok) await logout();
  }

  // Link de convite individual (?convite=<inviteId>.<token>): quem abre
  // ainda não tem NENHUMA conta/sessão — precisa vir ANTES até da checagem
  // de sessão salva abaixo, senão essa pessoa nunca sairia da tela de
  // "Carregando…"/login por PIN.
  const inviteParam = new URLSearchParams(window.location.search).get("convite");
  if (inviteParam) {
    const [inviteId, token] = inviteParam.split(".");
    if (inviteId && token) return <Suspense fallback={<BrandLoader />}><OnboardingInviteScreen inviteId={inviteId} token={token} /></Suspense>;
  }

  // Link Geral de auto-cadastro de estagiário (?cadastro-estagiario=<unitId>.<token>):
  // token fixo por unidade (ver botão na ColaboradoresTab), quem abre ainda
  // não tem NENHUMA conta — mesmo cuidado do branch `?convite=` acima, tem
  // que vir antes de qualquer checagem de sessão salva.
  const cadastroEstagiarioParam = new URLSearchParams(window.location.search).get("cadastro-estagiario");
  if (cadastroEstagiarioParam) {
    const [unitId, token] = cadastroEstagiarioParam.split(".");
    if (unitId && token) return <Suspense fallback={<BrandLoader />}><GeneralOnboardingScreen unitId={unitId} token={token} /></Suspense>;
  }

  // Link Geral de auto-cadastro de prestador PJ (?cadastro-pj=<unitId>.<token>):
  const cadastroPjParam = new URLSearchParams(window.location.search).get("cadastro-pj");
  if (cadastroPjParam) {
    const [unitId, token] = cadastroPjParam.split(".");
    if (unitId && token) return <Suspense fallback={<BrandLoader />}><GeneralPjOnboardingScreen unitId={unitId} token={token} /></Suspense>;
  }

  // Painel do responsável (?acompanhar=<access_code>): quem abre é o pai/mãe
  // que escaneou o QR mostrado no check-in, sem NENHUMA conta no sistema —
  // mesmo espírito do branch `?convite=` acima, tem que vir antes de
  // qualquer checagem de sessão salva.
  const acompanharParam = new URLSearchParams(window.location.search).get("acompanhar");
  if (acompanharParam) {
    return <Suspense fallback={<BrandLoader />}><AcompanharScreen code={acompanharParam} /></Suspense>;
  }

  // QR Code de Acesso Rápido (?acesso-rapido=<unit_id>): cartaz fixo na
  // entrada da unidade. Mesmo espírito dos branches acima — o responsável
  // não tem NENHUMA conta, então isto também precisa vir antes de qualquer
  // checagem de sessão salva.
  const acessoRapidoParam = new URLSearchParams(window.location.search).get("acesso-rapido");
  if (acessoRapidoParam) {
    return <Suspense fallback={<BrandLoader />}><AcessoRapidoScreen unitId={acessoRapidoParam} /></Suspense>;
  }


  // Enquanto a sessão salva não foi conferida, não decide nada: mostrar a
  // tela de login por um instante para quem já está logado faz o operador
  // digitar o PIN à toa a cada refresh.
  if (restoring) {
    return <BrandLoader />;
  }

  // Login por PIN não tem valor de negócio pra divergir entre versões —
  // MobileLogin usa exatamente os mesmos useAppState()/Api.employeesForLogin
  // de LoginScreen, só com a casca do modo celular.
  if (!employee) {
    return mobile.active ? <MobileLogin /> : <LoginScreen />;
  }

  // Modo Gerencial: fora do contexto das 3 unidades, é onde o Owner configura
  // o que vale para várias unidades de uma vez e vê relatórios cross-unit.
  // No celular a porta de entrada é a home "as 3 operações numa tela"
  // (MobileGerencial), não o console de 21 abas direto — ver o comentário
  // em mobile/MobileGerencial.tsx.
  // Modo Gerencial: fora do contexto das 3 unidades, é onde o Owner configura
  // o que vale para várias unidades de uma vez e vê relatórios cross-unit.
  // Operador NUNCA acessa o módulo Gerencial.
  if (gerencial) {
    if (employee?.role === "OPERADOR" || !can("config.write")) {
      setGerencial(false);
    } else {
      if (mobile.active) {
        return <MobileGerencial units={units} onExit={() => setGerencial(false)} onLogout={handleLogout} />;
      }
      return <Suspense fallback={<BrandLoader />}><GerencialApp onExit={() => setGerencial(false)} onLogout={handleLogout} /></Suspense>;
    }
  }

  // Se nenhuma operação/módulo foi selecionado ainda, exibe a Tela Inicial de Seleção de Módulo
  if (!unit) {
    return <SelectModuleScreen />;
  }

  // Retorno do app InfinitePay depois de uma cobrança por aproximação
  // (InfiniteTap, ver lib/infinitepayTap.ts). Precisa vir depois dos
  // checks de employee/unit acima porque finaliza a venda via API — mas
  // antes do resto porque não faz sentido decidir tela/módulo no meio de
  // uma cobrança pendente de confirmação.
  const tapReturn = parseTapReturn(window.location.search);
  if (tapReturn) {
    return <Suspense fallback={<BrandLoader />}><TapReturnScreen search={window.location.search} onDone={() => navigateToScreen("PAINEL")} /></Suspense>;
  }

  // Celular: a casca mobile é a porta de entrada. Só sai dela quando o
  // próprio operador pede uma tela completa (mobileEscape) ou desliga o
  // modo para este aparelho (mobile.active).
  if (mobile.active && mobileEscape === null && employee) {
    return (
      <MobileShell
        unit={unit}
        employeeName={employee.full_name}
        employeeId={employee.id}
        onAbrirTelaCompleta={(s) => setMobileEscape(s)}
        onUsarVersaoCompleta={mobile.useFullVersion}
        onTrocarModulo={handleChangeModule}
        onSair={handleLogout}
      />
    );
  }

  // Toda tela completa aberta pela casca mobile continua sendo a MESMA tela
  // do balcão — não uma segunda implementação — só vestida com a barra do
  // modo celular ("‹ Turno" + título) em vez do cabeçalho de balcão (marca +
  // 8 botões + menu hambúrguer). Antes só Saída/Caixa/PDV/Olhar tinham essa
  // moldura; Entrada completa, Relatórios, Configurações e Bonificação caíam
  // no fallback abaixo e o operador ficava com dois menus ao mesmo tempo.
  // O fallback (botão flutuante) só resta para telas fora desta lista.
  const MOBILE_FRAMED_TITLE: Partial<Record<Screen, string>> = {
    ENTRADA: "Entrada completa",
    SAIDA: "Saída",
    CAIXA: "Caixa",
    PDV: "PDV",
    RELATORIO_SESSAO: "Olhar FaçaAmigos",
    MINHA_BONIFICACAO: "Minha Bonificação",
    RELATORIO: "Relatórios",
    CONFIGURACOES: "Configurações",
  };
  if (mobile.active && mobileEscape != null && mobileEscape in MOBILE_FRAMED_TITLE && employee) {
    const FramedComponent = SCREEN_COMPONENTS[mobileEscape];
    return (
      <MobileScreenFrame title={MOBILE_FRAMED_TITLE[mobileEscape]!} backLabel={mobileReturnLabel()} onBack={() => setMobileEscape(null)}>
        <RequireCapability capability={SCREEN_CAPABILITY[mobileEscape]}>
          <Suspense fallback={<BrandLoader />}>
            <FramedComponent />
          </Suspense>
        </RequireCapability>
      </MobileScreenFrame>
    );
  }

  const ScreenComponent = SCREEN_COMPONENTS[screen];
  const brand = unitBrandFor(unit.name);

  return (
    <div className="kiosk-shell" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Régua da operação: a faixa de cor mais persistente da tela, para
          o operador saber em que unidade está sem precisar ler nada. */}
      <div style={{ flexShrink: 0, height: "3px", background: brand.accent }} />

      {/* Volta para a casca mobile depois de um desvio para a tela completa.
          Sem isto o operador que tocou em "Saída" no celular fica preso nas
          telas de balcão até fechar o app. */}
      {mobile.active && mobileEscape !== null && (
        <button
          type="button"
          onClick={() => setMobileEscape(null)}
          style={{
            position: "fixed",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
            zIndex: 60,
            border: "none",
            borderRadius: "9999px",
            padding: "12px 20px",
            minHeight: "44px",
            background: "var(--color-dark)",
            color: "#fff",
            font: "inherit",
            fontSize: "13px",
            fontWeight: 800,
            boxShadow: "0 8px 24px rgba(0,0,0,.28)",
            cursor: "pointer",
          }}
        >
          ‹ Voltar ao modo celular
        </button>
      )}


      <header
        className="kiosk-header"
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "16px",
          padding: "10px 24px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--surface-card)",
          flexWrap: "wrap",
        }}
      >
        <BrandLockup
          operation={brand.operation}
          accent={brand.accent}
          size="sm"
          title={`${brand.icon} ${unit.name}`}
        />

        {/* Só aparece em telas de celular (ver .kiosk-nav-toggle no
            app.css) — no computador o menu completo já cabe ao lado da
            marca e fica sempre aberto. */}
        <button
          type="button"
          className="kiosk-nav-toggle"
          onClick={() => setNavOpen((open) => !open)}
          aria-expanded={navOpen}
          aria-controls="kiosk-nav-menu"
          title={navOpen ? "Fechar menu de módulos" : "Abrir menu de módulos"}
          style={{
            marginLeft: "12px",
            width: "36px",
            height: "36px",
            flexShrink: 0,
            display: "none",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "50%",
            border: "1px solid var(--border-subtle)",
            background: "var(--surface-card)",
            color: "var(--color-primary-hover)",
            cursor: "pointer",
            fontSize: "18px",
          }}
        >
          {navOpen ? <XIcon /> : <ListIcon />}
        </button>

        <nav id="kiosk-nav-menu" className={`kiosk-nav${navOpen ? " is-open" : ""}`} style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginLeft: "12px" }}>
          {/* Esconder o que o colaborador não pode fazer é UX, não segurança:
              quem protege é a RLS e as RPCs fa_config_*. Por isso a tela em
              si também é guardada logo abaixo, com <RequireCapability>.
              O contorno em cada botão (mesmo os "ghost") é de propósito:
              sem ele, rótulo + ícone rosa sobre fundo branco se confundem
              com texto comum — o contorno é o que avisa "isto é clicável". */}
          {visibleScreens.map((s, index) => (
            <Button
              key={s.value}
              variant={screen === s.value ? "teal" : "ghost"}
              size="sm"
              className="kiosk-nav-btn"
              title={mobile.isPhone ? s.help : `${s.help} (Alt+${index + 1})`}
              aria-current={screen === s.value ? "page" : undefined}
              onClick={() => {
                navigateToScreen(s.value);
                setNavOpen(false);
              }}
              style={{ border: screen === s.value ? "1px solid transparent" : "1px solid var(--border-subtle)" }}
            >
              {s.icon} {s.label}
              {s.value === "RELATORIO_SESSAO" && <PendingSessionReportsBadge unitId={unit.id} />}
              {!mobile.isPhone && (
                <kbd className="kiosk-nav-kbd" style={{ marginLeft: "6px", fontSize: "10px", padding: "2px 4px", borderRadius: "4px", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", color: "var(--text-muted)" }}>
                  Alt+{index + 1}
                </kbd>
              )}
            </Button>
          ))}
        </nav>

        <div className="kiosk-header-right" style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <ConnectionStatusChip />

          {/* Pareamento por QR: só faz sentido no computador do balcão —
              no celular/tablet quem guia a instalação é o InstallPwaBanner. */}
          {isElectronLocal() && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowConnectModal(true)}
              title="Conectar celular/tablet lendo um QR Code — instala o aplicativo no aparelho"
              style={{ fontSize: "12px", border: "1px solid var(--color-teal)", color: "var(--color-teal-text)", background: "rgba(29, 155, 132, 0.08)" }}
            >
              <Emoji3D e="📱" /> <span className="kiosk-connect-label">Conectar celular/tablet</span>
            </Button>
          )}

          <span
            className="kiosk-user"
            title={`${employee.full_name} · ${ROLE_LABEL[employee.role]}`}
            style={{ fontSize: "13px", color: "var(--text-secondary)", fontWeight: "var(--weight-semibold)" as unknown as number }}
          >
            {employee.full_name} · {ROLE_LABEL[employee.role]}
          </span>

          {employee.role !== "OPERADOR" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleChangeModule}
              title="Alternar para a tela inicial de seleção de módulos"
              style={{ fontSize: "12px", border: "1px solid var(--border-subtle)" }}
            >
              <ArrowClockwiseIcon /> Trocar Módulo
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            title="Encerrar a sessão deste colaborador no terminal"
            style={{ fontSize: "12px", border: "1px solid var(--border-subtle)" }}
          >
            Sair
          </Button>
        </div>
      </header>

      {showConnectModal && <ConnectDeviceModal onClose={() => setShowConnectModal(false)} />}

      <InstallPwaBanner />
      <UpdatePwaBanner />
      <GlobalPdfReceiptModalListener />
      <OwnerFloatingDashboard />
      <ChatFab screen={screen} />

      {/* flex:1 + minHeight:0 é o que faz o filho poder ser 100% de altura
          sem estourar o pai — sem minHeight:0 um flex item nunca encolhe
          abaixo do seu conteúdo, e a rolagem "vaza" pra página inteira.
          Em telas de celular (ver .kiosk-main no app.css) essa contenção
          é desligada de propósito: com o cabeçalho quebrando em várias
          linhas, a altura fixa sobrava pouco espaço pro quadro — melhor
          deixar a página inteira rolar do que espremer o conteúdo. */}
      {/* Arrastar o dedo para os lados troca de módulo — gesto extra além
          da barra/menu, pensado para o celular (ver useSwipeNavigation). */}
      <main className="kiosk-main" style={{ flex: 1, minHeight: 0, paddingBottom: "var(--install-banner-height, 0px)" }} {...swipeHandlers}>
        {ScreenComponent && (
          <RequireCapability capability={SCREEN_CAPABILITY[screen]}>
            <Suspense fallback={<BrandLoader />}>
              <ScreenComponent />
            </Suspense>
          </RequireCapability>
        )}
      </main>
    </div>
  );
}
