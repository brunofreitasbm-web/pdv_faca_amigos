/**
 * Telas carregadas sob demanda (code splitting).
 *
 * Antes, App.tsx importava todas as telas estaticamente: as ~48 mil linhas da
 * SPA, e com elas face-api (tfjs), recharts e o pacote fiscal, iam num único
 * chunk de ~4,2 MB que precisava ser baixado, parseado e executado antes do
 * primeiro pixel, inclusive no Electron.
 *
 * O Painel (tela padrão) e o Login continuam estáticos. As demais carregam
 * quando abertas, e as telas quentes do balcão são pré-buscadas em tempo ocioso
 * (`prefetchHotScreens`) para o primeiro toque não esperar o chunk.
 */
import { lazy, type ComponentType } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function named<K extends string, C extends ComponentType<any>>(
  load: () => Promise<Record<K, C>>,
  key: K,
) {
  return lazy(() => load().then((m) => ({ default: m[key] })));
}

const loaders = {
  entrada: () => import("./screens/EntradaScreen.js"),
  saida: () => import("./screens/SaidaScreen.js"),
  pdv: () => import("./screens/PdvScreen.js"),
  caixa: () => import("./screens/CaixaScreen.js"),
};

export const EntradaScreen = named(loaders.entrada, "EntradaScreen");
export const SaidaScreen = named(loaders.saida, "SaidaScreen");
export const PdvScreen = named(loaders.pdv, "PdvScreen");
export const CaixaScreen = named(loaders.caixa, "CaixaScreen");

export const RelatorioSessaoScreen = named(() => import("./screens/RelatorioSessaoScreen.js"), "RelatorioSessaoScreen");
export const AniversariosScreen = named(() => import("./screens/AniversariosScreen.js"), "AniversariosScreen");
export const MinhaBonificacaoScreen = named(() => import("./screens/MinhaBonificacaoScreen.js"), "MinhaBonificacaoScreen");
export const RelatorioScreen = named(() => import("./screens/RelatorioScreen.js"), "RelatorioScreen");
export const ConfiguracoesScreen = named(() => import("./screens/ConfiguracoesScreen.js"), "ConfiguracoesScreen");
export const GerencialApp = named(() => import("./screens/gerencial/GerencialApp.js"), "GerencialApp");
export const TapReturnScreen = named(() => import("./screens/TapReturnScreen.js"), "TapReturnScreen");

// Telas de link público (cadastro/convite/acompanhamento): quem abre não usa o resto do app.
export const OnboardingInviteScreen = named(() => import("./screens/OnboardingInviteScreen.js"), "OnboardingInviteScreen");
export const GeneralOnboardingScreen = named(() => import("./screens/GeneralOnboardingScreen.js"), "GeneralOnboardingScreen");
export const GeneralPjOnboardingScreen = named(() => import("./screens/GeneralPjOnboardingScreen.js"), "GeneralPjOnboardingScreen");
export const AcompanharScreen = named(() => import("./screens/AcompanharScreen.js"), "AcompanharScreen");
export const AcessoRapidoScreen = named(() => import("./screens/AcessoRapidoScreen.js"), "AcessoRapidoScreen");

/**
 * Baixa em segundo plano os chunks das telas que o operador usa o tempo todo,
 * depois que o app já está interativo. Falha silenciosa: se a rede cair, o
 * `lazy` tenta de novo no momento do uso.
 */
export function prefetchHotScreens(): void {
  const run = () => {
    for (const load of Object.values(loaders)) void load().catch(() => {});
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 5000 });
  } else {
    setTimeout(run, 2000);
  }
}
