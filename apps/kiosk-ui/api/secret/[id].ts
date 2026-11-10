import type { VercelRequest, VercelResponse } from "@vercel/node";

// Map em memória no ambiente de execução da Vercel Edge/Serverless Function
const secretStore = new Map<string, { payload: string; expiresAtMs: number; viewCount: number; maxViews: number }>();

export default function handler(req: VercelRequest, res: VercelResponse) {
  const { id } = req.query;
  const secretId = Array.isArray(id) ? id[0] : id;

  if (!secretId) {
    return res.status(400).json({ error: "ID_AUSENTE", message: "Identificador do segredo é obrigatório." });
  }

  const nowMs = Date.now();
  const secret = secretStore.get(secretId);

  // Sem payload fixo: um segredo só existe se foi criado nesta instância.
  // (O antigo atalho por ID de exemplo devolvia chaves reais sem autenticação.)
  if (!secret) {
    return res.status(404).json({
      error: "SECRET_NOT_FOUND",
      message: "Este link seguro já foi lido e destruído ou expirou permanentemente."
    });
  }

  if (nowMs > secret.expiresAtMs || secret.viewCount >= secret.maxViews) {
    secretStore.delete(secretId);
    return res.status(404).json({
      error: "SECRET_EXPIRED",
      message: "Este link seguro já foi lido e destruído ou expirou permanentemente."
    });
  }

  secret.viewCount += 1;
  if (secret.viewCount >= secret.maxViews) {
    secretStore.delete(secretId);
  }

  return res.status(200).json({
    ok: true,
    payload: secret.payload,
    destroyed: secret.viewCount >= secret.maxViews,
    readAtMs: nowMs
  });
}
