-- Pacote (Porto Seguro) e da CRIANCA para quem foi vendido, nao de qualquer
-- filho do responsavel.
--
-- Incidente (MARIA VITORIA / responsavel RUBIA SILVA): o pacote foi vendido
-- para o irmao (fa_kiosk_guardian_packages.child_id = MATEUS SILVA), mas o
-- abatimento era por RESPONSAVEL e a tela selecionava "Usar saldo do pacote"
-- sozinha ao identificar a crianca. Resultado: MARIA VITORIA, que nunca teve
-- plano, consumiu 177 min do saldo do irmao (09, 10 e 11/11) e mais 55 min
-- "Alem do pacote" sairam a R$ 0,00 porque overage_cents_per_minute do
-- PORTO SEGURO estava 0.
--
-- Regra nova ("escolha do balcao"):
--   1. O saldo da propria crianca (ou pacote legado sem child_id) e usado
--      automaticamente.
--   2. Saldo de OUTRA crianca do mesmo responsavel so e usado se o balcao
--      confirmar (p_allow_sibling_package). Sem confirmacao o check-in recusa
--      com SALDO_PACOTE_DE_OUTRA_CRIANCA. A confirmacao fica na sessao
--      (guardian_package_sibling_ok) e o checkout so abate de irmao nesse caso.
--   3. Todos os outros ramos do checkout (pacote comprado na entrada, saldo
--      pre-pago, plano) abatem apenas pacote da propria crianca.
--   4. Tarifa de excedente do PORTO SEGURO deixa de ser 0 (R$ 1,50/min, o
--      valor de referencia ja documentado na migration 20261104120000).
--
-- Dados historicos NAO sao alterados aqui (estorno dos 177 min e cobranca dos
-- 55 min de excedente ficam para decisao do gerente).

alter table fa_kiosk_sessions
  add column if not exists guardian_package_sibling_ok boolean not null default false;

-- Sessoes ja abertas no deploy seguem como foram iniciadas.
update fa_kiosk_sessions set guardian_package_sibling_ok = true
 where uses_guardian_package and status in ('ATIVA', 'AGUARDANDO_PAGAMENTO');

update fa_kiosk_packages
   set overage_cents_per_minute = 150
 where name = 'PORTO SEGURO' and coalesce(overage_cents_per_minute, 0) = 0;

-- Titular do saldo: agora informa se o pacote e da propria crianca.
drop function if exists fa_kiosk_child_package_holder(uuid, uuid);
create function fa_kiosk_child_package_holder(p_unit_id uuid, p_child_id uuid)
returns table (
  guardian_id uuid, remaining_minutes integer, overage_cents_per_minute integer,
  expires_at_ms bigint, is_own boolean, owner_child_id uuid, owner_child_name text
) as $$
  select gp.guardian_id, gp.remaining_minutes, pk.overage_cents_per_minute, gp.expires_at_ms,
         (gp.child_id is null or gp.child_id = p_child_id) as is_own,
         gp.child_id, oc.full_name
    from fa_kiosk_guardian_packages gp
    join fa_kiosk_packages pk on pk.id = gp.package_id
    left join fa_kiosk_children oc on oc.id = gp.child_id
   where gp.guardian_id in (select cg.guardian_id from fa_kiosk_child_guardians cg where cg.child_id = p_child_id)
     and (gp.unit_id = p_unit_id
          or (pk.cross_unit
              and exists (select 1 from fa_kiosk_units u where u.id = p_unit_id and u.kind <> 'QUIOSQUE')))
     and gp.expires_at_ms > (extract(epoch from now()) * 1000)::bigint
     and gp.remaining_minutes > 0
   order by (gp.child_id is null or gp.child_id = p_child_id) desc,
            (gp.unit_id = p_unit_id) desc, gp.expires_at_ms asc
$$ language sql stable security definer set search_path = public;

revoke all on function fa_kiosk_child_package_holder(uuid, uuid) from public;
grant execute on function fa_kiosk_child_package_holder(uuid, uuid) to authenticated, service_role;

-- Lista da Entrada: marca o que e da crianca e o que e do irmao.
drop function if exists fa_kiosk_child_package_list(uuid, uuid);
create function fa_kiosk_child_package_list(p_unit_id uuid, p_child_id uuid)
returns table (
  package_id uuid, package_name text, remaining_minutes integer, included_minutes integer,
  expires_at_ms bigint, is_own boolean, owner_child_name text
) as $$
  select gp.id, gp.package_name_snapshot, gp.remaining_minutes, gp.included_minutes, gp.expires_at_ms,
         (gp.child_id is null or gp.child_id = p_child_id), oc.full_name
    from fa_kiosk_guardian_packages gp
    join fa_kiosk_packages pk on pk.id = gp.package_id
    left join fa_kiosk_children oc on oc.id = gp.child_id
   where gp.guardian_id in (select cg.guardian_id from fa_kiosk_child_guardians cg where cg.child_id = p_child_id)
     and (gp.unit_id = p_unit_id
          or (pk.cross_unit
              and exists (select 1 from fa_kiosk_units u where u.id = p_unit_id and u.kind <> 'QUIOSQUE')))
     and gp.expires_at_ms > (extract(epoch from now()) * 1000)::bigint
     and gp.remaining_minutes > 0
   order by (gp.child_id is null or gp.child_id = p_child_id) desc,
            (gp.unit_id = p_unit_id) desc, gp.expires_at_ms asc
$$ language sql stable set search_path = public;

revoke all on function fa_kiosk_child_package_list(uuid, uuid) from public;
grant execute on function fa_kiosk_child_package_list(uuid, uuid) to authenticated, service_role;

-- Abatimento: com p_child_id so pacote da crianca (e legado sem child_id);
-- pacote de irmao so com p_allow_siblings. Sem p_child_id mantem o
-- comportamento antigo (por responsavel).
drop function if exists fa_kiosk_package_consume(uuid, uuid, integer, bigint);
create function fa_kiosk_package_consume(
  p_unit_id uuid, p_guardian_id uuid, p_minutes integer, p_now_ms bigint,
  p_child_id uuid default null, p_allow_siblings boolean default false
) returns integer as $$
declare
  v_left integer := greatest(0, coalesce(p_minutes, 0));
  v_covered integer := 0;
  v_take integer;
  v_gp record;
