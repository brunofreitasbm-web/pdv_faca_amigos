/**
 * Sincronização das capacidades do colaborador logado, sem React.
 *
 * Existe separada do AuthContext por dois motivos: é a parte que decide
 * QUANTAS consultas ao Supabase acontecem (e quando a tela é desmontada), e
 * assim dá para testar sem montar componente.
 *
 * Regras:
 *  - mesmo usuário já carregado → não consulta de novo (SIGNED_IN repetido ao
 *    voltar para a aba, INITIAL_SESSION logo depois do getSession da abertura);
 *  - consulta em andamento para o mesmo usuário → reaproveita a promise;
 *  - usuário DIFERENTE → liga `loading` (a tela não pode mostrar permissões do
 *    colaborador anterior) e descarta respostas atrasadas do anterior;
 *  - `force` (refresh manual depois de login por PIN, TOKEN_REFRESHED)
 *    reconsulta, mas sem ligar `loading`: o usuário é o mesmo e desmontar a
 *    tela só para renovar permissões refazia todas as consultas dela.
 */
export interface CapabilitiesSyncDeps<T> {
  fetchCapabilities: () => Promise<T>;
  setCapabilities: (value: T) => void;
  setLoading: (value: boolean) => void;
  empty: () => T;
}

export function createCapabilitiesSync<T>(deps: CapabilitiesSyncDeps<T>) {
  let loadedFor: string | null = null;
  let currentUid: string | null = null;
  let inflight: { uid: string; promise: Promise<void> } | null = null;

  async function sync(uid: string | null, opts: { force?: boolean } = {}): Promise<void> {
    if (uid == null) {
      loadedFor = null;
      currentUid = null;
      inflight = null;
      deps.setCapabilities(deps.empty());
      deps.setLoading(false);
      return;
    }

    if (!opts.force && loadedFor === uid) return;
    if (inflight && inflight.uid === uid) return inflight.promise;

    if (currentUid !== uid) {
      // Troca de usuário (ou primeira carga): invalida o que havia.
      loadedFor = null;
      deps.setLoading(true);
    }
    currentUid = uid;

    const promise = deps
      .fetchCapabilities()
      .then((caps) => {
        // Resposta de um usuário que já saiu: ignora.
        if (currentUid !== uid) return;
        loadedFor = uid;
        deps.setCapabilities(caps);
        deps.setLoading(false);
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
    inflight = { uid, promise };
    return promise;
  }

  return { sync };
}
