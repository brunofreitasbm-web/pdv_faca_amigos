import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Api } from "../api/client.js";
import type { Unit } from "../api/client.js";
import { supabase } from "../lib/supabase/client.js";
import {
  listTerminalEmployees,
  pinLogin,
  forgetTerminalEmployee,
  type TerminalEmployee,
} from "../lib/supabase/terminalAuth.js";
import { clearSessionStarted, isStoredSessionExpired } from "../lib/supabase/sessionExpiry.js";
import { clearStepUpCache } from "../auth/stepUpCache.js";

interface AppStateValue {
  units: Unit[];
  unit: Unit | null;
  setUnitId: (id: string) => void;
  refreshUnits: () => Promise<void>;
  /** Modo Gerencial: fora das 3 unidades, configura o que vale para várias de uma vez. */
  gerencial: boolean;
  setGerencial: (value: boolean) => void;
  employee: TerminalEmployee | null;
  terminalEmployees: TerminalEmployee[];
  switchEmployee: (employeeId: string, pin: string) => Promise<void>;
  forgetEmployee: (employeeId: string) => void;
  logout: () => Promise<void>;
  /** true até a sessão salva no navegador ter sido conferida. */
  restoring: boolean;
}

const AppStateContext = createContext<AppStateValue | null>(null);

/** Papéis que só enxergam a(s) unidade(s) em que estão alocados (fa_kiosk_employee_units). */
function isUnitRestrictedRole(role: TerminalEmployee["role"]): boolean {
  return role === "OPERADOR" || role === "AVALIADOR";
}

/**
 * Unidades que o colaborador pode ver. Operador sem vínculo gravado cai na
 * primeira unidade (comportamento legado). Avaliador sem vínculo não vê
 * nenhuma: é um tablet fixo de uma unidade, e vazar as outras era o bug.
 */
