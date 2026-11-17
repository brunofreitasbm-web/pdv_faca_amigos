import { useState, useMemo } from "react";
import { Button, BrandLockup } from "@facaamigos/ui";
import { useAppState } from "../../state/AppState.js";
import { RequireCapability } from "../../auth/RequireCapability.js";
import { ROLE_LABEL } from "../../auth/capabilities.js";
import type { Capability } from "../../auth/capabilities.js";
import { useAuth } from "../../auth/AuthContext.js";
import { PlanosTab } from "./tabs/PlanosTab.js";
import { PacotesTab } from "./tabs/PacotesTab.js";
import { ProdutosTab } from "./tabs/ProdutosTab.js";
import { CuponsTab } from "./tabs/CuponsTab.js";
import { FidelidadeTab } from "./tabs/FidelidadeTab.js";
import { MetasTab } from "./tabs/MetasTab.js";
import { BonificacaoTab } from "./tabs/BonificacaoTab.js";
import { ColaboradoresTab } from "./tabs/ColaboradoresTab.js";
import { OcorrenciasTab } from "./tabs/OcorrenciasTab.js";
import { PermissoesTab } from "./tabs/PermissoesTab.js";
import { AparelhosTab } from "./tabs/AparelhosTab.js";
import { GerencialRelatorioTab } from "./tabs/GerencialRelatorioTab.js";
import { FolhaPagamentoTab } from "./tabs/FolhaPagamentoTab.js";
import { PassagemTurnoTab } from "./tabs/PassagemTurnoTab.js";
import { AberturaFechamentoTab } from "./tabs/AberturaFechamentoTab.js";
import { FotosEnvelopeTab } from "./tabs/FotosEnvelopeTab.js";
import { SaldoEnvelopesTab } from "./tabs/SaldoEnvelopesTab.js";
import { HistoricoTab } from "./tabs/HistoricoTab.js";
import { AuditoriaTab } from "./tabs/AuditoriaTab.js";
import { ContratoTab } from "./tabs/ContratoTab.js";
import { BobinasTab } from "./tabs/BobinasTab.js";
import { BancoTalentosTab } from "./tabs/BancoTalentosTab.js";
import { ClientesTab } from "./tabs/ClientesTab.js";
import { CrmWhatsappTab } from "./tabs/CrmWhatsappTab.js";
import { AniversarioCortesiaTab } from "./tabs/AniversarioCortesiaTab.js";
import { RelatoriosSessaoTab } from "./tabs/RelatoriosSessaoTab.js";
import { OwnerAcompanhamentoTab } from "./tabs/OwnerAcompanhamentoTab.js";
import { NpsDashboardTab } from "./tabs/NpsDashboardTab.js";
import { GeminiGerencialCopilot } from "../../components/GeminiGerencialCopilot.js";
import { isElectronLocal } from "../../pwa.js";
import { Emoji3D, renderEmoji } from "../../components/Emoji3D.js";

/**
 * Cópia de nome fixo do instalador, mantida por scripts/release-kiosk.mjs no
 * bucket público de updates: o link não quebra quando a versão muda.
 */
const INSTALADOR_URL =
  "https://ivjvpdzsfjdpyabbzzuj.supabase.co/storage/v1/object/public/kiosk-updates/kiosk/FacaAmigos-Setup-atual.exe";

export type GerencialTab =
  | "ACOMPANHAMENTO_OWNER"
  | "NPS_DASHBOARD"
  | "PLANOS"
  | "PACOTES"
  | "PRODUTOS"
  | "CUPONS"
  | "FIDELIDADE"
  | "METAS"
  | "COLABORADORES"
  | "OCORRENCIAS"
  | "PERMISSOES"
  | "APARELHOS"
  | "CLIENTES"
  | "CRM_WHATSAPP"
  | "ANIVERSARIO_CORTESIA"
  | "RELATORIOS_SESSAO"
  | "RELATORIOS"
  | "FOLHA"
  | "BONIFICACAO"
  | "ABERTURA_FECHAMENTO"
  | "PASSAGEM_TURNO"
  | "FOTOS_ENVELOPE"
  | "SALDO_ENVELOPES"
  | "HISTORICO"
  | "AUDITORIA"
  | "CONTRATO"
  | "TALENTOS"
  | "BOBINAS"
  | "COPILOT_IA";

interface ModuleItem {
  value: GerencialTab;
  label: string;
  icon: string;
  tag?: string;
  description: string;
  /** Item escondido de quem não tem a capacidade (só conveniência; o servidor decide). */
  capability?: Capability;
}

