/**
 * Código curto do aparelho (6 últimos caracteres do id, maiúsculo). É o que
 * o operador lê na tela do aparelho e o Owner confere na lista Gerencial >
 * Aparelhos: dois aparelhos com o mesmo nome continuam distinguíveis.
 */
export function shortDeviceCode(id: string): string {
  return id.replace(/-/g, "").slice(-6).toUpperCase();
}
