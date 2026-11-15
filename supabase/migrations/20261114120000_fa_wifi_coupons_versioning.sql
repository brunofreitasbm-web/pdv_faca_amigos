-- Versiona (sem mudar comportamento) os objetos dos cupons do Wi-Fi da clínica
-- (ESPERA-XXXX) que já existiam só no banco ao vivo:
--   * colunas expires_at_ms / partner_name em fa_kiosk_coupons
--   * policy de leitura que esconde ESPERA-% das listas do operador
--   * RPC de conferência do campo "Cupom do Wi-Fi da clínica"
--   * triggers de uso único por código e de validade
-- Definições copiadas do banco ao vivo em 2026-11-14.

alter table public.fa_kiosk_coupons add column if not exists expires_at_ms bigint;
alter table public.fa_kiosk_coupons add column if not exists partner_name text;

drop policy if exists fa_kiosk_read_authenticated on public.fa_kiosk_coupons;
create policy fa_kiosk_read_authenticated on public.fa_kiosk_coupons
  for select to authenticated
  using (code !~~ 'ESPERA-%'::text);

create or replace function public.fa_kiosk_coupons_espera_um_uso()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.code, 0));

  if exists (
    select 1 from public.fa_kiosk_coupons o
     where o.code = new.code and o.id <> new.id and o.used_count > 0
  ) then
    raise exception 'CUPOM_ESGOTADO' using detail = 'Este cupom do Wi-Fi já foi usado na outra unidade (um benefício por cupom)';
  end if;

  update public.fa_kiosk_coupons
     set active = false
   where code = new.code and id <> new.id and active;

  return new;
end;
$function$;

create or replace function public.fa_kiosk_coupons_validade()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.expires_at_ms is not null
     and new.expires_at_ms < (extract(epoch from now()) * 1000)::bigint then
    -- Prefixo CUPOM_INVALIDO: o caixa já trata esse código; o texto depois dos dois pontos é o motivo.
    raise exception 'CUPOM_INVALIDO: Cupom vencido em %',
      to_char(to_timestamp(new.expires_at_ms / 1000.0) at time zone 'America/Belem', 'DD/MM/YYYY');
  end if;
  return new;
end;
$function$;

drop trigger if exists fa_kiosk_coupons_espera_um_uso on public.fa_kiosk_coupons;
create trigger fa_kiosk_coupons_espera_um_uso
  before update on public.fa_kiosk_coupons
  for each row
  when (new.used_count > old.used_count and new.code ~~ 'ESPERA-%'::text)
  execute function public.fa_kiosk_coupons_espera_um_uso();

drop trigger if exists fa_kiosk_coupons_validade on public.fa_kiosk_coupons;
create trigger fa_kiosk_coupons_validade
  before update on public.fa_kiosk_coupons
  for each row
  when (new.used_count > old.used_count and new.expires_at_ms is not null)
  execute function public.fa_kiosk_coupons_validade();

create or replace function public.fa_kiosk_wifi_coupon_lookup(p_unit_id uuid, p_code text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_coupon record;
  v_lead record;
  v_expires_ms bigint;
  v_status text;
  v_first text;
  v_last text;
  v_name text;
begin
  if not exists (
    select 1 from fa_kiosk_employees e where e.auth_user_id = auth.uid() and e.active
  ) then
    raise exception 'SEM_PERMISSAO';
  end if;

  if v_code not like 'ESPERA-%' then
    return jsonb_build_object('found', false, 'status', 'NAO_ENCONTRADO');
  end if;

  select * into v_coupon from fa_kiosk_coupons where unit_id = p_unit_id and code = v_code;
  if not found then
    return jsonb_build_object('found', false, 'status', 'NAO_ENCONTRADO');
  end if;

  select guardian_name, coupon_expires_at, redeemed_count into v_lead
    from fa_wifi_leads where coupon_code = v_code;

  v_expires_ms := coalesce(
    v_coupon.expires_at_ms,
    case when v_lead.coupon_expires_at is not null
         then (extract(epoch from v_lead.coupon_expires_at) * 1000)::bigint end
  );

  v_status := case
    when v_coupon.used_count > 0 then 'USADO'
    when exists (select 1 from fa_kiosk_coupons o where o.code = v_code and o.id <> v_coupon.id and o.used_count > 0)
      then 'USADO_OUTRA_UNIDADE'
    when coalesce(v_lead.redeemed_count, 0) > 0 then 'USADO'
    when v_expires_ms is not null and v_expires_ms < v_now_ms then 'VENCIDO'
    when not v_coupon.active then 'DESATIVADO'
    else 'OK'
  end;

  -- Primeiro nome + inicial do último: o bastante para a operadora conferir com quem está no balcão.
  v_name := trim(coalesce(v_lead.guardian_name, ''));
  if v_name <> '' then
    v_first := split_part(v_name, ' ', 1);
    v_last := (regexp_split_to_array(v_name, '\s+'))[array_length(regexp_split_to_array(v_name, '\s+'), 1)];
    v_name := case when v_last <> v_first then v_first || ' ' || upper(left(v_last, 1)) || '.' else v_first end;
  end if;

  return jsonb_build_object(
    'found', true,
    'status', v_status,
    'id', v_coupon.id,
    'code', v_coupon.code,
    'kind', v_coupon.kind,
    'value', v_coupon.value,
    'description', v_coupon.description,
    'maxUses', v_coupon.max_uses,
    'usedCount', v_coupon.used_count,
    'active', v_coupon.active,
    'expiresAtMs', v_expires_ms,
    'guardianName', nullif(v_name, '')
  );
end;
$function$;
