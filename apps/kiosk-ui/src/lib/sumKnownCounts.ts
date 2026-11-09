/**
 * Soma contagens ignorando as desconhecidas (`null`, consulta que falhou).
 * Retorna `null` quando há ao menos uma unidade e nenhuma contagem é
 * conhecida, para a tela mostrar "—" em vez de um 0 falso.
 */
export function sumKnownCounts(counts: (number | null)[]): number | null {
  if (counts.length === 0) return 0;
  const known = counts.filter((c): c is number => c !== null);
  if (known.length === 0) return null;
  return known.reduce((acc, c) => acc + c, 0);
}