begin
  if v_left = 0 or p_guardian_id is null then return 0; end if;

  for v_gp in
    select gp.* from fa_kiosk_guardian_packages gp
      join fa_kiosk_packages pk on pk.id = gp.package_id
     where gp.guardian_id = p_guardian_id
       and (gp.unit_id = p_unit_id
            or (pk.cross_unit
                and exists (select 1 from fa_kiosk_units u where u.id = p_unit_id and u.kind <> 'QUIOSQUE')))
       and gp.expires_at_ms > p_now_ms and gp.remaining_minutes > 0
       and (p_child_id is null
            or gp.child_id is null or gp.child_id = p_child_id
            or p_allow_siblings)
     order by (p_child_id is null or gp.child_id is null or gp.child_id = p_child_id) desc,
              (gp.unit_id = p_unit_id) desc, gp.expires_at_ms asc
     for update of gp
  loop
    exit when v_left = 0;
    v_take := least(v_gp.remaining_minutes, v_left);
    update fa_kiosk_guardian_packages
       set remaining_minutes = remaining_minutes - v_take
     where id = v_gp.id;
    v_covered := v_covered + v_take;
    v_left := v_left - v_take;
  end loop;

  return v_covered;
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function fa_kiosk_package_consume(uuid, uuid, integer, bigint, uuid, boolean) from public, anon, authenticated;
grant execute on function fa_kiosk_package_consume(uuid, uuid, integer, bigint, uuid, boolean) to service_role;

drop function if exists fa_checkin(
  text, uuid, text, uuid, uuid, jsonb, jsonb, text, uuid, text, text[], boolean, uuid, int, uuid, text, uuid, boolean
);

create or replace function fa_checkin(
  p_idempotency_key text, p_unit_id uuid, p_activity text, p_plan_id uuid, p_asset_id uuid,
  p_guardian jsonb, p_child jsonb, p_coupon_code text, p_employee_id uuid,
  p_notes text default null, p_sensory_tags text[] default null, p_use_hour_bank boolean default false,
  p_pre_checkin_id uuid default null, p_pre_checkin_child_index integer default null,
  p_package_id uuid default null, p_device_id text default null,
  -- Consumo de saldo pré-pago (fa_kiosk_sell_prepaid_credit): a criança
  -- volta e usa o que já foi pago numa visita anterior.
  p_child_credit_id uuid default null,
  -- Entrada consumindo o saldo de pacote (Porto Seguro) do responsavel. Modo
  -- explicito: sem plano vendido, sem cupom, responsavel = quem tem o saldo.
  p_use_guardian_package boolean default false,
  -- Balcao confirmou usar o saldo de pacote de OUTRA crianca do mesmo
  -- responsavel (irmao). Sem isto, so o pacote da propria crianca vale.
  p_allow_sibling_package boolean default false
) returns jsonb as $$
declare
  v_cached jsonb;
  v_unit record;
  v_plan record;
  v_pkg record;
  v_closing_time text;
  v_remaining integer;
  v_plan_price_cents integer := null;
  v_rental_asset_kind text := null;
  v_guardian_id uuid;
  v_child_id uuid;
  v_coupon record;
  v_coupon_id uuid := null;
  v_coupon_discount_cents integer := 0;
  v_coupon_kind text := null;
  v_coupon_pct integer := null;
  v_discount_base_cents integer;
  v_session_id uuid := gen_random_uuid();
  v_access_code text;
  v_exit_pin text;
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_business_date date;
  v_visits_after integer;
  v_rule record;
  v_bank_balance integer := 0;
  v_bank_allocated integer := null;
  v_bank_overage integer := null;
  v_pkg_allocated integer := null;
  v_pkg_name text := null;
  v_pkg_price_cents integer := null;
  v_pkg_overage integer := null;
  v_conversion_key text;
  v_credit record;
  v_credit_allocated integer := null;
  v_credit_name text := null;
  v_credit_overage integer := null;
  v_credit_min_consumption integer := null;
  v_is_rental boolean := false;
  v_holder record;
  v_gp_overage integer := null;
  v_gp_balance integer := 0;
  v_gp_sibling_ok boolean := false;
