import { useCallback, useState } from "react";
import { useBackHandler } from "../hooks/useBackHandler.js";
import type { Unit } from "../api/client.js";
import { useActiveSessions } from "../api/useTick.js";
import { usePendingRenewals } from "../api/renewalRequests.js";
import { useAuth } from "../auth/AuthContext.js";
import { useAppState } from "../state/AppState.js";
import { useToast } from "../state/ToastContext.js";
import { useChat } from "../api/useChat.js";
import { buildChatContext } from "../lib/chat.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { InstallPwaBanner } from "../components/InstallPwaBanner.js";
import { UpdatePwaBanner } from "../components/UpdatePwaBanner.js";
import { MobileHome } from "./MobileHome.js";
import { MobileCheckin } from "./MobileCheckin.js";
import { MobileCheckinCircuito } from "./MobileCheckinCircuito.js";
import { MobilePainel } from "./MobilePainel.js";
import { MobilePedidosTempo } from "./MobilePedidosTempo.js";
import { MobileNavBar, MobileTabBar, TabIcons } from "./MobileNav.js";
import "./mobile.css";

export type EscapeScreen = "ENTRADA" | "SAIDA" | "PAINEL" | "RELATORIO_SESSAO" | "AVALIACOES" | "CAIXA" | "PDV" | "MINHA_BONIFICACAO" | "RELATORIO" | "CONFIGURACOES";

type Tab = "TURNO" | "PAINEL" | "MAIS";
type View = Tab | "CHECKIN" | "PEDIDOS";

// A casca desmonta quando o operador abre uma tela completa (Saída, Caixa…).
// Sem lembrar a aba, o "Voltar" sempre o devolveria ao Turno, mesmo que ele
// tivesse saído do Painel — perde o lugar. Vive fora do componente de
// propósito: só precisa sobreviver ao desmonte, não ao reload.
let lastTab: Tab = "TURNO";
let lastTabOwner: string | null = null;
const TAB_LABEL: Record<Tab, string> = { TURNO: "Turno", PAINEL: "Painel", MAIS: "Mais" };

/** Rótulo do botão "Voltar" das telas completas: a aba de onde o operador saiu. */
export function mobileReturnLabel(): string {
  return TAB_LABEL[lastTab];
}

/**
 * Casca mobile do operador.
 *
 * Contém as três coisas que acontecem com a família parada na frente do
 * colaborador — a fila do turno, a entrada e o cronômetro — e mais nada.
 * Tudo o que envolve dinheiro fechando (checkout, fiscal, caixa) abre a
 * tela completa de propósito: são fluxos testados, com regra fiscal e
 * impressão, e uma segunda implementação deles no celular seria uma
 * segunda regra de negócio para divergir da primeira.
 */
