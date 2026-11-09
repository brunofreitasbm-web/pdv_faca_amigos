import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { supabase } from "../lib/supabase/client.js";
import type { Capability, Role } from "./capabilities.js";
import { getDefaultCapabilitiesForRole } from "./capabilities.js";
import { createCapabilitiesSync } from "./capabilitiesSync.js";

/**
 * Capacidades do colaborador logado, lidas da view `fa_kiosk_my_capabilities`.
 *
 * ⚠️ Nada aqui é segurança. Esta camada existe só para não mostrar ao
 * Operador uma porta que não abre — qualquer pessoa pode editar o estado no
 * navegador e revelar a tela. O que de fato protege são as policies de RLS e
 * as RPCs `fa_config_*`, que checam `fa_kiosk_can()` no servidor a cada
 * chamada. Se esta camada e o servidor divergirem, o servidor ganha, e o
 * sintoma é um erro "sem permissão" na tela — nunca um vazamento.
 */
interface AuthValue {
  capabilities: ReadonlySet<Capability>;
  can: (capability: Capability) => boolean;
  /** true enquanto as capacidades da sessão atual ainda não chegaram. */
  loading: boolean;
  /** Reconsulta — usado depois de um login por PIN dentro de um gate. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

async function fetchCapabilities(): Promise<Set<Capability>> {
  let roleFromCache: Role | undefined;
  try {
    const raw = localStorage.getItem("fa_kiosk_terminal_employees");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        roleFromCache = parsed[parsed.length - 1]?.role as Role | undefined;
      }
    }
  } catch { /* melhor esforço: falha ignorada */ }

  try {
    const { data, error } = await supabase().from("fa_kiosk_my_capabilities").select("capability");
    if (!error && data && data.length > 0) {
      return new Set(data.map((row: { capability: string }) => row.capability as Capability));
    }
  } catch { /* melhor esforço: falha ignorada */ }

  try {
    const { data: { session } } = await supabase().auth.getSession();
    if (session?.user?.id) {
      const { data: emp } = await supabase()
        .from("fa_kiosk_employees")
        .select("role")
        .eq("auth_user_id", session.user.id)
        .maybeSingle();
      if (emp?.role) {
        return getDefaultCapabilitiesForRole(emp.role as Role);
      }
    }
  } catch { /* melhor esforço: falha ignorada */ }

  if (roleFromCache) {
    return getDefaultCapabilitiesForRole(roleFromCache);
  }

  return getDefaultCapabilitiesForRole("ADMIN");
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [capabilities, setCapabilities] = useState<ReadonlySet<Capability>>(new Set());
  const [loading, setLoading] = useState(true);

  // Quem decide quando consultar de fato é o capabilitiesSync (ver o arquivo
  // para as regras). Antes, TODO evento de auth ligava `loading` e refazia a
  // consulta, e `loading` desmonta a tela atual (RequireCapability): a
  // renovação de token, a cada ~1 h, e o SIGNED_IN ao voltar para a aba
  // reiniciavam todas as consultas da tela aberta e recriavam os canais Realtime.
  const syncRef = useRef(
    createCapabilitiesSync<ReadonlySet<Capability>>({
      fetchCapabilities,
      setCapabilities,
      setLoading,
      empty: () => new Set<Capability>(),
    }),
  );

  const refresh = useCallback(async () => {
    const { data } = await supabase().auth.getSession();
    await syncRef.current.sync(data.session?.user.id ?? null, { force: true });
  }, []);

  useEffect(() => {
    const sync = syncRef.current.sync;
    // Reagir a onAuthStateChange (e não só carregar uma vez) é o que faz
    // trocar de colaborador no terminal trocar de fato as permissões — sem
    // isso, o Owner que saiu deixaria o menu Configurações aberto para o
    // Operador que entrou depois. O mesmo usuário NÃO dispara nova consulta
    // com `loading`; só TOKEN_REFRESHED revalida, em segundo plano, para
    // continuar enxergando mudança de papel feita por um admin.
    const { data: subscription } = supabase().auth.onAuthStateChange((event, session) => {
      void sync(session?.user.id ?? null, { force: event === "TOKEN_REFRESHED" });
    });

    // Abertura: getSession e o INITIAL_SESSION do listener chegam quase juntos
    // para o mesmo usuário; o sync reaproveita a consulta em andamento.
    void supabase()
      .auth.getSession()
      .then(({ data }) => sync(data.session?.user.id ?? null));
    return () => subscription.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      capabilities,
      can: (capability: Capability) => capabilities.has(capability),
      loading,
      refresh,
    }),
    [capabilities, loading, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth precisa estar dentro de <AuthProvider>");
  return ctx;
}

/** Atalho para o caso comum de só querer o booleano. */
export function useCan(capability: Capability): boolean {
  return useAuth().can(capability);
}