begin
  v_cached := fa_kiosk_check_idempotency(p_idempotency_key);
  if v_cached is not null then return v_cached; end if;

  select * into v_unit from fa_kiosk_units where id = p_unit_id;
  if not found then raise exception 'UNIDADE_INVALIDA'; end if;

  select value into v_closing_time from fa_kiosk_app_settings where unit_id = p_unit_id and key = 'closing_time';
  if v_closing_time is not null then
    v_remaining := fa_kiosk_minutes_until_closing(v_now_ms, v_closing_time);
  end if;

  if p_child_credit_id is not null then
    if p_activity <> 'PLAYGROUND' then raise exception 'SALDO_PREPAGO_APENAS_PLAYGROUND'; end if;
    v_child_id := nullif(p_child->>'id', '')::uuid;
    if v_child_id is null then raise exception 'SALDO_PREPAGO_SEM_CADASTRO'; end if;

    if exists (select 1 from fa_kiosk_sessions where child_id = v_child_id and status = 'ATIVA') then
      raise exception 'CRIANCA_JA_EM_SESSAO';
    end if;

    select * into v_credit from fa_kiosk_child_time_credits
      where id = p_child_credit_id and child_id = v_child_id
        and cancelled_at_ms is null and remaining_minutes > 0
      for update;
    if not found then raise exception 'SALDO_PREPAGO_INVALIDO'; end if;

    v_credit_allocated := case when v_remaining is not null then greatest(0, least(v_credit.remaining_minutes, v_remaining)) else v_credit.remaining_minutes end;
    v_credit_name := v_credit.source_name_snapshot;
    v_credit_overage := v_credit.overage_cents_per_minute;
    v_credit_min_consumption := v_credit.min_consumption_minutes;
  elsif p_use_guardian_package then
    if p_activity <> 'PLAYGROUND' then raise exception 'SALDO_PACOTE_APENAS_PLAYGROUND'; end if;
    v_child_id := nullif(p_child->>'id', '')::uuid;
    if v_child_id is null then raise exception 'SALDO_PACOTE_SEM_CADASTRO'; end if;
    if exists (select 1 from fa_kiosk_sessions where child_id = v_child_id and status = 'ATIVA') then
      raise exception 'CRIANCA_JA_EM_SESSAO';
    end if;
    select * into v_holder from fa_kiosk_child_package_holder(p_unit_id, v_child_id)
      order by is_own desc, expires_at_ms asc limit 1;
    if not found then raise exception 'SALDO_PACOTE_SEM_SALDO'; end if;
    if not v_holder.is_own then
      -- Saldo e de outra crianca (irmao). So com confirmacao explicita do balcao.
      if not p_allow_sibling_package then
        raise exception 'SALDO_PACOTE_DE_OUTRA_CRIANCA: % (% min)', v_holder.owner_child_name, v_holder.remaining_minutes;
      end if;
      v_gp_sibling_ok := true;
    end if;
    -- A sessao fica no responsavel que tem o saldo: e nele que o checkout
    -- abate e que o painel consulta, qualquer que seja o CPF/telefone digitado.
    v_guardian_id := v_holder.guardian_id;
    v_gp_overage := v_holder.overage_cents_per_minute;
  elsif p_use_hour_bank then
    v_child_id := nullif(p_child->>'id', '')::uuid;
    if v_child_id is null then raise exception 'BANCO_HORAS_SEM_CADASTRO'; end if;

    select coalesce(sum(remaining_minutes), 0) into v_bank_balance
      from fa_kiosk_hour_bank_credits
     where child_id = v_child_id and expires_at_ms > v_now_ms and remaining_minutes > 0;
    if v_bank_balance <= 0 then raise exception 'BANCO_HORAS_SEM_SALDO'; end if;

    select overage_cents_per_minute into v_bank_overage
      from fa_kiosk_hour_bank_credits
     where child_id = v_child_id and expires_at_ms > v_now_ms and remaining_minutes > 0
     order by expires_at_ms asc limit 1;

    v_bank_allocated := case when v_remaining is not null then greatest(0, least(v_bank_balance, v_remaining)) else v_bank_balance end;
  elsif p_package_id is not null then
    select * into v_pkg from fa_kiosk_packages
      where id = p_package_id and unit_id = p_unit_id and activity = p_activity and active;
    if not found then raise exception 'PACOTE_INVALIDO'; end if;

    v_pkg_allocated := case when v_remaining is not null then greatest(0, least(v_pkg.included_minutes, v_remaining)) else v_pkg.included_minutes end;
    v_pkg_name := v_pkg.name;
    v_pkg_price_cents := v_pkg.price_cents;
    v_pkg_overage := v_pkg.overage_cents_per_minute;
  else
    select * into v_plan from fa_kiosk_plans where id = p_plan_id and activity = p_activity;
    if not found then raise exception 'PLANO_INVALIDO'; end if;
    v_plan_price_cents := v_plan.value_cents;
    v_is_rental := p_activity = 'PLAYGROUND' and v_plan.asset_kind is not null;
    v_rental_asset_kind := v_plan.asset_kind;
  end if;

  if v_is_rental then
    if p_coupon_code is not null then raise exception 'CUPOM_NAO_APLICAVEL_PELUCIA'; end if;
    if p_asset_id is null then raise exception 'ASSET_OBRIGATORIO'; end if;
    if not exists (
      select 1 from fa_kiosk_assets
       where id = p_asset_id and unit_id = p_unit_id and kind = v_rental_asset_kind
    ) then
      raise exception 'ASSET_INCOMPATIVEL';
    end if;
  end if;

  if p_activity = 'CARRINHO' or v_is_rental then
    if p_asset_id is null then raise exception 'ASSET_OBRIGATORIO'; end if;
    update fa_kiosk_assets set status = 'EM_USO'
      where id = p_asset_id and status = 'DISPONIVEL';
    if not found then raise exception 'ASSET_INDISPONIVEL'; end if;
  end if;

  if v_guardian_id is null then
    v_guardian_id := nullif(p_guardian->>'id', '')::uuid;
  end if;
  if v_guardian_id is null and p_guardian->>'cpf' is not null then
    select id into v_guardian_id from fa_kiosk_guardians where cpf = p_guardian->>'cpf';
  end if;
  if v_guardian_id is null then
    select id into v_guardian_id from fa_kiosk_guardians where phone_e164 = p_guardian->>'phoneE164';
  end if;
  if v_guardian_id is null then
    insert into fa_kiosk_guardians (full_name, phone_e164, cpf)
      values (p_guardian->>'fullName', p_guardian->>'phoneE164', p_guardian->>'cpf')
      returning id into v_guardian_id;
  end if;

  if v_child_id is null then
    v_child_id := nullif(p_child->>'id', '')::uuid;
  end if;
  if v_child_id is null then
    insert into fa_kiosk_children (full_name, birth_date, inclusive_eligible, inclusive_proof_type)
      values (p_child->>'fullName', (p_child->>'birthDate')::date,
              coalesce((p_child->>'inclusiveEligible')::boolean, false), p_child->>'inclusiveProofType')
      returning id into v_child_id;
  end if;

  -- Pelúcia e brincadeira não correm ao mesmo tempo para a mesma criança,
  -- nos dois sentidos: quem está com a pelúcia não entra no Playground, e
  -- quem está no Playground não aluga a pelúcia. A exceção aborta a
  -- transação inteira, então a reserva do ativo acima é desfeita junto.
  if exists (
    select 1 from fa_kiosk_sessions
     where child_id = v_child_id and status = 'ATIVA'
       and (v_is_rental or rental_kind is not null)
  ) then
    raise exception 'CRIANCA_JA_EM_SESSAO';
  end if;

  insert into fa_kiosk_child_guardians (child_id, guardian_id, is_authorized_pickup)
    values (v_child_id, v_guardian_id, true)
    on conflict (child_id, guardian_id) do nothing;

  -- Quem tem saldo de pacote valido nao compra plano avulso: o saldo e
  -- consumido primeiro. Pelucia e cortesia de aniversario nao tocam o saldo,
  -- entao seguem livres.
  if not p_use_guardian_package and not p_use_hour_bank
     and p_package_id is null and p_child_credit_id is null
     and p_activity = 'PLAYGROUND' and not v_is_rental then
    if not coalesce(v_plan.birthday_courtesy, false) then
      select coalesce(sum(remaining_minutes), 0) into v_gp_balance
        from fa_kiosk_child_package_holder(p_unit_id, v_child_id)
       where is_own;
      if v_gp_balance > 0 then
        raise exception 'SALDO_PACOTE_USAR_PRIMEIRO: % min disponiveis', v_gp_balance;
      end if;
    end if;
  end if;

  -- Cupom nunca se aplica ao consumo de saldo pré-pago: o desconto já
  -- foi aplicado uma vez, no momento da venda (fa_kiosk_sell_prepaid_credit).
  if p_coupon_code is not null and not p_use_hour_bank and p_child_credit_id is null and not p_use_guardian_package then
    select * into v_coupon from fa_kiosk_coupons
      where unit_id = p_unit_id and code = p_coupon_code and active for update;
    if not found then raise exception 'CUPOM_INVALIDO'; end if;
    if v_coupon.allowed_plan_id is not null and (p_package_id is not null or v_coupon.allowed_plan_id <> p_plan_id) then
      raise exception 'CUPOM_PLANO_INVALIDO: %', 'Este cupom não é válido para o plano selecionado';
    end if;
    if not fa_coupon_schedule_ok(v_coupon.schedule_days, v_coupon.schedule_start, v_coupon.schedule_end, v_unit.timezone, v_now_ms) then
      raise exception 'CUPOM_FORA_DO_HORARIO: %', 'Este cupom não é válido neste dia/horário';
    end if;
    if v_coupon.kind = 'DESCONTO_PCT' and p_activity <> 'PLAYGROUND' then
      raise exception 'CUPOM_APENAS_PLAYGROUND: %', 'Este cupom só é válido para o Playground';
    end if;
    update fa_kiosk_coupons set used_count = used_count + 1
      where id = v_coupon.id and (max_uses = 0 or used_count < max_uses);
    if not found then raise exception 'CUPOM_ESGOTADO'; end if;
    v_discount_base_cents := case when p_package_id is not null then v_pkg_price_cents else v_plan_price_cents end;
    if v_coupon.kind = 'DESCONTO_VALOR' then v_coupon_discount_cents := v_coupon.value; end if;
    if v_coupon.kind = 'DESCONTO_PCT' then v_coupon_discount_cents := round(v_discount_base_cents * v_coupon.value / 100.0); end if;
    v_coupon_id := v_coupon.id;
    v_coupon_kind := v_coupon.kind;
    v_coupon_pct := case when v_coupon.kind = 'DESCONTO_PCT' then v_coupon.value else null end;
  end if;

  if p_package_id is not null then
    insert into fa_kiosk_guardian_packages (
      unit_id, guardian_id, child_id, package_id, order_id,
      package_name_snapshot, price_cents, charged_cents,
      included_minutes, remaining_minutes, purchased_at_ms, expires_at_ms
    ) values (
      p_unit_id, v_guardian_id, v_child_id, v_pkg.id, null,
      v_pkg.name, v_pkg.price_cents, greatest(0, v_pkg.price_cents - v_coupon_discount_cents),
      v_pkg.included_minutes, v_pkg.included_minutes, v_now_ms,
      v_now_ms + v_pkg.validity_days::bigint * 86400000
    );
  end if;

  v_access_code := fa_kiosk_new_access_code();
  v_business_date := fa_kiosk_business_date(v_now_ms, v_unit.business_day_cutoff_hour);
  v_exit_pin := fa_kiosk_new_exit_pin(p_unit_id, v_business_date);

  insert into fa_kiosk_sessions (
    id, unit_id, activity, asset_id, plan_id, child_id, child_name_snapshot, guardian_id,
    access_code, exit_pin, wristband_code, ticket_code, notes, sensory_tags,
    checkin_at, checkin_at_ms, checkin_by_employee_id,
    coupon_id, coupon_discount_cents, coupon_kind, coupon_pct, free_from_loyalty, business_date,
    uses_hour_bank, hour_bank_allocated_minutes, hour_bank_overage_cents_per_minute,
    uses_package, package_id, package_name_snapshot, package_price_cents,
    package_allocated_minutes, package_overage_cents_per_minute,
    uses_child_credit, child_credit_id, child_credit_name_snapshot,
    child_credit_allocated_minutes, child_credit_overage_cents_per_minute,
    child_credit_min_consumption_minutes, rental_kind,
    uses_guardian_package, guardian_package_overage_cents_per_minute, guardian_package_sibling_ok
  ) values (
    v_session_id, p_unit_id, p_activity, p_asset_id,
    case when p_use_hour_bank or p_package_id is not null or p_child_credit_id is not null or p_use_guardian_package then null else p_plan_id end,
    v_child_id, p_child->>'fullName', v_guardian_id,
    v_access_code, v_exit_pin, v_access_code, v_access_code, nullif(trim(coalesce(p_notes, '')), ''), p_sensory_tags,
    to_timestamp(v_now_ms / 1000.0), v_now_ms, p_employee_id,
    v_coupon_id, v_coupon_discount_cents, v_coupon_kind, v_coupon_pct, false, v_business_date,
    p_use_hour_bank, v_bank_allocated, v_bank_overage,
    p_package_id is not null, p_package_id, v_pkg_name, v_pkg_price_cents,
    v_pkg_allocated, v_pkg_overage,
    p_child_credit_id is not null, p_child_credit_id, v_credit_name,
    v_credit_allocated, v_credit_overage,
    v_credit_min_consumption, case when v_is_rental then v_rental_asset_kind end,
    p_use_guardian_package, v_gp_overage, v_gp_sibling_ok
  );

  -- Aluguel de pelúcia não é visita: não conta para fidelidade nem selo VIP.
  if not v_is_rental then
    insert into fa_kiosk_visit_log (child_id, activity, at, at_ms) values (v_child_id, p_activity, to_timestamp(v_now_ms / 1000.0), v_now_ms);
    select count(*) into v_visits_after from fa_kiosk_visit_log where child_id = v_child_id;

    for v_rule in
      select * from fa_kiosk_loyalty_rules
      where unit_id = p_unit_id and active and (activity = p_activity or activity = 'AMBOS')
        and trigger_visits > 0 and v_visits_after % trigger_visits = 0
    loop
      insert into fa_kiosk_loyalty_rewards (child_id, rule_id, earned_at_ms) values (v_child_id, v_rule.id, v_now_ms);
    end loop;
  end if;

  perform fa_kiosk_enqueue_entry_prints(v_session_id, p_device_id);

  if p_pre_checkin_id is not null then
    v_conversion_key := coalesce(p_pre_checkin_child_index, 0)::text;
    update fa_kiosk_pre_checkins
      set conversions = conversions || jsonb_build_object(v_conversion_key, v_session_id::text)
      where id = p_pre_checkin_id and status = 'PENDENTE' and not (conversions ? v_conversion_key);

    update fa_kiosk_pre_checkins
      set status = 'CONVERTIDO'
      where id = p_pre_checkin_id and status = 'PENDENTE'
        and (select count(*) from jsonb_object_keys(conversions)) >= jsonb_array_length(children);
  end if;

  v_cached := jsonb_build_object(
    'sessionId', v_session_id, 'childId', v_child_id, 'guardianId', v_guardian_id,
    'accessCode', v_access_code, 'exitPin', v_exit_pin,
    'wristbandCode', v_access_code, 'ticketCode', v_access_code,
    'hourBankAllocatedMinutes', v_bank_allocated,
    'packageAllocatedMinutes', v_pkg_allocated,
    'childCreditAllocatedMinutes', v_credit_allocated,
    'frequencyBadge', fa_kiosk_visit_tier(v_child_id, v_now_ms)
  );
  perform fa_kiosk_store_idempotency(p_idempotency_key, 'fa_checkin', v_cached);
  return v_cached;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;


