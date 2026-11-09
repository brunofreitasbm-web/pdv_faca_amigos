import { Suspense, useState } from "react";
import { BrandLoader } from "@facaamigos/ui";
import { useBackHandler } from "../hooks/useBackHandler.js";
import type { Unit } from "../api/client.js";
import { GerencialApp } from "../lazyScreens.js";
import { MobileGerencialHome } from "./MobileGerencialHome.js";
import { MobileUnitDetail } from "./MobileUnitDetail.js";
import { MobileTabBar, TabIcons } from "./MobileNav.js";
import "./mobile.css";

type View = { kind: "HOME" } | { kind: "UNIT"; unit: Unit } | { kind: "FULL" };

/**
 * Entrada do Owner no modo celular.
 *
 * O console completo (GerencialApp, 21 abas — preço, colaboradores,
 * permissões, folha, fiscal) já é seu próprio "app": tem cabeçalho,
 * marca e botão de saída próprios, e a barra de abas já quebra linha
 * sozinha (packages/ui/src/components/Tabs.tsx tem flexWrap). Vestir ele
 * de novo com a barra de status do modo celular duplicaria cabeçalho —
 * por isso ele é renderizado tal como é no balcão, sem embrulho.
 *
 * O que faltava era a PRIMEIRA tela: hoje, entrar em Gerencial cai direto
 * na aba Planos, sem nenhum resumo. Esta home mostra as 3 operações
 * juntas primeiro, com o detalhe de cada unidade e um caminho pro console completo quando o Owner
 * precisa mexer em cadastro de verdade.
 */
export function MobileGerencial({ units, onExit, onLogout }: { units: Unit[]; onExit: () => void; onLogout: () => void | Promise<void> }) {
  const [view, setView] = useState<View>({ kind: "HOME" });
  // Voltar do aparelho leva à home do Gerencial antes de sair dele.
  useBackHandler(view.kind === "HOME" ? 0 : 1, () => setView({ kind: "HOME" }));

  // O console completo tem o próprio cabeçalho; o "Sair do Gerencial" dele
  // agora leva de volta ao Resumo (e não direto para a seleção de unidade,
  // o que fazia o Owner perder o lugar). Quem quer mesmo trocar de
  // unidade usa a aba "Atender".
  if (view.kind === "FULL") {
    return (
      <Suspense fallback={<BrandLoader />}>
        <GerencialApp onExit={() => setView({ kind: "HOME" })} onLogout={onLogout} />
      </Suspense>
    );
  }

  // Abas principais do Owner. "Operar" é a única que sai do Gerencial: leva
  // à escolha de unidade para atender no balcão — antes isto só existia
  // como o "‹" ambíguo do topo.
  const tabs = [
    { id: "HOME" as const, label: "Resumo", icon: TabIcons.resumo },
    { id: "FULL" as const, label: "Completo", icon: TabIcons.console },
    { id: "OPERAR" as const, label: "Atender", icon: TabIcons.operar },
  ];
  const onTab = (id: (typeof tabs)[number]["id"]) => {
    if (id === "OPERAR") return onExit();
    setView({ kind: id });
  };
  const activeTab = view.kind === "UNIT" ? "HOME" : view.kind;

  return (
    <div className="m-shell">
      <div className="m-frame">
        {view.kind === "UNIT" ? (
          <MobileUnitDetail unit={view.unit} onBack={() => setView({ kind: "HOME" })} />
        ) : (
          <>
            <div className="m-appbar">
              <p className="m-title m-grow">Gerencial</p>
            </div>
            <MobileGerencialHome
              units={units}
              onAbrirPainelCompleto={() => setView({ kind: "FULL" })}
              onAbrirUnidade={(unit) => setView({ kind: "UNIT", unit })}
            />
          </>
        )}
        <MobileTabBar tabs={tabs} active={activeTab} onSelect={onTab} label="Gerencial" />
      </div>
    </div>
  );
}
