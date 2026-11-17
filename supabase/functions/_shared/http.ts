// CORS e resposta JSON compartilhados pelas Edge Functions.
//
// A origem permitida vem de FUNCTIONS_ALLOWED_ORIGINS (lista separada por
// vírgula, ex.: "https://kiosk.facaamigos.com.br,http://localhost:5173").
// Trocar o `*` que estava fixo nas três funções por uma allowlist é o que
// impede login-pin de ser martelado a partir de qualquer página aberta no
// navegador de qualquer pessoa. Sem a variável configurada, cai em
// localhost — falha fechado, e o erro aparece em homologação, não em
// produção com a porta aberta.

const FALLBACK_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:4173",
  "https://kiosk-ui.vercel.app",
  "https://app.institutofacaamigos.com.br",
  "https://institutofacaamigos.com.br",
  "https://www.institutofacaamigos.com.br",
  "https://playground.institutofacaamigos.com.br",
  "https://rh.institutofacaamigos.com.br",
  "http://127.0.0.1:5500",
  // App Electron do quiosque (apps/kiosk): a SPA é servida pelo Fastify
  // local em 127.0.0.1:7317 e chama estas functions direto do renderer —
  // sem essa origem aqui, o navegador bloqueia a resposta (CORS) e o
  // supabase-js reporta "Failed to send a request to the Edge Function",
  // escondendo que o motivo real é CORS e não falta de rede.
  "http://127.0.0.1:7317",
  "https://127.0.0.1:7317",
];

function allowedOrigins(): string[] {
  const raw = Deno.env.get("FUNCTIONS_ALLOWED_ORIGINS");
  if (!raw) return FALLBACK_ORIGINS;
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowed = allowedOrigins();
  return {
    // Origem não permitida recebe um header que o navegador recusa — a
    // resposta até existe, mas o JS da página nunca a lê.
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0]!,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  return null;
}

/**
 * Trava webhooks públicos (google-review, etc.) atrás de um segredo
 * compartilhado configurado via `supabase secrets set <envVarName>=...` e
 * enviado pelo chamador (Zapier/Make/n8n) no header `x-webhook-secret`.
 * Sem essa checagem, qualquer um com a URL da function (que é pública por
 * natureza) podia disparar o efeito colateral do webhook diretamente.
 * Falha fechado: se o secret não estiver configurado no projeto, toda
 * chamada é recusada em vez de aceitar sem verificação.
 */
export function requireWebhookSecret(req: Request, envVarName: string): Response | null {
  const expected = Deno.env.get(envVarName);
  if (!expected) {
    console.error(`${envVarName} não configurado — recusando chamada por padrão seguro`);
    return jsonResponse(req, { error: "webhook não configurado" }, 503);
  }
  const provided = req.headers.get("x-webhook-secret");
  if (provided !== expected) {
    return jsonResponse(req, { error: "não autorizado" }, 401);
  }
  return null;
}
