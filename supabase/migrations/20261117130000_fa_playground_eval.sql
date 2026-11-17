-- Avaliação no playground (VB-MAPP em até 5 visitas): lado do PDV.
--
-- O conteúdo (itens, evoluções, presença) vive na clínica. Aqui ficam só:
--   1. capacidades da aba "Avaliações";
--   2. recibos de envio (sem respostas e sem nome da criança);
--   3. fila cifrada de reenvio (o PDV não consegue ler o conteúdo);
--   4. setor Fisioterapia para o colaborador;
--   5. cron de 5 em 5 min que reenvia a fila (ação `flush` da edge function
--      playground-eval-bridge).
--
-- Nada aqui é enviado ao responsável: não toca fa_kiosk_session_reports nem o CRM.

-- ---------------------------------------------------------------------
-- 1. Capacidades
--    DECISÃO: `avaliacao_playground.write` fica no papel ESTAGIARIO (rank 0,
--    como relatorio_sessao.write): uma linha em rank 0 vale para todos os
--    papéis, e o usuário de aparelho (tablet fixo) e qualquer profissional
--    conseguem preencher. `avaliacao_playground.presenca` (Chegou/Saiu) fica no
--    OPERADOR, o papel que opera o caixa (tem sessao.checkin/checkout); Líder e
--    Owner herdam. Estagiário e Prestador PJ (rank 0) NÃO a recebem.
-- ---------------------------------------------------------------------
insert into fa_kiosk_role_capabilities (role, capability) values
  ('ESTAGIARIO', 'avaliacao_playground.write'),
  ('OPERADOR',   'avaliacao_playground.presenca')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Setor Fisioterapia
--    O formulário do Olhar não depende do setor (lista única de 16 itens), então
--    um colaborador de Fisioterapia preenche o Olhar normalmente; o setor só vira
--    o rótulo "especialidade" gravado em fa_kiosk_session_reports.
--    filled_by_sector_snapshot (text, sem check) e na Avaliação do playground.
-- ---------------------------------------------------------------------
alter table fa_kiosk_employees drop constraint if exists fa_kiosk_employees_sector_check;
alter table fa_kiosk_employees add constraint fa_kiosk_employees_sector_check
  check (sector is null or sector in ('EDUCACAO_FISICA', 'PSICOLOGIA', 'TERAPIA_OCUPACIONAL', 'PEDAGOGIA', 'FISIOTERAPIA'));

create or replace function fa_config_set_employee_sector(p_employee_id uuid, p_sector text) returns void as $$
declare
  v_old text;
begin
  if not fa_kiosk_can('config.employees.write') then
    raise exception 'sem permissão para alterar o setor de colaborador' using errcode = '42501';
  end if;
  if p_sector is not null and p_sector not in ('EDUCACAO_FISICA', 'PSICOLOGIA', 'TERAPIA_OCUPACIONAL', 'PEDAGOGIA', 'FISIOTERAPIA') then
    raise exception 'setor inválido' using errcode = '22023';
  end if;
  if not exists (select 1 from fa_kiosk_employees where id = p_employee_id) then
    raise exception 'colaborador não encontrado' using errcode = 'P0002';
  end if;
  select sector into v_old from fa_kiosk_employees where id = p_employee_id;
  update fa_kiosk_employees set sector = p_sector where id = p_employee_id;
  perform fa_config_audit('CONFIG_EMPLOYEE_SECTOR_CHANGE',
                          jsonb_build_object('employeeId', p_employee_id, 'from', v_old, 'to', p_sector));
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function fa_config_set_employee_sector(uuid, text) from public, anon;
grant execute on function fa_config_set_employee_sector(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Recibos de envio: SEM respostas e SEM nome da criança.
--    Escrita só pela edge function (service role, que ignora RLS).
-- ---------------------------------------------------------------------
create table if not exists fa_kiosk_playground_eval_receipts (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references fa_kiosk_units (id),
  clinic_visit_id text not null,
  kind text not null,                       -- arrive | leave | entries | conclude
  evaluator_employee_id uuid references fa_kiosk_employees (id),
  device_id text,
  status text not null check (status in ('SENT', 'FAILED')),
  error text,                               -- código e motivo; nunca conteúdo da avaliação
  sent_at_ms bigint not null default (extract(epoch from now()) * 1000)::bigint
);
create index if not exists idx_fa_playground_receipts_unit on fa_kiosk_playground_eval_receipts (unit_id, sent_at_ms desc);
create index if not exists idx_fa_playground_receipts_failed on fa_kiosk_playground_eval_receipts (status) where status = 'FAILED';

alter table fa_kiosk_playground_eval_receipts enable row level security;
drop policy if exists fa_playground_receipts_read on fa_kiosk_playground_eval_receipts;
create policy fa_playground_receipts_read on fa_kiosk_playground_eval_receipts
  for select to authenticated using (fa_kiosk_can('relatorio.read'));
revoke all on fa_kiosk_playground_eval_receipts from anon;
revoke insert, update, delete on fa_kiosk_playground_eval_receipts from authenticated;

-- ---------------------------------------------------------------------
-- 4. Fila de reenvio. payload_sealed é um sealed box (libsodium) com a chave
--    pública da clínica: o PDV não consegue ler. Os ids ao lado (visita, autor,
--    aparelho) são só para gerar o recibo depois; não há nome nem resposta.
--    Sem policy: nenhum acesso de cliente.
-- ---------------------------------------------------------------------
create table if not exists fa_kiosk_playground_eval_outbox (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references fa_kiosk_units (id),
  action text not null,                     -- arrive | leave | entries | conclude
  payload_sealed text not null,
  idempotency_key text not null unique,
  attempts integer not null default 0,
  next_attempt_at_ms bigint not null,
  last_error text,
  created_at_ms bigint not null default (extract(epoch from now()) * 1000)::bigint,
  clinic_visit_id text,
  evaluator_employee_id uuid,
  device_id text
);
create index if not exists idx_fa_playground_outbox_due on fa_kiosk_playground_eval_outbox (next_attempt_at_ms);

alter table fa_kiosk_playground_eval_outbox enable row level security;
revoke all on fa_kiosk_playground_eval_outbox from anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Cron: reenvia a fila a cada 5 min. Mesmo padrão das demais functions de
--    cron (verify_jwt = false, sem segredo no header; a URL é a do projeto).
--    A função só reenvia o que já está na fila, e a idempotencyKey impede
--    duplicata. Para funcionar precisa dos secrets da function: CLINIC_URL,
--    CLINIC_BRIDGE_SECRET e PLAYGROUND_BRIDGE_PUBLIC_KEY.
-- ---------------------------------------------------------------------
do $$
begin
  perform cron.unschedule('fa-playground-eval-flush');
exception when others then null;
end $$;

select cron.schedule(
  'fa-playground-eval-flush',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://ivjvpdzsfjdpyabbzzuj.supabase.co/functions/v1/playground-eval-bridge',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body := '{"action":"flush"}'::jsonb
     ); $$
);
