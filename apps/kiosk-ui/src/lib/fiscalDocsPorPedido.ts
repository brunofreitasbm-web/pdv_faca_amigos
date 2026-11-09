/**
 * Agrupa documentos fiscais por pedido quando vários pedidos são consultados
 * numa única requisição (Caixa: antes era uma consulta por venda, a cada 5 s).
 *
 * Um pedido pode ter um documento DESCARTADO e outro ativo ao mesmo tempo (o
 * índice único de fa_kiosk_fiscal_docs só vale para status <> 'DESCARTADO').
 * Nesse caso o ativo vence. Se só existir o descartado, ele é devolvido, que
 * era o comportamento de `fiscalDocByOrder` quando havia uma única linha.
 */
export function fiscalDocsPorPedido<T extends { order_id: string; status: string }>(
  docs: readonly T[],
): Record<string, T> {
  const porPedido: Record<string, T> = {};
  for (const doc of docs) {
    const atual = porPedido[doc.order_id];
    if (!atual || (atual.status === "DESCARTADO" && doc.status !== "DESCARTADO")) {
      porPedido[doc.order_id] = doc;
    }
  }
  return porPedido;
}
