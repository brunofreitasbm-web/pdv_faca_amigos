// Login por PIN — a ÚNICA forma de autenticação de colaborador no
// terminal. Não existe e-mail/senha em lugar nenhum da UI: cada
// colaborador tem uma conta em auth.users com um e-mail SINTÉTICO
// (gerado em admin-create-employee, nunca mostrado nem digitado por
// ninguém) só para satisfazer o requisito do GoTrue de precisar de um
// identificador. O PIN é conferido aqui, no servidor, contra o hash em
// fa_kiosk_local_credentials — e só se bater é que uma sessão real é
// emitida, via `admin.generateLink` (magic link nunca enviado por
// e-mail; o token volta direto na resposta HTTP e o cliente troca por
// sessão com `auth.verifyOtp`). Isso preserva `auth.uid()` correto para
// RLS/audit_log em todo o app, sem nenhum passo de e-mail/senha.
//
// FREIO DE FORÇA BRUTA: um PIN de 6 dígitos são 10^6 combinações, e a
// lista de colaboradores (id + papel) é legível por qualquer terminal —
// o atacante escolhe direto o Owner. Sem trava, varrer esse espaço contra
// uma Edge Function é perfeitamente factível. O bloqueio é por
// employee_id e NÃO por IP de propósito: o balcão inteiro sai por um NAT
// só, banir IP derrubaria a loja.

import { createClient } from "jsr:@supabase/supabase-js@2";
import bcrypt from "npm:bcryptjs@2.4.3";
import { jsonResponse, preflight } from "../_shared/http.ts";
import { requireDevice } from "../_shared/deviceGate.ts";

interface LoginPinBody {
  employeeId: string;
  pin: string;
  /** Só para o audit_log distinguir login inicial de reautenticação (EmployeeAuthGate). */
  context?: "LOGIN" | "STEP_UP";
}

// Mensagem genérica em qualquer falha (colaborador inexistente, inativo,
// sem PIN cadastrado, bloqueado ou PIN errado) — não dá pra um terminal
// descobrir por tentativa e erro se um employeeId existe ou está ativo.
const GENERIC_ERROR = "PIN incorreto";
const LOCKED_ERROR = "Muitas tentativas. Aguarde alguns minutos e tente de novo.";

// Escada deliberadamente suave no começo: quem erra o PIN de verdade
// costuma errar 1-2 vezes, e travar o operador no meio do sábado é um
// problema operacional pior do que 5 tentativas a mais para o atacante.
const LOCK_STEPS: ReadonlyArray<{ afterFailures: number; lockMs: number }> = [
  { afterFailures: 5, lockMs: 60_000 },
  { afterFailures: 8, lockMs: 5 * 60_000 },
  { afterFailures: 10, lockMs: 15 * 60_000 },
];

// Janela após a qual o contador de erros esfria sozinho — senão um
// colaborador que erra uma vez por semana acaba bloqueado por acúmulo.
const ATTEMPT_DECAY_MS = 30 * 60_000;

function lockMsFor(failedCount: number): number | null {
  let lock: number | null = null;
  for (const step of LOCK_STEPS) {
    if (failedCount >= step.afterFailures) lock = step.lockMs;
  }
  return lock;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse(req, { error: "method_not_allowed" }, 405);

  let body: LoginPinBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, { error: "corpo inválido" }, 400);
  }
  if (!body.employeeId || !body.pin) return jsonResponse(req, { error: GENERIC_ERROR }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Aparelho cadastrado ANTES de qualquer consulta de PIN/trava: sem ele o
  // atacante nem chega a gastar tentativa de ninguém.
  const device = await requireDevice(req, adminClient, "login-pin");
  if (!device.ok) return device.response;

  const nowMs = Date.now();

  // Trava consultada ANTES do bcrypt: além de barrar o ataque, evita gastar
  // ~100ms de CPU por tentativa, que por si só é um vetor de exaustão.
  const { data: attempts } = await adminClient
    .from("fa_kiosk_pin_attempts")
    .select("failed_count, last_failed_ms, locked_until_ms")
    .eq("employee_id", body.employeeId)
    .maybeSingle();

  if (attempts?.locked_until_ms && attempts.locked_until_ms > nowMs) {
    return jsonResponse(req, { error: LOCKED_ERROR }, 429);
  }

  const decayed =
    attempts?.last_failed_ms != null && nowMs - attempts.last_failed_ms > ATTEMPT_DECAY_MS;
  const previousFailures = decayed ? 0 : (attempts?.failed_count ?? 0);

  async function registerFailure(): Promise<Response> {
    const failedCount = previousFailures + 1;
    const lockMs = lockMsFor(failedCount);
    await adminClient.from("fa_kiosk_pin_attempts").upsert(
      {
        employee_id: body.employeeId,
        failed_count: failedCount,
        last_failed_ms: nowMs,
        locked_until_ms: lockMs === null ? null : nowMs + lockMs,
      },
      { onConflict: "employee_id" },
    );
    return jsonResponse(req, { error: lockMs === null ? GENERIC_ERROR : LOCKED_ERROR }, lockMs === null ? 401 : 429);
  }

  const { data: employee, error: employeeError } = await adminClient
    .from("fa_kiosk_employees")
    .select("id, full_name, role, active, auth_user_id")
    .eq("id", body.employeeId)
    .single();
  // Colaborador inexistente não entra na tabela de tentativas (FK), então a
  // resposta é a genérica direta — sem revelar a diferença por timing além
  // do inevitável.
  if (employeeError || !employee || !employee.active || !employee.auth_user_id) {
    return jsonResponse(req, { error: GENERIC_ERROR }, 401);
  }

  const { data: credentials, error: credentialsError } = await adminClient
    .from("fa_kiosk_local_credentials")
    .select("pin_hash")
    .eq("employee_id", employee.id)
    .single();
  if (credentialsError || !credentials) return await registerFailure();

  const pinOk = bcrypt.compareSync(body.pin, credentials.pin_hash);
  if (!pinOk) return await registerFailure();

  const { data: authUser, error: authUserError } = await adminClient.auth.admin.getUserById(employee.auth_user_id);
  if (authUserError || !authUser.user?.email) return jsonResponse(req, { error: GENERIC_ERROR }, 401);

  const { data: link, error: linkError } = await adminClient.auth.admin.generateLink({
    type: "magiclink",
    email: authUser.user.email,
  });
  if (linkError || !link?.properties?.hashed_token) {
    return jsonResponse(req, { error: "não foi possível iniciar a sessão" }, 500);
  }

  // Só zera depois da sessão ter sido efetivamente emitida.
  await adminClient.from("fa_kiosk_pin_attempts").delete().eq("employee_id", employee.id);

  await adminClient.from("fa_kiosk_audit_log").insert({
    employee_id: employee.id,
    action: body.context === "STEP_UP" ? "AUTH_STEP_UP_PIN_OK" : "AUTH_LOGIN_PIN_OK",
    severity: "INFO",
    device_id: device.deviceId,
  });

  return jsonResponse(req, {
    tokenHash: link.properties.hashed_token,
    employee: { id: employee.id, full_name: employee.full_name, role: employee.role },
  });
});
