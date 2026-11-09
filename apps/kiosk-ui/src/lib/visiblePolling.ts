/**
 * Polling que não gasta requisição com a janela escondida.
 *
 * Roda `run` na hora, depois a cada `intervalMs` enquanto a aba/janela está
 * visível, e uma vez ao voltar a ficar visível (para não mostrar dado velho
 * depois de minutos escondida). Devolve a função que cancela tudo.
 *
 * Telas como Caixa e Painel consultavam o Supabase em intervalos de 5 a 15 s
 * mesmo minimizadas; num terminal que fica ligado o dia inteiro isso é a maior
 * fonte de requisições.
 */
export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export function startVisiblePolling(
  run: () => void,
  intervalMs: number,
  doc: VisibilitySource = document,
): () => void {
  run();
  const id = setInterval(() => {
    if (!doc.hidden) run();
  }, intervalMs);
  const onVisibility = () => {
    if (!doc.hidden) run();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearInterval(id);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