interface ModuleCategory {
  id: string;
  label: string;
  icon: string;
  badge?: string;
  description: string;
  items: ModuleItem[];
}

const CATEGORIES: ModuleCategory[] = [
  {
    id: "visao_geral",
    label: "Visão Geral & IA",
    icon: "⚡",
    badge: "Estratégico",
    description: "Cockpit executivo, assistente de vendas e inteligência de mercado",
    items: [
      { value: "NPS_DASHBOARD", label: "Dashboard NPS", icon: "📈", tag: "Novo", description: "NPS, equipe e espaço por unidade, taxa de resposta, tendência, detratores a tratar e contribuições dos responsáveis." },
      { value: "COPILOT_IA", label: "ZoeIA (Copilot)", icon: "✦", tag: "IA Vendas", description: "Assistente comercial humana para sugestões automáticas e aumento de ticket médio." },
      { value: "RELATORIOS", label: "Relatórios Consolidados", icon: "📊", description: "Vendas, visitas, planos e sessões unificadas da rede." },
    ],
  },
  {
    id: "comercial",
    label: "Comercial & Vendas",
    icon: "🏷️",
    badge: "Receita",
    description: "Engenharia de preços, catálogo de produtos, pacotes VIP e fidelidade",
    items: [
      { value: "PLANOS", label: "Planos de Preços", icon: "🎟️", description: "Cadastre planos e defina valores e vigência por unidade." },
      { value: "PACOTES", label: "Pacotes VIP", icon: "🎁", tag: "Ticket Alto", description: "Catálogo de pacotes de horas oferecidos como upgrade VIP." },
      { value: "PRODUTOS", label: "Produtos & Bar", icon: "🍿", description: "Itens vendidos avulsos no PDV e controle de estoque por loja." },
      { value: "CUPONS", label: "Cupons & Descontos", icon: "🎟️", description: "Códigos de desconto e campanhas de parceiros." },
      { value: "FIDELIDADE", label: "Programa Fidelidade", icon: "⭐", description: "Recompensas automáticas para encantar e reter clientes recorrentes." },
      { value: "CONTRATO", label: "Modelo de Contrato", icon: "📄", description: "Contrato impresso para prestação de serviços em planos de 2h+." },
    ],
  },
  {
    id: "financeiro_metas",
    label: "Metas & Financeiro",
    icon: "💰",
    badge: "Desempenho",
    description: "Aceleração de vendas diárias, bonificação da equipe e folha de pagamento",
    items: [
      { value: "METAS", label: "Metas Diárias", icon: "🎯", tag: "Bônus", description: "Regras de aceleradores de faturamento para comissionamento." },
      { value: "BONIFICACAO", label: "Extrato de Bonificação", icon: "💵", description: "Saldo mensal de bonificação por operador com teto de R$200." },
      { value: "FOLHA", label: "Folha de Pagamento", icon: "📄", description: "Extrato mensal de salários, dados bancários e exportação Bradesco." },
    ],
  },
  {
    id: "pessoas",
    label: "Equipe & Clientes",
    icon: "👥",
    badge: "RH & CRM",
    description: "Gestão da equipe, recrutamento e clientes",
    items: [
      { value: "COLABORADORES", label: "Equipe & Operadores", icon: "👤", description: "Cadastro unificado da equipe e permissões por unidade." },
      { value: "CLIENTES", label: "Base de Clientes", icon: "🧑‍🤝‍🧑", description: "Consulta e histórico centralizado de responsáveis e crianças da rede." },
      { value: "CRM_WHATSAPP", label: "CRM WhatsApp", icon: "💬", tag: "Novo", description: "Conversas e funil de clientes do Playground e do Circuito pelo WhatsApp." },
      { value: "ANIVERSARIO_CORTESIA", label: "Cortesia de aniversário", icon: "🎂", tag: "Novo", description: "30 min grátis no Playground: quem recebeu, quem usou, minutos adicionais cobrados, quem comprou depois e a comparação com o grupo de controle." },
      { value: "RELATORIOS_SESSAO", label: "Olhar FaçaAmigos", icon: "📝", tag: "Novo", description: "Mapa de observação de cada visita de 1h+, quem preencheu, prazo de 40 min e a mensagem enviada ao responsável." },
      { value: "PERMISSOES", label: "Permissões de Acesso", icon: "🔒", description: "Nível de acesso (Operador, Líder ou Owner) exigido por ação." },
      { value: "APARELHOS", label: "Aparelhos", icon: "📱", tag: "Novo", capability: "dispositivos.manage", description: "Cadastro dos terminais, navegadores e celulares que podem abrir a tela de PIN." },
    ],
  },
  {
    id: "caixa_operacoes",
    label: "Caixa & Auditoria",
    icon: "🛡️",
    badge: "Segurança",
    description: "Conferência de sangrias, livro de turnos e rastreabilidade financeira",
    items: [
      { value: "ABERTURA_FECHAMENTO", label: "Abertura & Fechamento", icon: "🔑", description: "Horários de caixa, responsável e troco inicial por loja." },
      { value: "PASSAGEM_TURNO", label: "Passagem de Turno", icon: "📖", description: "Livro de registro diário repassado entre operadores de turno." },
      { value: "SALDO_ENVELOPES", label: "Saldo em Envelopes", icon: "✉️", description: "Acompanhamento do dinheiro retido em sangrias nos cofres." },
      { value: "FOTOS_ENVELOPE", label: "Fotos de Sangria", icon: "📸", description: "Comprovantes visuais das sangrias registradas nos PDVs." },
      { value: "HISTORICO", label: "Fluxograma de Caixa", icon: "🔄", description: "Rastreabilidade do fluxo de caixa e movimentação por turno." },
      { value: "AUDITORIA", label: "Log de Auditoria", icon: "🛡️", description: "Histórico de ações sensíveis, logins e alterações de dados." },
      { value: "BOBINAS", label: "Bobinas de Cupom", icon: "🧻", tag: "Novo", description: "Consumo de papel térmico por unidade, previsão de término e troca de bobina." },
    ],
  },
];