async function resolveVisibleUnits(employee: TerminalEmployee, allUnits: Unit[]): Promise<Unit[]> {
  if (!isUnitRestrictedRole(employee.role)) return allUnits;
  const myIds: string[] = await Api.myUnitIds(employee.id).catch(() => []);
  const assigned = allUnits.filter((u) => myIds.includes(u.id));
  if (assigned.length > 0) return assigned;
  return employee.role === "AVALIADOR" ? [] : allUnits.slice(0, 1);
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [gerencial, setGerencial] = useState(false);
  const [employee, setEmployee] = useState<TerminalEmployee | null>(null);
  const [terminalEmployees, setTerminalEmployees] = useState<TerminalEmployee[]>(listTerminalEmployees());
  const [restoring, setRestoring] = useState(true);

  // As unidades só podem ser lidas com sessão (as policies de leitura são
  // `to authenticated` desde a migration 20260807000003), então a busca
  // depende do colaborador estar logado.
  // Para colaboradores com papel OPERADOR, a lista de unidades é restrita
  // exclusivamente à(s) unidade(s) alocada(s) em fa_kiosk_employee_units.
  useEffect(() => {
    if (!employee) {
      setUnits([]);
      return;
    }

    let isCancelled = false;

    async function loadUnits() {
      try {
        const allUnits = await Api.units();
        if (isCancelled) return;

        const visible = await resolveVisibleUnits(employee!, allUnits);
        if (isCancelled) return;
        setUnits(visible);
      } catch {
        if (!isCancelled) setUnits([]);
      }
    }

    void loadUnits();

    return () => {
      isCancelled = true;
    };
  }, [employee]);

  // Seleciona a unidade do terminal (definida localmente no Electron/Fastify)
  // ou vinculada ao colaborador automaticamente ao fazer login.
  const autoSelectedForEmployeeId = useRef<string | null>(null);
  useEffect(() => {
    if (!employee || unitId) return;
    if (autoSelectedForEmployeeId.current === employee.id) return;

    let isCancelled = false;
    fetch("/api/system/terminal-unit")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (isCancelled) return;
        if (data?.unitId && units.some((u) => u.id === data.unitId)) {
          autoSelectedForEmployeeId.current = employee.id;
          setUnitId(data.unitId);
          return;
        }

        if (isUnitRestrictedRole(employee.role) && units.length > 0) {
          autoSelectedForEmployeeId.current = employee.id;
          setUnitId(units[0]!.id);
          return;
        }

        Api.myUnitIds(employee.id)
          .then((ids) => {
            if (isCancelled) return;
            autoSelectedForEmployeeId.current = employee.id;
            if (ids.length === 1) setUnitId(ids[0]!);
          })
          .catch(() => {
            if (!isCancelled) autoSelectedForEmployeeId.current = employee.id;
          });
      })
      .catch(() => {
        if (isCancelled) return;
        if (isUnitRestrictedRole(employee.role) && units.length > 0) {
          autoSelectedForEmployeeId.current = employee.id;
          setUnitId(units[0]!.id);
          return;
        }
        Api.myUnitIds(employee.id)
          .then((ids) => {
            if (isCancelled) return;
            autoSelectedForEmployeeId.current = employee.id;
            if (ids.length === 1) setUnitId(ids[0]!);
          })
          .catch(() => {
            if (!isCancelled) autoSelectedForEmployeeId.current = employee.id;
          });
      });

    return () => {
      isCancelled = true;
    };
  }, [employee, unitId, units]);

  // Restaura a sessão do Supabase Auth que o navegador já tinha (o terminal
  // do balcão não deve pedir PIN a cada refresh da página) e reflete
  // logout/expiração vindos de qualquer lugar.
  //
  // O login automático "entra com o primeiro colaborador da lista, sem PIN"
  // que existia aqui foi REMOVIDO: sem sessão real não há `auth.uid()`, e
  // sem `auth.uid()` nenhuma policy de RLS e nenhuma checagem de capacidade
  // no servidor é exercida — o RBAC inteiro seria decorativo.
  useEffect(() => {
    let cancelled = false;

    async function resolveEmployeeFromSession() {
      const { data } = await supabase().auth.getSession();
      if (cancelled) return;
      if (!data.session) {
        setEmployee(null);
        setRestoring(false);
        return;
      }
      // Terminal ficou desligado/fechado durante o corte das 23h30: a sessão
      // do operador anterior não pode ser reaproveitada, exige novo PIN.
      if (isStoredSessionExpired()) {
        await supabase().auth.signOut();
        clearSessionStarted();
        clearStepUpCache();
        if (!cancelled) {
          setEmployee(null);
          setRestoring(false);
        }
        return;
      }
      try {
        const me = await Api.currentEmployee();
        if (!cancelled) setEmployee(me);
      } catch {
        if (!cancelled) setEmployee(null);
      } finally {
        if (!cancelled) setRestoring(false);
      }
    }

    void resolveEmployeeFromSession();

    const { data: subscription } = supabase().auth.onAuthStateChange((_event, session) => {
      if (!session) setEmployee(null);
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  // Logout "de verdade" (sessão Supabase + estado local), reaproveitado pelo
  // valor exposto em `logout` e pelo encerramento automático às 23h30 abaixo.
  const doLogout = async () => {
    await supabase().auth.signOut();
    clearSessionStarted();
    clearStepUpCache();
    setEmployee(null);
    setUnitId(null);
    setGerencial(false);
    autoSelectedForEmployeeId.current = null;
  };

  // Encerra a sessão automaticamente às 23h30 de cada dia, para que o
  // colaborador do turno seguinte seja obrigado a fazer login com a própria
  // conta em vez de continuar usando a sessão de quem operou antes. O critério
  // é "login anterior ao último corte" (ver sessionExpiry.ts), não "são 23h30
  // agora": assim também vale se o app estava fechado/suspenso no horário.
  const employeeRef = useRef(employee);
  employeeRef.current = employee;
  useEffect(() => {
    const checkAutoLogout = () => {
      if (employeeRef.current && isStoredSessionExpired()) void doLogout();
    };

    checkAutoLogout();
    const intervalId = window.setInterval(checkAutoLogout, 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const refreshUnits = async () => {
    if (!employee) return;
    try {
      const allUnits = await Api.units();
      setUnits(await resolveVisibleUnits(employee, allUnits));
    } catch (err) {
      console.error("Erro ao recarregar unidades:", err);
    }
  };

  const handleSetGerencial = (val: boolean) => {
    // Operador NUNCA acessa o módulo gerencial
    if (val && employee?.role === "OPERADOR") {
      setGerencial(false);
      return;
    }
    setGerencial(val);
  };

  const value = useMemo<AppStateValue>(
    () => ({
      units,
      unit: units.find((u) => u.id === unitId) ?? null,
      setUnitId,
      refreshUnits,
      gerencial: employee?.role === "OPERADOR" ? false : gerencial,
      setGerencial: handleSetGerencial,
      employee,
      terminalEmployees,
      restoring,
      switchEmployee: async (employeeId, pin) => {
        const emp = await pinLogin(employeeId, pin);
        clearStepUpCache();
        setTerminalEmployees(listTerminalEmployees());
        setEmployee(emp);
      },
      forgetEmployee: (employeeId) => {
        forgetTerminalEmployee(employeeId);
        setTerminalEmployees(listTerminalEmployees());
      },
      logout: doLogout,
    }),
    [units, unitId, gerencial, employee, terminalEmployees, restoring],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState precisa estar dentro de <AppStateProvider>");
  return ctx;
}
