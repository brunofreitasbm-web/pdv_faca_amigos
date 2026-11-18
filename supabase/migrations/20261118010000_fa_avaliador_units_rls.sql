-- Avaliador só lê a(s) unidade(s) em que está alocado (fa_kiosk_employee_units).
--
-- Contexto: a policy fa_kiosk_read_authenticated de fa_kiosk_units é `using (true)`
-- (20260806000009), então qualquer login, inclusive o AVALIADOR do tablet fixo do
-- playground, lê todas as unidades direto pela API, mesmo com a UI filtrando.
--
-- Só o papel AVALIADOR é restringido. Qualquer outro papel, e qualquer usuário sem
-- linha em fa_kiosk_employees, continua com o comportamento atual (lê todas), para
-- não quebrar as telas que dependem de ver mais de uma unidade (Gerencial etc.).
-- Avaliador sem vínculo gravado não lê nenhuma unidade.
--
-- A checagem vai numa função SECURITY DEFINER para não depender das policies de
-- fa_kiosk_employees / fa_kiosk_employee_units (evita recursão de RLS).
--
-- Esta migration NÃO foi aplicada: aplicar em produção é uma ação separada e explícita.

create or replace function fa_kiosk_can_read_unit(p_unit_id uuid) returns boolean as $$
  select case
    when exists (
      select 1 from fa_kiosk_employees e
       where e.auth_user_id = auth.uid() and e.active and e.role = 'AVALIADOR'
    )
    then exists (
      select 1
        from fa_kiosk_employee_units eu
        join fa_kiosk_employees e on e.id = eu.employee_id
       where e.auth_user_id = auth.uid() and e.active and eu.unit_id = p_unit_id
    )
    else true
  end;
$$ language sql stable security definer set search_path = public, pg_temp;

revoke execute on function fa_kiosk_can_read_unit(uuid) from public, anon;
grant execute on function fa_kiosk_can_read_unit(uuid) to authenticated;

drop policy if exists fa_kiosk_read_authenticated on fa_kiosk_units;
create policy fa_kiosk_read_authenticated on fa_kiosk_units
  for select to authenticated
  using (fa_kiosk_can_read_unit(id));