// Mapeamento rápido de item -> categoria
const ITEM_TO_CATEGORY: Record<GerencialTab, string> = CATEGORIES.reduce((acc, cat) => {
  cat.items.forEach((item) => {
    acc[item.value] = cat.id;
  });
  return acc;
}, {} as Record<GerencialTab, string>);

const ALL_ITEMS: (ModuleItem & { categoryLabel: string })[] = CATEGORIES.flatMap((cat) =>
  cat.items.map((item) => ({ ...item, categoryLabel: cat.label }))
);

export function GerencialApp({ onExit, onLogout }: { onExit: () => void; onLogout: () => void | Promise<void> }) {
  const { employee } = useAppState();
  const { can } = useAuth();
  const [tab, setTab] = useState<GerencialTab>("COPILOT_IA");
  const [activeCategory, setActiveCategory] = useState<string>(() => ITEM_TO_CATEGORY["COPILOT_IA"] || "visao_geral");
  const [searchQuery, setSearchQuery] = useState("");

  const handleSelectTab = (newTab: GerencialTab) => {
    setTab(newTab);
    const catId = ITEM_TO_CATEGORY[newTab] || "visao_geral";
    setActiveCategory(catId);
  };

  // Menu só com o que o colaborador pode usar (ex.: Aparelhos é só do Owner).
  const categories = useMemo(
    () => CATEGORIES.map((c) => ({ ...c, items: c.items.filter((i) => !i.capability || can(i.capability)) })),
    [can],
  );
  const allItems = useMemo(
    () => categories.flatMap((cat) => cat.items.map((item) => ({ ...item, categoryLabel: cat.label }))),
    [categories],
  );

  const handleSelectCategory = (catId: string) => {
    setActiveCategory(catId);
    const cat = categories.find((c) => c.id === catId);
    if (cat && cat.items.length > 0) {
      const currentItemInCat = cat.items.find((i) => i.value === tab);
      if (!currentItemInCat) {
        const first = cat.items[0];
        if (first) {
          setTab(first.value);
        }
      }
    }
  };

  const currentCategory: ModuleCategory = useMemo(() => {
    const found = categories.find((c) => c.id === activeCategory);
    return found ? found : (categories[0] as ModuleCategory);
  }, [activeCategory, categories]);

  const currentItem: ModuleItem = useMemo(() => {
    const found = allItems.find((i) => i.value === tab);
    return found ? found : (allItems[0] as ModuleItem);
  }, [tab, allItems]);

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase().trim();
    return allItems.filter(
      (item) => item.label.toLowerCase().includes(q) || item.description.toLowerCase().includes(q) || item.categoryLabel.toLowerCase().includes(q)
    );
  }, [searchQuery, allItems]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--background-default, var(--surface-sunken))" }}>
      <div style={{ flexShrink: 0, height: "3px", background: "linear-gradient(90deg, var(--color-teal) 0%, var(--color-primary) 50%, var(--color-amber) 100%)" }} />

      {/* Header Desktop Full Width */}
      <header
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "6px 20px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--surface-card)",
          flexWrap: "wrap",
          boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
        }}
      >
        <BrandLockup operation="Gerencial" accent="var(--color-primary)" size="sm" title="🗂️ Painel Gerencial" />

        {/* Omnibox Busca Rápida */}
        <div style={{ position: "relative", minWidth: "280px", maxWidth: "420px", flex: 1, margin: "0 8px" }}>
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <span style={{ position: "absolute", left: "12px", color: "var(--text-secondary, var(--text-muted))", fontSize: "14px" }}><Emoji3D e="🔎" /></span>
            <input
              type="text"
              placeholder="Buscar menu gerencial... (ex: Zoe, Planos, Bonificação)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: "100%",
                padding: "5px 12px 5px 36px",
                fontSize: "13px",
                borderRadius: "8px",
                border: "1px solid var(--border-subtle)",
                background: "var(--surface-input, var(--surface-sunken))",
                outline: "none",
                transition: "all 0.2s ease",
              }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                style={{
                  position: "absolute",
                  right: "10px",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  color: "var(--text-muted)",
                  fontSize: "12px",
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* Popup Resultados de Busca */}
          {searchResults.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                right: 0,
                maxHeight: "320px",
                overflowY: "auto",
                background: "var(--surface-card)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "10px",
                boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.15)",
                zIndex: 1000,
                padding: "6px",
              }}
            >
              <div style={{ padding: "6px 10px", fontSize: "11px", fontWeight: "bold", color: "var(--text-muted)", textTransform: "uppercase" }}>
                {searchResults.length} módulo(s) encontrado(s)
              </div>
              {searchResults.map((res) => (
                <div
                  key={res.value}
                  onClick={() => {
                    handleSelectTab(res.value);
                    setSearchQuery("");
                  }}
                  style={{
                    padding: "8px 12px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    background: tab === res.value ? "rgba(240, 25, 107, 0.06)" : "transparent",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-sunken)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = tab === res.value ? "rgba(240, 25, 107, 0.06)" : "transparent")}
                >
                  <span style={{ fontSize: "18px" }}>{renderEmoji(res.icon)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>{res.label}</div>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                      {res.categoryLabel} · {res.description}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "12px" }}>
          {employee && (
            <span style={{ fontSize: "13px", color: "var(--text-secondary)", fontWeight: 600 }}>
              {employee.full_name} · <span style={{ color: "var(--color-primary)" }}>{ROLE_LABEL[employee.role]}</span>
            </span>
          )}
          {/* No Electron o app já está instalado: o ícone só faz sentido no navegador. */}
          {!isElectronLocal() && (
            <a
              href={INSTALADOR_URL}
              download
              title="Baixar o aplicativo para Windows"
              aria-label="Baixar o aplicativo para Windows"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "32px",
                height: "32px",
                fontSize: "16px",
                textDecoration: "none",
                borderRadius: "8px",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <span aria-hidden="true"><Emoji3D e="⬇️" /></span>
            </a>
          )}
          <Button variant="ghost" size="sm" onClick={onExit} style={{ fontSize: "12px", border: "1px solid var(--border-subtle)" }}>
            Sair do Gerencial
          </Button>
          <Button variant="ghost" size="sm" onClick={onLogout} style={{ fontSize: "12px", border: "1px solid var(--border-subtle)" }}>
            Sair
          </Button>
        </div>
      </header>

      {/* Navegação compacta e fixa: só o conteúdo rola */}
      <RequireCapability capability="config.write">
        <nav
          aria-label="Menu gerencial"
          style={{
            flexShrink: 0,
            padding: "8px 20px 0",
            background: "var(--surface-card)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          {/* Categorias: uma linha de abas */}
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {categories.map((cat) => {
              const isActive = activeCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => handleSelectCategory(cat.id)}
                  title={`${cat.description} (${cat.items.length} itens)`}
                  aria-pressed={isActive}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "6px 14px",
                    fontSize: "13px",
                    fontWeight: isActive ? 700 : 500,
                    border: "none",
                    borderBottom: isActive ? "3px solid var(--color-primary)" : "3px solid transparent",
                    background: "transparent",
                    color: isActive ? "var(--color-primary-hover)" : "var(--text-secondary)",
                    cursor: "pointer",
                  }}
                >
                  <span>{renderEmoji(cat.icon)}</span>
                  <span>{cat.label}</span>
                </button>
              );
            })}
          </div>

          {/* Sub-itens da categoria ativa */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", padding: "8px 0" }}>
            {currentCategory.items.map((subItem) => {
              const isSelected = tab === subItem.value;
              return (
                <button
                  key={subItem.value}
                  type="button"
                  onClick={() => handleSelectTab(subItem.value)}
                  title={subItem.description}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    padding: "4px 10px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontWeight: isSelected ? 700 : 500,
                    border: isSelected ? "1px solid var(--color-primary)" : "1px solid var(--border-subtle)",
                    background: isSelected ? "var(--color-primary)" : "var(--surface-input, var(--surface-sunken))",
                    color: isSelected ? "var(--text-on-primary)" : "var(--text-primary)",
                    cursor: "pointer",
                  }}
                >
                  <span>{renderEmoji(subItem.icon)}</span>
                  <span>{subItem.label}</span>
                  {subItem.tag && (
                    <span
                      style={{
                        fontSize: "9px",
                        padding: "0 4px",
                        borderRadius: "4px",
                        background: isSelected ? "rgba(255,255,255,0.25)" : "var(--border-subtle)",
                        color: isSelected ? "var(--text-on-primary)" : "var(--text-secondary)",
                        fontWeight: 700,
                      }}
                    >
                      {subItem.tag}
                    </span>
                  )}
                </button>
              );
            })}
            {/* Descrição da aba ativa na mesma linha, em vez de uma faixa própria */}
            <span
              style={{
                marginLeft: "8px",
                flex: "1 1 240px",
                minWidth: 0,
                fontSize: "11px",
                color: "var(--text-secondary, var(--text-muted))",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={currentItem.description}
            >
              {currentItem.description}
            </span>
          </div>
        </nav>

        <main style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          <div className="gerencial-shell" style={{ width: "100%", padding: "12px 20px 16px", margin: "0 auto", boxSizing: "border-box" }}>
            {/* ÁREA DE CONTEÚDO EXPANDIDA (DESKTOP FULL WIDTH) */}
            <div role="tabpanel" style={{ width: "100%", flex: 1 }}>
              {tab === "ACOMPANHAMENTO_OWNER" && <OwnerAcompanhamentoTab />}
              {tab === "NPS_DASHBOARD" && <NpsDashboardTab />}
              {tab === "COPILOT_IA" && <GeminiGerencialCopilot />}
              {tab === "PLANOS" && <PlanosTab />}
              {tab === "PACOTES" && <PacotesTab />}
              {tab === "PRODUTOS" && <ProdutosTab />}
              {tab === "CUPONS" && <CuponsTab />}
              {tab === "FIDELIDADE" && <FidelidadeTab />}
              {tab === "METAS" && <MetasTab />}
              {tab === "COLABORADORES" && <ColaboradoresTab />}
              {tab === "OCORRENCIAS" && <OcorrenciasTab />}
              {tab === "PERMISSOES" && <PermissoesTab />}
              {tab === "APARELHOS" && can("dispositivos.manage") && <AparelhosTab />}
              {tab === "CLIENTES" && <ClientesTab />}
              {tab === "CRM_WHATSAPP" && <CrmWhatsappTab />}
              {tab === "ANIVERSARIO_CORTESIA" && <AniversarioCortesiaTab />}
              {tab === "RELATORIOS_SESSAO" && <RelatoriosSessaoTab />}
              {tab === "TALENTOS" && <BancoTalentosTab />}
              {tab === "FOLHA" && <FolhaPagamentoTab />}
              {tab === "BONIFICACAO" && <BonificacaoTab />}
              {tab === "RELATORIOS" && <GerencialRelatorioTab />}
              {tab === "ABERTURA_FECHAMENTO" && <AberturaFechamentoTab />}
              {tab === "PASSAGEM_TURNO" && <PassagemTurnoTab />}
              {tab === "FOTOS_ENVELOPE" && <FotosEnvelopeTab />}
              {tab === "SALDO_ENVELOPES" && <SaldoEnvelopesTab />}
              {tab === "HISTORICO" && <HistoricoTab />}
              {tab === "AUDITORIA" && <AuditoriaTab />}
              {tab === "CONTRATO" && <ContratoTab />}
              {tab === "BOBINAS" && <BobinasTab />}
            </div>

          </div>
        </main>
      </RequireCapability>
    </div>
  );
}


