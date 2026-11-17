# Política de Segurança

## Como relatar uma vulnerabilidade

Abra uma issue privada (*Security > Report a vulnerability*) neste repositório
ou escreva para o responsável técnico. Não abra issue pública para falha
explorável, nem cole credencial em issue ou pull request.

## Onde ficam as credenciais

**Nenhuma chave entra no código-fonte.** O terminal Electron lê tudo do `.env`
da instalação — ver `apps/kiosk/.env.example`. O `.env` da pasta de dados do
usuário (`%APPDATA%\FacaAmigos\.env` no Windows) tem precedência sobre o que
veio dentro do instalador, então dá para trocar a chave de um computador sem
gerar instalador novo.

`apps/kiosk/test/no-embedded-credentials.spec.ts` falha o build se uma chave
literal voltar ao código.

Chaves em uso, e o que cada uma pode:

| Chave | Onde | Poder |
| --- | --- | --- |
| Publicável (`sb_publishable_...`) | SPA, landing pages | Limitada pelo RLS. Pública por natureza |
| Secreta (`sb_secret_...`) | Só no `.env` do terminal | **Ignora todo o RLS.** Acesso total ao banco |

A chave secreta (e a `service_role` legada, que ela substitui) lê e escreve
qualquer tabela, inclusive `fa_kiosk_employee_payroll_info` — dados bancários
dos colaboradores. Ela nunca deve chegar ao navegador, a um tablet, nem a um
arquivo versionado.

## Rotacionar a chave secreta do Supabase

Faça isto se a chave apareceu em código versionado, em um instalador
distribuído, em um print, ou se alguém com acesso a ela saiu da operação.

Prefira criar uma **chave secreta nova** (`sb_secret_...`) em vez de rotacionar
o segredo JWT legado: a secreta é rotacionável sozinha, enquanto trocar o
segredo JWT invalida de uma vez a `anon` e a `service_role` — e derruba junto a
SPA, as landing pages e as Edge Functions.

1. Supabase > *Project Settings* > *API Keys* > *Secret keys* > criar uma nova.
2. Em **cada** computador, editar `%APPDATA%\FacaAmigos\.env`:
   `FACAAMIGOS_SUPABASE_SECRET_KEY=sb_secret_<nova>`, e remover a linha
   `FACAAMIGOS_SUPABASE_SERVICE_ROLE_KEY` se existir.
3. Reiniciar o app em cada máquina e **confirmar que imprime** (Configurações >
   Impressoras > *Cupom de Teste*) e que a emissão de NFC-e segue funcionando.
   Sem chave válida, os dois avisam na tela em vez de falhar em silêncio.
4. Só depois de os dois terminais confirmados: revogar a chave antiga no
   Supabase (*Secret keys* > revogar; para a `service_role` legada, desabilitar
   as *legacy JWT keys* — confirme antes que nenhuma Edge Function ou script
   ainda dependa delas).
5. Repassar a chave nova pessoalmente ou por cofre de senhas. Nunca por
   WhatsApp, e-mail ou commit.

Revogar antes do passo 3 desliga a impressão no balcão em horário de
funcionamento — a ordem importa.

## O que fazer se uma chave vazou

Trocar o arquivo não desfaz o vazamento: quem já clonou o repositório, ou tem um
instalador antigo, continua com a chave antiga. **Rotacionar é obrigatório** —
reescrever o histórico do git não substitui isso, e não alcança clones e forks
que já existem.

## Aparelhos da unidade (camada antes do PIN)

`list-employees` e `login-pin` só respondem a um aparelho cadastrado (header
`x-device-token`, conferido por `supabase/functions/_shared/deviceGate.ts`).
O cadastro é por código de uso único (8 caracteres, 15 min) gerado pelo Owner
em Gerencial > Aparelhos; cada aparelho pode ser revogado sozinho.

Implantação (a ordem importa, senão trava a loja):

1. Aplicar a migration `20261117150000_fa_kiosk_devices.sql`, fazer deploy de
   `device-enroll`, `device-admin`, `list-employees`, `login-pin`, e do app.
   Sem `DEVICE_GATE_ENFORCE` o gate só registra no log (modo transição).
2. Entrar como Owner, gerar um código por aparelho e ativar cada terminal e
   celular. Conferir em Aparelhos o "último uso" de todos.
3. Só então: `supabase secrets set DEVICE_GATE_ENFORCE=true`.

Perdeu todos os aparelhos: entrar pelo Hub de Gestão (`/sso`, fora do gate) e
gerar o código, ou rodar `supabase/create_device_code.sql`.

O token fica no aparelho: quem tem o celular desbloqueado ou o Windows do
balcão tem o primeiro fator, por isso o PIN continua obrigatório e o aparelho
se revoga na hora.
