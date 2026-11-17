import type { Capability } from "./capabilities.js";

export type Screen =
  | "ENTRADA"
  | "SAIDA"
  | "PAINEL"
  | "RELATORIO_SESSAO"
  | "AVALIACOES"
  | "PDV"
  | "CAIXA"
  | "ANIVERSARIOS"
  | "MINHA_BONIFICACAO"
  | "RELATORIO"
  | "CONFIGURACOES";

/**
 * Capacidade exigida por cada tela do menu.
 *
 * O `Record<Screen, Capability>` é proposital: adicionar uma tela nova sem
 * declarar a capacidade dela quebra o build. Sem isso, o modo de falha
 * natural seria uma tela nova nascer acessível a todo mundo — e ninguém
 * perceber.
 */
export const SCREEN_CAPABILITY: Record<Screen, Capability> = {
  ENTRADA: "sessao.checkin",
  SAIDA: "sessao.checkout",
  PAINEL: "sessao.checkout",
  RELATORIO_SESSAO: "relatorio_sessao.write",
  // Chegou/Saiu (.presenca) é um botão dentro da tela, não a porta de entrada dela.
  AVALIACOES: "avaliacao_playground.write",
  PDV: "pdv.sell",
  CAIXA: "caixa.open_close",
  ANIVERSARIOS: "relatorio.read",
  MINHA_BONIFICACAO: "bonificacao.self",
  RELATORIO: "relatorio.read",
  CONFIGURACOES: "config.read",
};