revoke all on function fa_checkin(
  text, uuid, text, uuid, uuid, jsonb, jsonb, text, uuid, text, text[], boolean, uuid, int, uuid, text, uuid, boolean, boolean
) from public, anon;
grant execute on function fa_checkin(
  text, uuid, text, uuid, uuid, jsonb, jsonb, text, uuid, text, text[], boolean, uuid, int, uuid, text, uuid, boolean, boolean
) to authenticated, service_role;

create or replace function fa_checkout(
  p_idempotency_key text, p_session_ids uuid[], p_payments jsonb,
  p_redeem_reward_ids uuid[], p_employee_id uuid, p_closed_at_ms bigint default null
) returns jsonb as $$
declare
  v_cached jsonb;
  v_actual_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_now_ms bigint := least(coalesce(p_closed_at_ms, v_actual_now_ms), v_actual_now_ms);
  v_session record;
  v_plan record;
  v_timing jsonb;
  v_total_cents integer := 0;
  v_payments_total integer := 0;
  v_unit_id uuid;
  v_shift record;
  v_order_id uuid := gen_random_uuid();
  v_order_code text := fa_kiosk_next_order_code();
  v_payment jsonb;
  v_index integer := 0;
  v_first_session_id uuid;
  v_reward_id uuid;
  v_free_from_loyalty boolean;
  v_line_cents integer;
  v_applied_discount integer;
  v_valid_employee_id uuid := p_employee_id;
  v_covered jsonb := '{}'::jsonb;
  v_covered_minutes integer;
  v_elapsed_minutes integer;
  v_uncovered_minutes integer;
  v_extra record;
  v_extra_cents integer;
  v_plan_minutes integer;
  v_bank_leftover integer;
  v_bank_validity_days integer;
  v_loyalty_used boolean := false;
  v_loyalty_session_id uuid;
  v_courtesy_free boolean;
  v_free_stay boolean;
  v_pkg_covered integer;
