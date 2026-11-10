# Segurança: pendências da auditoria de 2026-11-10

Lista do que **não** foi resolvido pela Onda 1 neste repositório. Nenhum valor de
segredo aparece aqui, só onde está e o que fazer. Apague cada item ao concluir.

## Ações do dono (não dependem de código)

- [ ] Rotacionar tudo que estava em `APi Banco de talentos.txt` (no histórico até o commit `2cfa0bc`): Brevo, chave do banco de talentos, chave do Wi-Fi, usuário e senha de DVR, MikroTik e Wi-Fi.
- [ ] Rotacionar o token do Penpot que estava em `.mcp.json`.
- [ ] Rotacionar as chaves de API do shopping: estão em texto puro nas migrations `20260819000004`, `20260821000001`, `20261026000001` e estavam fixas no bundle.
- [ ] Trocar o PIN `000000` dos ADMIN se `supabase/create_admin_user.sql` / `create_admin2.sql` rodaram em produção.
- [ ] Supabase Auth do PLAY: ativar "Leaked password protection" e confirmar signup público desligado.
- [ ] Dizer de quem são as funções `biofit_*` (executáveis por anon, sem guarda, não pertencem a nenhum dos 5 repos).
- [ ] Fazer deploy de `delete-job-applications`.

## Onda 2 (muda comportamento, aprovar item a item)

- [ ] `fa_checkout`: falta limite inferior em `p_closed_at_ms` (o cliente pode fechar a sessão no horário do check-in e não pagar o tempo).
- [ ] `fa_create_pdv_order`: validar `quantity > 0`, produto ativo e da unidade. Antes, entender os 39 pagamentos com valor zero ou negativo que já existem em `fa_kiosk_payments`.
- [ ] Triggers de RBAC saem cedo quando `fa_kiosk_current_employee_id()` é nulo: passar a negar para `authenticated` que não é colaborador.
- [ ] Trocar `using (true)` para `authenticated` por "é colaborador ativo" nas ~50 policies `fa_kiosk_*`.
- [ ] Edge functions `crm-*-dispatch` e `chat-telegram-notify` sem autenticação: exigir segredo e fazer o cron enviá-lo (função aceita com e sem, atualiza o cron, depois exige).
- [ ] Bucket `envelope-fotos` público (fotos de envelope de caixa): tornar privado. Remover a policy `fa_kiosk_crianca_fotos_write_anon_temp`.
- [ ] `VITE_GEMINI_API_KEY` no bundle: mover para edge function.
- [ ] Chave de serviço em cada terminal Windows (`apps/kiosk/src/config/supabaseTerminalKey.ts`): credencial restrita ou função intermediária.
- [ ] Servidor local do quiosque escuta em `0.0.0.0` sem auth em `/api/system/*` e `/api/secret/*`.
- [ ] `job-application-webhook`: honeypot, limite por IP e validação do PDF pelos bytes.
- [ ] Views `fa_kiosk_fiscal_csc_status` e `fa_kiosk_fiscal_certificate_status` sem `security_invoker`.
- [ ] `pnpm audit` no CI.
