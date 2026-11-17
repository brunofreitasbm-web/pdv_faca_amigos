import { supabase } from "./client.js";
import { markSessionStarted } from "./sessionExpiry.js";
import { clearDeviceToken, deviceHeaders, isDeviceRejected } from "./deviceToken.js";

/**
 * Login por PIN — a única forma de autenticação de colaborador no
 * kiosk-ui. Não existe e-mail/senha em nenhuma tela: o PIN é conferido no
 * servidor (Edge Function `login-pin`, ver supabase/functions) contra o
 * hash guardado em fa_kiosk_local_credentials, e só se bater é que uma
 * sessão real do Supabase Auth é emitida — o que preserva `auth.uid()`
 * correto em todo registro de audit_log/ponto_records.
 *
 * O cache local abaixo (localStorage) guarda só nome/papel dos
 * colaboradores já usados neste terminal, para a lista de atalho "quem
 * está operando?" — nenhum segredo fica salvo no cliente; o PIN é sempre
 * verificado no servidor a cada login.
 */

const STORAGE_KEY = "fa_kiosk_terminal_employees";

interface CachedEmployee {
  employeeId: string;
  fullName: string;
  role: "ESTAGIARIO" | "OPERADOR" | "GERENTE" | "ADMIN" | "PRESTADOR_PJ";
  contract_type?: "CLT" | "ESTAGIO" | "AUTONOMO" | "PJ" | null;
}

/** Mesmo shape do antigo `Employee` de api/client.ts, para não exigir mudanças nas telas. */
export interface TerminalEmployee {
  id: string;
  full_name: string;
  role: "ESTAGIARIO" | "OPERADOR" | "GERENTE" | "ADMIN" | "PRESTADOR_PJ";
  contract_type?: "CLT" | "ESTAGIO" | "AUTONOMO" | "PJ" | null;
}

function readCache(): CachedEmployee[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as CachedEmployee[];
  } catch {
    return [];
  }
}

function writeCache(entries: CachedEmployee[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function listTerminalEmployees(): TerminalEmployee[] {
  return readCache().map(({ employeeId, fullName, role }) => ({ id: employeeId, full_name: fullName, role }));
}

export function forgetTerminalEmployee(employeeId: string) {
  writeCache(readCache().filter((e) => e.employeeId !== employeeId));
}

interface LoginPinResponse {
  tokenHash: string;
  employee: TerminalEmployee;
}

/**
 * Único caminho de login: employeeId escolhido na lista + PIN de 6 dígitos.
 * `context` só existe para o audit_log distinguir login inicial de
 * reautenticação numa ação sensível (EmployeeAuthGate) — a verificação do
 * PIN em si é idêntica nos dois casos.
 */
export async function pinLogin(
  employeeId: string,
  pin: string,
  context: "LOGIN" | "STEP_UP" = "LOGIN",
): Promise<TerminalEmployee> {
  const { data, error } = await supabase().functions.invoke<LoginPinResponse>("login-pin", {
    body: { employeeId, pin, context },
    headers: deviceHeaders(),
  });
  if (error && (await isDeviceRejected(error))) {
    await clearDeviceToken();
    throw new Error("Aparelho não autorizado. Ative-o novamente com um código do Owner.");
  }
  if (error || !data?.tokenHash) throw new Error("PIN incorreto");

  const { data: verifyData, error: verifyError } = await supabase().auth.verifyOtp({
    token_hash: data.tokenHash,
    type: "email",
  });
  if (verifyError || !verifyData.session) throw new Error("Não foi possível entrar");

  // Reautenticação de ação sensível não é um novo turno: não renova o prazo.
  if (context === "LOGIN") markSessionStarted();

  writeCache([
    ...readCache().filter((e) => e.employeeId !== data.employee.id),
    { employeeId: data.employee.id, fullName: data.employee.full_name, role: data.employee.role },
  ]);
  return data.employee;
}
