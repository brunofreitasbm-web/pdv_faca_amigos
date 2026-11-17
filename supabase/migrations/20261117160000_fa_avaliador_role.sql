-- Papel Avaliador (AVALIADOR): login do tablet fixo do playground, só preenche a aba Avaliações.
--
-- Por que rank -1 (e não 0 como Estagiário/Prestador PJ):
-- fa_kiosk_can e fa_kiosk_my_capabilities concedem a um colaborador TODA linha de
-- fa_kiosk_role_capabilities cujo papel tem rank <= o rank dele. Em rank 0, o Avaliador
-- herdaria as linhas do Estagiário e do Prestador PJ (ponto, bonificação, relatório de
-- sessão, chat, check-in) e o menu do tablet não ficaria restrito. Em rank -1 ele recebe só
-- as linhas do próprio papel (abaixo), enquanto todos os demais papéis (rank >= 0) continuam
-- herdando `avaliacao_playground.write`, como já acontece hoje via Estagiário.
-- fa_kiosk_has_role não lista o AVALIADOR em nenhum degrau: ele não passa em nenhuma checagem
-- por papel (Gerencial, sangria etc.).
--
-- Esta migration NÃO foi aplicada: aplicar em produção é uma ação separada e explícita.

alter table fa_kiosk_employees drop constraint if exists fa_kiosk_employees_role_check;
alter table fa_kiosk_employees add constraint fa_kiosk_employees_role_check
  check (role in ('ESTAGIARIO', 'OPERADOR', 'GERENTE', 'ADMIN', 'PRESTADOR_PJ', 'AVALIADOR'));

alter table fa_kiosk_role_capabilities drop constraint if exists fa_kiosk_role_capabilities_role_check;
alter table fa_kiosk_role_capabilities add constraint fa_kiosk_role_capabilities_role_check
  check (role in ('ESTAGIARIO', 'OPERADOR', 'GERENTE', 'ADMIN', 'PRESTADOR_PJ', 'AVALIADOR'));

alter table fa_kiosk_onboarding_invites drop constraint if exists fa_kiosk_onboarding_invites_role_check;
alter table fa_kiosk_onboarding_invites add constraint fa_kiosk_onboarding_invites_role_check
  check (role in ('ESTAGIARIO', 'OPERADOR', 'GERENTE', 'ADMIN', 'PRESTADOR_PJ', 'AVALIADOR'));

create or replace function fa_kiosk_role_rank(p_role text) returns int as $$
  select case p_role
    when 'AVALIADOR'     then -1
    when 'ESTAGIARIO'    then 0
    when 'PRESTADOR_PJ'  then 0
    when 'OPERADOR'      then 1
    when 'GERENTE'       then 2
    when 'ADMIN'         then 3
    else 0
  end;
$$ language sql immutable set search_path = public, pg_temp;

insert into fa_kiosk_role_capabilities (role, capability) values
  ('AVALIADOR', 'avaliacao_playground.write')
on conflict do nothing;

create or replace function fa_config_set_employee_role(p_employee_id uuid, p_role text) returns void as $$
declare
  v_old text;
begin
  if not fa_kiosk_can('config.employees.write') then
    raise exception 'sem permissão para alterar o papel de colaborador' using errcode = '42501';
  end if;
  if p_role not in ('ESTAGIARIO', 'OPERADOR', 'GERENTE', 'ADMIN', 'PRESTADOR_PJ', 'AVALIADOR') then
    raise exception 'papel inválido' using errcode = '22023';
  end if;

  select role into v_old from fa_kiosk_employees where id = p_employee_id;
  if v_old is null then
    raise exception 'colaborador não encontrado' using errcode = 'P0002';
  end if;

  update fa_kiosk_employees set role = p_role where id = p_employee_id;

  perform fa_config_audit('CONFIG_EMPLOYEE_ROLE_CHANGE',
                          jsonb_build_object('employeeId', p_employee_id, 'from', v_old, 'to', p_role));
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