begin
  v_cached := fa_kiosk_check_idempotency(p_idempotency_key);
  if v_cached is not null then return v_cached; end if;

  if v_valid_employee_id is not null and not exists (select 1 from fa_kiosk_employees where id = v_valid_employee_id) then
    select id into v_valid_employee_id from fa_kiosk_employees limit 1;
  end if;

  for v_session in
    select * from fa_kiosk_sessions where id = any(p_session_ids) for update
  loop
    if v_session.status not in ('ATIVA', 'AGUARDANDO_PAGAMENTO') then
      raise exception 'SESSAO_JA_FECHADA: %', v_session.id;
    end if;
    if v_session.paused_at_ms is not null then
      raise exception 'SESSAO_PAUSADA: %', v_session.id;
    end if;
    if v_index = 0 then v_first_session_id := v_session.id; v_unit_id := v_session.unit_id; end if;

    -- A recompensa zera a primeira sessão do pedido que não é aluguel de
    -- pelúcia (antes: sempre a de v_index = 0).
    v_free_from_loyalty := (not v_loyalty_used and v_session.rental_kind is null
                            and array_length(p_redeem_reward_ids, 1) > 0);
    if v_free_from_loyalty then
      v_loyalty_used := true;
      v_loyalty_session_id := v_session.id;
    end if;
    v_elapsed_minutes := greatest(1, ceil(
      greatest(0, v_now_ms - v_session.checkin_at_ms - (coalesce(v_session.paused_ms_total, 0) + coalesce(v_session.loyalty_courtesy_minutes, 0) * 60000)) / 60000.0)::integer);
    -- tolerância: entrou e saiu em até 3 min não cobra nem consome saldo.
    v_free_stay := greatest(0, v_now_ms - v_session.checkin_at_ms - coalesce(v_session.paused_ms_total, 0)) <= 180000;

    if v_free_stay then
      v_line_cents := case when v_session.uses_package then coalesce(v_session.package_price_cents, 0) else 0 end;
    elsif v_session.uses_guardian_package then
      -- Saldo de pacote (Porto Seguro) em modo explicito: o plano nunca e
      -- cobrado. Abate do saldo do responsavel; so o que faltar vira
      -- excedente, pela tarifa do pacote congelada no check-in.
      v_covered_minutes := fa_kiosk_package_consume(v_session.unit_id, v_session.guardian_id, v_elapsed_minutes, v_now_ms,
        v_session.child_id, coalesce(v_session.guardian_package_sibling_ok, false));
      v_covered := jsonb_set(v_covered, array[v_session.id::text], to_jsonb(v_covered_minutes));
      v_uncovered_minutes := greatest(0, v_elapsed_minutes - v_covered_minutes - 1);
      v_line_cents := v_uncovered_minutes * coalesce(v_session.guardian_package_overage_cents_per_minute, 0);
    elsif v_session.uses_hour_bank then
      v_covered_minutes := fa_kiosk_hour_bank_consume(v_session.child_id, v_elapsed_minutes, v_now_ms);
      v_covered := jsonb_set(v_covered, array[v_session.id::text], to_jsonb(v_covered_minutes));
      v_uncovered_minutes := greatest(0, v_elapsed_minutes - v_covered_minutes);
      v_line_cents := v_uncovered_minutes * coalesce(v_session.hour_bank_overage_cents_per_minute, 0);
    elsif v_session.uses_package then
      -- Débito do saldo (FIFO por vencimento, consome primeiro o que o
      -- responsável já tinha antes deste pacote novo). O preço cheio do
      -- pacote é cobrado agora, na compra — diferente do banco de horas,
      -- que já foi pago quando o crédito nasceu. Excedente cobra pela
      -- tarifa do PACOTE (com desconto, ex.: 1,50 ou 1,80/min), não pela
      -- de um Plano — o plan_id da sessão é nulo aqui. Tolerância de 1
      -- minuto após esgotar o saldo, igual ao Plano (ver
      -- fa_kiosk_session_timing acima).
      v_covered_minutes := fa_kiosk_package_consume(v_session.unit_id, v_session.guardian_id, v_elapsed_minutes, v_now_ms, v_session.child_id, false);
      v_covered := jsonb_set(v_covered, array[v_session.id::text], to_jsonb(v_covered_minutes));
      v_uncovered_minutes := greatest(0, v_elapsed_minutes - v_covered_minutes - 1);
      v_line_cents := coalesce(v_session.package_price_cents, 0)
        + v_uncovered_minutes * coalesce(v_session.package_overage_cents_per_minute, 0);
    elsif v_session.uses_child_credit then
      -- Saldo já foi pago na venda (fa_kiosk_sell_prepaid_credit) — a
      -- linha do saldo em si é R$ 0,00, só o excedente cobra. Piso de
      -- min_consumption_minutes: crédito de Plano avulso não fraciona
      -- abaixo de uma visita inteira (null = Pacote, fraciona livre).
      v_covered_minutes := fa_kiosk_child_credit_consume(
        v_session.child_id,
        greatest(v_elapsed_minutes, coalesce(v_session.child_credit_min_consumption_minutes, 0)),
        v_now_ms);
      -- O que o saldo da criança não cobriu abate do pacote do responsável
      -- (Porto Seguro etc.) antes de virar excedente. O pacote é um saldo
      -- separado (fa_kiosk_guardian_packages): sem este passo, a renovação
      -- comprada com a sessão em saldo pré-pago ficava intocada enquanto o
      -- excedente era cobrado/zerado.
      v_pkg_covered := fa_kiosk_package_consume(
        v_session.unit_id, v_session.guardian_id,
        greatest(0, v_elapsed_minutes - v_covered_minutes), v_now_ms, v_session.child_id, false);
      v_covered_minutes := v_covered_minutes + v_pkg_covered;
      v_covered := jsonb_set(v_covered, array['pkg:' || v_session.id::text], to_jsonb(v_pkg_covered));
      v_covered := jsonb_set(v_covered, array[v_session.id::text], to_jsonb(v_covered_minutes));
      v_uncovered_minutes := greatest(0, v_elapsed_minutes - v_covered_minutes - 1);
      v_line_cents := v_uncovered_minutes * coalesce(v_session.child_credit_overage_cents_per_minute, 0);
    elsif v_session.rental_kind is not null then
      -- Aluguel de pelúcia: plano + excedente, nunca toca o pacote.
      select * into v_plan from fa_kiosk_plans where id = v_session.plan_id;
      v_timing := fa_kiosk_session_timing(v_plan, v_session.checkin_at_ms, v_now_ms, (coalesce(v_session.paused_ms_total, 0) + coalesce(v_session.loyalty_courtesy_minutes, 0) * 60000));
      v_line_cents := (v_timing->>'liveTotalCents')::integer;
    else
      select * into v_plan from fa_kiosk_plans where id = v_session.plan_id;
      v_timing := fa_kiosk_session_timing(v_plan, v_session.checkin_at_ms, v_now_ms, (coalesce(v_session.paused_ms_total, 0) + coalesce(v_session.loyalty_courtesy_minutes, 0) * 60000));
      -- cortesia de aniversário: nunca consome o saldo de pacote da família
      -- (os 30 min são de graça; o excedente sai pela tarifa do plano).
      if coalesce(v_plan.birthday_courtesy, false) then
        v_covered_minutes := 0;
      else
        v_covered_minutes := fa_kiosk_package_consume(v_session.unit_id, v_session.guardian_id, v_elapsed_minutes, v_now_ms, v_session.child_id, false);
      end if;
      v_covered := jsonb_set(v_covered, array[v_session.id::text], to_jsonb(v_covered_minutes));

      if v_covered_minutes > 0 then
        -- Plano pago com saldo de pacote do responsável: mesma tolerância
        -- de 1 minuto do Plano puro, aplicada aqui porque este ramo não
        -- passa por fa_kiosk_session_timing.
        v_uncovered_minutes := greatest(0, v_elapsed_minutes - v_covered_minutes - 1);
        v_line_cents := v_uncovered_minutes * coalesce(v_plan.overage_cents_per_minute, 0);
      else
        v_line_cents := (v_timing->>'liveTotalCents')::integer;
        -- Cortesia de fidelidade: até N min de permanência, o plano sai de
        -- graça; passou disso, o relógio já andou N min a menos (acima) e o
        -- plano é cobrado normalmente.
        if coalesce(v_session.loyalty_courtesy_minutes, 0) > 0
           and greatest(0, v_now_ms - v_session.checkin_at_ms - coalesce(v_session.paused_ms_total, 0))
               <= v_session.loyalty_courtesy_minutes * 60000 then
          v_line_cents := 0;
        end if;
      end if;
    end if;
    v_total_cents := v_total_cents + v_line_cents;

    v_applied_discount := 0;
    -- Pelúcia nunca tem desconto: o check-in já recusa cupom, e esta guarda
    -- garante que nenhum valor gravado na sessão abata o aluguel.
    if coalesce(v_session.coupon_discount_cents, 0) > 0 and v_session.rental_kind is null then
      if v_session.coupon_kind = 'DESCONTO_PCT' and v_session.activity = 'PLAYGROUND' then
        -- Recalcula sobre o valor real da linha (já com excedente), não
        -- sobre o valor fixo gravado no check-in — é o que garante que o
        -- minuto adicional também recebe o mesmo percentual de desconto.
        v_applied_discount := least(v_line_cents, round(v_line_cents * coalesce(v_session.coupon_pct, 0) / 100.0)::integer);
      else
        v_applied_discount := least(v_session.coupon_discount_cents, v_line_cents);
      end if;
      v_line_cents := v_line_cents - v_applied_discount;
      v_total_cents := v_total_cents - v_applied_discount;
    end if;
    if v_free_from_loyalty then
      v_total_cents := v_total_cents - v_line_cents;
    end if;

    select coalesce(sum(quantity * unit_price_cents), 0) into v_extra_cents
      from fa_kiosk_session_extra_items where session_id = v_session.id and order_id is null;
    v_total_cents := v_total_cents + v_extra_cents;

    update fa_kiosk_sessions set status = 'AGUARDANDO_PAGAMENTO', coupon_discount_cents = v_applied_discount where id = v_session.id;
    v_index := v_index + 1;
  end loop;

  if v_index <> array_length(p_session_ids, 1) then
    raise exception 'SESSAO_NAO_ENCONTRADA';
  end if;

  select coalesce(sum((p->>'amountCents')::integer), 0) into v_payments_total from jsonb_array_elements(p_payments) p;
  if v_payments_total <> v_total_cents then
    raise exception 'SOMA_PAGAMENTOS_DIVERGENTE: esperado % recebido %', v_total_cents, v_payments_total;
  end if;

  select * into v_shift from fa_kiosk_shifts where unit_id = v_unit_id and status = 'ABERTO';
  if not found then raise exception 'SEM_TURNO_ABERTO'; end if;

  insert into fa_kiosk_orders (id, unit_id, shift_id, kind, total_cents, status, business_date, order_code)
    values (v_order_id, v_unit_id, v_shift.id, 'SESSAO', v_total_cents, 'ABERTA', v_shift.business_date, v_order_code);

  for v_session in select * from fa_kiosk_sessions where id = any(p_session_ids) loop
    v_covered_minutes := coalesce((v_covered->>v_session.id::text)::integer, 0);
    v_courtesy_free := coalesce(v_session.loyalty_courtesy_minutes, 0) > 0
      and greatest(0, v_now_ms - v_session.checkin_at_ms - coalesce(v_session.paused_ms_total, 0))
          <= v_session.loyalty_courtesy_minutes * 60000;
    v_free_stay := greatest(0, v_now_ms - v_session.checkin_at_ms - coalesce(v_session.paused_ms_total, 0)) <= 180000;
    if coalesce(v_session.loyalty_courtesy_minutes, 0) > 0 then
      insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
        values (v_order_id, 'SESSAO', 'SERVICO',
          format('Cortesia de fidelidade — %s min grátis', v_session.loyalty_courtesy_minutes), 1, 0, 0, 0, v_session.id);
    end if;
    v_elapsed_minutes := greatest(1, ceil(
      greatest(0, v_now_ms - v_session.checkin_at_ms - (coalesce(v_session.paused_ms_total, 0) + coalesce(v_session.loyalty_courtesy_minutes, 0) * 60000)) / 60000.0)::integer);

    if v_free_stay then
      -- tolerância: linha única, sem consumo de saldo e sem banco de horas.
      select * into v_plan from fa_kiosk_plans where id = v_session.plan_id;
      -- cortesia de aniversário: entrou e saiu em até 3 min não gasta a
      -- cortesia da família (foi o balcão escolhendo errado ou desistindo).
      if coalesce(v_plan.birthday_courtesy, false) then
        update fa_kiosk_birthday_courtesies
           set status = 'EMITIDA', used_session_id = null, used_unit_id = null, used_at_ms = null
         where used_session_id = v_session.id and status = 'USADA';
      end if;
      insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
        values (v_order_id, 'SESSAO', 'SERVICO',
          format('%s — %s', v_session.child_name_snapshot,
                 case when v_session.uses_package then coalesce(v_session.package_name_snapshot, 'Pacote')
                      when v_session.uses_guardian_package then 'Saldo do pacote'
                      else coalesce(v_plan.name, 'Plano') end), 1,
          case when v_session.uses_package then coalesce(v_session.package_price_cents, 0) else 0 end,
          case when v_session.uses_package then coalesce(v_session.package_price_cents, 0) else coalesce(v_plan.value_cents, 0) end,
          case when v_session.uses_package then coalesce(v_session.package_price_cents, 0) else 0 end, v_session.id);
    elsif v_session.uses_guardian_package then
      if v_covered_minutes > 0 then
        insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
          values (v_order_id, 'SESSAO', 'SERVICO',
            format('%s — %s min usados do saldo do pacote', v_session.child_name_snapshot, v_covered_minutes), 1,
            0, 0, 0, v_session.id);
      end if;
      v_uncovered_minutes := greatest(0, v_elapsed_minutes - v_covered_minutes - 1);
      if v_uncovered_minutes > 0 then
        insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
          values (v_order_id, 'SESSAO', 'SERVICO', format('Além do pacote (%s min)', v_uncovered_minutes), 1,
            v_uncovered_minutes * coalesce(v_session.guardian_package_overage_cents_per_minute, 0),
            v_uncovered_minutes * coalesce(v_session.guardian_package_overage_cents_per_minute, 0),
            v_uncovered_minutes * coalesce(v_session.guardian_package_overage_cents_per_minute, 0), v_session.id);
      end if;
    elsif v_session.uses_hour_bank then
      insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
        values (v_order_id, 'SESSAO', 'SERVICO',
          format('%s — %s min do banco de horas', v_session.child_name_snapshot, v_covered_minutes), 1,
          0, 0, 0, v_session.id);

      v_uncovered_minutes := greatest(0, v_elapsed_minutes - v_covered_minutes);
      if v_uncovered_minutes > 0 then
        insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
          values (v_order_id, 'SESSAO', 'SERVICO', format('Além do banco de horas (%s min)', v_uncovered_minutes), 1,
            v_uncovered_minutes * coalesce(v_session.hour_bank_overage_cents_per_minute, 0),
            v_uncovered_minutes * coalesce(v_session.hour_bank_overage_cents_per_minute, 0),
            v_uncovered_minutes * coalesce(v_session.hour_bank_overage_cents_per_minute, 0), v_session.id);
      end if;
    elsif v_session.uses_package then
      insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
        values (v_order_id, 'SESSAO', 'SERVICO',
          format('%s — %s', v_session.child_name_snapshot, coalesce(v_session.package_name_snapshot, 'Pacote')), 1,
          coalesce(v_session.package_price_cents, 0), coalesce(v_session.package_price_cents, 0),
          coalesce(v_session.package_price_cents, 0), v_session.id);

      if v_covered_minutes > 0 then
        insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
          values (v_order_id, 'SESSAO', 'SERVICO', format('%s min usados do saldo do pacote', v_covered_minutes), 1,
            0, 0, 0, v_session.id);
      end if;

      v_uncovered_minutes := greatest(0, v_elapsed_minutes - v_covered_minutes - 1);
      if v_uncovered_minutes > 0 then
        insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
          values (v_order_id, 'SESSAO', 'SERVICO', format('Além do pacote (%s min)', v_uncovered_minutes), 1,
            v_uncovered_minutes * coalesce(v_session.package_overage_cents_per_minute, 0),
            v_uncovered_minutes * coalesce(v_session.package_overage_cents_per_minute, 0),
            v_uncovered_minutes * coalesce(v_session.package_overage_cents_per_minute, 0), v_session.id);
      end if;
    elsif v_session.uses_child_credit then
      v_pkg_covered := coalesce((v_covered->>('pkg:' || v_session.id::text))::integer, 0);
      insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
        values (v_order_id, 'SESSAO', 'SERVICO',
          format('%s — %s min do saldo pré-pago', v_session.child_name_snapshot, v_covered_minutes - v_pkg_covered), 1,
          0, 0, 0, v_session.id);
      if v_pkg_covered > 0 then
        insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
          values (v_order_id, 'SESSAO', 'SERVICO', format('%s min usados do saldo do pacote', v_pkg_covered), 1,
            0, 0, 0, v_session.id);
      end if;

      v_uncovered_minutes := greatest(0, v_elapsed_minutes - v_covered_minutes - 1);
      if v_uncovered_minutes > 0 then
        insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
          values (v_order_id, 'SESSAO', 'SERVICO', format('Além do saldo pré-pago (%s min)', v_uncovered_minutes), 1,
            v_uncovered_minutes * coalesce(v_session.child_credit_overage_cents_per_minute, 0),
            v_uncovered_minutes * coalesce(v_session.child_credit_overage_cents_per_minute, 0),
            v_uncovered_minutes * coalesce(v_session.child_credit_overage_cents_per_minute, 0), v_session.id);
      end if;
    elsif v_session.rental_kind is not null then
      select * into v_plan from fa_kiosk_plans where id = v_session.plan_id;
      v_timing := fa_kiosk_session_timing(v_plan, v_session.checkin_at_ms, v_now_ms, (coalesce(v_session.paused_ms_total, 0) + coalesce(v_session.loyalty_courtesy_minutes, 0) * 60000));
      insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
        values (v_order_id, 'SESSAO', 'SERVICO',
          format('%s — %s (%s)', v_session.child_name_snapshot,
                 coalesce((select name from fa_kiosk_assets where id = v_session.asset_id), 'Pelúcia'),
                 coalesce(v_plan.name, 'Pelúcia')), 1,
          coalesce(v_plan.value_cents, 0), coalesce(v_plan.value_cents, 0), coalesce(v_plan.value_cents, 0), v_session.id);
      if (v_timing->>'overMinutes')::integer > 0 then
        insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
          values (v_order_id, 'SESSAO', 'SERVICO', format('Excedente pelúcia (%s min)', v_timing->>'overMinutes'), 1,
            (v_timing->>'overCents')::integer, (v_timing->>'overCents')::integer, (v_timing->>'overCents')::integer, v_session.id);
      end if;
    else
      select * into v_plan from fa_kiosk_plans where id = v_session.plan_id;
      v_timing := fa_kiosk_session_timing(v_plan, v_session.checkin_at_ms, v_now_ms, (coalesce(v_session.paused_ms_total, 0) + coalesce(v_session.loyalty_courtesy_minutes, 0) * 60000));

      if v_covered_minutes > 0 then
        insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
          values (v_order_id, 'SESSAO', 'SERVICO',
            format('%s — %s min do pacote', v_session.child_name_snapshot, v_covered_minutes), 1,
            0, coalesce(v_plan.value_cents, 0), 0, v_session.id);

        v_uncovered_minutes := greatest(0, v_elapsed_minutes - v_covered_minutes - 1);
        if v_uncovered_minutes > 0 then
          insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
            values (v_order_id, 'SESSAO', 'SERVICO', format('Além do saldo (%s min)', v_uncovered_minutes), 1,
              v_uncovered_minutes * coalesce(v_plan.overage_cents_per_minute, 0),
              v_uncovered_minutes * coalesce(v_plan.overage_cents_per_minute, 0),
              v_uncovered_minutes * coalesce(v_plan.overage_cents_per_minute, 0), v_session.id);
        end if;
      else
        insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
          values (v_order_id, 'SESSAO', 'SERVICO', format('%s — %s', v_session.child_name_snapshot, coalesce(v_plan.name, 'Plano')), 1,
            case when v_courtesy_free then 0 else coalesce(v_plan.value_cents, 0) end, coalesce(v_plan.value_cents, 0),
            case when v_courtesy_free then 0 else coalesce(v_plan.value_cents, 0) end, v_session.id);
        if (v_timing->>'overMinutes')::integer > 0 then
          insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
            values (v_order_id, 'SESSAO', 'SERVICO', format('Excedente (%s min)', v_timing->>'overMinutes'), 1,
              (v_timing->>'overCents')::integer, (v_timing->>'overCents')::integer, (v_timing->>'overCents')::integer, v_session.id);
        end if;

        v_plan_minutes := fa_kiosk_plan_duration_minutes(v_plan.duration_value, v_plan.duration_unit);
        if v_plan_minutes > fa_kiosk_setting_int(v_session.unit_id, 'hour_bank_threshold_minutes', 120) then
          v_bank_leftover := v_plan_minutes - least(v_plan_minutes, v_elapsed_minutes);
          if v_bank_leftover >= 1 then
            v_bank_validity_days := fa_kiosk_setting_int(v_session.unit_id, 'hour_bank_validity_days', 45);
            insert into fa_kiosk_hour_bank_credits (
              child_id, source_session_id, source_unit_id, plan_name_snapshot,
              overage_cents_per_minute, minutes_total, remaining_minutes, created_at_ms, expires_at_ms
            ) values (
              v_session.child_id, v_session.id, v_session.unit_id, coalesce(v_plan.name, 'Plano'),
              coalesce(v_plan.overage_cents_per_minute, 0), v_bank_leftover, v_bank_leftover,
              v_now_ms, v_now_ms + v_bank_validity_days::bigint * 86400000
            ) on conflict (source_session_id) do nothing;

            insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, session_id)
              values (v_order_id, 'SESSAO', 'SERVICO',
                format('Banco de horas: +%s min (vale %s dias, em qualquer unidade)', v_bank_leftover, v_bank_validity_days), 1,
                0, 0, 0, v_session.id);
          end if;
        end if;
      end if;
    end if;

    for v_extra in select ei.*, p.name as product_name from fa_kiosk_session_extra_items ei
      join fa_kiosk_products p on p.id = ei.product_id
      where ei.session_id = v_session.id and ei.order_id is null
    loop
      insert into fa_kiosk_order_items (order_id, item_type, item_nature, description, quantity, unit_price_cents, list_unit_price_cents, total_cents, product_id, session_id)
        values (v_order_id, 'PRODUTO', 'PRODUTO', v_extra.product_name, v_extra.quantity,
          v_extra.unit_price_cents, v_extra.unit_price_cents, v_extra.quantity * v_extra.unit_price_cents,
          v_extra.product_id, v_session.id);
      update fa_kiosk_session_extra_items set order_id = v_order_id where id = v_extra.id;
    end loop;
  end loop;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    insert into fa_kiosk_payments (order_id, method, amount_cents, nsu, authorization_code, pix_txid)
      values (v_order_id, v_payment->>'method', (v_payment->>'amountCents')::integer,
        v_payment->>'nsu', v_payment->>'authorization', v_payment->>'pixTxid');
  end loop;

  update fa_kiosk_orders set status = 'PAGA', closed_by_employee_id = v_valid_employee_id, closed_at_ms = v_now_ms where id = v_order_id;

  for v_session in select * from fa_kiosk_sessions where id = any(p_session_ids) loop
    update fa_kiosk_sessions set status = 'FINALIZADA', checkout_at_ms = v_now_ms, order_id = v_order_id where id = v_session.id;
    if v_session.asset_id is not null then
      update fa_kiosk_assets set status = 'DISPONIVEL',
        odometer_minutes = odometer_minutes + ceil((v_now_ms - coalesce(v_session.checkin_at_ms, v_now_ms)) / 60000.0)
        where id = v_session.asset_id;
    end if;
  end loop;

  -- Pedido só com pelúcia não resgata nada: a recompensa continua
  -- disponível para a próxima visita de verdade.
  if v_loyalty_used then
    foreach v_reward_id in array coalesce(p_redeem_reward_ids, array[]::uuid[]) loop
      update fa_kiosk_loyalty_rewards set redeemed_at_ms = v_now_ms, redeemed_session_id = v_loyalty_session_id
        where id = v_reward_id and redeemed_at_ms is null;
    end loop;
  end if;

  v_cached := jsonb_build_object('orderId', v_order_id, 'orderCode', v_order_code, 'totalCents', v_total_cents);
  perform fa_kiosk_store_idempotency(p_idempotency_key, 'fa_checkout', v_cached);
  return v_cached;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