export function MobileShell({
  unit,
  employeeName,
  employeeId,
  onAbrirTelaCompleta,
  onUsarVersaoCompleta,
  onTrocarModulo,
  onSair,
}: {
  unit: Unit;
  employeeName: string;
  employeeId: string;
  onAbrirTelaCompleta: (screen: EscapeScreen) => void;
  onUsarVersaoCompleta: () => void;
  onTrocarModulo: () => void;
  onSair: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  // Outro colaborador no mesmo aparelho começa sempre no Turno.
  if (lastTabOwner !== employeeId) {
    lastTabOwner = employeeId;
    lastTab = "TURNO";
  }
  const [view, setViewState] = useState<View>(lastTab);
  const setView = (next: View) => {
    if (next === "TURNO" || next === "PAINEL" || next === "MAIS") lastTab = next;
    setViewState(next);
  };
  const { entries, status, refetch } = useActiveSessions(unit.id);
  // Mesma fila que já existe no badge do Painel de balcão (PainelScreen.tsx)
  // — reaproveita as sessões já carregadas acima, sem abrir uma segunda
  // assinatura Realtime só para isto.
  const pendingRenewals = usePendingRenewals(entries.map((e) => e.session.id));

  // Chat com os donos: no balcão é o botão flutuante CHAT (App.tsx), que a
  // casca mobile não monta. Aqui ele vira uma linha em "Mais" com o mesmo
  // hook e o mesmo painel — o aviso de mensagem nova aparece na aba Mais.
  const [chatOpen, setChatOpen] = useState(false);
  const chatEnabled = can("chat.usar");
  const getChatContext = useCallback(
    () =>
      buildChatContext({
        screen: "MOBILE",
        unitId: unit.id,
        appVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : undefined,
        userAgent: navigator.userAgent,
      }),
    [unit.id],
  );
  const chat = useChat({ enabled: chatEnabled, panelOpen: chatOpen, getContext: getChatContext });

  // O gesto/botão "voltar" do Android fecha o chat, depois o check-in/pedidos,
  // em vez de sair do app — sem isto o operador perde o lugar ao tocar por reflexo.
  const subView = view === "CHECKIN" || view === "PEDIDOS";
  useBackHandler((chatOpen ? 1 : 0) + (subView ? 1 : 0), () => {
    if (chatOpen) return setChatOpen(false);
    setView("TURNO");
  });

  const activeCount = status === "ready" ? entries.length : null;

  // No Circuito (quiosque) a entrada exige escolher o veículo — o passo
  // extra que MobileCheckinCircuito resolve (busca → veículo → checklist +
  // plano/pacote), reaproveitando o mesmo fa_checkin de sempre.
  const isQuiosque = unit.kind === "QUIOSQUE";

  function abrirCompleta(screen: EscapeScreen, reason?: string) {
    if (reason) toast.success(reason);
    onAbrirTelaCompleta(screen);
  }

  const tabs = [
    { id: "TURNO" as const, label: "Turno", icon: TabIcons.turno, badge: pendingRenewals.size },
    { id: "PAINEL" as const, label: "Painel", icon: TabIcons.painel, show: can("sessao.checkout") },
    { id: "MAIS" as const, label: "Mais", icon: TabIcons.mais, badge: chatEnabled ? chat.unread : 0 },
  ];

  return (
    <div className="m-shell">
      <div className="m-frame">
        {view === "CHECKIN" ? (
          <>
            <MobileNavBar title={isQuiosque ? "Nova sessão" : "Nova entrada"} backLabel="Turno" onBack={() => setView("TURNO")} />
            {isQuiosque ? (
              <MobileCheckinCircuito unitId={unit.id} employeeId={employeeId} onDone={() => void refetch()} />
            ) : (
              <MobileCheckin
                unitId={unit.id}
                employeeId={employeeId}
                onEscape={(screen, reason) => abrirCompleta(screen, reason)}
                onDone={() => void refetch()}
              />
            )}
          </>
        ) : view === "TURNO" ? (
          <MobileHome
            unit={unit}
            employeeName={employeeName}
            activeCount={activeCount}
            onNovaEntrada={() => setView("CHECKIN")}
            onAbrirTela={(screen) => abrirCompleta(screen)}
            pendingRenewalsCount={pendingRenewals.size}
            onAbrirPedidos={() => setView("PEDIDOS")}
            onAbrirPainel={() => setView("PAINEL")}
          />
        ) : view === "PEDIDOS" ? (
          <>
            <MobileNavBar title="Pedidos de tempo" backLabel="Turno" onBack={() => setView("TURNO")} />
            <MobilePedidosTempo entries={entries} pending={pendingRenewals} employeeId={employeeId} />
          </>
        ) : view === "PAINEL" ? (
          <MobilePainel unitId={unit.id} isQuiosque={isQuiosque} onLiberarSaida={() => abrirCompleta("SAIDA")} />
        ) : (
          <MobileMais
            unitName={unit.name}
            employeeName={employeeName}
            onAbrirTela={abrirCompleta}
            chat={chatEnabled ? { unread: chat.unread, onOpen: () => setChatOpen(true) } : null}
            onUsarVersaoCompleta={onUsarVersaoCompleta}
            onTrocarModulo={onTrocarModulo}
            onSair={onSair}
          />
        )}

        {/* Os dois banners vivem no rodapé da casca de balcão (App.tsx), que
            a casca mobile substitui inteira no celular — sem repeti-los aqui,
            justamente quem mais precisa deles nunca os veria: é o
            InstallPwaBanner que ensina a botar o app na tela inicial (o
            "Adicionar à Tela de Início" do iOS não tem prompt programático),
            e o UpdatePwaBanner que avisa da versão nova. */}
        <InstallPwaBanner />
        <UpdatePwaBanner />

        {chatOpen && (
          <ChatPanel
            messages={chat.messages}
            loading={chat.loading}
            error={chat.error}
            onSend={(body, file) => chat.send(body, file, employeeId)}
            onRetry={(id) => void chat.retry(id)}
            onClose={() => setChatOpen(false)}
          />
        )}

        {/* Fica visível também em "Pedidos de tempo" (aba Turno acesa): só o
            check-in esconde a barra, porque é um fluxo que pede foco total
            e já tem o próprio "Turno" no topo. */}
        {view !== "CHECKIN" && (
          <MobileTabBar tabs={tabs} active={view === "PEDIDOS" ? "TURNO" : view} onSelect={(id) => setView(id)} />
        )}
      </div>
    </div>
  );
}

function MobileMais({
  unitName,
  employeeName,
  onAbrirTela,
  chat,
  onUsarVersaoCompleta,
  onTrocarModulo,
  onSair,
}: {
  unitName: string;
  employeeName: string;
  onAbrirTela: (screen: EscapeScreen) => void;
  chat: { unread: number; onOpen: () => void } | null;
  onUsarVersaoCompleta: () => void;
  onTrocarModulo: () => void;
  onSair: () => void;
}) {
  const { can } = useAuth();
  const { employee } = useAppState();

  const telas: Array<{ screen: EscapeScreen; titulo: string; ajuda: string; show: boolean; grupo: "ATENDIMENTO" | "GESTAO" }> = [
    { screen: "ENTRADA", titulo: "Entrada completa", ajuda: "criança nova, cupom, pacote, carrinho, contrato", show: can("sessao.checkin"), grupo: "ATENDIMENTO" },
    { screen: "SAIDA", titulo: "Saída", ajuda: "cobrar o excedente, emitir nota e liberar", show: can("sessao.checkout"), grupo: "ATENDIMENTO" },
    { screen: "RELATORIO_SESSAO", titulo: "Olhar FaçaAmigos", ajuda: "mapa de observação e registro pro responsável", show: can("relatorio_sessao.write"), grupo: "ATENDIMENTO" },
    { screen: "AVALIACOES", titulo: "Avaliações", ajuda: "chegada, saída e avaliação das crianças do playground", show: can("avaliacao_playground.write"), grupo: "ATENDIMENTO" },
    { screen: "PDV", titulo: "PDV", ajuda: "vender produto avulso", show: can("pdv.sell"), grupo: "ATENDIMENTO" },
    { screen: "CAIXA", titulo: "Caixa", ajuda: "abrir turno, sangria, fechar", show: can("caixa.open_close"), grupo: "GESTAO" },
    { screen: "MINHA_BONIFICACAO", titulo: "Minha Bonificação", ajuda: "seu ticket médio e o acumulado do mês, só seu", show: can("bonificacao.self"), grupo: "GESTAO" },
    { screen: "RELATORIO", titulo: "Relatórios", ajuda: "vendas, visitas e planos", show: can("relatorio.read"), grupo: "GESTAO" },
    { screen: "CONFIGURACOES", titulo: "Configurações", ajuda: "planos, produtos, equipe, unidade", show: can("config.read"), grupo: "GESTAO" },
  ];

  return (
    <>
      <div className="m-appbar">
        <div className="m-grow">
          <p className="m-title">Mais</p>
          <p className="m-sub">
            {employeeName} · {unitName}
          </p>
        </div>
      </div>

      <div className="m-scroll">
        {chat && (
          <button
            type="button"
            className="m-tap m-card"
            onClick={chat.onOpen}
            style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", marginBottom: 22, font: "inherit", textAlign: "left" }}
          >
            <span className="m-grow">
              <span style={{ display: "block", fontSize: 15.5, fontWeight: 800 }}>Chat</span>
              <span style={{ display: "block", marginTop: 3, fontSize: 12.5, lineHeight: 1.4, fontWeight: 600, color: "var(--text-muted)" }}>
                {chat.unread > 0 ? `${chat.unread} mensagem(ns) nova(s)` : "sistema, problemas e avisos"}
              </span>
            </span>
            {chat.unread > 0 && (
              <span className="m-tab-badge" style={{ position: "static" }} aria-hidden="true">
                {chat.unread > 9 ? "9+" : chat.unread}
              </span>
            )}
            <span aria-hidden="true" style={{ fontSize: 20, color: "var(--color-gray-300)", flex: "none" }}>
              ›
            </span>
          </button>
        )}

        {(["ATENDIMENTO", "GESTAO"] as const).map((grupo, i) => {
          const itens = telas.filter((t) => t.show && t.grupo === grupo);
          if (itens.length === 0) return null;
          return (
            <section key={grupo}>
              <p className="m-eyebrow" style={{ marginTop: i === 0 ? 0 : 22 }}>
                {grupo === "ATENDIMENTO" ? "Atendimento" : "Caixa e gestão"}
              </p>
              <div className="m-stack" style={{ gap: 10, marginTop: 10 }}>
                {itens.map((t) => (
                  <button
                    key={t.screen}
                    type="button"
                    className="m-tap m-card"
                    onClick={() => onAbrirTela(t.screen)}
                    style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", font: "inherit", textAlign: "left" }}
                  >
                    <span className="m-grow">
                      <span style={{ display: "block", fontSize: 15.5, fontWeight: 800 }}>{t.titulo}</span>
                      <span style={{ display: "block", marginTop: 3, fontSize: 12.5, lineHeight: 1.4, fontWeight: 600, color: "var(--text-muted)" }}>
                        {t.ajuda}
                      </span>
                    </span>
                    <span aria-hidden="true" style={{ fontSize: 20, color: "var(--color-gray-300)", flex: "none" }}>
                      ›
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}

        <p className="m-eyebrow" style={{ marginTop: 22 }}>
          Este aparelho
        </p>
        <div className="m-stack" style={{ gap: 10, marginTop: 10 }}>
          <button type="button" className="m-pill" onClick={onUsarVersaoCompleta}>
            Usar versão de computador neste aparelho
          </button>
          {employee?.role !== "OPERADOR" && (
            <button type="button" className="m-pill" onClick={onTrocarModulo}>
              Trocar de unidade
            </button>
          )}
          <button type="button" className="m-pill" onClick={onSair} style={{ color: "var(--color-primary-hover)" }}>
            Sair
          </button>
        </div>
      </div>
    </>
  );
}
