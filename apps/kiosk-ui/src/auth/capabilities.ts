/**
 * Capacidades do RBAC — espelho da tabela `fa_kiosk_role_capabilities`
 * (migration 20260807000002).
 *
 * Isto é uma lista de NOMES, não a regra: quem tem o quê é decidido no
 * banco e chega pronto pela view `fa_kiosk_my_capabilities`. O tipo existe
 * só para o TypeScript acusar um `can("cofig.write")` digitado errado, que
 * silenciosamente esconderia a tela em vez de falhar.
 */
export const CAPABILITIES = [
  "sessao.checkin",
  "sessao.checkout",
  "sessao.cancel",
  "nfse.emit",
  "nfce.retry",
  "sessao.change_plan",
  "pdv.sell",
  "venda.upsell",
  "venda.estorno",
  "venda.prepago",
  "caixa.open_close",
  "caixa.sangria",
  "caixa.passagem_turno.read",
  "caixa.passagem_turno.history",
  "desconto.manual",
  "ponto.self",
  "relatorio.read",
  "relatorio.ponto",
  "config.read",
  "config.write",
  "config.employees.write",
  "config.unit.write",
  "config.fiscal.write",
  "config.terms.write",
  "config.rbac.write",
  "talentos.read",
  "talentos.write",
  "ocorrencias.read",
  "ocorrencias.write",
  "notificacoes.owner_push",
  "metas.ticket.write",
  "clientes.write",
  "bonificacao.self",
  "crm.read",
  "crm.write",
  "crm.admin",
  "relatorio_sessao.write",
  "relatorio_sessao.read",
  "avaliacao_playground.write",
  "avaliacao_playground.presenca",
  "chat.usar",
  "dispositivos.manage",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Rótulo em PT-BR de cada capacidade, para a tela Gerencial > Permissões. */
export const CAPABILITY_LABEL: Record<Capability, string> = {
  "sessao.checkin": "Fazer check-in de sessão",
  "sessao.checkout": "Fazer saída/check-out de sessão",
  "sessao.cancel": "Cancelar sessão",
  "nfse.emit": "Emitir Nota Fiscal de Serviço (NFS-e)",
  "nfce.retry": "Reenviar NFC-e bloqueada ou rejeitada (Tentar Novamente no Caixa)",
  "sessao.change_plan": "Trocar o plano de uma sessão em andamento",
  "pdv.sell": "Vender no PDV",
  "venda.upsell": "Fazer upsell de venda",
  "venda.estorno": "Estornar venda",
  "venda.prepago": "Vender saldo pré-pago (sem iniciar sessão)",
  "caixa.open_close": "Abrir e fechar caixa",
  "caixa.sangria": "Registrar sangria de caixa",
  "caixa.passagem_turno.read": "Ler a passagem de turno do dia anterior ao abrir o caixa",
  "caixa.passagem_turno.history": "Ver o histórico de passagens de turno (Gerencial)",
  "desconto.manual": "Aplicar desconto manual",
  "ponto.self": "Bater o próprio ponto",
  "relatorio.read": "Ver relatórios",
  "relatorio.ponto": "Ver espelho de ponto de colaboradores",
  "config.read": "Ver Configurações",
  "config.write": "Editar Configurações (planos, produtos, cupons etc.)",
  "config.employees.write": "Editar cadastro de colaboradores",
  "config.unit.write": "Editar dados da unidade",
  "config.fiscal.write": "Editar dados fiscais",
  "config.terms.write": "Editar Termos de Uso",
  "config.rbac.write": "Editar permissões de cada papel (esta tela)",
  "talentos.read": "Ver Banco de Talentos",
  "talentos.write": "Editar Banco de Talentos",
  "ocorrencias.read": "Ver ocorrências (atestado/falta) de colaboradores",
  "ocorrencias.write": "Lançar ocorrências (atestado/falta) de colaboradores",
  "notificacoes.owner_push": "Ativar notificações de relatório do Owner neste dispositivo",
  "metas.ticket.write": "Configurar meta de Ticket Médio (mínimo e alvo) de cada unidade",
  "clientes.write": "Editar dados de clientes (responsável e crianças vinculadas)",
  "bonificacao.self": "Ver a própria bonificação (menu Minha Bonificação)",
  "crm.read": "Ver o CRM de WhatsApp (conversas e contatos do Playground e do Circuito)",
  "crm.write": "Responder clientes e editar a ficha no CRM de WhatsApp",
  "crm.admin": "Gerenciar números (canais) e templates do CRM de WhatsApp",
  "relatorio_sessao.write": "Preencher o Olhar FaçaAmigos (crianças com plano de 1h ou mais)",
  "relatorio_sessao.read": "Ver o histórico do Olhar FaçaAmigos no Gerencial",
  "avaliacao_playground.write": "Preencher a Avaliação no playground (itens e evolução)",
  "avaliacao_playground.presenca": "Marcar chegada e saída da criança na Avaliação no playground",
  "chat.usar": "Usar o chat interno com os donos (botão flutuante)",
  "dispositivos.manage": "Cadastrar e revogar aparelhos da unidade (código de ativação)",
};

/** Papéis como estão no banco. Ver ROLE_LABEL para o que o usuário lê. */
export type Role = "ESTAGIARIO" | "OPERADOR" | "GERENTE" | "ADMIN" | "PRESTADOR_PJ";

/**
 * Os valores no banco continuam OPERADOR/GERENTE/ADMIN — renomeá-los
 * exigiria migrar check constraint, linhas, funções e policies de uma vez,
 * com risco de deixar um 'ADMIN' hardcoded para trás. O rótulo resolve o
 * mesmo problema visível com risco zero.
 *
 * ESTAGIARIO e PRESTADOR_PJ não são hierárquicos como os outros três —
 * só registram frequência/prestação de serviço, sem nenhum outro acesso ao sistema.
 */
export const ROLE_LABEL: Record<Role, string> = {
  ESTAGIARIO: "Estagiário",
  OPERADOR: "Operador",
  GERENTE: "Líder",
  ADMIN: "Owner",
  PRESTADOR_PJ: "Prestador PJ",
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  ESTAGIARIO: "Só acessa o Controle de Frequência. Não opera caixa, vendas nem check-in/saída.",
  PRESTADOR_PJ: "Só acessa o Registro de Prestação de Serviço (Check-in/Check-out). Sem vínculo empregatício CLT.",
  OPERADOR: "Caixa, vendas, troca de planos e Configurações.",
  GERENTE: "Tudo do Operador, mais sangrias, estornos e relatórios.",
  ADMIN: "Acesso total, incluindo cancelamento de sessões.",
};

/**
 * Ordem de exibição dos níveis de acesso nos seletores de cadastro/edição
 * de colaborador. Não existe mais um cargo/função com nome próprio
 * (Recepção, Vendedor, Líder de Turno...) desacoplado do RBAC — o único
 * nível concedido é a própria permissão.
 */
export const ROLE_OPTIONS: ReadonlyArray<Role> = ["OPERADOR", "GERENTE", "ADMIN", "ESTAGIARIO", "PRESTADOR_PJ"];

/**
 * Retorna o conjunto de capacidades padrão para um papel de colaborador.
 * Usado como fallback resiliente caso a consulta à view `fa_kiosk_my_capabilities` falhe ou venha vazia.
 */
export function getDefaultCapabilitiesForRole(role: Role): Set<Capability> {
  if (role === "ADMIN") {
    return new Set(CAPABILITIES);
  }

  if (role === "GERENTE") {
    return new Set(
      CAPABILITIES.filter(
        (c) =>
          c !== "sessao.cancel" &&
          c !== "config.rbac.write" &&
          c !== "notificacoes.owner_push" &&
          c !== "talentos.write"
      )
    );
  }

  if (role === "OPERADOR") {
    return new Set([
      "sessao.checkin",
      "sessao.checkout",
      "sessao.change_plan",
      "pdv.sell",
      "venda.upsell",
      "venda.prepago",
      "caixa.open_close",
      "caixa.sangria",
      "ponto.self",
      "config.read",
      "config.write",
      "config.employees.write",
      "config.unit.write",
      "config.fiscal.write",
      "config.terms.write",
      "bonificacao.self",
      "relatorio.read",
      "clientes.write",
      "nfse.emit",
      "nfce.retry",
      "relatorio_sessao.write",
      "avaliacao_playground.write",
      "avaliacao_playground.presenca",
      "chat.usar",
    ]);
  }

  if (role === "ESTAGIARIO") {
    return new Set(["ponto.self", "bonificacao.self", "relatorio_sessao.write", "avaliacao_playground.write", "chat.usar"]);
  }

  if (role === "PRESTADOR_PJ") {
    return new Set(["ponto.self", "sessao.checkin", "sessao.checkout", "relatorio_sessao.write", "avaliacao_playground.write"]);
  }

  return new Set(CAPABILITIES);
}

